// ---------------------------------------------------------------------------
// The neutral client<->facade REST surface, as an OpenAPI 3.1 document
// (WORKORDER Chunk 23 WI2; contract North Star "The contract as a published
// artifact"). This is the SERVER-side dual of the client-side default transport
// descriptor (engine/descriptor.ts): one states the neutral surface for facade
// authors, the other reads it as engine config.
//
// NEUTRALITY INVARIANT (the whole point): this describes ONLY the neutral
// surface — no Girder routes, no `folderId`, no file ids, no `JobStatus` enum,
// no proxiable-URL shape, no Slicer XML. A reviewer can enumerate exactly what a
// non-Girder facade must implement WITHOUT reading girder_volview source. The
// `__tests__/openapi.spec.ts` neutrality gate greps this document for those
// leaks; keep it clean.
//
// SINGLE SOURCE (D4): the wire component schemas are the SAME zod-generated JSON
// Schemas the facade validates against (`schema-json.ts` / `generateJsonSchemas`),
// injected here rather than re-typed — so the OpenAPI can never drift from the
// normative zod definition. The hand-authored pieces are only the request/
// response ENVELOPES the client wraps the wire schemas in (they have no zod home
// — they are the engine's transport, not the contract vocabulary).
//
// v1 PUBLISHES THE SEAM, NOT THE BINDING DESCRIPTOR: this is the neutral surface
// for facade authors, explicitly NOT the north-star executable binding
// descriptor (config, not even a facade) — that is deferred to backend #2. See
// README for the cross-link.
//
// House rules: functional style; `type`, not `interface`.
// ---------------------------------------------------------------------------

import { generateJsonSchemas, type GeneratedSchemaName } from './schema-json';
import { INTENT_VOCABULARY_VERSION, RESULT_INTENTS, JOB_STATES } from './wire';
import { SPEC_VERSION } from './task-spec';

// ---------------------------------------------------------------------------
// Wire component schemas — injected from the single zod source (D4)
// ---------------------------------------------------------------------------

// Generated-schema name -> OpenAPI component name. Every neutral wire schema the
// package defines is published as a component so a facade author sees the whole
// vocabulary in one document.
const WIRE_COMPONENTS: Record<GeneratedSchemaName, string> = {
  'task-spec': 'TaskSpec',
  'input-value': 'InputValue',
  'neutral-job-status': 'NeutralJobStatus',
  'result-intent': 'ResultIntent',
  'neutral-job-handle': 'NeutralJobHandle',
  'job-results': 'JobResults',
  'job-results-error': 'JobResultsError',
};

// The generated schemas carry a per-schema `$schema` dialect marker; OpenAPI 3.1
// declares the dialect once at the document root (`jsonSchemaDialect`), so strip
// the per-schema marker as each is embedded as a component.
const stripDialect = (schema: unknown): Record<string, unknown> => {
  const { $schema, ...rest } = schema as Record<string, unknown>;
  void $schema;
  return rest;
};

const wireComponentSchemas = (): Record<string, unknown> => {
  const generated = generateJsonSchemas();
  return Object.fromEntries(
    (Object.keys(WIRE_COMPONENTS) as GeneratedSchemaName[]).map((name) => [
      WIRE_COMPONENTS[name],
      stripDialect(generated[name]),
    ])
  );
};

// ---------------------------------------------------------------------------
// Envelope component schemas — hand-authored transport shapes (no zod home)
//
// These are the request/response wrappers the client puts the wire schemas in.
// They are NOT the contract vocabulary (that is the zod-generated set above);
// they are the neutral transport envelope, kept small and free of any backend
// specific.
// ---------------------------------------------------------------------------

const ref = (component: string) => ({
  $ref: `#/components/schemas/${component}`,
});

const envelopeComponentSchemas = (): Record<string, unknown> => ({
  // Advisory display metadata for the task picker. The facade emits it and the
  // engine passes it through with no schema, so only `id`/`title` are required
  // and additional advisory hints (e.g. a category or image label) are allowed.
  TaskSummary: {
    type: 'object',
    description:
      'Advisory display metadata for one task in the picker. Pass-through: the ' +
      'client renders it but validates only id/title; extra hints are ignored.',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'title'],
    additionalProperties: true,
  },

  // The submit body. Each bound value is either a Seam-1 input value
  // (`{ type, format?, uris }`) or a plain scalar/list parameter.
  RunTaskRequest: {
    type: 'object',
    description:
      'Submission payload. `values` maps each task parameter id to its bound ' +
      'value: a Seam-1 InputValue for an input binding, or a scalar/list for a ' +
      'plain parameter.',
    properties: {
      values: {
        type: 'object',
        additionalProperties: {
          oneOf: [
            ref('InputValue'),
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'array' },
            { type: 'null' },
          ],
        },
      },
    },
    additionalProperties: false,
  },

  // The submit response: an opaque job id the client polls. `status` is the
  // optional born-terminal fast-path (a synchronous backend may return an
  // already-terminal status; the client applies it without ever polling).
  JobRef: {
    type: 'object',
    description:
      'Handle to the submitted job. `jobId` is opaque. An optional terminal ' +
      '`status` is the born-terminal fast-path for a synchronous backend.',
    properties: {
      jobId: { type: 'string' },
      status: ref('NeutralJobStatus'),
    },
    required: ['jobId'],
    additionalProperties: false,
  },

  // The staging response: the facade-minted download URIs for the client-held
  // bytes it POSTed. At least one URI — the client constructs none itself, so an
  // empty response fails closed (Seam 1).
  StageResponse: {
    type: 'object',
    description:
      'Facade-minted opaque URIs for the staged bytes. The client mints no URI ' +
      'itself, so at least one is required (fail closed).',
    properties: {
      uris: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    required: ['uris'],
    additionalProperties: false,
  },

  // One produced result on a successful read. It carries a neutral result
  // intent (see ResultIntent) plus advisory file metadata the client shows in
  // its job list. `id`/`name`/`url` are the minimum a facade must supply.
  ResultListItem: {
    type: 'object',
    description:
      'A produced result. `intent`/`url`/`name` (and, for add-segment-group, ' +
      'the optional `segments` + `source`) are the neutral result-intent ' +
      'vocabulary — see ResultIntent; an `intent` outside the v1 vocabulary ' +
      'degrades to `download`. `id`/`mimeType`/`size` are advisory metadata.',
    properties: {
      id: {
        type: 'string',
        description:
          'Opaque, stable result identifier (the client display key).',
      },
      name: { type: 'string' },
      url: {
        type: 'string',
        description: 'Opaque download URI for the produced file.',
      },
      intent: {
        type: 'string',
        description:
          'One of the neutral result-intent vocabulary names (ResultIntent); ' +
          'an unknown name degrades to `download`.',
      },
      mimeType: { type: ['string', 'null'] },
      size: { type: ['number', 'null'] },
      segments: {
        type: 'array',
        description:
          'Optional segment descriptors folded into an add-segment-group ' +
          'result (see ResultIntent).',
        items: { type: 'object' },
      },
      source: {
        type: 'object',
        description:
          'Provenance tag on an add-segment-group result (the tier-2 ' +
          'idempotency key; identical to ResultIntent.source).',
        properties: {
          jobId: { type: 'string' },
          outputId: { type: 'string' },
        },
        required: ['jobId', 'outputId'],
        additionalProperties: false,
      },
    },
    required: ['id', 'name', 'url'],
    additionalProperties: true,
  },
});

// ---------------------------------------------------------------------------
// Reusable response fragments
// ---------------------------------------------------------------------------

const json = (schema: Record<string, unknown>) => ({
  'application/json': { schema },
});

// A non-success result read is an EXPLICIT error, never a silent empty list
// (Seam 3 / D5): a facade returns this for a job that has not reached `success`,
// and for a succeeded job whose every recorded output is unresolvable.
const resultReadErrorResponse = {
  description:
    'The job has not reached the `success` state, or every recorded output is ' +
    'unresolvable. An explicit error — never an empty result list — so the ' +
    'client never mistakes a non-success or output-loss read for "no results".',
  content: json(ref('JobResultsError')),
};

// ---------------------------------------------------------------------------
// Paths — every endpoint the client actually calls, in neutral terms
//
// Two addressing models, both neutral:
//   * context-scoped   (tag `context`): relative to a processing context — the
//     collection a task runs against. tasks / spec / run / stage / recent-jobs.
//   * job-addressed    (tag `job`): keyed by the opaque job id ALONE; the job's
//     own access control is the gate, so no context appears in the path (D5).
// ---------------------------------------------------------------------------

const taskIdParam = {
  name: 'taskId',
  in: 'path',
  required: true,
  description: 'Opaque task identifier.',
  schema: { type: 'string' },
} as const;

const jobIdParam = {
  name: 'jobId',
  in: 'path',
  required: true,
  description: 'Opaque job identifier.',
  schema: { type: 'string' },
} as const;

const paths = (): Record<string, unknown> => ({
  '/tasks': {
    get: {
      operationId: 'listTasks',
      tags: ['context'],
      summary: 'List the processing tasks available in this context.',
      responses: {
        '200': {
          description: 'The available tasks as advisory summaries.',
          content: json({ type: 'array', items: ref('TaskSummary') }),
        },
      },
    },
  },

  '/tasks/{taskId}/spec': {
    get: {
      operationId: 'getTaskSpec',
      tags: ['context'],
      summary:
        "Get a task's VolView task spec (the facade translates its own " +
        'native task format into this neutral spec).',
      parameters: [taskIdParam],
      responses: {
        '200': {
          description: "The task's neutral task spec.",
          content: json(ref('TaskSpec')),
        },
        '404': { description: 'No such task in this context.' },
      },
    },
  },

  '/tasks/{taskId}/run': {
    post: {
      operationId: 'runTask',
      tags: ['context'],
      summary: 'Submit a task; returns an opaque job handle to poll.',
      parameters: [taskIdParam],
      requestBody: {
        required: false,
        content: json(ref('RunTaskRequest')),
      },
      responses: {
        '200': {
          description: 'The submitted job handle.',
          content: json(ref('JobRef')),
        },
        '404': { description: 'No such task in this context.' },
      },
    },
  },

  '/jobs': {
    get: {
      operationId: 'listRecentJobs',
      tags: ['context'],
      summary:
        "This context's recent jobs, as neutral handles, for cold-reload " +
        're-discovery (tier-2). OPTIONAL capability: a backend with no durable ' +
        'job enumeration omits it and the client degrades to in-session replay.',
      responses: {
        '200': {
          description:
            'The recent jobs as neutral handles (jobId + taskId + the input ' +
            'opaque URIs + finishedAt) — no route, no status enum, no file id.',
          content: json({ type: 'array', items: ref('NeutralJobHandle') }),
        },
      },
    },
  },

  '/stage': {
    post: {
      operationId: 'stageInput',
      tags: ['context'],
      summary:
        'Stage client-held bytes as a transient input; returns facade-minted ' +
        'URIs the client round-trips as an InputValue at submit. OPTIONAL ' +
        'capability (a backend that accepts no client-created inputs omits it).',
      parameters: [
        {
          name: 'name',
          in: 'query',
          required: false,
          description: 'File name to record for the staged bytes.',
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        description: 'The raw bytes to stage.',
        content: {
          'application/octet-stream': {
            schema: { type: 'string', format: 'binary' },
          },
        },
      },
      responses: {
        '200': {
          description: 'The facade-minted URIs for the staged bytes.',
          content: json(ref('StageResponse')),
        },
      },
    },
  },

  '/jobs/{jobId}': {
    get: {
      operationId: 'getJob',
      tags: ['job'],
      summary:
        "A job's neutral status. Poll this until a terminal state (v1 is " +
        'poll-only). Job-addressed: keyed by job id alone, gated by the job ' +
        'own access control — no context in the path.',
      parameters: [jobIdParam],
      responses: {
        '200': {
          description: 'The neutral job status.',
          content: json(ref('NeutralJobStatus')),
        },
      },
    },
  },

  '/jobs/{jobId}/results': {
    get: {
      operationId: 'getJobResults',
      tags: ['job'],
      summary:
        "A job's results as neutral result intents, once it reaches the " +
        '`success` state. A non-success or total-output-loss read is an ' +
        'explicit error, never a silent empty list (Seam 3 / D5).',
      parameters: [jobIdParam],
      responses: {
        '200': {
          description:
            'The resolved results (a bare array of result intents). Unresolved ' +
            'outputs are reported as a loss, never silently dropped — the ' +
            'JobResults schema ({ intents, missing }) is the reserved richer ' +
            'envelope for a facade that reports the missing count inline.',
          content: json({ type: 'array', items: ref('ResultListItem') }),
        },
        '400': resultReadErrorResponse,
      },
    },
  },

  '/jobs/{jobId}/cancel': {
    post: {
      operationId: 'cancelJob',
      tags: ['job'],
      summary:
        "Best-effort cancel. Returns the job's real projected status after the " +
        'attempt — never a fabricated `cancelled`; the client poller converges ' +
        'on whatever terminal state the backend ultimately reports. Job-' +
        'addressed and OPTIONAL (a backend with no cancel surface omits it).',
      parameters: [jobIdParam],
      responses: {
        '200': {
          description: 'The projected job status after the cancel attempt.',
          content: json(ref('NeutralJobStatus')),
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const buildOpenApiDocument = (): Record<string, unknown> => ({
  openapi: '3.1.0',
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: {
    title: 'VolView neutral processing contract',
    version: `1.${SPEC_VERSION}.${INTENT_VOCABULARY_VERSION}`,
    description:
      'The neutral REST surface the VolView client calls to run processing ' +
      'tasks against a backend. A conforming server-side FACADE implements ' +
      'these endpoints and the referenced wire schemas — no VolView client ' +
      'change is needed to bring a new backend online. Everything here is ' +
      'neutral: no backend routes, ids, status enums, or URL shapes leak. The ' +
      'result-intent vocabulary is versioned by INTENT_VOCABULARY_VERSION; the ' +
      'task-spec shape by specVersion. This states the SEAM, not the ' +
      'north-star executable binding descriptor (deferred to backend #2).',
  },
  servers: [
    {
      url: '{baseUrl}',
      description:
        'The provider processing base. Context-scoped endpoints are relative ' +
        'to a processing context; job-addressed endpoints are keyed by job id ' +
        'alone. The mapping of both onto concrete URLs is the facade choice.',
      variables: { baseUrl: { default: '/' } },
    },
  ],
  tags: [
    {
      name: 'context',
      description:
        'Context-scoped: operate against a processing context (the collection ' +
        'a task runs in).',
    },
    {
      name: 'job',
      description:
        'Job-addressed: keyed by the opaque job id alone and gated by the ' +
        "job's own access control — no context in the path (D5).",
    },
  ],
  paths: paths(),
  components: {
    schemas: {
      ...wireComponentSchemas(),
      ...envelopeComponentSchemas(),
    },
  },
});

// The neutral result-intent vocabulary + state names, re-exported so tests and
// docs can assert the published document stays in lockstep with the source.
export const OPENAPI_INTENT_VOCABULARY = RESULT_INTENTS;
export const OPENAPI_JOB_STATES = JOB_STATES;

// Every operationId the published surface must expose (AC1: enumerate the facade
// obligation without reading girder_volview source).
export const NEUTRAL_OPERATION_IDS = [
  'listTasks',
  'getTaskSpec',
  'runTask',
  'listRecentJobs',
  'stageInput',
  'getJob',
  'getJobResults',
  'cancelJob',
] as const;
