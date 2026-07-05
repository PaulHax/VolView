# processing-contract

> **Status: draft `0.x` (currently `0.1.0`).** The shapes may change until a
> **second backend's shim passes the [conformance kit](#the-facade-conformance-kit)**
> — that is the pinned **1.0** criterion (decision D12). This is a private,
> versioned draft with exactly one known consumer (girder_volview, vendored via
> `sync-facade.sh`); it carries no stability promise and no distribution channel
> yet. Semver/changelog, a publish channel, and a versioned external acceptance
> surface are chosen at the 1.0 graduation, deliberately **not** now. See
> [Versioning and stability](#versioning-and-stability).

The neutral client↔facade processing contract, published as a self-contained,
backend-decoupled artifact. The VolView client and any server-side **facade**
(girder_volview today, a MONAI shim tomorrow) build against the shapes defined
here; no backend speaks them natively — a facade **translates** its native task
format into this one neutral spec (contract Seam 2; decision D2).

**Bring a new backend online = implement the [OpenAPI](#the-neutral-rest-surface-openapi)
+ pass the [conformance kit](#the-facade-conformance-kit); zero VolView client
change.** That is the whole point of this package: adding a second backend is a
_conformance exercise_, not a reverse-engineering of girder_volview.

This is the **contract keystone** (WORKORDER Chunk 5), reframed by Chunk 23 as a
published artifact: **girder_volview is one _consumer_ of this package**, not its
owner. It vendors the fixtures + generated schemas (`tests/contract/`) and
validates against them; it defines nothing here.

## Layout

```
processing-contract/
  task-spec.ts        VolView's own zod task-spec schema (Seam 2)
  wire.ts             neutral wire shapes: input value (Seam 1), job status +
                      NeutralJobHandle + result-read payloads (Seam 3), and the
                      v1 result-intent vocabulary (Seam 2)
  openapi.ts          the neutral REST surface as an OpenAPI 3.1 document, built
                      single-source (wire component schemas injected from the zod
                      codegen); the facade's obligation surface (Chunk 23)
  schema-json.ts      zod -> JSON Schema codegen (the D4 single-source mechanism)
  index.ts            re-exports the schemas + types (NOT the codegen/openapi —
                      those are imported directly by scripts + tests)
  generated/          checked-in artifacts the facade validates against:
                      *.schema.json (one per wire schema) + openapi.json
  fixtures/
    task-spec/        golden task specs (MedianFilter / Otsu / Threshold + a
                      synthetic bounds+enum+UI-hints spec)
    task-spec-xml/    synthetic Slicer XML source for the Chunk 6 translator
    negative/         specs that MUST fail validation (fail closed)
    wire/             input values, job statuses, result intents, job handle,
                      result-read payloads
  scripts/
    generate-json-schema.ts   regenerates generated/*.schema.json
    generate-openapi.ts       regenerates generated/openapi.json
    sync-facade.sh            vendors fixtures + generated/ into a facade repo
  __tests__/          vitest: every fixture validates; negatives fail; generated
                      schema + openapi are in sync with the zod source; the
                      openapi covers exactly the neutral surface and leaks nothing
  CONFORMANCE.md      the runnable conformance checklist a new facade executes
```

## The single normative definition

The **zod sources here are the one normative definition** of the contract.
JSON Schema is deliberately NOT the wire contract (D2) — it describes validity
but not rendering, and there is exactly one producer (our facade) and one
consumer (our renderer). The **golden JSON fixtures** are the interchange format
both sides pin, and the generated JSON Schemas are the facade's _validator_,
codegen'd from the zod source so the two can't drift (D4).

## The neutral REST surface (OpenAPI)

`generated/openapi.json` (built from `openapi.ts`) describes **exactly the
endpoints the client calls**, in **neutral terms** — no Girder routes, no
`folderId`, no file ids, no `JobStatus` enum, no proxiable-URL shape. A reviewer
can enumerate what a non-Girder facade must implement **without reading
girder_volview source**:

| operation        | method + neutral path        | request → response                    |
| ---------------- | ---------------------------- | ------------------------------------- |
| `listTasks`      | `GET /tasks`                 | → `TaskSummary[]`                     |
| `getTaskSpec`    | `GET /tasks/{taskId}/spec`   | → `TaskSpec`                          |
| `runTask`        | `POST /tasks/{taskId}/run`   | `RunTaskRequest` → `JobRef`          |
| `listRecentJobs` | `GET /jobs`                  | → `NeutralJobHandle[]` (tier-2, opt.) |
| `stageInput`     | `POST /stage`                | bytes → `StageResponse` (opt.)       |
| `getJob`         | `GET /jobs/{jobId}`          | → `NeutralJobStatus`                 |
| `getJobResults`  | `GET /jobs/{jobId}/results`  | → result intents, or explicit error  |
| `cancelJob`      | `POST /jobs/{jobId}/cancel`  | → `NeutralJobStatus`                 |

The component schemas are the wire schemas above (`TaskSpec`, `InputValue`,
`NeutralJobStatus`, `ResultIntent`, `NeutralJobHandle`, …), injected from the
same zod codegen, so the published surface can never drift from the normative
definition. The lifecycle is **poll-only** in v1 (`getJob`); push (SSE) is an
additive backend-only enhancement, never a neutral client requirement, so it is
_not_ described here. Job-addressed routes (`getJob` / `getJobResults` /
`cancelJob`) are keyed by the opaque job id **alone** — the job's own access
control is the gate, so no context leaks into the path (D5).

## The facade conformance kit

The golden fixtures + generated schemas + the OpenAPI, together, are a runnable
kit a facade executes to prove conformance. See **[CONFORMANCE.md](./CONFORMANCE.md)**
for the checklist and how to run it. girder_volview is the **reference
implementation** and the kit's first consumer: its `tests/` validate the
facade-emitted specs, intents, and job statuses against these exact artifacts.

## Two reusability tiers

1. **Now — the facade as a conformance exercise (this package).** "Add a backend"
   in v1 means "write a conforming facade": implement the OpenAPI, pass the
   conformance kit. The cost moved server-side; it did not vanish.
2. **Later — the north-star binding descriptor (deferred to backend #2).** The
   end state is _config, not even a facade_: the provider config carries a
   declarative **binding descriptor** the generic engine _executes_, so a new
   backend is data, not code. That is deferred on purpose (it can only be
   designed against two real backends — MONAI + Girder). See
   `client-processing-contract.md`, **"North star — the binding descriptor"** and
   **"v1 pre-builds the seam, not the descriptor."** This OpenAPI is the
   **server-facing dual** of that seam: it states the neutral surface for facade
   authors; the client-side default transport descriptor
   (`src/processing/engine/descriptor.ts`) reads the same surface as engine
   config. **This package does NOT build the descriptor** — it publishes the
   seam.

## Job-state names (Chunk 12 → Chunk 23 reconcile)

The neutral job states are `pending | running | success | error | cancelled` —
the names the facade projects and the client store consumes at runtime. Girder's
native job status maps onto these with no translation layer, so the canonical
schema is named _to_ the runtime (driver decision, 2026-07-04; DECISIONS-LOG
"Chunk 12 → ORCHESTRATOR RESOLUTION"). A facade-side status-conformance test
(girder_volview `tests/test_status_conformance.py`) validates its projected
status against the generated `neutral-job-status` schema so this can't silently
drift again.

## Versioning and stability

Two versions live here and they turn on **separate clocks**:

- The **artifact version** — `processing-contract/package.json` `version` (today
  `0.1.0`, `private: true`) and the OpenAPI `info.version`. It versions _this
  package as a published thing_ and states its maturity: a draft `0.x` carrying
  no stability promise.
- The **shape versions** — `INTENT_VOCABULARY_VERSION` (`wire.ts`) and the
  task-spec `specVersion`. These version the _wire vocabulary_ so a producer and
  the applier can negotiate additive compatibility; they are NOT the artifact
  version, and the OpenAPI `info.version` is a deliberate literal rather than a
  value derived from them.

**The `1.0` criterion is pinned (D12):** stamp `1.0` only when a **second**
backend's shim (the north-star MONAI backend) passes the conformance kit
unchanged — the first moment the shapes are proven reusable rather than
retrofitted. Only at that graduation are the `1.0` obligations taken on: a
stability promise (semver + changelog), a distribution channel (npm publish /
standalone repo / rendered docs), and a support surface (the conformance kit as
an external-facade acceptance test, with versioned fixtures). Until then this
stays a private draft that may change any day, in lock-step with its one
consumer.

## Reserved shapes

The published wire is the _real_ wire — no shape appears here without stated
semantics. There is exactly one **reserved** shape:

- **Inline results on the run response** (reserved _for sync backends_). A
  synchronous backend (the north-star MONAI `/infer`, D5) could return a
  born-terminal job whose results are already present in the `runTask` response,
  letting the client skip the poll-then-read round-trip. The neutral surface
  already carries the born-terminal `status` fast-path (`JobRef.status`); an
  inline **results** member is its natural companion. It is **reserved in prose
  only** — there is no schema and no member for it, and none is built until
  backend #2 exists to design it against. A `0.x` facade need not implement it;
  the poll-then-`getJobResults` path is the whole v1 contract.

## Regenerating

```
npx tsx processing-contract/scripts/generate-json-schema.ts   # rewrite generated/*.schema.json
npx tsx processing-contract/scripts/generate-openapi.ts       # rewrite generated/openapi.json
processing-contract/scripts/sync-facade.sh [FACADE_REPO]      # regen + vendor into a facade repo
```

`sync-facade.sh` is the **single writer** of a facade's vendored copy (never
hand-edit `tests/contract/`); it regenerates first, then copies, so a facade's
copy is never stale. The vitest drift guards
(`__tests__/generated-schema.spec.ts`, `__tests__/openapi.spec.ts`) fail if the
checked-in artifacts fall out of sync with the zod source.
