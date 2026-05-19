import { z } from 'zod';
import { zodEnumFromObjKeys } from '@/src/utils';
import { ACTIONS } from '@/src/constants';

import { useRectangleStore } from '@/src/store/tools/rectangles';
import { useRulerStore } from '@/src/store/tools/rulers';
import { usePolygonStore } from '@/src/store/tools/polygons';
import { useViewStore } from '@/src/store/views';
import { useWindowingStore } from '@/src/store/view-configs/windowing';
import { actionToKey } from '@/src/composables/useKeyboardShortcuts';
import { useSegmentGroupStore } from '@/src/store/segmentGroups';
import { AnnotationToolStore } from '@/src/store/tools/useAnnotationTool';
import useLoadDataStore from '@/src/store/load-data';
import { layoutConfig } from '@/src/utils/layoutParsing';
import { useProvidersStore } from '@/src/store/providers';
import type {
  ProcessingProviderConfig,
  SourceRef,
} from '@/src/processing/types';

// --------------------------------------------------------------------------
// Layout

const layouts = z.record(z.string(), layoutConfig).optional();

// --------------------------------------------------------------------------
// Keyboard shortcuts

const shortcuts = z
  .partialRecord(zodEnumFromObjKeys(ACTIONS), z.string())
  .optional();

// --------------------------------------------------------------------------
// Labels

const color = z.string();

const label = z.object({
  color,
  strokeWidth: z.number().optional(),
});

const rulerLabel = label;
const polygonLabel = label;

const rectangleLabel = z.intersection(
  label,
  z.object({
    fillColor: color,
  })
);

const labels = z
  .object({
    defaultLabels: z.record(z.string(), label).or(z.null()).optional(),
    rulerLabels: z.record(z.string(), rulerLabel).or(z.null()).optional(),
    rectangleLabels: z
      .record(z.string(), rectangleLabel)
      .or(z.null())
      .optional(),
    polygonLabels: z.record(z.string(), polygonLabel).or(z.null()).optional(),
  })
  .optional();

// --------------------------------------------------------------------------
// IO

const io = z
  .object({
    segmentGroupSaveFormat: z.string().optional(),
    segmentGroupExtension: z.string().default(''),
    layerExtension: z.string().default(''),
  })
  .optional();

// --------------------------------------------------------------------------
// Window Level

const windowing = z
  .object({
    level: z.number(),
    width: z.number(),
  })
  .optional();

const disabledViewTypes = z.array(z.enum(['2D', '3D', 'Oblique'])).optional();

// --------------------------------------------------------------------------
// Processing

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

const processing = z
  .object({
    providers: z.array(processingProviderConfig).default([]),
  })
  .optional();

export const config = z.object({
  layouts,
  labels,
  shortcuts,
  io,
  windowing,
  disabledViewTypes,
  processing,
});

export type Config = z.infer<typeof config>;

export const readConfigFile = async (configFile: File) => {
  const decoder = new TextDecoder();
  const ab = await configFile.arrayBuffer();
  const text = decoder.decode(new Uint8Array(ab));
  return config.parse(JSON.parse(text));
};

const applyLabels = (manifest: Config) => {
  if (!manifest.labels) return;

  // pass through null labels, use fallback labels if undefined
  const defaultLabelsIfUndefined = <T>(toolLabels: T) => {
    if (toolLabels === undefined) return manifest.labels?.defaultLabels;
    return toolLabels;
  };

  const applyLabelsToStore = (
    store: AnnotationToolStore,
    maybeLabels: (typeof manifest.labels)[keyof typeof manifest.labels]
  ) => {
    const labelsOrFallback = defaultLabelsIfUndefined(maybeLabels);
    if (!labelsOrFallback) return;
    store.clearDefaultLabels();
    store.mergeLabels(labelsOrFallback);
  };

  const { rulerLabels, rectangleLabels, polygonLabels } = manifest.labels;
  applyLabelsToStore(useRulerStore(), rulerLabels);
  applyLabelsToStore(useRectangleStore(), rectangleLabels);
  applyLabelsToStore(usePolygonStore(), polygonLabels);
};

const applyLayout = (manifest: Config) => {
  if (!manifest.layouts) return;

  const viewStore = useViewStore();
  const layoutEntries = Object.entries(manifest.layouts);

  if (layoutEntries.length === 0) return;

  viewStore.setNamedLayoutsFromConfig(manifest.layouts);

  const firstLayoutName = layoutEntries[0][0];
  viewStore.switchToNamedLayout(firstLayoutName);
};

const applyShortcuts = (manifest: Config) => {
  if (!manifest.shortcuts) return;

  actionToKey.value = {
    ...actionToKey.value,
    ...manifest.shortcuts,
  };
};

const applyIo = (manifest: Config) => {
  if (!manifest.io) return;

  if (manifest.io.segmentGroupSaveFormat)
    useSegmentGroupStore().saveFormat = manifest.io.segmentGroupSaveFormat;
  const loadDataStore = useLoadDataStore();
  loadDataStore.segmentGroupExtension = manifest.io.segmentGroupExtension;
  loadDataStore.layerExtension = manifest.io.layerExtension;
};

const applyWindowing = (manifest: Config) => {
  if (!manifest.windowing) return;

  useWindowingStore().runtimeConfigWindowLevel = manifest.windowing;
};

const applyDisabledViewTypes = (manifest: Config) => {
  if (!manifest.disabledViewTypes) return;

  useViewStore().disabledViewTypes = manifest.disabledViewTypes;
};

const applyProcessing = (manifest: Config) => {
  if (!manifest.processing?.providers?.length) return;
  const providers = useProvidersStore();
  manifest.processing.providers.forEach((p) => {
    providers.registerProviderConfig(p as ProcessingProviderConfig);
  });
};

export const applyPreStateConfig = (manifest: Config) => {
  applyDisabledViewTypes(manifest);
  applyLayout(manifest);
  applyShortcuts(manifest);
  applyIo(manifest);
  applyWindowing(manifest);
  applyProcessing(manifest);
};

export const applyPostStateConfig = (manifest: Config) => {
  applyLabels(manifest);
};
