# processing-contract

The neutral client↔facade processing contract, as a self-contained artifact.
The VolView client and any server-side **facade** (girder_volview today, a MONAI
shim tomorrow) build against the shapes defined here; no backend speaks them
natively — a facade **translates** its native task format into this one neutral
spec (contract Seam 2; decision D2).

This is the **contract keystone** (WORKORDER Chunk 5): everything after depends
on it. Chunk 23 later adds the OpenAPI of the neutral REST surface + a runnable
facade conformance kit on top of these same fixtures.

## Layout

```
processing-contract/
  task-spec.ts        VolView's own zod task-spec schema (Seam 2)
  wire.ts             neutral wire shapes: input value (Seam 1), job status +
                      NeutralJobHandle + result-read payloads (Seam 3), and the
                      v1 result-intent vocabulary (Seam 2)
  schema-json.ts      zod -> JSON Schema codegen (the D4 single-source mechanism)
  index.ts            re-exports the schemas + types
  generated/          checked-in JSON Schemas the facade validates against
  fixtures/
    task-spec/        golden task specs (MedianFilter / Otsu / Threshold + a
                      synthetic bounds+enum+UI-hints spec)
    task-spec-xml/    synthetic Slicer XML source for the Chunk 6 translator
    negative/         specs that MUST fail validation (fail closed)
    wire/             input values, job statuses, result intents, job handle,
                      result-read payloads
  scripts/
    generate-json-schema.ts   regenerates generated/*.schema.json
    sync-facade.sh            copies fixtures + generated schemas into girder_volview
  __tests__/          vitest: every fixture validates; negatives fail; generated
                      schema is in sync with the zod source
```

## The single normative definition

The **zod sources here are the one normative definition** of the contract.
JSON Schema is deliberately NOT the wire contract (D2) — it describes validity
but not rendering, and there is exactly one producer (our facade) and one
consumer (our renderer). The **golden JSON fixtures** are the interchange format
both sides pin.

## Two in-flight decisions taken (Chunk 5)

**Fixture home.** Canonical fixtures + zod source live **here**, in the VolView
repo, next to the normative definition. girder_volview holds a **copy** for its
facade tests (`tests/contract/`), produced by `scripts/sync-facade.sh` — never
hand-edited. Chunk 23 reframes this as "girder_volview is one consumer of the
package."

**Parity mechanism (D4): single source via codegen.** Rather than a
hand-maintained second schema on the Python side, `schema-json.ts` generates a
JSON Schema from the zod source (Zod 4's built-in `z.toJSONSchema`). One
definition (zod), two validators (zod in TS; the generated JSON Schema in
Python). The generated files are checked in and guarded against drift by
`__tests__/generated-schema.spec.ts`. The **fixtures** are still physically
copied into girder_volview (a separate repo/CI cannot import a sibling
checkout); `sync-facade.sh` is the single writer and Chunk 24 re-checks parity.

zod's cross-field refinements (`min<=max`, default-in-range, enum default) are
not representable in JSON Schema and stay the zod side's extra rigor (exercised
by the negative constraint-violation fixture).

## Regenerating

```
npx tsx processing-contract/scripts/generate-json-schema.ts   # rewrite generated/
processing-contract/scripts/sync-facade.sh                    # vendor into girder_volview
```
