// ---------------------------------------------------------------------------
// Writes the published OpenAPI document (WORKORDER Chunk 23) to
// `processing-contract/generated/openapi.json`. Run with the repo's TS runner:
//
//   npx tsx processing-contract/scripts/generate-openapi.ts
//
// Single source (D4): the wire component schemas are injected from the SAME
// zod-generated JSON Schemas the facade validates against, so the OpenAPI can
// never drift from the normative zod definition. `__tests__/openapi.spec.ts`
// guards the checked-in output against drift; `scripts/sync-facade.sh` vendors
// it (alongside the fixtures + generated schemas) into girder_volview.
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument } from '../openapi';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'generated');
mkdirSync(outDir, { recursive: true });

const path = resolve(outDir, 'openapi.json');
writeFileSync(path, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${path}`);
