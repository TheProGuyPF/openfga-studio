#!/usr/bin/env node

/**
 * Migrates an OpenFGA authorization model from a file into an OpenFGA store.
 *
 * Supported model formats:
 *   - JSON (.json) – raw OpenFGA authorization model JSON
 *   - DSL  (.fga)  – OpenFGA DSL syntax (auto-converted to JSON)
 *
 * Usage:
 *   node scripts/migrate-model.mjs --file <path> [--store-id <id>] [--create-store <name>] [--dry-run]
 *
 * Examples:
 *   # Write model to existing store (store ID from .env)
 *   node scripts/migrate-model.mjs --file model.json
 *
 *   # Write model to a specific store
 *   node scripts/migrate-model.mjs --file model.fga --store-id 01JXYZ...
 *
 *   # Create a new store and write the model into it
 *   node scripts/migrate-model.mjs --file model.fga --create-store "my-app-prod"
 *
 *   # Preview what would be sent without writing
 *   node scripts/migrate-model.mjs --file model.fga --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import axios from "axios";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    file: null,
    storeId: null,
    createStore: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--file":
        args.file = argv[++i];
        break;
      case "--store-id":
        args.storeId = argv[++i];
        break;
      case "--create-store":
        args.createStore = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        printUsage();
        process.exit(1);
    }
  }
  return args;
}

function printUsage() {
  console.log(`
Usage: node scripts/migrate-model.mjs --file <path> [options]

Options:
  --file <path>            Path to the model file (.json or .fga)
  --store-id <id>          Target store ID (overrides VITE_OPENFGA_STORE_ID from .env)
  --create-store <name>    Create a new store with this name and write the model into it
  --dry-run                Parse and display the model without writing
  --help, -h               Show this help message
`);
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
// DSL → JSON converter (ported from src/utils/modelConverter.ts)
// ---------------------------------------------------------------------------

function dslToJson(dsl) {
  const lines = dsl.trim().split("\n");
  const model = {
    schema_version: "1.1",
    type_definitions: [],
    conditions: {},
  };

  let currentType = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("model")) continue;
    if (trimmed.startsWith("schema")) {
      model.schema_version = trimmed.split(" ")[1];
      continue;
    }

    if (trimmed.startsWith("condition ")) {
      let conditionStr = trimmed;
      let i = idx + 1;
      while (i < lines.length && !lines[i].includes("}")) {
        conditionStr += "\n" + lines[i];
        i++;
      }
      if (i < lines.length) {
        conditionStr += "\n" + lines[i];
      }
      idx = i;
      const condition = parseCondition(conditionStr);
      model.conditions[condition.name] = condition;
      continue;
    }

    if (trimmed.startsWith("type ")) {
      if (currentType) {
        model.type_definitions.push(currentType);
      }
      currentType = {
        type: trimmed.split(" ")[1],
        relations: {},
        metadata: { relations: {} },
      };
    } else if (trimmed.startsWith("relations")) {
      // skip the "relations" keyword line
      continue;
    } else if (trimmed.startsWith("define ") && currentType) {
      const match = trimmed.match(/define\s+(\w+):\s+(.+)/);
      if (!match) continue;
      const [, relationName, definition] = match;

      const directTypes = parseDirectlyRelatedTypes(definition);
      let relationDef;

      if (directTypes.length > 0) {
        const remainingDef = definition.replace(/\[.*?\]/, "").trim();
        if (remainingDef.startsWith("or ")) {
          relationDef = {
            union: {
              child: [
                { this: {} },
                ...(parseRelationDefinition(remainingDef.slice(3)).union
                  ?.child || [parseRelationDefinition(remainingDef.slice(3))]),
              ],
            },
          };
        } else if (remainingDef.length === 0) {
          relationDef = { this: {} };
        } else {
          relationDef = {
            union: {
              child: [{ this: {} }, parseRelationDefinition(remainingDef)],
            },
          };
        }
      } else {
        relationDef = parseRelationDefinition(definition);
      }

      currentType.relations[relationName] = relationDef;
      if (directTypes.length > 0) {
        currentType.metadata.relations[relationName] = {
          directly_related_user_types: directTypes,
        };
      }
    }
  }

  if (currentType) {
    model.type_definitions.push(currentType);
  }

  if (Object.keys(model.conditions).length === 0) {
    delete model.conditions;
  }

  return model;
}

function parseRelationDefinition(definition) {
  const parts = definition.split(" or ").map((p) => p.trim());

  if (parts.length > 1) {
    return {
      union: {
        child: parts.map((part) => {
          if (part.startsWith("[")) return { this: {} };
          if (part.includes(" and ")) {
            const andParts = part.split(" and ").map((p) => p.trim());
            return {
              intersection: { child: andParts.map(parseSingleRelation) },
            };
          }
          return parseSingleRelation(part);
        }),
      },
    };
  }

  const single = parts[0];
  if (single.startsWith("[")) return { this: {} };
  if (single.includes(" and ")) {
    const andParts = single.split(" and ").map((p) => p.trim());
    return { intersection: { child: andParts.map(parseSingleRelation) } };
  }
  return parseSingleRelation(single);
}

function parseSingleRelation(part) {
  if (part.includes(" from ")) {
    const [relation, fromPart] = part.split(" from ").map((p) => p.trim());
    return {
      tupleToUserset: {
        tupleset: { relation: fromPart },
        computedUserset: { relation },
      },
    };
  }
  if (part.includes(" but not ")) {
    const [base, excluded] = part.split(" but not ").map((p) => p.trim());
    return {
      difference: {
        base: parseSingleRelation(base),
        subtract: parseSingleRelation(excluded),
      },
    };
  }
  return { computedUserset: { relation: part } };
}

function parseCondition(conditionStr) {
  const match = conditionStr.match(
    /condition\s+(\w+)\s*\((.*?)\)\s*\{([\s\S]*?)\}/
  );
  if (!match) {
    throw new Error(`Invalid condition format: ${conditionStr}`);
  }

  const [, name, params, expression] = match;
  const parameters = {};

  if (params.trim()) {
    for (const param of params.split(",")) {
      const parts = param.trim().split(":");
      if (parts.length !== 2) continue;
      const [pName, pType] = parts.map((p) => p.trim());
      parameters[pName] = {
        type_name: `TYPE_NAME_${pType.toUpperCase()}`,
      };
    }
  }

  return { name, expression: expression.trim(), parameters };
}

function parseDirectlyRelatedTypes(definition) {
  const match = definition.match(/\[(.*?)\]/);
  if (!match) return [];

  return match[1].split(",").map((t) => {
    const type = t.trim();
    if (type.includes("#")) {
      const [typeName, relation] = type.split("#").map((p) => p.trim());
      return { type: typeName, relation };
    }
    if (type.includes(":*")) {
      return { type: type.split(":")[0].trim(), wildcard: {} };
    }
    if (type.includes(" with ")) {
      const [baseType, condition] = type.split(" with ").map((p) => p.trim());
      return { type: baseType, condition };
    }
    return { type };
  });
}

// ---------------------------------------------------------------------------
// Model file reader
// ---------------------------------------------------------------------------

function readModelFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf-8");

  if (ext === ".json") {
    const parsed = JSON.parse(content);
    if (parsed.type_definitions) {
      return parsed;
    }
    if (parsed.authorization_model) {
      return parsed.authorization_model;
    }
    throw new Error(
      "JSON file must contain a valid OpenFGA model (with type_definitions)"
    );
  }

  if (ext === ".fga" || ext === ".dsl" || ext === ".openfga") {
    return dslToJson(content);
  }

  // Try to auto-detect: if content starts with '{', treat as JSON, otherwise DSL
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (parsed.type_definitions) return parsed;
    if (parsed.authorization_model) return parsed.authorization_model;
    throw new Error("JSON content does not contain a valid OpenFGA model");
  }

  return dslToJson(content);
}

// ---------------------------------------------------------------------------
// Pretty-print helpers
// ---------------------------------------------------------------------------

function summarizeModel(model) {
  const types = model.type_definitions || [];
  console.log(`  Schema version : ${model.schema_version}`);
  console.log(`  Type definitions: ${types.length}`);
  for (const td of types) {
    const relations = td.relations ? Object.keys(td.relations) : [];
    console.log(
      `    - ${td.type}${relations.length ? ` (relations: ${relations.join(", ")})` : ""}`
    );
  }
  const conditions = model.conditions ? Object.keys(model.conditions) : [];
  if (conditions.length > 0) {
    console.log(`  Conditions     : ${conditions.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (!args.file) {
    console.error("Error: --file <path> is required");
    printUsage();
    process.exit(1);
  }

  if (args.createStore && args.storeId) {
    console.error(
      "Error: --create-store and --store-id are mutually exclusive"
    );
    process.exit(1);
  }

  // --- Load env ---------------------------------------------------------------

  const envPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    ".env"
  );
  const env = loadEnv(envPath);

  const apiUrl = env.VITE_OPENFGA_API_URL;
  const token = env.VITE_OPENFGA_API_TOKEN || env.VITE_FGA_X2S_TOKEN;

  if (!apiUrl && !args.dryRun) {
    console.error("Error: VITE_OPENFGA_API_URL not set in .env");
    process.exit(1);
  }

  let storeId = args.storeId || env.VITE_OPENFGA_STORE_ID;

  if (!storeId && !args.createStore && !args.dryRun) {
    console.error(
      "Error: No store ID provided. Use --store-id, set VITE_OPENFGA_STORE_ID in .env, or use --create-store <name>"
    );
    process.exit(1);
  }

  // --- Read & parse model file ------------------------------------------------

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: Model file not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Reading model: ${filePath}`);
  let model;
  try {
    model = readModelFile(filePath);
  } catch (err) {
    console.error(`Error parsing model file: ${err.message}`);
    process.exit(1);
  }

  console.log("\nModel summary:");
  summarizeModel(model);

  // --- Dry-run ----------------------------------------------------------------

  if (args.dryRun) {
    console.log("\n--- DRY RUN ---");
    console.log("\nJSON payload that would be sent:\n");
    console.log(JSON.stringify(model, null, 2));
    console.log("\nNo changes were made. Remove --dry-run to execute.");
    return;
  }

  // --- API client -------------------------------------------------------------

  const api = axios.create({
    baseURL: apiUrl,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  // --- Optionally create store ------------------------------------------------

  if (args.createStore) {
    console.log(`\nCreating store "${args.createStore}" ...`);
    try {
      const res = await api.post("/stores", { name: args.createStore });
      storeId = res.data.id;
      console.log(`  Store created: ${storeId}`);
    } catch (err) {
      const msg =
        err.response?.data?.message || err.response?.data || err.message;
      console.error(`Failed to create store: ${JSON.stringify(msg)}`);
      process.exit(1);
    }
  }

  // --- Write authorization model ----------------------------------------------

  console.log(
    `\nWriting authorization model to store ${storeId} ...`
  );

  try {
    const res = await api.post(
      `/stores/${storeId}/authorization-models`,
      model
    );
    const modelId = res.data.authorization_model_id;
    console.log(`\nDone. Authorization model written successfully.`);
    console.log(`  Store ID : ${storeId}`);
    console.log(`  Model ID : ${modelId}`);
  } catch (err) {
    const msg =
      err.response?.data?.message || err.response?.data || err.message;
    console.error(
      `\nFailed to write authorization model: ${JSON.stringify(msg)}`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
