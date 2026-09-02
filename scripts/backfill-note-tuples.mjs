#!/usr/bin/env node

/**
 * MWI-1038 — Migrates note rows from a CSV into structural OpenFGA tuples for
 * the `note` type (see mx-authorization's notes.fga). Per note it writes:
 *   - (institution:X, parent_institution, note:N)   — always
 *   - exactly ONE parent, by context:
 *       entity      -> (entity:E,     parent_entity,     note:N)
 *       assessment  -> (assessment:A, parent_assessment, note:N)
 *       task        -> (task:T,       parent_task,       note:N)
 *       risk / none -> (no parent tuple)
 *
 * The mapping mirrors mx-authorization's `note_events` inbox handler, which is
 * the runtime source of these tuples. Its `build_tuples` writes the institution
 * tuple plus a single parent selected by the `Context` variant, and its
 * `Context::Risk` arm deliberately writes no parent — `risk_output` is not an
 * FGA type. Risk- and no-context notes therefore resolve `parent_can_read` to
 * false and are unreadable until the model gains a risk parent (Notes
 * Permissions tech design §2, pending Product).
 *
 * `NoteAdded` is the only note event and notes are never deleted, so there are
 * no purge cases to exclude and no watermark to respect — unlike the documents
 * backfill (MWI-1037), whose export filters hard-deleted and purged rows.
 *
 * Writes go directly to the OpenFGA API (bypassing Kafka, so no audit events or
 * notifications are produced). Writes set `on_duplicate: ignore`, so existing
 * tuples are skipped without failing the batch — the script is idempotent and
 * safe to re-run. Identical tuples are also de-duplicated before writing.
 *
 * CSV must be RFC 4180 (quoted fields may contain commas and newlines).
 * Expected columns (header row required, produced by export-note-tuples.sql):
 *   note_id, institution_id, context, entity_id, assessment_id, task_id
 *
 * `context` is one of `entity`, `assessment`, `task`, `risk`, `none` — derived
 * in the SQL export by most-specific-parent precedence, because the variant is
 * not persisted on the row. A row whose context names an id that is missing is
 * skipped and reported rather than silently written without its parent.
 *
 * Environment (or --env-file <path>):
 *   OPENFGA_API_URL    (or MX_AUTH_OPENFGA_ENDPOINT)  e.g. https://openfga-mx.npe.moodys.cloud
 *   OPENFGA_STORE_ID
 *   OPENFGA_API_TOKEN  bearer token; omit for a local store with auth disabled
 *
 * Usage:
 *   node scripts/backfill-note-tuples.mjs --csv <path> --model-id <id> [--dry-run] [--limit <n|all>] [--batch-size <n>] [--env-file <path>]
 *
 * Examples:
 *   node scripts/backfill-note-tuples.mjs --csv notes.csv --dry-run
 *   node scripts/backfill-note-tuples.mjs --csv notes.csv --dry-run --limit all > planned-tuples.txt
 *   node scripts/backfill-note-tuples.mjs --csv notes.csv --model-id 01J... --batch-size 100
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * `context` values and the parent tuple each produces. `risk` and `none` map to
 * null: the handler writes no parent for them.
 */
const CONTEXT_PARENTS = {
  entity: { relation: "parent_entity", type: "entity", column: "entity_id" },
  assessment: {
    relation: "parent_assessment",
    type: "assessment",
    column: "assessment_id",
  },
  task: { relation: "parent_task", type: "task", column: "task_id" },
  risk: null,
  none: null,
};

const DEFAULT_BATCH_SIZE = 100;
/** OpenFGA's default `maxTuplesPerWrite`; a larger batch is rejected outright. */
const MAX_BATCH_SIZE = 100;
const BATCH_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/** Tuples listed by --dry-run before truncating. Override with --limit. */
const DRY_RUN_SAMPLE_SIZE = 20;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    csv: null,
    modelId: null,
    dryRun: false,
    batchSize: DEFAULT_BATCH_SIZE,
    envFile: null,
    limit: DRY_RUN_SAMPLE_SIZE,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--csv":
        args.csv = argv[++i];
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
      case "--env-file":
        args.envFile = argv[++i];
        break;
      // How many tuples --dry-run lists. `all` (or 0) prints every one, which is
      // what you want when diffing the planned tuple set rather than eyeballing it.
      case "--limit": {
        const n = Number.parseInt(argv[++i], 10);
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
    // `.env` files in this repo quote some values; ids and URLs must not carry
    // the quotes into a request header or URL path.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      if (value.at(-1) === value[0]) value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// CSV reader (RFC 4180: quoted fields, commas and newlines inside quotes)
// ---------------------------------------------------------------------------

/**
 * Split RFC 4180 content into rows of raw fields. CRLF and LF both terminate a
 * record; a lone CR is not treated as a terminator (Postgres COPY never emits
 * one). Doubled quotes inside a quoted field are unescaped to a single quote.
 */
export function parseCsvRows(content) {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  // Flush a final record that is not newline-terminated.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop blank lines (a trailing newline yields a single empty field).
  return rows.filter((cells) => !(cells.length === 1 && cells[0].trim() === ""));
}

/** Parse CSV content into header-keyed, trimmed row objects. */
export function parseCsv(content) {
  const rows = parseCsvRows(content);
  if (rows.length === 0) return [];
  const header = rows[0].map((name) => name.trim());
  return rows.slice(1).map((cells) => {
    const row = {};
    header.forEach((name, idx) => {
      row[name] = (cells[idx] ?? "").trim();
    });
    return row;
  });
}

function readCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, "utf-8"));
}

/** OpenFGA rejects a TupleKey user/object that is not ^[^\s]{2,256}$ */
export function isValidOpenFgaTupleSegment(s) {
  return typeof s === "string" && /^[^\s]{2,256}$/.test(s);
}

// ---------------------------------------------------------------------------
// Row -> OpenFGA structural tuples
// ---------------------------------------------------------------------------

/** Returns null when the row is usable, otherwise a short reason it was skipped. */
export function rowSkipReason(row) {
  if (!row.note_id?.trim()) return "missing note_id";
  if (!row.institution_id?.trim()) return "missing institution_id";

  const context = row.context?.trim().toLowerCase();
  if (!(context in CONTEXT_PARENTS)) {
    return `unrecognized context ${JSON.stringify(row.context ?? "")}`;
  }

  // A context that names a parent must carry that parent's id. Writing the
  // institution tuple alone would leave the note silently unreadable, which is
  // indistinguishable from a legitimately parentless risk-context note.
  const parent = CONTEXT_PARENTS[context];
  if (parent && !row[parent.column]?.trim()) {
    return `context ${context} but ${parent.column} is empty`;
  }
  return null;
}

/** Map a CSV row to its OpenFGA structural tuples (or [] if the row is unusable). */
export function rowToNoteTuples(row) {
  if (rowSkipReason(row) !== null) return [];

  const noteId = row.note_id.trim();
  const institutionId = row.institution_id.trim();
  const context = row.context.trim().toLowerCase();

  const objectNote = `note:${noteId}`;
  const tuples = [
    {
      user: `institution:${institutionId}`,
      relation: "parent_institution",
      object: objectNote,
    },
  ];

  // Exactly one parent, selected by context — mirroring the handler's match over
  // the Context variant. `risk` and `none` add nothing.
  const parent = CONTEXT_PARENTS[context];
  if (parent) {
    tuples.push({
      user: `${parent.type}:${row[parent.column].trim()}`,
      relation: parent.relation,
      object: objectNote,
    });
  }

  // Keep only tuples whose segments satisfy OpenFGA's constraints. UUID-derived
  // ids always pass; this drops any tuple built from malformed data without
  // discarding the rest of the note's structural tuples.
  return tuples.filter(
    (t) =>
      isValidOpenFgaTupleSegment(t.user) && isValidOpenFgaTupleSegment(t.object),
  );
}

/** De-duplicate identical (user, relation, object) tuples. */
export function dedupeTuples(tuples) {
  const seen = new Set();
  const unique = [];
  for (const t of tuples) {
    const key = `${t.user}|${t.relation}|${t.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }
  return unique;
}

/**
 * Counts for the pre-write summary: what will be written, what was skipped, and
 * how many notes end up with no read parent.
 */
export function summarize(rows, tuples) {
  const skipped = [];
  let noReadParent = 0;

  for (const row of rows) {
    const reason = rowSkipReason(row);
    if (reason !== null) {
      skipped.push({ noteId: row.note_id ?? "", reason });
      continue;
    }
    if (!CONTEXT_PARENTS[row.context.trim().toLowerCase()]) noReadParent++;
  }

  const countRelation = (relation) =>
    tuples.filter((t) => t.relation === relation).length;

  return {
    totalRows: rows.length,
    usableRows: rows.length - skipped.length,
    skipped,
    noReadParent,
    parentInstitution: countRelation("parent_institution"),
    parentEntity: countRelation("parent_entity"),
    parentAssessment: countRelation("parent_assessment"),
    parentTask: countRelation("parent_task"),
  };
}

// ---------------------------------------------------------------------------
// Batch writer
// ---------------------------------------------------------------------------

export function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 409 (optimistic-concurrency abort), 429 (rate limited) and 5xx are transient —
 * with `on_duplicate: ignore` re-asserting the same batch is safe. Other 4xx are
 * validation failures and are not worth retrying. Mirrors the classification in
 * mx-authorization's openfga-http-client.
 *
 * 401 is transient too, and for the same reason that client refreshes on it: a
 * bearer token minted before the run can expire mid-backfill. Treating it as a
 * validation failure would dead-letter every remaining batch over an expired
 * token and read back as bad data.
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
      // Pick up a token the operator refreshed while the run was in flight.
      if (err.status === 401) config.refreshToken?.();
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `  ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

export async function writeBatches(config, tuples, batchSize) {
  const batches = chunk(tuples, batchSize);
  const totalBatches = batches.length;
  let written = 0;
  const failures = [];

  for (let i = 0; i < totalBatches; i++) {
    const batch = batches[i];
    const label = `Batch ${i + 1}/${totalBatches}`;
    try {
      await writeBatchWithRetries(config, batch, label);
      written += batch.length;
      console.log(`  ${label} written  (${written}/${tuples.length} tuples)`);
    } catch (err) {
      console.error(`  ${label} FAILED: ${err.message}`);
      failures.push({ batchIndex: i + 1, tuples: batch, error: err.message });
    }

    if (i < totalBatches - 1) await sleep(BATCH_DELAY_MS);
  }

  return { written, failures };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printSummary(stats, rawTupleCount, tupleCount) {
  const line = (label, value) => console.log(`  ${label.padEnd(46)}: ${value}`);
  line("Total rows in CSV", stats.totalRows);
  line("Usable rows", stats.usableRows);
  line("Skipped rows (see reasons below)", stats.skipped.length);
  line("parent_institution on note", stats.parentInstitution);
  line("parent_entity on note", stats.parentEntity);
  line("parent_assessment on note", stats.parentAssessment);
  line("parent_task on note", stats.parentTask);
  line("Tuples before dedupe", rawTupleCount);
  line("Total tuples to write (after dedupe)", tupleCount);

  if (stats.noReadParent > 0) {
    console.log(
      `\nNote: ${stats.noReadParent} note(s) get parent_institution only — risk-context\n` +
        "  and context-less notes have no FGA parent (risk_output is not a type), so\n" +
        "  can_read stays false for them. This mirrors the handler's Risk arm.",
    );
  }
  if (stats.skipped.length > 0) {
    console.warn(`\nSkipped ${stats.skipped.length} row(s):`);
    for (const { noteId, reason } of stats.skipped.slice(0, 20)) {
      console.warn(`  ${noteId || "(no note_id)"} — ${reason}`);
    }
    if (stats.skipped.length > 20) {
      console.warn(`  ... and ${stats.skipped.length - 20} more`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.csv) {
    console.error("Error: --csv <path> is required");
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

  // Process env wins over the env file, so a one-off override needs no edit.
  const envPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    ".env"
  );
  const env = loadEnv(envPath);

  const apiUrl = env.VITE_OPENFGA_API_URL;
  const storeId = env.VITE_OPENFGA_STORE_ID;
  const token = env.VITE_OPENFGA_API_TOKEN || env.VITE_FGA_X2S_TOKEN;

  if (!apiUrl && !args.dryRun) {
    console.error(
      "Error: OPENFGA_API_URL (or MX_AUTH_OPENFGA_ENDPOINT) is not set",
    );
    process.exit(1);
  }
  if (!storeId && !args.dryRun) {
    console.error("Error: OPENFGA_STORE_ID is not set");
    process.exit(1);
  }

  const csvPath = path.resolve(args.csv);
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}`);
  const rows = readCsv(csvPath);

  const rawTuples = rows.flatMap(rowToNoteTuples);
  const tuples = dedupeTuples(rawTuples);
  const stats = summarize(rows, tuples);
  printSummary(stats, rawTuples.length, tuples.length);

  if (args.dryRun) {
    const shown = Math.min(args.limit, tuples.length);
    const heading =
      shown === tuples.length
        ? `all ${tuples.length} tuples`
        : `first ${shown} of ${tuples.length} tuples`;
    console.log(`\n--- DRY RUN (${heading}) ---`);
    tuples.slice(0, shown).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.user}  ${t.relation}  ${t.object}`);
    });
    if (tuples.length > shown) {
      console.log(
        `  ... and ${tuples.length - shown} more (use --limit all to list every tuple)`,
      );
    }
    console.log("\nNo tuples were written. Remove --dry-run to execute.");
    return;
  }

  if (tuples.length === 0) {
    console.log("\nNothing to write.");
    return;
  }

  const config = {
    writeUrl: `${apiUrl.replace(/\/+$/, "")}/stores/${storeId}/write`,
    modelId: args.modelId,
    token,
    // A backfill can outlive the token it started with. On a 401 the writer
    // re-reads the source so an operator can refresh it mid-run.
    refreshToken() {
      const refreshed = readEnv().OPENFGA_API_TOKEN;
      if (refreshed && refreshed !== this.token) {
        this.token = refreshed;
        console.warn("  Picked up a refreshed OPENFGA_API_TOKEN");
      }
    },
  };

  console.log(`\nWriting ${tuples.length} tuples to store ${storeId} ...`);
  const { written, failures } = await writeBatches(
    config,
    tuples,
    args.batchSize,
  );

  console.log(`\nDone. ${written} tuples written successfully.`);
  if (failures.length > 0) {
    console.error(`${failures.length} batch(es) failed.`);
    const failPath = path.resolve("migration-note-failures.json");
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
