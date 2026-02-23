#!/usr/bin/env node

/**
 * Migrates user-institution rows from a CSV file into OpenFGA relationship tuples.
 *
 * Usage:
 *   node scripts/migrate-tuples.mjs --csv <path> --model-id <id> [--dry-run] [--batch-size <n>]
 * 
 * Examples:
 *   # Preview the tuples without writing anything
 *   node scripts/migrate-tuples.mjs --csv path/to/your-data.csv --dry-run
 *
 *   # Execute the migration
 *   node scripts/migrate-tuples.mjs --csv path/to/your-data.csv --model-id <your-authorization-model-id>
 *
 *   # With a custom batch size
 *   node scripts/migrate-tuples.mjs --csv path/to/your-data.csv --model-id <id> --batch-size 50
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import axios from "axios";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { csv: null, modelId: null, dryRun: false, batchSize: 100 };
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
        args.batchSize = parseInt(argv[++i], 10);
        break;
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

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    vars[key] = value;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// CSV reader – streams line-by-line to keep memory low
// ---------------------------------------------------------------------------

async function readCsv(filePath) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, "utf-8"),
    crlfDelay: Infinity,
  });

  let headers = null;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(",").map((c) => c.trim());
    if (!headers) {
      headers = cols;
      continue;
    }
    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cols[i];
    }
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Map a CSV row to an OpenFGA tuple (or null to skip)
// ---------------------------------------------------------------------------

function rowToTuple(row) {
  const isActive = row.is_active?.toUpperCase() === "TRUE";
  if (!isActive) return null;

  const isAdmin = row.admin?.toUpperCase() === "TRUE";
  return {
    user: `user:${row.id}`,
    relation: isAdmin ? "admin" : "member",
    object: `institution:${row.institution_id}`,
  };
}

// ---------------------------------------------------------------------------
// Batch writer
// ---------------------------------------------------------------------------

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

const BATCH_DELAY_MS = 200;

async function writeBatches(api, storeId, modelId, tuples, batchSize) {
  const batches = chunk(tuples, batchSize);
  const totalBatches = batches.length;
  let written = 0;
  const failures = [];

  for (let i = 0; i < totalBatches; i++) {
    const batch = batches[i];
    try {
      await api.post(`/stores/${storeId}/write`, {
        writes: { tuple_keys: batch },
        authorization_model_id: modelId,
      });
      written += batch.length;
      console.log(
        `  Batch ${i + 1}/${totalBatches} written  (${written}/${tuples.length} tuples)`
      );
    } catch (err) {
      const msg =
        err.response?.data?.message || err.response?.data || err.message;
      console.error(
        `  Batch ${i + 1}/${totalBatches} FAILED: ${JSON.stringify(msg)}`
      );
      failures.push({ batchIndex: i + 1, tuples: batch, error: msg });
    }

    if (i < totalBatches - 1) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return { written, failures };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

  const envPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    ".env"
  );
  const env = loadEnv(envPath);

  const apiUrl = env.VITE_OPENFGA_API_URL;
  const storeId = env.VITE_OPENFGA_STORE_ID;
  const token = env.VITE_OPENFGA_API_TOKEN || env.VITE_FGA_X2S_TOKEN;

  if (!apiUrl) {
    console.error("Error: VITE_OPENFGA_API_URL not set in .env");
    process.exit(1);
  }
  if (!storeId && !args.dryRun) {
    console.error("Error: VITE_OPENFGA_STORE_ID not set in .env");
    process.exit(1);
  }

  // --- Read & transform CSV ---------------------------------------------------

  const csvPath = path.resolve(args.csv);
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}`);
  const rows = await readCsv(csvPath);
  console.log(`  Total rows in CSV: ${rows.length}`);

  const tuples = rows.map(rowToTuple).filter(Boolean);
  const skipped = rows.length - tuples.length;
  const admins = tuples.filter((t) => t.relation === "admin").length;
  const members = tuples.filter((t) => t.relation === "member").length;

  console.log(`  Active rows  : ${tuples.length}`);
  console.log(`  Skipped (inactive): ${skipped}`);
  console.log(`  Admin tuples : ${admins}`);
  console.log(`  Member tuples: ${members}`);

  // --- Dry-run ----------------------------------------------------------------

  if (args.dryRun) {
    console.log("\n--- DRY RUN (first 20 tuples) ---");
    tuples.slice(0, 20).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.user}  ${t.relation}  ${t.object}`);
    });
    if (tuples.length > 20) {
      console.log(`  ... and ${tuples.length - 20} more`);
    }
    console.log("\nNo tuples were written. Remove --dry-run to execute.");
    return;
  }

  // --- Write ------------------------------------------------------------------

  const api = axios.create({
    baseURL: apiUrl,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  console.log(`\nWriting ${tuples.length} tuples to store ${storeId} ...`);
  const { written, failures } = await writeBatches(
    api,
    storeId,
    args.modelId,
    tuples,
    args.batchSize
  );

  console.log(`\nDone. ${written} tuples written successfully.`);
  if (failures.length > 0) {
    console.error(`${failures.length} batch(es) failed.`);
    const failPath = path.resolve("migration-failures.json");
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2));
    console.error(`Failed batches saved to ${failPath}`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
