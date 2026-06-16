import { z } from 'zod';

import { useProvidersStore } from '@/src/store/providers';
import type { Config } from '@/src/io/import/configJson';
import type {
  ProcessingProviderConfig,
  SourceRef,
} from '@/src/processing/types';

const sourceRef = z.string().transform((s) => s as SourceRef);

const loadedProcessingSource = z.object({
  datasetId: z.string(),
  name: z.string(),
  uri: z.string().optional(),
  sourceRef: sourceRef.optional(),
});

const processingContext = z.object({
  activeDatasetId: z.string().optional(),
  activeSourceRef: sourceRef.optional().nullable(),
  loadedSources: z.array(loadedProcessingSource).default([]),
});

const processingProviderConfig = z.object({
  id: z.string(),
  label: z.string(),
  protocol: z.enum(['slicer-cli']),
  baseUrl: z.string(),
  auth: z.enum(['same-origin', 'bearer', 'tokenUrl']).optional(),
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

const providerOrigin = (config: ProcessingProviderConfig) => {
  try {
    return new URL(config.baseUrl, window.location.href).origin;
  } catch {
    return null;
  }
};

// An allow-list entry may be a full origin (`https://host`) or a bare
// `host`/`host:port` an operator typed without a scheme; assume https for the
// latter so a common configuration mistake does not silently drop the entry.
const allowedOrigin = (entry: string) => {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)
    ? entry
    : `https://${entry}`;
  try {
    const { origin } = new URL(candidate);
    if (origin && origin !== 'null') return origin;
  } catch {
    // fall through to the warning below
  }
  console.warn(`Ignoring invalid processing origin: ${entry}`);
  return null;
};

// Same-origin is always allowed; the env list adds extra origins on top.
const allowedOrigins = () =>
  new Set([
    window.location.origin,
    ...(import.meta.env.VITE_PROCESSING_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(allowedOrigin)
      .filter((origin): origin is string => origin !== null),
  ]);

const isProviderOriginAllowed = (
  config: ProcessingProviderConfig,
  allowed: Set<string>
) => {
  const origin = providerOrigin(config);
  if (!origin) {
    console.warn(
      `Skipping processing provider "${config.id}" because baseUrl is invalid: ${config.baseUrl}`
    );
    return false;
  }

  if (allowed.has(origin)) return true;

  console.warn(
    `Skipping processing provider "${config.id}" because origin "${origin}" is not allowed`
  );
  return false;
};

export const applyProcessingConfig = (manifest: Config) => {
  const providersConfig = (manifest as ConfigWithProcessing).processing
    ?.providers;
  if (!providersConfig?.length) return;

  const allowed = allowedOrigins();
  const providers = useProvidersStore();
  providersConfig.forEach((p) => {
    if (!isProviderOriginAllowed(p, allowed)) return;
    providers.registerProviderConfig(p);
  });
};
