# OpenFGA Studio

A web UI for **designing, visualising, testing, and operating [OpenFGA](https://openfga.dev) authorization models**. OpenFGA Studio gives you a model editor with live validation, an interactive relationship graph, access-check tooling that shows *why* a decision was made, latency benchmarking, and multi-environment connection management — all in the browser.

Built with React 19, TypeScript, Vite, Material UI, React Flow, and the OpenFGA HTTP API.

![OpenFGA Studio — dark mode](screenshots/0-screenshot.png)
![OpenFGA Studio — light mode](screenshots/0-screenshot-light-mode.png)

> Some screenshots predate the latest model-graph and resolution-path redesigns; the workflows they show are otherwise current.

---

## Contents
- [What you can do](#what-you-can-do)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration & environments](#configuration--environments)
- [Running with Docker](#running-with-docker)
- [Data migration scripts](#data-migration-scripts)
- [Project structure](#project-structure)
- [Development & testing](#development--testing)
- [License & credits](#license--credits)

---

## What you can do

The app is organised into tabs, all scoped to the currently selected **environment** and **store**.

### Authorization Model
- **Monaco editor** for the model in DSL or JSON, with live parsing/validation and inline errors.
- **Read-only by default for live-store models** — click **Unlock to edit**; saving prompts a **confirmation dialog** showing the target store, environment, tier, and a change summary. Unlock re-locks when you switch store/environment.
- **Interactive, force-directed graph** of the model:
  - Type and relation nodes; directly-assignable types render as **chips** on the relation (no shared-`user` hub clutter); edges show computed usersets, `X from Y` (tuple-to-userset), and direct references.
  - **Click-to-focus** (highlight a node's neighbourhood), **search**, hover tooltips, **minimap**, an **outline sidebar**, **collapsible type groups** (collapsed by default for large models), a **re-arrange** control, and PNG export.
- **Weighted-graph mode** — static performance insight inspired by [`openfga/model-visualizer`](https://github.com/openfga/model-visualizer): per-terminal-type worst-case weights (a direct assignment costs 1, each userset/tuple-to-userset hop adds 1, `or`/`and`/`but not` take the max, recursion is ∞), a colour scale, a per-type selector, and a "heaviest relations" table to spot hotspots.

### Tuples
- Add relationship tuples in **assisted** mode (model-driven type/relation/object pickers, condition parameters) or **freeform** mode (raw tuple / JSON condition).
- Browse existing tuples with pagination and delete with confirmation.

### Query (Validate Access)
- Run **checks** (`is user:X related to object:Y as relation?`) via a form or natural-language/JSON freeform input.
- **Resolution-path visualiser** — because OpenFGA's Check returns only a boolean, the app reconstructs *why*: it walks the model's rewrite tree, using batched checks for same-object branches and tuple reads to traverse `X from Y` edges. View it as a **playground-style tree diagram** or an **indented list**, toggle between the **ACL path** (minimal satisfying path) and the **full tree**, search nodes, and see **allowed *and* denied** explanations. Results are cached briefly with a "Cached" badge and a Refresh to re-run live.
- Persistent, per-store **check history** with replay.

### Lookup
- **List objects** a user can access (effective access) and **read** direct tuples, with persistent history.

### Benchmark
- Measure check / list-objects **latency** (cold vs warm cache), seed a benchmark store, and view results — useful for spotting the network-vs-model cost split.

### Across the app
- **Multi-environment switching** with tier-aware guards (non-prod / canary / production): a persistent banner and confirm-on-switch for guarded tiers.
- **Connection details** popover with a **live server-health** indicator (`/healthz`), plus store/model IDs.
- A passive **latency monitor**, deep-linkable tabs (`?tab=…`, `?store=…`), and dark/light themes.

---

## Tech stack

| Area | Choice |
|------|--------|
| UI | React 19 + TypeScript, Material UI 7 (+ Emotion) |
| Build/dev | Vite 6 |
| Editor | Monaco (`@monaco-editor/react`) |
| Graphs | React Flow + `d3-force` |
| Charts | Recharts |
| Model parsing | `@openfga/syntax-transformer` (DSL ⇄ JSON) |
| API | OpenFGA HTTP API via Axios |
| Tests | Vitest |

---

## Getting started

### Prerequisites
- **Node.js 20+** (CI builds on Node 24).
- Access to an **OpenFGA server** — either a local instance or a configured environment (see below).

> If your organisation installs npm packages from a private registry, make sure your registry auth is current before `npm install` (a stale token typically shows up as `E401`).

### Install & run (local dev)
```bash
npm install

# copy the env template and fill in at least the default (NPE-XUS) environment
cp .env.example .env

npm run dev          # Vite dev server on http://localhost:5173
```

### Point the default environment at a local OpenFGA
Run an OpenFGA server locally:
```bash
# see https://github.com/openfga/openfga/releases
./openfga run --http-addr 0.0.0.0:8080 --grpc-addr 0.0.0.0:8081
```
Then set the default environment's API URL in `.env`:
```bash
VITE_OPENFGA_API_URL_NPE_XUS=http://localhost:8080
```
Reload the dev server and pick **NPE-XUS** in the environment selector.

### Other scripts
```bash
npm run build        # type-check (tsc -b) + production build to dist/
npm run preview      # serve the production build locally
npm run lint         # ESLint
npm test             # Vitest (parser, weight algorithm, resolution engine)
```

---

## Configuration & environments

OpenFGA Studio ships with several **named environments** you switch between from the UI (defined in [`src/environments.ts`](src/environments.ts)), each tagged with a **tier**: `nonprod`, `canary`, or `prod`. Guarded tiers (canary/prod) get a persistent banner, confirm-on-switch, and the read-only-until-unlocked model editor.

Configuration lives in `.env` (git-ignored; see [`.env.example`](.env.example) for the full template). Each environment has two kinds of values:

- **Non-secret** (`VITE_*`, inlined into the client bundle at build time):
  - `VITE_OPENFGA_API_URL_<ENV>` — the OpenFGA HTTP API base URL
  - `VITE_OPENFGA_STORE_ID_<ENV>` — the default store for that environment
  - `VITE_TOKEN_SERVICE_AUDIENCE_<ENV>` — token audience
- **Secret** (non-`VITE_`, read **only** by the server-side proxy and **never** shipped to the browser):
  - `TOKEN_SERVICE_URL_<ENV>` and `FGA_X2S_TOKEN_<ENV>`

`<ENV>` is one of `NPE_XUS`, `CAN_US`, `XUS`, `XEU`.

### How authentication works
The app never holds long-lived credentials in the browser. When a request needs a token, the UI calls a same-origin route `/token-service/<env>`; the **proxy** (Vite in dev, nginx in the container) injects the secret X2S credential as the `Authorization` header and forwards it to the real token service, returning a short-lived bearer token. Tokens are refreshed automatically on `401`. An optional `VITE_OPENFGA_API_TOKEN` can supply a manual token override (lowest priority; usually blank).

> Keep real environment values out of version control — `.env` and `.env.prod` are git-ignored. Do not paste production URLs or credentials into commits, issues, or this README.

---

## Running with Docker

The container is a multi-stage build (Node build → nginx runtime) that bundles an embedded OpenFGA binary, so it can run standalone or point at an external OpenFGA. It exposes **3000** (UI), **8080** (OpenFGA HTTP), and **8081** (gRPC).

```bash
# build locally
docker build -t openfga-studio .

# 1) Default: embedded OpenFGA (great for a quick local try)
docker run -p 3000:3000 -p 8080:8080 -p 8081:8081 openfga-studio
#   UI:            http://localhost:3000
#   OpenFGA HTTP:  http://localhost:8080

# 2) External OpenFGA — point at an existing instance
docker run -p 3000:3000 -e OPENFGA_ENDPOINT=https://your-openfga.example.com/api openfga-studio
```

Useful container variables: `OPENFGA_ENDPOINT` (full URL, takes precedence), or `OPENFGA_HOST` / `OPENFGA_SCHEME` / `OPENFGA_HTTP_PORT` / `OPENFGA_GRPC_PORT` / `OPENFGA_PATH_PREFIX`; `DISABLE_LOCAL_OPENFGA=true` to force UI-only; `ENABLE_LOCAL_OPENFGA=true` to force the embedded instance. For the multi-environment/token-service setup, provide the same `.env` variables described above (the nginx template wires the `/token-service/<env>` proxy). An example is in [`examples/docker-compose.yml`](examples/docker-compose.yml). CI publishes an image to GHCR (`ghcr.io/<owner>/openfga-studio`) on `v*` tags.

---

## Data migration scripts

Backfilling existing data into OpenFGA is done with the Node scripts in [`scripts/`](scripts/) (e.g. `backfill-task-tuples.mjs`, `migrate-user-tuples.mjs`, `migrate-assessment-tuples.mjs`, `migrate-assessment-template-tuples.mjs`). Each reads an RFC-4180 CSV, transforms rows into structural tuples for a specific resource, and writes them **directly** to the OpenFGA API.

```bash
node scripts/backfill-task-tuples.mjs --csv path/to/data.csv --dry-run
node scripts/backfill-task-tuples.mjs --csv path/to/data.csv --model-id <authorization-model-id>
```

Common flags: `--csv <path>` (required), `--model-id <id>` (required unless `--dry-run`), `--dry-run` (transform + print stats, write nothing), `--batch-size <n>`. Writes use `on_duplicate: ignore` (idempotent, safe to re-run). Scripts read their target from `.env` (`VITE_OPENFGA_API_URL`, `VITE_OPENFGA_STORE_ID`, and a token).

> These writes go straight to OpenFGA and **bypass any Kafka/audit event pipeline**. Never commit real source CSVs — treat migration input data as sensitive.

---

## Project structure

```
src/
  components/        one folder per feature (AuthModelTab, AuthModelGraph,
                     TuplesTab, QueryTab, LookupTab, BenchmarkTab, ConnectionInfo, common/…)
  services/          OpenFGAService (API), token/environment stores, latency bus
  utils/             modelGraph, modelWeights, resolutionEngine, graphLayout, modelConverter, tupleHelper
  contexts/          Environment, Token, Toast, DirtyState
  hooks/             useHistory, useLocalStorage
  environments.ts    environment + tier definitions
scripts/             data migration / seeding scripts
templates/, bin/     nginx + OpenFGA startup templating for the container
```

---

## Development & testing

- Deeper development and container internals are documented in [DEVELOPMENT.md](DEVELOPMENT.md).
- Run the test suite with `npm test`; type-check and lint with `npm run build` / `npm run lint`.
- The dev server proxies `/api` (to a local OpenFGA) and `/token-service/<env>` (see `vite.config.ts`).

---

## License & credits

Licensed under the **Apache License 2.0** (see [LICENSE](LICENSE)).

OpenFGA Studio is a fine-grained-authorization tooling UI built on top of [OpenFGA](https://openfga.dev) and originated from the open-source [openfga-studio](https://github.com/prakashm88/openfga-studio) project. It is not affiliated with OpenFGA Inc.'s hosted Playground.
