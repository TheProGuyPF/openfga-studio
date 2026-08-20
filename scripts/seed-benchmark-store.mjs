#!/usr/bin/env node

/**
 * Seeds a dedicated, isolated benchmark store for OpenFGA Studio's Benchmark tab.
 *
 * It creates-or-reuses a store named `openfga-studio-benchmark` in a NON-PROD env,
 * applies the same authorization model that's deployed there (copied from a real
 * source store, or from a JSON file), and writes a fixed, deterministic "deep
 * chain" of tuples so a known probe user (`user:__bench_probe`) resolves `allowed`
 * through progressively deeper model paths:
 *
 *   institution.admin            (direct)
 *   team.can_read                (1 TTU hop)
 *   task.can_read                (TTU + task_type)
 *   assessment.can_read          (assessment → template → template_group)
 *   document.can_read            (intersection + parent_note chain)
 *   recycle_bin_entry.can_read   (recycle_bin → document → note → assessment → institution)
 *
 * The fixed IDs/tuples below MUST match src/components/BenchmarkTab/seedData.ts
 * (the shared source of truth the in-app "Seed benchmark store" button uses).
 *
 * SAFETY: refuses to run against a `prod`-tier env (xus/xeu). Writes go to an
 * isolated benchmark store only — never to real data. Writes use
 * `on_duplicate: ignore`, so the script is idempotent and safe to re-run.
 *
 * AUTH: this script cannot mint an X2S token (that happens server-side in the app
 * proxy). Provide a pre-minted bearer token via --token or the BENCH_API_TOKEN /
 * VITE_OPENFGA_API_TOKEN env var.
 *
 * Usage:
 *   node scripts/seed-benchmark-store.mjs --env npe-xus --source-store <id> [--dry-run]
 *   node scripts/seed-benchmark-store.mjs --env npe-xus --model-json path/to/authmodel.json
 *   node scripts/seed-benchmark-store.mjs --env npe-xus --teardown [--delete-store]
 *
 * Options:
 *   --env <key>          npe-xus | can-us   (prod keys are rejected)
 *   --source-store <id>  copy the latest auth model from this real store
 *   --model-json <path>  fallback: write the model from a JSON file
 *   --token <bearer>     pre-minted OpenFGA bearer token
 *   --store-name <name>  override the benchmark store name
 *   --scale <name>       dataset size: minimal | medium | large (default minimal)
 *   --batch-size <n>     tuples per write batch (default 100)
 *   --teardown           delete the seeded tuples instead of writing them
 *   --delete-store       with --teardown, also delete the benchmark store
 *   --dry-run            print what would happen; write nothing
 */

import fs from "node:fs";
import path from "node:path";
import axios from "axios";

// ---------------------------------------------------------------------------
// Env registry (mirrors src/environments.ts — non-prod keys only are runnable)
// ---------------------------------------------------------------------------

const ENV_META = {
  "npe-xus": { suffix: "NPE_XUS", tier: "nonprod", defaultUrl: "https://openfga-mx.npe.moodys.cloud" },
  "can-us": { suffix: "CAN_US", tier: "canary", defaultUrl: "" },
  xus: { suffix: "XUS", tier: "prod", defaultUrl: "" },
  xeu: { suffix: "XEU", tier: "prod", defaultUrl: "" },
};

const DEFAULT_STORE_NAME = "openfga-studio-benchmark";

// ---------------------------------------------------------------------------
// Fixed seed IDs — keep in sync with src/components/BenchmarkTab/presets.ts
// ---------------------------------------------------------------------------

const PROBE = "user:__bench_probe";
const ID = {
  institution: "institution:__bench",
  team: "team:__bench_team",
  taskType: "task_type:__bench_tt",
  task: "task:__bench_task",
  group: "assessment_template_group:__bench_g",
  template: "assessment_template:__bench_t",
  assessment: "assessment:__bench_a",
  note: "note:__bench_note",
  document: "document:__bench_doc",
  recycleBin: "recycle_bin_entry:__bench_rb",
};

const INSTITUTION_GRANTS = [
  "admin", "team_reader", "task_reader", "note_reader", "document_reader", "recycle_bin_reader",
];
// `admin` is `[user]` only — not grantable to a role#assignee userset (400).
const ROLE_GRANTS = INSTITUTION_GRANTS.filter((r) => r !== "admin");

// Scale presets — keep in sync with src/components/BenchmarkTab/seedData.ts
const SCALE_PRESETS = {
  minimal: { roles: 0, assigneesPerRole: 0, members: 0, objects: 0 },
  medium: { roles: 15, assigneesPerRole: 25, members: 200, objects: 50 },
  large: { roles: 60, assigneesPerRole: 50, members: 1500, objects: 300 },
};

/** Base deep-chain tuples (Minimal). Order is irrelevant (batched writes). */
function baseTuples() {
  return [
    ...INSTITUTION_GRANTS.map((relation) => ({ user: PROBE, relation, object: ID.institution })),

    { user: ID.institution, relation: "parent_institution", object: ID.team },
    { user: ID.institution, relation: "parent_institution", object: ID.taskType },
    { user: ID.institution, relation: "parent_institution", object: ID.task },
    { user: ID.institution, relation: "parent_institution", object: ID.group },
    { user: ID.institution, relation: "parent_institution", object: ID.template },
    { user: ID.institution, relation: "parent_institution", object: ID.assessment },
    { user: ID.institution, relation: "parent_institution", object: ID.note },
    { user: ID.institution, relation: "parent_institution", object: ID.document },
    { user: ID.institution, relation: "parent_institution", object: ID.recycleBin },

    { user: ID.taskType, relation: "parent_task_type", object: ID.task },
    { user: ID.group, relation: "parent_template_group", object: ID.template },
    { user: ID.template, relation: "parent_template", object: ID.assessment },
    { user: ID.assessment, relation: "parent_assessment", object: ID.note },
    { user: ID.note, relation: "parent_note", object: ID.document },
    { user: ID.document, relation: "parent_document", object: ID.recycleBin },

    { user: PROBE, relation: "reader", object: ID.group },
  ];
}

/** Base chain plus additive cardinality for the given scale params. */
function buildSeedTuples(p) {
  const tuples = baseTuples();
  for (let r = 0; r < p.roles; r++) {
    const role = `role:__bench_role_${r}`;
    tuples.push({ user: ID.institution, relation: "parent_institution", object: role });
    for (const relation of ROLE_GRANTS) {
      tuples.push({ user: `${role}#assignee`, relation, object: ID.institution });
    }
    tuples.push({ user: `${role}#assignee`, relation: "reader", object: ID.group });
    tuples.push({ user: PROBE, relation: "assignee", object: role });
    for (let a = 0; a < p.assigneesPerRole; a++) {
      tuples.push({ user: `user:__bench_ru${r}_${a}`, relation: "assignee", object: role });
    }
  }
  if (p.members > 0) {
    tuples.push({ user: `${ID.team}#member`, relation: "reader", object: ID.assessment });
    tuples.push({ user: PROBE, relation: "member", object: ID.team });
    for (let m = 0; m < p.members; m++) {
      tuples.push({ user: `user:__bench_m${m}`, relation: "member", object: ID.team });
    }
  }
  for (let j = 0; j < p.objects; j++) {
    const doc = `document:__bench_doc_${j}`;
    tuples.push({ user: ID.institution, relation: "parent_institution", object: doc });
    tuples.push({ user: ID.note, relation: "parent_note", object: doc });
    const asmt = `assessment:__bench_a_${j}`;
    tuples.push({ user: ID.institution, relation: "parent_institution", object: asmt });
    tuples.push({ user: ID.template, relation: "parent_template", object: asmt });
  }
  return tuples;
}

// ---------------------------------------------------------------------------
// CLI + .env
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    env: null, sourceStore: null, modelJson: null, token: null,
    storeName: DEFAULT_STORE_NAME, batchSize: 100, scale: "minimal",
    teardown: false, deleteStore: false, dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--env": args.env = argv[++i]; break;
      case "--source-store": args.sourceStore = argv[++i]; break;
      case "--model-json": args.modelJson = argv[++i]; break;
      case "--token": args.token = argv[++i]; break;
      case "--store-name": args.storeName = argv[++i]; break;
      case "--batch-size": args.batchSize = parseInt(argv[++i], 10); break;
      case "--scale": args.scale = argv[++i]; break;
      case "--teardown": args.teardown = true; break;
      case "--delete-store": args.deleteStore = true; break;
      case "--dry-run": args.dryRun = true; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

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

// ---------------------------------------------------------------------------
// OpenFGA helpers
// ---------------------------------------------------------------------------

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function findOrCreateStore(api, name, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] Would find-or-create store "${name}"`);
    return "<dry-run-store-id>";
  }
  const { data } = await api.get("/stores");
  const existing = (data.stores || []).find((s) => s.name === name);
  if (existing) {
    console.log(`Reusing store "${name}" (${existing.id})`);
    return existing.id;
  }
  if (dryRun) {
    console.log(`[dry-run] Would create store "${name}"`);
    return "<dry-run-store-id>";
  }
  const created = await api.post("/stores", { name });
  console.log(`Created store "${name}" (${created.data.id})`);
  return created.data.id;
}

async function copyModelFromSource(api, sourceStoreId) {
  const list = await api.get(`/stores/${sourceStoreId}/authorization-models`);
  const models = list.data.authorization_models || [];
  if (models.length === 0) throw new Error(`Source store ${sourceStoreId} has no authorization models`);
  const latest = models[0]; // OpenFGA returns newest first
  return { schema_version: latest.schema_version, type_definitions: latest.type_definitions, conditions: latest.conditions };
}

function readModelJson(p) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(p), "utf-8"));
  const m = raw.authorization_model || raw;
  return { schema_version: m.schema_version, type_definitions: m.type_definitions, conditions: m.conditions };
}

async function applyModel(api, storeId, model, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] Would write model (${model.type_definitions?.length ?? "?"} types)`);
    return "<dry-run-model-id>";
  }
  const res = await api.post(`/stores/${storeId}/authorization-models`, model);
  console.log(`Wrote authorization model ${res.data.authorization_model_id}`);
  return res.data.authorization_model_id;
}

async function writeTupleBatches(api, storeId, modelId, tuples, batchSize) {
  const batches = chunk(tuples, batchSize);
  let written = 0;
  for (let i = 0; i < batches.length; i++) {
    await api.post(`/stores/${storeId}/write`, {
      writes: { tuple_keys: batches[i], on_duplicate: "ignore" },
      authorization_model_id: modelId,
    });
    written += batches[i].length;
    console.log(`  wrote batch ${i + 1}/${batches.length} (${written}/${tuples.length})`);
  }
  return written;
}

async function deleteTupleBatches(api, storeId, modelId, tuples, batchSize) {
  const batches = chunk(tuples, batchSize);
  let deleted = 0;
  for (let i = 0; i < batches.length; i++) {
    try {
      await api.post(`/stores/${storeId}/write`, {
        deletes: { tuple_keys: batches[i] },
        authorization_model_id: modelId,
      });
      deleted += batches[i].length;
      console.log(`  deleted batch ${i + 1}/${batches.length}`);
    } catch (err) {
      // Deleting a non-existent tuple errors — tolerate it so teardown is idempotent.
      console.warn(`  batch ${i + 1}: ${err.response?.data?.message || err.message} (continuing)`);
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const meta = ENV_META[args.env];
  if (!meta) {
    console.error(`Error: --env must be one of: ${Object.keys(ENV_META).join(", ")}`);
    process.exit(1);
  }
  if (meta.tier === "prod") {
    console.error(`Refusing to seed a benchmark store in a PROD environment (${args.env}).`);
    process.exit(1);
  }

  const dotenv = loadEnv(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ".env"));
  const apiUrl = dotenv[`VITE_OPENFGA_API_URL_${meta.suffix}`] || meta.defaultUrl;
  const token = args.token || process.env.BENCH_API_TOKEN || dotenv.VITE_OPENFGA_API_TOKEN || dotenv.BENCH_API_TOKEN;

  if (!apiUrl) {
    console.error(`Error: no API URL for ${args.env} (set VITE_OPENFGA_API_URL_${meta.suffix} in .env)`);
    process.exit(1);
  }
  if (!token && !args.dryRun) {
    console.error("Error: no bearer token. Pass --token, or set BENCH_API_TOKEN / VITE_OPENFGA_API_TOKEN.");
    process.exit(1);
  }
  if (!args.teardown && !args.sourceStore && !args.modelJson && !args.dryRun) {
    console.error("Error: provide --source-store <id> or --model-json <path> to apply the model.");
    process.exit(1);
  }

  console.log(`Env: ${args.env} (${meta.tier})   API: ${apiUrl}`);
  const api = axios.create({
    baseURL: apiUrl,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  const scaleParams = SCALE_PRESETS[args.scale];
  if (!scaleParams) {
    console.error(`Error: --scale must be one of: ${Object.keys(SCALE_PRESETS).join(", ")}`);
    process.exit(1);
  }
  const tuples = buildSeedTuples(scaleParams);
  console.log(`Scale: ${args.scale} (${tuples.length} tuples)`);
  const storeId = await findOrCreateStore(api, args.storeName, args.dryRun);

  if (args.teardown) {
    console.log(`\nTearing down ${tuples.length} seeded tuples from ${storeId} ...`);
    if (args.dryRun) {
      console.log("[dry-run] Would delete seeded tuples" + (args.deleteStore ? " and the store." : "."));
      return;
    }
    // Teardown needs a model id for the write endpoint; use the store's latest.
    const models = await api.get(`/stores/${storeId}/authorization-models`);
    const modelId = models.data.authorization_models?.[0]?.id;
    await deleteTupleBatches(api, storeId, modelId, tuples, args.batchSize);
    if (args.deleteStore) {
      await api.delete(`/stores/${storeId}`);
      console.log(`Deleted store ${storeId}`);
    }
    console.log("Teardown complete.");
    return;
  }

  if (args.dryRun) {
    const modelSrc = args.sourceStore
      ? `copied from source store ${args.sourceStore}`
      : args.modelJson
        ? `from ${args.modelJson}`
        : "(none)";
    console.log(`\n[dry-run] Would apply model ${modelSrc} and write ${tuples.length} tuples (first 25):`);
    tuples.slice(0, 25).forEach((t, i) => console.log(`  ${i + 1}. ${t.user}  ${t.relation}  ${t.object}`));
    if (tuples.length > 25) console.log(`  … and ${tuples.length - 25} more`);
    console.log("\nNo changes made. Remove --dry-run to execute.");
    return;
  }

  const model = args.sourceStore
    ? await copyModelFromSource(api, args.sourceStore)
    : readModelJson(args.modelJson);

  const modelId = await applyModel(api, storeId, model, false);
  console.log(`\nWriting ${tuples.length} seed tuples ...`);
  const written = await writeTupleBatches(api, storeId, modelId, tuples, args.batchSize);
  console.log(`\nDone. Store ${storeId}, model ${modelId}, ${written} tuples.`);
  console.log("Point the Benchmark tab at this store to run the depth ladder.");
}

main().catch((err) => {
  console.error("Unexpected error:", err.response?.data || err.message);
  process.exit(1);
});
