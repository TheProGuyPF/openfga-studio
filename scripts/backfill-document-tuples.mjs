#!/usr/bin/env node

/**
 * MWI-1037 — Migrates document rows from a CSV into structural OpenFGA tuples
 * for the `document` and `recycle_bin_entry` types (see mx-authorization's
 * documents.fga / recyclebin.fga). Per document it writes, as applicable:
 *   - (institution:X, parent_institution, document:D)                    — always
 *   - (note:N, parent_note, document:D)                                  — note-attached
 *   - (external_form_submission:FT,
 *      parent_external_form_submission, document:D)                      — external-form attachments
 *   - (institution:X, parent_institution, recycle_bin_entry:D)           — soft-deleted
 *   - (document:D, parent_document, recycle_bin_entry:D)                 — soft-deleted
 *
 * The mapping mirrors mx-authorization's document_events inbox handler, which
 * is the runtime source of these tuples:
 *   - DocumentUploaded  -> parent_institution on the document.
 *   - DocumentClaimed   -> parent_institution + parent_note (when the claim
 *                          context carries a note_id).
 *   - DocumentSoftDeleted -> the recycle_bin_entry pair, WITHOUT removing the
 *                          document's own tuples (recycle_bin_entry.parent_can_read
 *                          resolves through parent_document, so both are needed).
 *   - Hard-delete / erase / draft-expiry / infected-or-unsupported scan purge
 *                       -> every tuple removed. `export-document-tuples.sql`
 *                          filters those rows out, so they are never re-created.
 *
 * NOTE on `parent_external_form_submission`: the relation exists in the model
 * (documents.fga) but the inbox handler does not write it yet. Documents whose
 * context is an external form would otherwise resolve `parent_can_read` to
 * false and be unreadable, so the backfill emits it from `form_template_id`
 * (the model keys submissions per template, not per instance).
 *
 * Documents in an entity / assessment / task / internal_form / bitsight context
 * get `parent_institution` only: the model defines no parent for them, so
 * `can_read` stays false until it does. The dry-run summary reports how many
 * rows land in that bucket so the count is visible before writing.
 *
 * Writes go directly to the OpenFGA API (bypassing Kafka, so no audit events or
 * notifications are produced). Writes set `on_duplicate: ignore`, so existing
 * tuples are skipped without failing the batch — the script is idempotent and
 * safe to re-run. Identical tuples are also de-duplicated before writing.
 *
 * CSV must be RFC 4180 (quoted fields may contain commas and newlines).
 * Expected columns (header row required, produced by export-document-tuples.sql):
 *   document_id, institution_id, state, note_id, form_template_id, context_type
 *
 * `state` is `active` or `deleted` (soft-deleted). Rows with an unrecognized
 * state are skipped and reported rather than silently treated as active, since
 * that would drop the recycle-bin tuples.
 *
 * Environment (or --env-file <path>):
 *   OPENFGA_API_URL    (or MX_AUTH_OPENFGA_ENDPOINT)  e.g. https://openfga-mx.npe.moodys.cloud
 *   OPENFGA_STORE_ID
 *   OPENFGA_API_TOKEN  bearer token; omit for a local store with auth disabled
 *
 * Usage:
 *   node scripts/backfill-document-tuples.mjs --csv <path> --model-id <id> [--dry-run] [--limit <n|all>] [--batch-size <n>] [--env-file <path>]
 *
 * Examples:
 *   node scripts/backfill-document-tuples.mjs --csv documents.csv --dry-run
 *   node scripts/backfill-document-tuples.mjs --csv documents.csv --dry-run --limit all > planned-tuples.txt
 *   node scripts/backfill-document-tuples.mjs --csv documents.csv --model-id 01J... --batch-size 100
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_ACTIVE = "active";
const STATE_DELETED = "deleted";

/** `document_context_type` value whose FGA parent is an external_form_submission. */
const CONTEXT_EXTERNAL_FORM = "external_form";

const DEFAULT_BATCH_SIZE = 100;
/** OpenFGA's default `maxTuplesPerWrite`; a larger batch is rejected outright. */
const MAX_BATCH_SIZE = 100;
const BATCH_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;
/** OpenFGA advises retrying 409 (optimistic-concurrency abort) and 429. */
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
    // `.env` files in this repo quote some values; OpenFGA ids and URLs must not
    // carry the quotes into a request header or URL path.
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
  if (!row.document_id?.trim()) return "missing document_id";
  if (!row.institution_id?.trim()) return "missing institution_id";
  const state = row.state?.trim().toLowerCase();
  if (state !== STATE_ACTIVE && state !== STATE_DELETED) {
    return `unrecognized state ${JSON.stringify(row.state ?? "")}`;
  }
  return null;
}

/** Map a CSV row to its OpenFGA structural tuples (or [] if the row is unusable). */
export function rowToDocumentTuples(row) {
  if (rowSkipReason(row) !== null) return [];

  const documentId = row.document_id.trim();
  const institutionId = row.institution_id.trim();
  const state = row.state.trim().toLowerCase();
  const noteId = row.note_id?.trim();
  const formTemplateId = row.form_template_id?.trim();
  const contextType = row.context_type?.trim().toLowerCase();

  const objectDocument = `document:${documentId}`;
  const userInstitution = `institution:${institutionId}`;
  const tuples = [];

  // Always: institution -> parent_institution -> document (DocumentUploaded).
  tuples.push({
    user: userInstitution,
    relation: "parent_institution",
    object: objectDocument,
  });

  // Note attachments: the read parent (DocumentClaimed with a note_id). Keyed on
  // note_id alone, matching the handler — not on context_type.
  if (noteId) {
    tuples.push({
      user: `note:${noteId}`,
      relation: "parent_note",
      object: objectDocument,
    });
  }

  // External-form attachments: submissions are keyed per template in the model,
  // so the parent object is the form template id.
  if (contextType === CONTEXT_EXTERNAL_FORM && formTemplateId) {
    tuples.push({
      user: `external_form_submission:${formTemplateId}`,
      relation: "parent_external_form_submission",
      object: objectDocument,
    });
  }

  // Soft-deleted documents additionally get their recycle-bin entry. The
  // document's own tuples above stay: recycle_bin_entry.parent_can_read resolves
  // through parent_document.
  if (state === STATE_DELETED) {
    const objectRecycleBinEntry = `recycle_bin_entry:${documentId}`;
    tuples.push({
      user: userInstitution,
      relation: "parent_institution",
      object: objectRecycleBinEntry,
    });
    tuples.push({
      user: objectDocument,
      relation: "parent_document",
      object: objectRecycleBinEntry,
    });
  }

  // Keep only tuples whose segments satisfy OpenFGA's constraints. UUID-derived
  // ids always pass; this drops any tuple built from malformed data without
  // discarding the rest of the document's structural tuples.
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
 * which rows end up with no readable parent.
 */
export function summarize(rows, tuples) {
  const skipped = [];
  let externalFormMissingTemplate = 0;
  let noReadParent = 0;

  for (const row of rows) {
    const reason = rowSkipReason(row);
    if (reason !== null) {
      skipped.push({ documentId: row.document_id ?? "", reason });
      continue;
    }
    const contextType = row.context_type?.trim().toLowerCase();
    const hasNote = Boolean(row.note_id?.trim());
    const hasTemplate = Boolean(row.form_template_id?.trim());
    if (contextType === CONTEXT_EXTERNAL_FORM && !hasTemplate) {
      externalFormMissingTemplate++;
    }
    if (!hasNote && !(contextType === CONTEXT_EXTERNAL_FORM && hasTemplate)) {
      noReadParent++;
    }
  }

  const countWhere = (predicate) => tuples.filter(predicate).length;

  return {
    totalRows: rows.length,
    usableRows: rows.length - skipped.length,
    skipped,
    externalFormMissingTemplate,
    noReadParent,
    parentInstitutionOnDocument: countWhere(
      (t) =>
        t.relation === "parent_institution" && t.object.startsWith("document:"),
    ),
    parentNote: countWhere((t) => t.relation === "parent_note"),
    parentExternalFormSubmission: countWhere(
      (t) => t.relation === "parent_external_form_submission",
    ),
    parentInstitutionOnRecycleBinEntry: countWhere(
      (t) =>
        t.relation === "parent_institution" &&
        t.object.startsWith("recycle_bin_entry:"),
    ),
    parentDocument: countWhere((t) => t.relation === "parent_document"),
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
  const line = (label, value) => console.log(`  ${label.padEnd(52)}: ${value}`);
  line("Total rows in CSV", stats.totalRows);
  line("Usable rows", stats.usableRows);
  line("Skipped rows (see reasons below)", stats.skipped.length);
  line("parent_institution on document", stats.parentInstitutionOnDocument);
  line("parent_note on document", stats.parentNote);
  line(
    "parent_external_form_submission on document",
    stats.parentExternalFormSubmission,
  );
  line(
    "parent_institution on recycle_bin_entry",
    stats.parentInstitutionOnRecycleBinEntry,
  );
  line("parent_document on recycle_bin_entry", stats.parentDocument);
  line("Tuples before dedupe", rawTupleCount);
  line("Total tuples to write (after dedupe)", tupleCount);

  if (stats.noReadParent > 0) {
    console.log(
      `\nNote: ${stats.noReadParent} document(s) get parent_institution only — the model\n` +
        "  defines no read parent for entity / assessment / task / internal_form /\n" +
        "  bitsight contexts, so can_read stays false for them until it does.",
    );
  }
  if (stats.externalFormMissingTemplate > 0) {
    console.warn(
      `\nWarning: ${stats.externalFormMissingTemplate} external_form document(s) have no\n` +
        "  form_template_id, so no parent_external_form_submission tuple could be built\n" +
        "  and they will not be readable. Investigate before writing.",
    );
  }
  if (stats.skipped.length > 0) {
    console.warn(`\nSkipped ${stats.skipped.length} row(s):`);
    for (const { documentId, reason } of stats.skipped.slice(0, 20)) {
      console.warn(`  ${documentId || "(no document_id)"} — ${reason}`);
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
      "Error: OPENFGA_API_URL is not set",
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

  const rawTuples = rows.flatMap(rowToDocumentTuples);
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
    const failPath = path.resolve("migration-document-failures.json");
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
