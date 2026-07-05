// ---------------------------------------------------------------------------
// The default transport descriptor (decision C3; WORKORDER WI4).
//
// This is the ONE descriptor v1 ships: the neutral-facade default. It gathers
// every settled transport axis in a single object the generic engine reads —
//   * endpoint templates (list / spec / run / status / results),
//   * input placement (bound values ride as a JSON `{ values }` body),
//   * the poll lifecycle,
//   * the wire result format (delegated to the existing validators).
// Nothing here is hardcoded inside the engine; swapping this object for another
// redirects every engine call (asserted by the descriptor-swap test). That is
// the seam a facade-less backend (#2, MONAI) slots a SECOND descriptor into —
// NOT an engine refactor. Building further variation points (data access,
// `/info` discovery, sync drivers, the interactive loop) is out of v1 scope:
// this is the seam, not the full binding descriptor.
//
// The wire validators are the neutral result-format (`engine/wire.ts`), not
// backend-specific parsing; the default descriptor delegates to them here.
//
// House rules: functional style; `type`, not `interface`.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { TaskSummary } from '@/src/processing/types';
import {
  parseJobHandles,
  parseJobRef,
  parseJobStatus,
  parseResults,
  parseStageResponse,
} from './wire';
import { parseTaskSpecEnvelope } from './taskSpec';
import type { TransportDescriptor } from './transport';

const join = (base: string, path: string) =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

// ---------------------------------------------------------------------------
// Task-summary parsing — advisory pass-through, fail SOFT (Seam 2)
//
// Task summaries are advisory display metadata for the picker, not contract
// vocabulary, so this is a LIGHT, lenient guard — not the wire validators. It
// requires only the two fields the picker cannot render without (id/title) and
// keeps every other advisory hint (description/dockerImage/category) verbatim
// (extra keys ride through untouched). A malformed entry is DROPPED WITH A
// WARNING, never thrown on: one bad summary must never kill the whole picker —
// the same fail-closed-per-item split the parameter form uses (one bad param
// never kills a form). A non-array payload degrades to an empty list. This is
// deliberately VolView's own light zod schema, NOT one derived from the contract
// wire schemas (that wire-layer dedupe is a later chunk).
// ---------------------------------------------------------------------------
const taskSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
});

const parseTaskSummaries = (raw: unknown): TaskSummary[] => {
  if (!Array.isArray(raw)) {
    console.warn('processing: task list was not an array; ignoring it');
    return [];
  }
  return raw.filter((entry): entry is TaskSummary => {
    const parsed = taskSummarySchema.safeParse(entry);
    if (!parsed.success) {
      console.warn('processing: dropping malformed task summary', entry);
    }
    return parsed.success;
  });
};

const id = (taskOrJobId: string) => encodeURIComponent(taskOrJobId);

// Job routes are addressed by job id alone (D5) — the launch folder is not part
// of a job's identity, so the facade serves them off a folder-free
// `volview_processing` surface. The launch-context endpoints (tasks/spec/run/
// stage) genuinely operate per-folder and keep the folder-scoped baseUrl; the
// job endpoints re-root by dropping the `folder/<id>/` segment. A baseUrl that
// carries no folder (already the processing root) is left unchanged.
const jobsRoot = (baseUrl: string) =>
  baseUrl.replace(/\/folder\/[^/]+(?=\/[^/]+\/?$)/, '');

export const defaultDescriptor: TransportDescriptor = {
  endpoints: {
    listTasks: (baseUrl) => join(baseUrl, 'tasks'),
    taskSpec: (baseUrl, taskId) => join(baseUrl, `tasks/${id(taskId)}/spec`),
    runTask: (baseUrl, taskId) => join(baseUrl, `tasks/${id(taskId)}/run`),
    // Job-addressed + folder-free (D5): matches the facade routes
    // `GET|POST volview_processing/jobs/:jobId[/results|/cancel]`.
    jobStatus: (baseUrl, jobId) => join(jobsRoot(baseUrl), `jobs/${id(jobId)}`),
    jobResults: (baseUrl, jobId) =>
      join(jobsRoot(baseUrl), `jobs/${id(jobId)}/results`),
    cancel: (baseUrl, jobId) =>
      join(jobsRoot(baseUrl), `jobs/${id(jobId)}/cancel`),
    // Client-created labelmap inputs POST here for facade-minted URIs (Chunk 14
    // facade half; Chunk 15 client half). Matches the facade route
    // `POST folder/:folderId/volview_processing/stage`.
    stage: (baseUrl) => join(baseUrl, 'stage'),
    // Tier-2 cold-reload re-discovery (Chunk 19, D5). Context-scoped (keeps the
    // folder-scoped baseUrl, unlike the job-addressed routes above): matches the
    // facade route `GET folder/:folderId/volview_processing/jobs`. Its presence
    // advertises the durable-enumeration capability; the engine calls it on load
    // and degrades to tier-1 (in-session replay) when a descriptor omits it.
    listRecentJobs: (baseUrl) => join(baseUrl, 'jobs'),
  },

  buildRunRequest: (values) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  }),

  lifecycle: 'poll',

  format: {
    // Task summaries are advisory display metadata. A LIGHT, lenient guard drops
    // a malformed entry with a warning (only id/title required) and passes every
    // advisory hint through verbatim — one bad summary never kills the picker.
    parseTasks: parseTaskSummaries,
    parseSpec: parseTaskSpecEnvelope,
    parseRunResponse: parseJobRef,
    parseStatus: parseJobStatus,
    parseResults,
    parseStageResponse,
    parseJobHandles,
  },
};
