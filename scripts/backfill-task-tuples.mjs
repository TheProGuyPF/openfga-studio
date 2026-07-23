#!/usr/bin/env node

/**
 * Migrates task rows from a CSV into structural OpenFGA tuples for the `task`
 * type (see tasks.fga). Per task it writes, as applicable:
 *   - (institution:X, parent_institution, task:T)                 — always
 *   - (task_type:TT, parent_task_type, task:T)                    — typed tasks
 *   - (institution:X, parent_institution, task_type:TT)          — typed tasks
 *   - (user:U,  task_assignee, task:T)                           — user-assigned
 *   - (team:TM#member, task_assignee, task:T)                    — team-assigned
 *
 * Writes go directly to the OpenFGA API (bypassing Kafka, so no audit events /
 * notifications are produced). Writes set `on_duplicate: ignore`, so existing
 * tuples are skipped without failing the batch — the script is idempotent and
 * safe to re-run. Identical tuples are also de-duplicated before writing (the
 * `parent_institution` tuple on a shared task_type repeats across every task of
 * that type).
 *
 * CSV must be RFC 4180 (quoted fields may contain commas and newlines); do not
 * use naive comma-splitting exports. Expected columns (header row required):
 *   task_id, institution_id, task_type_id, assigned_to_id, assigned_to_type
 *
 * IMPORTANT: `task_type_id` is the stable task-type UUID (the FGA object is
 * `task_type:{uuid}`). It is NOT the connector-defined `task_type` name string.
 * `assigned_to_type` is the DB enum value: `USER` or `TEAM` (case-insensitive).
 * Untyped/unassigned tasks simply leave the relevant columns empty.
 *
 * 
 * Usage:
 *   node scripts/migrate-task-tuples.mjs --csv <path> --model-id <id> [--dry-run] [--batch-size <n>]
 *
 * Examples:
 *   node scripts/migrate-task-tuples.mjs --csv path/to/tasks.csv --dry-run
 *   node scripts/migrate-task-tuples.mjs --csv path/to/tasks.csv --model-id <authorization-model-id>
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
// Map a CSV row to its OpenFGA structural tuples (or [] if required ids missing)
// ---------------------------------------------------------------------------

function rowToTaskTuples(row) {
  const taskId = row.task_id?.trim();
  const institutionId = row.institution_id?.trim();
  // Stable task-type UUID (FGA object `task_type:{uuid}`), NOT the `task_type`
  // name string. Empty for untyped tasks.
  const taskTypeId = row.task_type_id?.trim();
  const assignedToId = row.assigned_to_id?.trim();
  const assignedToType = row.assigned_to_type?.trim()?.toUpperCase();

  // task_id and institution_id are mandatory — every task gets a parent_institution.
  if (!taskId || !institutionId) return [];

  const objectTask = `task:${taskId}`;
  const userInstitution = `institution:${institutionId}`;
  const tuples = [];

  // Always: institution -> parent_institution -> task
  tuples.push({
    user: userInstitution,
    relation: "parent_institution",
    object: objectTask,
  });

  // Typed tasks: link the task to its type, and the type to its institution.
  if (taskTypeId) {
    const objectTaskType = `task_type:${taskTypeId}`;
    tuples.push({
      user: objectTaskType,
      relation: "parent_task_type",
      object: objectTask,
    });
    tuples.push({
      user: userInstitution,
      relation: "parent_institution",
      object: objectTaskType,
    });
  }

  // Assigned tasks: a user directly, or a team via the `team#member` userset.
  if (assignedToId && assignedToType) {
    let assigneeUser = null;
    if (assignedToType === "USER") {
      assigneeUser = `user:${assignedToId}`;
    } else if (assignedToType === "TEAM") {
      assigneeUser = `team:${assignedToId}#member`;
    }
    if (assigneeUser) {
      tuples.push({
        user: assigneeUser,
        relation: "task_assignee",
        object: objectTask,
      });
    }
  }

  // Keep only tuples whose segments satisfy OpenFGA's constraints. UUID-derived
  // ids always pass; this drops any tuple built from malformed/empty data
  // without discarding the rest of the task's structural tuples.
  return tuples.filter(
    (t) =>
      isValidOpenFgaTupleSegment(t.user) && isValidOpenFgaTupleSegment(t.object)
  );
}

/** De-duplicate identical (user, relation, object) tuples. */
function dedupeTuples(tuples) {
  const seen = new Set();
  const unique = [];
  for (const t of tuples) {
    const key = `${t.user}${t.relation}${t.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }
  return unique;
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

  const rawTuples = rows.flatMap(rowToTaskTuples);
  const tuples = dedupeTuples(rawTuples);

  const completeRows = rows.filter((row) => {
    const taskId = row.task_id?.trim();
    const institutionId = row.institution_id?.trim();
    return Boolean(taskId && institutionId);
  });
  const skipped = rows.length - completeRows.length;

  const byRelation = (relation) =>
    tuples.filter((t) => t.relation === relation);
  const parentInstitutionOnTask = tuples.filter(
    (t) => t.relation === "parent_institution" && t.object.startsWith("task:")
  ).length;
  const parentInstitutionOnTaskType = tuples.filter(
    (t) =>
      t.relation === "parent_institution" && t.object.startsWith("task_type:")
  ).length;
  const parentTaskType = byRelation("parent_task_type").length;
  const assigneeUser = tuples.filter(
    (t) => t.relation === "task_assignee" && t.user.startsWith("user:")
  ).length;
  const assigneeTeam = tuples.filter(
    (t) => t.relation === "task_assignee" && t.user.startsWith("team:")
  ).length;

  console.log(`  Complete rows (task_id + institution_id present): ${completeRows.length}`);
  console.log(`  Skipped (missing task_id or institution_id)      : ${skipped}`);
  console.log(`  parent_institution on task                       : ${parentInstitutionOnTask}`);
  console.log(`  parent_task_type on task                         : ${parentTaskType}`);
  console.log(`  parent_institution on task_type (deduped)        : ${parentInstitutionOnTaskType}`);
  console.log(`  task_assignee (user)                             : ${assigneeUser}`);
  console.log(`  task_assignee (team)                             : ${assigneeTeam}`);
  console.log(`  Tuples before dedupe                             : ${rawTuples.length}`);
  console.log(`  Total tuples to write (after dedupe)             : ${tuples.length}`);

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
    const failPath = path.resolve("migration-task-failures.json");
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2));
    console.error(`Failed batches saved to ${failPath}`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
