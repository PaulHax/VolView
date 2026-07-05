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
  // Explicit folder-free base for the job-addressed routes (status/results/cancel;
  // D5). MUST be listed here because zod strips unknown keys — omitting it would
  // silently drop a facade-sent jobsBaseUrl before it reaches the provider. Absent
  // ⇒ the transport falls back to baseUrl (additive).
  jobsBaseUrl: z.string().optional(),
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
  // Gate EVERY egress target the provider would reach: the folder-scoped baseUrl
  // and (when present) the folder-free jobsBaseUrl the job-addressed routes use.
  // Both carry the bearer via `$fetch`, so an ungated jobsBaseUrl would be a
  // token-exfiltration hole — fail closed on either (D9, the single egress gate).
  const targets = [config.baseUrl, config.jobsBaseUrl].filter(
    (url): url is string => url !== undefined
  );

  const invalid = targets.find((url) => resolveOrigin(url) === null);
  if (invalid !== undefined) {
    console.warn(
      `Skipping processing provider "${config.id}" because baseUrl is invalid: ${invalid}`
    );
    return false;
  }

  const rejected = (
    await Promise.all(
      targets.map(async (url) => ({ url, allowed: await isOriginAllowed(url) }))
    )
  ).find((r) => !r.allowed);
  if (!rejected) return true;

  console.warn(
    `Skipping processing provider "${config.id}" because origin "${resolveOrigin(
      rejected.url
    )}" is not allowed`
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
