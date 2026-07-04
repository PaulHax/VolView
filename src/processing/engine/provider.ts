// ---------------------------------------------------------------------------
// Provider factory — lazy-loaded chunk (contract "one generic engine, zero
// per-backend client code").
//
// Composes the `ProcessingProvider` the core consumes from the generic engine
// transport reading the neutral-facade default descriptor. There is no
// per-backend code here and no XML: every live HTTP path (tasks / spec / run /
// status / results) is the engine's, over the bearer-aware `$fetch`. A second
// backend (MONAI, facade-less) slots a different descriptor into the engine, not
// a new provider file.
//
// The providers store dynamic-import()s this module so the engine stays out of
// the boot bundle until a provider is actually instantiated.
//
// House rules: functional style; `type`, not `interface`.
// ---------------------------------------------------------------------------

import type {
  ProcessingProvider,
  ProcessingProviderConfig,
} from '@/src/processing/types';
import { createEngineTransport } from './transport';
import { defaultDescriptor } from './descriptor';

export const createProvider = (
  config: ProcessingProviderConfig
): ProcessingProvider => {
  const transport = createEngineTransport(config.baseUrl, defaultDescriptor);
  return {
    config,
    listTasks: () => transport.listTasks(),
    getTaskSpec: (taskId) => transport.getTaskSpec(taskId),
    // Output filenames are auto-generated server-side, so v1 supplies no
    // provider-side default bindings (inputs are minted from provenance at
    // submit; see engine/mintInput.ts).
    getDefaultBindings: async () => ({}),
    runTask: (taskId, values) => transport.runTask(taskId, values),
    getJob: (jobId) => transport.getJob(jobId),
    getResults: (jobId) => transport.getResults(jobId),
  };
};
