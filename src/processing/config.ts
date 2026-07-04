import { z } from 'zod';

import { useProvidersStore } from '@/src/store/providers';
import { isOriginAllowed, resolveOrigin } from '@/src/io/originGate';
import type { Config } from '@/src/io/import/configJson';
import type { ProcessingProviderConfig } from '@/src/processing/types';

const processingContext = z.object({
  activeDatasetId: z.string().optional(),
});

const processingProviderConfig = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  context: processingContext.optional(),
});

const processingConfigShape = {
  processing: z
    .object({
      providers: z.array(processingProviderConfig).default([]),
    })
    .optional(),
};

type ConfigWithProcessing = Config & {
  processing?: {
    providers?: ProcessingProviderConfig[];
  };
};

export const withProcessingConfig = <Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>
) => schema.extend(processingConfigShape);

// Provider registration is gated by the shared runtime egress gate
// (`io/originGate`): same-origin always registers (the deployment's own facade,
// zero config); a cross-origin provider registers only if the deployment's
// same-origin allow-list names its origin. The gate reads the allow-list solely
// from the deployment-controlled source, so a config can never allow-list its
// own provider — trust attaches to where the provider points, not to how the
// config arrived.
const isProviderOriginAllowed = async (
  config: ProcessingProviderConfig
): Promise<boolean> => {
  const origin = resolveOrigin(config.baseUrl);
  if (!origin) {
    console.warn(
      `Skipping processing provider "${config.id}" because baseUrl is invalid: ${config.baseUrl}`
    );
    return false;
  }

  if (await isOriginAllowed(config.baseUrl)) return true;

  console.warn(
    `Skipping processing provider "${config.id}" because origin "${origin}" is not allowed`
  );
  return false;
};

export const applyProcessingConfig = async (manifest: Config) => {
  const providersConfig = (manifest as ConfigWithProcessing).processing
    ?.providers;
  if (!providersConfig?.length) return;

  const providers = useProvidersStore();
  // The allow-list is fetched once and cached, so gating providers in parallel
  // still issues a single origin-file request. Registration is keyed by id, so
  // ordering is immaterial.
  await Promise.all(
    providersConfig.map(async (p) => {
      if (await isProviderOriginAllowed(p)) providers.registerProviderConfig(p);
    })
  );
};
