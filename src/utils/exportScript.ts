// "Export as script": emits a standalone .mjs that applies an embedded
// MigrationTemplate to a source CSV headlessly (CI parity with the in-app runner).
// The generated script depends only on csv-parse + axios (already vendored in this
// repo) and reads .env the same way the hand-written backfill scripts do. The
// transform logic is a faithful, dependency-free mirror of utils/migrationTransform.
import type { MigrationTemplate } from './migrationTransform';

// The transform + runner body is a static string so the generated output is
// deterministic (only the embedded TEMPLATE JSON varies) — see exportScript.test.ts.
const RUNNER_BODY = String.raw`
// --- CLI args --------------------------------------------------------------
function parseArgs(argv) {
  const args = { csv: null, modelId: null, dryRun: false, batchSize: 40 };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--csv": args.csv = argv[++i]; break;
      case "--model-id": args.modelId = argv[++i]; break;
      case "--dry-run": args.dryRun = true; break;
      case "--batch-size": args.batchSize = parseInt(argv[++i], 10); break;
      default: console.error("Unknown argument: " + argv[i]); process.exit(1);
    }
  }
  return args;
}

// --- .env loader (lightweight) --------------------------------------------
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  for (const raw of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return vars;
}

// --- Transform (mirror of utils/migrationTransform) ------------------------
function isValidSegment(s) { return typeof s === "string" && /^[^\s]{2,256}$/.test(s); }
function foldCase(v, mode) { return mode === "upper" ? v.toUpperCase() : mode === "lower" ? v.toLowerCase() : v; }
function cell(row, col) { const v = col ? row[col] : ""; return typeof v === "string" ? v.trim() : ""; }
function enumLookup(map, value, ci) {
  if (!ci) return map[value];
  const n = value.toLowerCase();
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === n) return v;
  return undefined;
}
function resolveSegment(seg, row) {
  let type = seg.type, userset = seg.usersetRelation;
  if (seg.enum) {
    const match = enumLookup(seg.enum.map, cell(row, seg.enum.column), seg.enum.caseInsensitive);
    if (!match) return { value: null };
    type = match.type; userset = match.usersetRelation ?? seg.usersetRelation;
  }
  const id = foldCase(cell(row, seg.column), seg.caseFold);
  let value = type ? type + ":" + id : id;
  if (userset) value += "#" + userset;
  return { value };
}
function resolveRelation(rel, row) {
  if (rel.constant !== undefined) return { value: rel.constant };
  if (rel.enum) {
    const match = enumLookup(rel.enum.map, cell(row, rel.enum.column), rel.enum.caseInsensitive);
    if (match !== undefined) return { value: match };
    if (rel.enum.default !== undefined) return { value: rel.enum.default };
    return { value: null };
  }
  return { value: null };
}
function rowPasses(row, filters) {
  for (const f of filters) {
    const raw = cell(row, f.column);
    const value = f.caseInsensitive ? raw.toLowerCase() : raw;
    const set = f.caseInsensitive ? f.truthyValues.map((v) => v.toLowerCase()) : f.truthyValues;
    const truthy = set.includes(value);
    if (f.mode === "include" && !truthy) return false;
    if (f.mode === "exclude" && truthy) return false;
  }
  return true;
}
function firstMissing(row, cols) { for (const c of cols) if (!cell(row, c)) return c; return null; }
function transformRow(row, t) {
  if (!rowPasses(row, t.rowFilters)) return [];
  if (firstMissing(row, t.requiredColumns)) return [];
  const tuples = [];
  let invalid = false;
  for (const rule of t.rules) {
    if (firstMissing(row, rule.whenColumnsPresent)) continue;
    const user = resolveSegment(rule.user, row);
    const object = resolveSegment(rule.object, row);
    const relation = resolveRelation(rule.relation, row);
    if (user.value === null || object.value === null || relation.value === null) continue;
    const tuple = { user: user.value, relation: relation.value, object: object.value };
    if (!isValidSegment(tuple.user) || !isValidSegment(tuple.object)) { invalid = true; continue; }
    tuples.push(tuple);
  }
  if (t.validationMode === "drop-row" && invalid) return [];
  return tuples;
}
function transform(rows, t) {
  const all = rows.flatMap((r) => transformRow(r, t));
  if (!t.dedupe) return all;
  const seen = new Set(), out = [];
  for (const x of all) {
    const k = x.user + "|" + x.relation + "|" + x.object;
    if (seen.has(k)) continue;
    seen.add(k); out.push(x);
  }
  return out;
}

// --- Batch writer ----------------------------------------------------------
function chunk(arr, size) { const c = []; for (let i = 0; i < arr.length; i += size) c.push(arr.slice(i, i + size)); return c; }
async function writeBatches(api, storeId, modelId, tuples, batchSize) {
  const batches = chunk(tuples, batchSize);
  let written = 0; const failures = [];
  for (let i = 0; i < batches.length; i++) {
    try {
      await api.post("/stores/" + storeId + "/write", {
        writes: { tuple_keys: batches[i], on_duplicate: "ignore" },
        authorization_model_id: modelId,
      });
      written += batches[i].length;
      console.log("  Batch " + (i + 1) + "/" + batches.length + " written (" + written + "/" + tuples.length + ")");
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data || err.message;
      console.error("  Batch " + (i + 1) + " FAILED: " + JSON.stringify(msg));
      failures.push({ batchIndex: i + 1, tuples: batches[i], error: msg });
    }
    if (i < batches.length - 1) await new Promise((r) => setTimeout(r, 200));
  }
  return { written, failures };
}

// --- Main ------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (!args.csv) { console.error("Error: --csv <path> is required"); process.exit(1); }
  if (!args.modelId && !args.dryRun) { console.error("Error: --model-id <id> is required (unless --dry-run)"); process.exit(1); }

  const envPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".env");
  const env = loadEnv(envPath);
  const apiUrl = env.VITE_OPENFGA_API_URL;
  const storeId = env.VITE_OPENFGA_STORE_ID;
  const token = env.VITE_OPENFGA_API_TOKEN || env.VITE_FGA_X2S_TOKEN;
  if (!apiUrl) { console.error("Error: VITE_OPENFGA_API_URL not set in .env"); process.exit(1); }
  if (!storeId && !args.dryRun) { console.error("Error: VITE_OPENFGA_STORE_ID not set in .env"); process.exit(1); }

  const rows = parse(fs.readFileSync(path.resolve(args.csv), "utf-8"), {
    columns: true, skip_empty_lines: true, trim: true, bom: true,
  });
  console.log("Rows in CSV: " + rows.length);
  const tuples = transform(rows, TEMPLATE);
  console.log("Tuples to write: " + tuples.length);

  if (args.dryRun) {
    console.log("\n--- DRY RUN (first 20) ---");
    tuples.slice(0, 20).forEach((t, i) => console.log("  " + (i + 1) + ". " + t.user + "  " + t.relation + "  " + t.object));
    console.log("\nNo tuples written. Remove --dry-run to execute.");
    return;
  }

  const api = axios.create({
    baseURL: apiUrl,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
  });
  console.log("\nWriting " + tuples.length + " tuples to store " + storeId + " ...");
  const { written, failures } = await writeBatches(api, storeId, args.modelId, tuples, args.batchSize);
  console.log("\nDone. " + written + " tuples written.");
  if (failures.length) {
    const failPath = path.resolve("migration-failures.json");
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2));
    console.error(failures.length + " batch(es) failed. Saved to " + failPath);
  }
}

main().catch((err) => { console.error("Unexpected error:", err); process.exit(1); });
`;

/** Generate a standalone headless .mjs that applies `template` to a CSV. */
export function exportAsScript(template: MigrationTemplate): string {
  const header = `#!/usr/bin/env node
/**
 * Auto-generated by OpenFGA Studio — Migrate tab, "Export as script".
 * Standalone headless runner: applies the embedded MigrationTemplate to a source
 * CSV and writes the resulting structural tuples (on_duplicate:ignore, idempotent).
 * Bypasses Kafka/audit events — same caveat as the in-app runner and the original
 * backfill scripts.
 *
 * Usage:
 *   node ${slugify(template.name)}.mjs --csv <path> --model-id <id> [--dry-run] [--batch-size 40]
 */
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { parse } from "csv-parse/sync";

const TEMPLATE = ${JSON.stringify(template, null, 2)};
`;
  return header + RUNNER_BODY;
}

/** Filesystem-safe slug for the download filename. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'migration'
  );
}
