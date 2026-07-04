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

import type { TaskSummary } from '@/src/processing/types';
import {
  parseJobRef,
  parseJobStatus,
  parseResults,
  parseStageResponse,
} from './wire';
import { parseTaskSpecEnvelope } from './taskSpec';
import type { TransportDescriptor } from './transport';

const join = (base: string, path: string) =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

const id = (taskOrJobId: string) => encodeURIComponent(taskOrJobId);

export const defaultDescriptor: TransportDescriptor = {
  endpoints: {
    listTasks: (baseUrl) => join(baseUrl, 'tasks'),
    taskSpec: (baseUrl, taskId) => join(baseUrl, `tasks/${id(taskId)}/spec`),
    runTask: (baseUrl, taskId) => join(baseUrl, `tasks/${id(taskId)}/run`),
    jobStatus: (baseUrl, jobId) => join(baseUrl, `jobs/${id(jobId)}`),
    jobResults: (baseUrl, jobId) => join(baseUrl, `jobs/${id(jobId)}/results`),
    // Client-created labelmap inputs POST here for facade-minted URIs (Chunk 14
    // facade half; Chunk 15 client half). Matches the facade route
    // `POST folder/:folderId/volview_processing/stage`.
    stage: (baseUrl) => join(baseUrl, 'stage'),
  },

  buildRunRequest: (values) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  }),

  lifecycle: 'poll',

  format: {
    // Task summaries are advisory display metadata, kept as a pass-through (no
    // schema) — transport, not vocabulary.
    parseTasks: (raw) => raw as TaskSummary[],
    parseSpec: parseTaskSpecEnvelope,
    parseRunResponse: parseJobRef,
    parseStatus: parseJobStatus,
    parseResults,
    parseStageResponse,
  },
};
