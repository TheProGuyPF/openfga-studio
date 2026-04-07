#!/usr/bin/env node

/**
 * Migrates assessment rows from a CSV into structural OpenFGA tuples:
 * `parent_template` and `parent_institution` on `assessment` (see assessments.fga).
 * Writes set `on_duplicate: ignore` so tuples that already exist are skipped without failing the batch.
 * CSV must be RFC 4180 (quoted fields may contain commas and newlines); do not use naive comma-splitting exports.
 *
 * Fetch the upstream model for reference (requires GitHub CLI auth):
 *   gh api repos/moodys-ma-platform/mx-authorization/contents/crates/openfga-http-migrator/src/authmodels/v1.1/assessments.fga --jq '.content' | base64 -d
 *
 * Usage:
 *   node scripts/migrate-assessment-tuples.mjs --csv <path> --model-id <id> [--dry-run] [--batch-size <n>]
 *
 * Examples:
 *   node scripts/migrate-assessment-tuples.mjs --csv path/to/assessments.csv --dry-run
 *   node scripts/migrate-assessment-tuples.mjs --csv path/to/assessments.csv --model-id <authorization-model-id>
 */

import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { parse } from "csv-parse/sync";

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
// CSV reader (RFC 4180: quoted fields, commas, newlines inside quotes)
// ---------------------------------------------------------------------------

function readCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

/** OpenFGA rejects TupleKey user/object if not ^[^\s]{2,256}$ */
function isValidOpenFgaTupleSegment(s) {
  return typeof s === "string" && /^[^\s]{2,256}$/.test(s);
}

// ---------------------------------------------------------------------------
// Map a CSV row to two OpenFGA tuples (or [] if required ids missing)
// ---------------------------------------------------------------------------

function rowToAssessmentTuples(row) {
  const id = row.id?.trim();
  const templateId = row.template_id?.trim();
  const institutionId = row.institution_id?.trim();
  if (!id || !templateId || !institutionId) return [];

  const userTemplate = `assessment_template:${templateId}`;
  const userInstitution = `institution:${institutionId}`;
  const objectAssessment = `assessment:${id}`;
  if (
    !isValidOpenFgaTupleSegment(userTemplate) ||
    !isValidOpenFgaTupleSegment(userInstitution) ||
    !isValidOpenFgaTupleSegment(objectAssessment)
  ) {
    return [];
  }

  return [
    {
      user: userTemplate,
      relation: "parent_template",
      object: objectAssessment,
    },
    {
      user: userInstitution,
      relation: "parent_institution",
      object: objectAssessment,
    },
  ];
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
        writes: {
          tuple_keys: batch,
          on_duplicate: "ignore",
        },
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
    console.error(
      "Error: --model-id <id> is required (unless using --dry-run)"
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

  if (!apiUrl) {
    console.error("Error: VITE_OPENFGA_API_URL not set in .env");
    process.exit(1);
  }
  if (!storeId && !args.dryRun) {
    console.error("Error: VITE_OPENFGA_STORE_ID not set in .env");
    process.exit(1);
  }

  const csvPath = path.resolve(args.csv);
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}`);
  const rows = readCsv(csvPath);
  console.log(`  Total rows in CSV: ${rows.length}`);

  const tuples = rows.flatMap(rowToAssessmentTuples);
  const completeRows = rows.filter((row) => {
    const id = row.id?.trim();
    const templateId = row.template_id?.trim();
    const institutionId = row.institution_id?.trim();
    return Boolean(id && templateId && institutionId);
  });
  const skipped = rows.length - completeRows.length;
  const skippedInvalidFormat =
    completeRows.length - tuples.length / 2;

  const parentTemplate = tuples.filter((t) => t.relation === "parent_template")
    .length;
  const parentInstitution = tuples.filter(
    (t) => t.relation === "parent_institution"
  ).length;

  console.log(`  Complete rows (all ids present): ${completeRows.length}`);
  console.log(`  Skipped (missing id, template_id, or institution_id): ${skipped}`);
  if (skippedInvalidFormat > 0) {
    console.log(
      `  Skipped (ids fail OpenFGA tuple string rules): ${skippedInvalidFormat}`
    );
  }
  console.log(`  parent_template tuples     : ${parentTemplate}`);
  console.log(`  parent_institution tuples  : ${parentInstitution}`);
  console.log(`  Total tuples               : ${tuples.length}`);

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
    const failPath = path.resolve("migration-assessment-failures.json");
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2));
    console.error(`Failed batches saved to ${failPath}`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
