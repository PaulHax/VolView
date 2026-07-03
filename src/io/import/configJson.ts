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

export const config = z.object({
  layouts,
  labels,
  shortcuts,
  io,
  windowing,
  disabledViewTypes,
});

export type Config = z.infer<typeof config>;

// ---------------------------------------------------------------------------
// Config-by-shape recognition (D9, chunk 2)
//
// Config may arrive via ANY channel — launch manifest, dropped file, or a JSON
// inside the normal `urls=` file list. There is no channel distinction: a JSON
// is recognized as config purely BY SHAPE, and trust for the `processing`
// section attaches later to the provider's ORIGIN (see io/originGate), never to
// how the config arrived.
//
// Recognition is strict on the trust boundary so a data JSON can't drift into
// being read as config:
//   - zero known top-level section keys          => data (silent; plain import)
//   - >=1 known key AND >=1 unknown top-level key => near-miss: surfaced by the
//                                                    caller, then imported as
//                                                    data (a newer config on an
//                                                    older client is a visible
//                                                    error, not a silent import)
//   - only known top-level keys                   => config (values validated)

export type ConfigRecognition =
  | { kind: 'config'; config: Config }
  | { kind: 'near-miss'; unknownKeys: string[] }
  | { kind: 'data' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const recognizeConfig = async (
  raw: unknown
): Promise<ConfigRecognition> => {
  if (!isPlainObject(raw)) return { kind: 'data' };

  // The full schema (base sections + `processing`) defines the known top-level
  // keys. Imported lazily so the processing schema stays in its own chunk.
  const { withProcessingConfig } = await import('@/src/processing/config');
  const fullConfig = withProcessingConfig(config);
  const knownKeys = new Set(Object.keys(fullConfig.shape));

  const presentKeys = Object.keys(raw);
  const knownPresent = presentKeys.filter((key) => knownKeys.has(key));
  // No config signal at all — a plain data JSON. Falls through silently so a
  // stray data file is not announced as a config near-miss.
  if (knownPresent.length === 0) return { kind: 'data' };

  const unknownKeys = presentKeys.filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) return { kind: 'near-miss', unknownKeys };

  // Every top-level key is a known section: validate the values. A malformed
  // value throws (a config-shaped file with a broken section is a real error).
  return { kind: 'config', config: fullConfig.parse(raw) };
};

export const recognizeConfigFile = async (
  file: File
): Promise<ConfigRecognition> => {
  const text = new TextDecoder().decode(
    new Uint8Array(await file.arrayBuffer())
  );
  return recognizeConfig(JSON.parse(text));
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

const applyProcessing = async (manifest: Config) => {
  const { applyProcessingConfig } = await import('@/src/processing/config');
  await applyProcessingConfig(manifest);
};

export const applyPreStateConfig = async (manifest: Config) => {
  applyDisabledViewTypes(manifest);
  applyLayout(manifest);
  applyShortcuts(manifest);
  applyIo(manifest);
  applyWindowing(manifest);
  await applyProcessing(manifest);
};

export const applyPostStateConfig = (manifest: Config) => {
  applyLabels(manifest);
};
