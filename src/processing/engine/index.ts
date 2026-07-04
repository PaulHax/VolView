// ---------------------------------------------------------------------------
// Generic processing engine (contract Seam 2/3; decisions C3 + D2).
//
// ONE engine, ZERO per-backend client code. It renders the parameter form from
// a server-emitted, zod-validated task spec and routes all HTTP through the
// bearer-aware `$fetch`, reading every transport specific from a single
// descriptor. Adapters compose a provider from these pieces; core VolView
// consumes the provider contract only.
// ---------------------------------------------------------------------------

export * from './transport';
export * from './descriptor';
export * from './taskSpec';
export * from './formModel';
export * from './mintInput';
export * from './bounds';
