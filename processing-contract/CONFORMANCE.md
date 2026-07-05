# Facade conformance kit

> **Status: draft `0.x` (currently `0.1.0`).** This kit and the shapes it checks
> may change until a **second backend's shim passes it unchanged** — the pinned
> **1.0** criterion (decision D12). At `0.x` the kit is the reference facade's
> own regression harness, not yet a versioned external-acceptance surface; treat
> a passing run as "conforms to today's draft," not "conforms to a frozen 1.0."

A **facade** is conforming when the VolView client can drive its backend with no
client change. This kit lets you prove that mechanically, before wiring a live
stack. It is the neutral surface (the [OpenAPI](./generated/openapi.json)) + the
golden fixtures + the generated JSON Schemas + this checklist.

girder_volview is the **reference implementation**; its `tests/` are the first
consumer and a worked example of every check below.

## Running it against your facade

1. Vendor the artifacts into your facade repo (single writer; never hand-edit the
   copy):

   ```
   processing-contract/scripts/sync-facade.sh /path/to/your-facade
   ```

   This drops `fixtures/` + `generated/` (the `*.schema.json` validators and
   `openapi.json`) under `your-facade/tests/contract/`.

2. In your facade's test suite, load them (girder_volview's `tests/contract_loader.py`
   is a pure-stdlib example) and assert the six obligations below — validating
   **your facade's own emitted shapes** against the generated JSON Schemas, and
   your routes against the OpenAPI.

Every check is a JSON-Schema validation or a fixture comparison, so it runs in
any language with a JSON-Schema validator (girder_volview uses Python
`jsonschema`; the client uses `zod`). One definition, two validators.

## The checklist

| # | Obligation | Validate against | Golden fixtures | Reference test (girder_volview) |
|---|------------|------------------|-----------------|--------------------------------|
| 1 | **Spec translation yields valid specs.** Your facade translates its native task format into a `TaskSpec`. An unknown field kind must be **rejectable** so the client fails closed (never renders a param it can't type). | `task-spec.schema.json` (+ the zod cross-field refinements) | `task-spec/*.json`; `negative/unknown-field-kind.json`, `negative/constraint-violation.json` must FAIL | `test_slicer_spec_translation.py` |
| 2 | **Input values match Seam 1.** Bound inputs cross the wire as `{ type, format?, uris }` — opaque provenance URIs + an open semantic type tag, never a backend id. | `input-value.schema.json` | `input-value.*.json` | `test_input_value_resolution.py` |
| 3 | **Result intents validate; unknown → download.** Each result declares a neutral intent from the v1 vocabulary (`add-base-image | add-layer | add-segment-group | restore-state | download`), carrying the `source:{jobId,outputId}` tag on a segment group. An intent **outside** the vocabulary still parses (fail-open) so the applier degrades it to `download` — every result is a file. | `result-intent.schema.json` | `intent.*.json` incl. `intent.unknown.json` (must pass, fail-open) | `test_result_intent.py` |
| 4 | **Neutral status + handle shapes match.** Job status projects to `{ jobId, state, progress?, errorTail? }` with `state ∈ pending|running|success|error|cancelled`; a re-discoverable job projects to a `NeutralJobHandle` (`{ jobId, taskId, inputUris, finishedAt }`). | `neutral-job-status.schema.json`, `neutral-job-handle.schema.json` | `status.*.json`, `job-handle.json` | `test_status_conformance.py`, `test_tier2_durability*.py` |
| 5 | **Result-read error / `missing` semantics.** Reads gate on the job reaching `success`. A non-success read (or a succeeded job whose every output is unresolvable) is an **explicit error**, never a silent `[]`. Unresolvable outputs are reported as a loss, never silently dropped. | `job-results-error.schema.json`; the `{ intents, missing }` results envelope `job-results.schema.json` | `job-results.error.json`, `job-results.missing.json` | `test_job_output_binding*.py` |
| 6 | **Neutral REST surface implemented.** Your facade exposes the operations the client calls — `listTasks`, `getTaskSpec`, `runTask`, `getJob`, `getJobResults`, `listRecentJobs`, `stageInput`, `cancelJob` — matching [`openapi.json`](./generated/openapi.json). (`listRecentJobs` / `stageInput` / `cancelJob` are optional capabilities; omit an endpoint and the client fails closed on it rather than guessing a route.) | `generated/openapi.json` | — | `test_openapi_conformance.py` |

## Fail-closed obligations (the spirit of the contract)

These are server-side obligations the checklist encodes; honor them even where a
schema can't:

- **Unknown task-spec field kind → rejectable** (check 1). The client must not
  silently render a param it can't type.
- **Unknown result intent → `download`** (check 3), NOT reject. Every result is a
  file, so the floor is always safe.
- **Result read gates on `success`** with an **explicit** error for non-success,
  and an unresolvable-output **loss is counted, never a silent `[]`** (check 5).
- **Nothing backend-specific in the neutral surface** (check 6): no routes, ids,
  status enums, or URL shapes leak. The OpenAPI is grep-tested for this.

## Out of scope (deferred, do not implement to "conform")

The kit describes the v1 neutral **seam**, not the north-star executable binding
descriptor (config, not even a facade — deferred to backend #2). It is poll-only
(no SSE/push endpoint), assumes the same-origin cookie-auth topology (no
cross-origin bearer flow), and freezes the intent vocabulary at the v1 five
(annotation intents are backlog). See `client-processing-contract.md`.

One **reserved** shape is documented but NOT part of conformance at `0.x`: an
inline **results** member on the `runTask` response, reserved _for sync
backends_ (a born-terminal MONAI `/infer` returning results in the run response,
D5). It is reserved in prose only — there is no schema, no member, and nothing
to implement or validate. A conforming `0.x` facade uses the poll-then-
`getJobResults` path (checks 5–6); see the README **Reserved shapes** section.
