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

const allowedOrigins = () =>
  new Set(
    (import.meta.env.VITE_PROCESSING_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          console.warn(`Ignoring invalid processing origin: ${origin}`);
          return null;
        }
      })
      .filter((origin): origin is string => origin !== null)
  );

const isProviderOriginAllowed = (config: ProcessingProviderConfig) => {
  const origin = providerOrigin(config);
  if (!origin) {
    console.warn(
      `Skipping processing provider "${config.id}" because baseUrl is invalid: ${config.baseUrl}`
    );
    return false;
  }

  if (origin === window.location.origin) return true;
  if (allowedOrigins().has(origin)) return true;

  console.warn(
    `Skipping processing provider "${config.id}" because origin "${origin}" is not allowed`
  );
  return false;
};

export const applyProcessingConfig = (manifest: Config) => {
  const providersConfig = (manifest as ConfigWithProcessing).processing
    ?.providers;
  if (!providersConfig?.length) return;

  const providers = useProvidersStore();
  providersConfig.forEach((p) => {
    if (!isProviderOriginAllowed(p)) return;
    providers.registerProviderConfig(p);
  });
};
