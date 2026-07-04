// ---------------------------------------------------------------------------
// processing-contract — the neutral client<->facade contract, published as an
// artifact (contract "the contract as a published artifact"; WORKORDER Chunk 5,
// reframed by Chunk 23).
//
// The zod sources in this package are the single normative definition of the
// task spec and the neutral wire shapes. The golden JSON fixtures under
// `fixtures/` are the interchange format BOTH suites pin: the VolView client
// validates them with the zod schemas here; the girder_volview facade validates
// them against a JSON Schema generated from these same zod sources (see
// `schema-json.ts`). One definition, two validators.
// ---------------------------------------------------------------------------

export * from './task-spec';
export * from './wire';
