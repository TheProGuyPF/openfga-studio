#!/usr/bin/env node

/**
 * MB-1851 — Migrates entity rows from a CSV into structural OpenFGA tuples
 * for the `entity` type (see mx-authorization's entities.fga). Per usable row
 * it writes exactly ONE tuple:
 *   - (institution:I, parent_institution, entity:E)
 *
 * `parent_institution` is the only structural relation the model declares for
 * `entity` — the other relations (`creator`, `reader`, `editor`, `deleter`,
 * `sharer`) are per-instance direct grants this CSV carries no data for, and
 * the `can_*` relations are computed. There is no recycle-bin analogue and no
 * creator grant for entities.
 *
 * The mapping mirrors mx-authorization's inbox-worker `entity_events` handler,
 * the runtime source of this tuple:
 *   fn build_tuples(entity_id, institution_id) -> vec![RelationTuple {
 *     user: "institution:{institution_id}", relation: "parent_institution",
 *     object: "entity:{entity_id}",
 *   }]
 * `EntityCreated` writes it, `EntityRemoved` deletes it, `EntityUpdated` is a
 * no-op.
 *
 * saga_state filter: only rows whose (quote-stripped) `saga_state` is exactly
 * `Onboarded` produce a tuple. The source `SagaState` enum (entities-mx) also
 * has `Pending`, `Onboarding`, `AlreadyExists { .. }`, `Offboarding`,
 * `Offboarded`, and `Errored { .. }` — none of those have completed onboarding
 * (or have since been offboarded / errored), so writing a tuple for them would
 * grant access to an entity view that was never (or is no longer) live. Rows
 * in any other state are skipped and reported, never silently treated as
 * onboarded.
 *
 * Writes go directly to the OpenFGA API (bypassing Kafka, so no audit events
 * or notifications are produced). Writes set `on_duplicate: ignore`, so
 * existing tuples are skipped without failing the batch — the script is
 * idempotent and safe to re-run or resume. `entity_id` is unique per row in
 * these exports, so no cross-row de-duplication is needed.
 *
 * CSV must be RFC 4180 (quoted fields may contain commas and newlines) and is
 * streamed rather than loaded whole — the largest export is ~151 MB / ~1.22M
 * rows. Expected columns (header row required):
 *   institution_id, entity_id, saga_state, created_at
 * `saga_state` is a JSON-encoded string (e.g. a raw `"Onboarded"` row value
 * parses, after RFC 4180 unescaping, to the literal `"Onboarded"` — quotes
 * included — which is stripped before comparison). `created_at` is unused.
 *
 * Environment is resolved per --env from .env at the repo root (see
 * .env.example), mirroring src/environments.ts / vite.config.ts:
 *   VITE_OPENFGA_API_URL_<SUFFIX>            OpenFGA base URL
 *   VITE_OPENFGA_STORE_ID_<SUFFIX>           OpenFGA store id
 *   VITE_TOKEN_SERVICE_AUDIENCE_<SUFFIX>     token-service audience
 *   TOKEN_SERVICE_URL_<SUFFIX>               token-service endpoint (secret)
 *   FGA_X2S_TOKEN_<SUFFIX>                   X2S Basic credential (secret)
 * where <SUFFIX> is NPE_XUS / CAN_US / XUS / XEU for --env npe-xus / can-us /
 * xus / xeu. npe-xus falls back to the public NPE URL / audience, matching
 * src/environments.ts. VITE_OPENFGA_API_TOKEN, if set, is a static override
 * that skips minting entirely.
 *
 * A run over the largest CSV takes hours and will outlive a single token, so
 * the script mints its own (mirroring src/services/TokenService.ts: POST
 * TOKEN_SERVICE_URL_<SUFFIX> with `Authorization: Basic <X2S>` and body
 * `{ audience }`, response `access_token` (or `token`) + optional
 * `expires_in` seconds), refreshes proactively before expiry, and also
 * refreshes reactively on a 401 before the retry.
 *
 * Usage:
 *   node scripts/backfill-entity-tuples.mjs --csv <path> --env <env> --model-id <id> [--dry-run] [--limit <n|all>] [--batch-size <n>] [--batch-delay-ms <n>]
 *
 * Examples:
 *   node scripts/backfill-entity-tuples.mjs --csv path/to/entities.csv --dry-run
 *   node scripts/backfill-entity-tuples.mjs --csv path/to/entities.csv --dry-run --limit all > planned-tuples.txt
 *   node scripts/backfill-entity-tuples.mjs --csv path/to/entities.csv --env npe-xus --model-id 01J... --batch-size 100 --batch-delay-ms 50
 */

import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAGA_STATE_ONBOARDED = "Onboarded";

const DEFAULT_BATCH_SIZE = 100;
/** OpenFGA's default `maxTuplesPerWrite`; a larger batch is rejected outright. */
const MAX_BATCH_SIZE = 100;
const DEFAULT_BATCH_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;
/** OpenFGA advises retrying 409 (optimistic-concurrency abort) and 429. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/** Tuples listed by --dry-run before truncating. Override with --limit. */
const DRY_RUN_SAMPLE_SIZE = 20;

/** How many skipped-row reasons to keep around for the summary printout. */
const SKIP_SAMPLE_SIZE = 20;

/** Mirrors src/services/TokenService.ts. */
const DEFAULT_REFRESH_INTERVAL_MS = 3600 * 1000; // 1 hour
const REFRESH_MARGIN_MS = 60 * 1000; // refresh 1 min before expiry
const MIN_REFRESH_INTERVAL_MS = 30_000;

/** --env key -> .env var suffix (mirrors src/environments.ts / vite.config.ts). */
const ENV_SUFFIXES = {
  "npe-xus": "NPE_XUS",
  "can-us": "CAN_US",
  xus: "XUS",
  xeu: "XEU",
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    csv: null,
    env: null,
    modelId: null,
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    batchDelayMs: DEFAULT_BATCH_DELAY_MS,
    limit: DRY_RUN_SAMPLE_SIZE,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--csv":
        args.csv = argv[++i];
        break;
      case "--env":
        args.env = argv[++i];
        break;
      case "--model-id":
        args.modelId = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--batch-size":
        args.batchSize = Number.parseInt(argv[++i], 10);
        break;
      case "--batch-delay-ms":
        args.batchDelayMs = Number.parseInt(argv[++i], 10);
        break;
      // How many tuples --dry-run lists. `all` (or 0) prints every one, which is
      // what you want when diffing the planned tuple set rather than eyeballing it.
      case "--limit": {
        const n = Number.parseInt(argv[++i], 10);
        // `all`, `0`, or anything unparseable means "no cap" — this only affects
        // display, so erring toward more output is the safe default.
        args.limit = Number.isInteger(n) && n > 0 ? n : Infinity;
        break;
      }
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// .env loader (lightweight – no external dependency)
// ---------------------------------------------------------------------------

export function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  for (const raw of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // `.env` files in this repo quote some values; ids, URLs and credentials must
    // not carry the quotes into a request header or URL path.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      if (value.at(-1) === value[0]) value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/** Resolve the per-env OpenFGA + token-service config for --env <key>. */
export function resolveEnvConfig(env, envKey) {
  const suffix = ENV_SUFFIXES[envKey];
  if (!suffix) return null;
  return {
    apiUrl:
      env[`VITE_OPENFGA_API_URL_${suffix}`] ||
      (envKey === "npe-xus" ? "https://openfga-mx.npe.moodys.cloud" : ""),
    storeId: env[`VITE_OPENFGA_STORE_ID_${suffix}`] || "",
    tokenServiceAudience:
      env[`VITE_TOKEN_SERVICE_AUDIENCE_${suffix}`] ||
      (envKey === "npe-xus" ? "openfga-mx" : ""),
    tokenServiceUrl: env[`TOKEN_SERVICE_URL_${suffix}`] || "",
    x2sToken: env[`FGA_X2S_TOKEN_${suffix}`] || "",
  };
}

// ---------------------------------------------------------------------------
// Streaming CSV reader (RFC 4180: quoted fields, commas/newlines inside quotes)
// ---------------------------------------------------------------------------

/** Async-iterate header-keyed row objects without materializing the file. */
export async function* streamCsvRows(filePath) {
  const parser = fs.createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }),
  );
  for await (const row of parser) {
    yield row;
  }
}

/** OpenFGA rejects a TupleKey user/object that is not ^[^\s]{2,256}$ */
export function isValidOpenFgaTupleSegment(s) {
  return typeof s === "string" && /^[^\s]{2,256}$/.test(s);
}

// ---------------------------------------------------------------------------
// Row -> OpenFGA structural tuple
// ---------------------------------------------------------------------------

/**
 * Strips one layer of surrounding double quotes from a JSON-encoded saga_state
 * value (`"Onboarded"` -> `Onboarded`). Values that don't have that shape
 * (e.g. the `Errored { .. }` / `AlreadyExists { .. }` JSON-object variants)
 * are returned unchanged so they simply fail the equality check below.
 */
export function normalizeSagaState(raw) {
  const s = (raw ?? "").trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

/** Returns null when the row is usable, otherwise a short reason it was skipped. */
export function rowSkipReason(row) {
  if (!row.institution_id?.trim()) return "missing institution_id";
  if (!row.entity_id?.trim()) return "missing entity_id";
  const sagaState = normalizeSagaState(row.saga_state);
  if (sagaState !== SAGA_STATE_ONBOARDED) {
    return `saga_state not Onboarded (${JSON.stringify(row.saga_state ?? "")})`;
  }
  return null;
}

/** Map a CSV row to its OpenFGA structural tuple (or [] if the row is unusable). */
export function rowToEntityTuples(row) {
  if (rowSkipReason(row) !== null) return [];

  const entityId = row.entity_id.trim();
  const institutionId = row.institution_id.trim();

  const tuple = {
    user: `institution:${institutionId}`,
    relation: "parent_institution",
    object: `entity:${entityId}`,
  };

  // UUID-derived ids always pass; this guards against malformed data rather
  // than expecting to trip in practice.
  return isValidOpenFgaTupleSegment(tuple.user) &&
    isValidOpenFgaTupleSegment(tuple.object)
    ? [tuple]
    : [];
}

// ---------------------------------------------------------------------------
// Token minting / refresh (mirrors src/services/TokenService.ts)
// ---------------------------------------------------------------------------

export async function fetchAccessToken(envConfig) {
  const response = await fetch(envConfig.tokenServiceUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${envConfig.x2sToken}`,
    },
    body: JSON.stringify({ audience: envConfig.tokenServiceAudience }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Token service request failed: status ${response.status}: ${body}`,
    );
  }
  const data = await response.json();
  const token = data.access_token ?? data.token;
  if (!token) {
    throw new Error("Token service response did not contain a token");
  }
  let refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
  if (typeof data.expires_in === "number" && data.expires_in > 0) {
    refreshIntervalMs = Math.max(
      data.expires_in * 1000 - REFRESH_MARGIN_MS,
      MIN_REFRESH_INTERVAL_MS,
    );
  }
  return { token, refreshIntervalMs };
}

/**
 * Mints once, schedules a proactive refresh before expiry (leaving the
 * timer unref'd so it never keeps the process alive on its own), and exposes
 * a `refresh()` also used reactively on a 401.
 */
export function createTokenManager(envConfig) {
  let token = null;
  let timer = null;

  function scheduleRefresh(intervalMs) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      mint().catch((err) => {
        console.warn(`  Proactive token refresh failed: ${err.message}`);
      });
    }, intervalMs);
    timer.unref?.();
  }

  async function mint() {
    const { token: newToken, refreshIntervalMs } =
      await fetchAccessToken(envConfig);
    token = newToken;
    scheduleRefresh(refreshIntervalMs);
    return token;
  }

  return {
    getToken: () => token,
    mint,
    refresh: mint,
    stop: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Batch writer
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 409 (optimistic-concurrency abort), 429 (rate limited) and 5xx are transient —
 * with `on_duplicate: ignore` re-asserting the same batch is safe. Other 4xx are
 * validation failures and are not worth retrying. Mirrors the classification in
 * mx-authorization's openfga-http-client.
 *
 * 401 is transient too: a bearer token minted before the run can expire
 * mid-backfill, and the writer refreshes on it before retrying.
 */
export function isRetriableStatus(status) {
  return status === 401 || status === 409 || status === 429 || status >= 500;
}

export function buildHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function postWrite(config, batch) {
  const response = await fetch(config.writeUrl, {
    method: "POST",
    headers: buildHeaders(config.token),
    body: JSON.stringify({
      writes: { tuple_keys: batch, on_duplicate: "ignore" },
      authorization_model_id: config.modelId,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  const error = new Error(`status ${response.status}: ${body}`);
  error.status = response.status;
  error.retriable = isRetriableStatus(response.status);
  throw error;
}

async function writeBatchWithRetries(config, batch, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      await postWrite(config, batch);
      return;
    } catch (err) {
      // Network/abort errors carry no status; treat them as transient.
      const retriable = err.status === undefined || err.retriable === true;
      if (!retriable || attempt >= MAX_ATTEMPTS) throw err;
      // Pick up a fresh token before the retry.
      if (err.status === 401 && config.refreshToken) {
        await config.refreshToken();
      }
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `  ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printSkipSample(skippedCount, skippedSample) {
  if (skippedCount === 0) return;
  console.warn(`\nSkipped ${skippedCount} row(s):`);
  for (const { entityId, reason } of skippedSample) {
    console.warn(`  ${entityId || "(no entity_id)"} — ${reason}`);
  }
  if (skippedCount > skippedSample.length) {
    console.warn(`  ... and ${skippedCount - skippedSample.length} more`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.csv) {
    console.error("Error: --csv <path> is required");
    process.exit(1);
  }
  if (!args.env && !args.dryRun) {
    console.error(
      "Error: --env <npe-xus|can-us|xus|xeu> is required (unless using --dry-run)",
    );
    process.exit(1);
  }
  if (args.env && !ENV_SUFFIXES[args.env]) {
    console.error(
      `Error: --env must be one of ${Object.keys(ENV_SUFFIXES).join(", ")}`,
    );
    process.exit(1);
  }
  if (!args.modelId && !args.dryRun) {
    console.error("Error: --model-id <id> is required (unless using --dry-run)");
    process.exit(1);
  }
  if (
    !Number.isInteger(args.batchSize) ||
    args.batchSize < 1 ||
    args.batchSize > MAX_BATCH_SIZE
  ) {
    console.error(
      `Error: --batch-size must be an integer between 1 and ${MAX_BATCH_SIZE} (OpenFGA's maxTuplesPerWrite)`,
    );
    process.exit(1);
  }
  if (!Number.isInteger(args.batchDelayMs) || args.batchDelayMs < 0) {
    console.error("Error: --batch-delay-ms must be a non-negative integer");
    process.exit(1);
  }

  const envPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    ".env",
  );
  const env = loadEnv(envPath);

  const envConfig = args.env ? resolveEnvConfig(env, args.env) : null;
  const staticToken = env.VITE_OPENFGA_API_TOKEN;

  if (!args.dryRun) {
    if (!envConfig.apiUrl) {
      console.error(`Error: VITE_OPENFGA_API_URL_${ENV_SUFFIXES[args.env]} is not set`);
      process.exit(1);
    }
    if (!envConfig.storeId) {
      console.error(`Error: VITE_OPENFGA_STORE_ID_${ENV_SUFFIXES[args.env]} is not set`);
      process.exit(1);
    }
    if (!staticToken && (!envConfig.tokenServiceUrl || !envConfig.x2sToken)) {
      console.error(
        `Error: TOKEN_SERVICE_URL_${ENV_SUFFIXES[args.env]} / FGA_X2S_TOKEN_${ENV_SUFFIXES[args.env]} must be set (or set VITE_OPENFGA_API_TOKEN as a static override)`,
      );
      process.exit(1);
    }
  }

  const csvPath = path.resolve(args.csv);
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}`);

  let tokenManager = null;
  const config = args.dryRun
    ? null
    : {
        writeUrl: `${envConfig.apiUrl.replace(/\/+$/, "")}/stores/${envConfig.storeId}/write`,
        modelId: args.modelId,
        token: staticToken || null,
        refreshToken: staticToken
          ? null
          : async function refreshToken() {
              this.token = await tokenManager.refresh();
            },
      };

  if (!args.dryRun && !staticToken) {
    tokenManager = createTokenManager(envConfig);
    console.log("Minting an OpenFGA access token ...");
    config.token = await tokenManager.mint();
  }

  const stats = { totalRows: 0, usableRows: 0, skippedCount: 0, skippedSample: [] };
  let tupleCount = 0;
  let written = 0;
  const failures = [];
  let batch = [];
  let batchIndex = 0;
  let shown = 0;

  if (args.dryRun) {
    console.log(
      `\n--- DRY RUN (${args.limit === Infinity ? "all tuples" : `first ${args.limit} tuples`}) ---`,
    );
  }

  for await (const row of streamCsvRows(csvPath)) {
    stats.totalRows++;
    const reason = rowSkipReason(row);
    if (reason !== null) {
      stats.skippedCount++;
      if (stats.skippedSample.length < SKIP_SAMPLE_SIZE) {
        stats.skippedSample.push({
          entityId: (row.entity_id ?? "").trim(),
          reason,
        });
      }
      continue;
    }
    stats.usableRows++;

    for (const tuple of rowToEntityTuples(row)) {
      tupleCount++;

      if (args.dryRun) {
        if (shown < args.limit) {
          shown++;
          console.log(`  ${shown}. ${tuple.user}  ${tuple.relation}  ${tuple.object}`);
        }
        continue;
      }

      batch.push(tuple);
      if (batch.length >= args.batchSize) {
        batchIndex++;
        const label = `Batch ${batchIndex}`;
        try {
          await writeBatchWithRetries(config, batch, label);
          written += batch.length;
          console.log(`  ${label} written  (${written}/${tupleCount} tuples so far)`);
        } catch (err) {
          console.error(`  ${label} FAILED: ${err.message}`);
          failures.push({ batchIndex, tuples: batch, error: err.message });
        }
        batch = [];
        await sleep(args.batchDelayMs);
      }
    }
  }

  if (!args.dryRun && batch.length > 0) {
    batchIndex++;
    const label = `Batch ${batchIndex}`;
    try {
      await writeBatchWithRetries(config, batch, label);
      written += batch.length;
      console.log(`  ${label} written  (${written}/${tupleCount} tuples so far)`);
    } catch (err) {
      console.error(`  ${label} FAILED: ${err.message}`);
      failures.push({ batchIndex, tuples: batch, error: err.message });
    }
  }

  tokenManager?.stop();

  console.log("\n--- Summary ---");
  const line = (label, value) => console.log(`  ${label.padEnd(52)}: ${value}`);
  line("Total rows in CSV", stats.totalRows);
  line("Usable rows (saga_state = Onboarded)", stats.usableRows);
  line("Skipped rows (see reasons below)", stats.skippedCount);
  line("Total tuples", tupleCount);

  printSkipSample(stats.skippedCount, stats.skippedSample);

  if (args.dryRun) {
    if (tupleCount > shown) {
      console.log(
        `\n... and ${tupleCount - shown} more tuple(s) not shown (use --limit all to list every tuple)`,
      );
    }
    console.log("\nNo tuples were written. Remove --dry-run to execute.");
    return;
  }

  if (tupleCount === 0) {
    console.log("\nNothing to write.");
    return;
  }

  console.log(`\nDone. ${written} tuples written successfully.`);
  if (failures.length > 0) {
    console.error(`${failures.length} batch(es) failed.`);
    const failPath = path.resolve("migration-entity-failures.json");
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2));
    console.error(`Failed batches saved to ${failPath}`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so the tests can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
