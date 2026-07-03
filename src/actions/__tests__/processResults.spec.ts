import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyIntent,
  autoLoadProcessingResults,
} from '@/src/actions/processResults';
import type {
  ProcessingResult,
  SubmittedJobContext,
} from '@/src/processing/types';

// Mock every store / import boundary the applier touches so each test can
// assert exactly which store call an intent maps to. `vi.hoisted` lets the
// (hoisted) `vi.mock` factories share these spies.
const mocks = vi.hoisted(() => ({
  uriToDataSource: vi.fn(),
  importDataSources: vi.fn(),
  toDataSelection: vi.fn(),
  isVolumeResult: vi.fn(),
  loadUrls: vi.fn(),
  addLayer: vi.fn(),
  convertImageToLabelmap: vi.fn(),
  updateSegment: vi.fn(),
  orderByParent: { value: {} as Record<string, string[]> },
}));

vi.mock('@/src/io/import/dataSource', () => ({
  uriToDataSource: mocks.uriToDataSource,
}));
vi.mock('@/src/io/import/importDataSources', () => ({
  importDataSources: mocks.importDataSources,
  toDataSelection: mocks.toDataSelection,
}));
vi.mock('@/src/io/import/common', () => ({
  isVolumeResult: mocks.isVolumeResult,
}));
vi.mock('@/src/actions/loadUserFiles', () => ({
  loadUrls: mocks.loadUrls,
}));
vi.mock('@/src/store/datasets-layers', () => ({
  useLayersStore: () => ({ addLayer: mocks.addLayer }),
}));
vi.mock('@/src/store/segmentGroups', () => ({
  useSegmentGroupStore: () => ({
    convertImageToLabelmap: mocks.convertImageToLabelmap,
    updateSegment: mocks.updateSegment,
    orderByParent: mocks.orderByParent,
  }),
}));
vi.mock('pinia', async (orig) => {
  const actual = await orig<typeof import('pinia')>();
  // The segment-group store mock exposes `orderByParent` as a ref-like object,
  // so storeToRefs only needs to pass the store through.
  return { ...actual, storeToRefs: (store: unknown) => store };
});

const file = { url: 'https://example/out.nrrd', name: 'out.nrrd' };

const context = (activeDatasetId?: string): SubmittedJobContext => ({
  jobId: 'j1',
  taskId: 't1',
  providerId: 'p1',
  submittedAt: '2026-06-16T00:00:00Z',
  activeDatasetId,
});

const result = (
  overrides: Partial<ProcessingResult> = {}
): ProcessingResult => ({
  id: 'r1',
  name: file.name,
  url: file.url,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orderByParent.value = {};
  mocks.uriToDataSource.mockReturnValue({ type: 'uri' });
  mocks.importDataSources.mockResolvedValue([
    { type: 'data', dataID: 'child-1' },
  ]);
  mocks.isVolumeResult.mockReturnValue(true);
  mocks.toDataSelection.mockReturnValue('child-selection');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyIntent', () => {
  it('add-base-image opens the file as a new dataset', async () => {
    await applyIntent({ intent: 'add-base-image', ...file }, context('parent'));
    expect(mocks.loadUrls).toHaveBeenCalledWith({
      urls: [file.url],
      names: [file.name],
    });
    expect(mocks.addLayer).not.toHaveBeenCalled();
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
  });

  it('restore-state opens the file (no dedicated session restore yet)', async () => {
    await applyIntent({ intent: 'restore-state', ...file }, context('parent'));
    expect(mocks.loadUrls).toHaveBeenCalledWith({
      urls: [file.url],
      names: [file.name],
    });
  });

  it('download performs no store mutation', async () => {
    await applyIntent({ intent: 'download', ...file }, context('parent'));
    expect(mocks.loadUrls).not.toHaveBeenCalled();
    expect(mocks.addLayer).not.toHaveBeenCalled();
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
  });

  it('add-layer attaches a layer onto the originating dataset', async () => {
    await applyIntent({ intent: 'add-layer', ...file }, context('parent'));
    expect(mocks.addLayer).toHaveBeenCalledWith('parent', 'child-selection');
    expect(mocks.loadUrls).not.toHaveBeenCalled();
  });

  it('add-layer with no originating dataset falls back to opening', async () => {
    await applyIntent({ intent: 'add-layer', ...file }, context(undefined));
    expect(mocks.addLayer).not.toHaveBeenCalled();
    expect(mocks.loadUrls).toHaveBeenCalledWith({
      urls: [file.url],
      names: [file.name],
    });
  });

  it('attach-segment-group converts the labelmap and applies descriptors', async () => {
    mocks.orderByParent.value = { parent: ['group-1'] };
    const segments = [
      {
        value: 1,
        name: 'liver',
        color: [255, 0, 0, 255] as [number, number, number, number],
      },
      {
        value: 2,
        name: 'tumor',
        color: [0, 255, 0, 255] as [number, number, number, number],
        visible: false,
      },
    ];
    await applyIntent(
      { intent: 'attach-segment-group', ...file, segments },
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent'
    );
    expect(mocks.updateSegment).toHaveBeenCalledTimes(2);
    expect(mocks.updateSegment).toHaveBeenCalledWith('group-1', 1, {
      name: 'liver',
      color: [255, 0, 0, 255],
    });
    expect(mocks.updateSegment).toHaveBeenCalledWith('group-1', 2, {
      name: 'tumor',
      color: [0, 255, 0, 255],
      visible: false,
    });
    expect(mocks.loadUrls).not.toHaveBeenCalled();
  });

  it('attach-segment-group with no originating dataset falls back to opening', async () => {
    await applyIntent(
      { intent: 'attach-segment-group', ...file, segments: [] },
      context(undefined)
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.loadUrls).toHaveBeenCalledWith({
      urls: [file.url],
      names: [file.name],
    });
  });
});

describe('autoLoadProcessingResults', () => {
  it('auto-applies only attach-segment-group results, ignoring the rest', async () => {
    mocks.orderByParent.value = { parent: ['group-1'] };
    await autoLoadProcessingResults(
      [
        result({ id: 'a', role: 'base' }),
        result({ id: 'b', role: 'layer' }),
        result({
          id: 'c',
          role: 'segmentGroup',
          segments: [{ value: 1, name: 'liver', color: [1, 2, 3, 4] }],
        }),
      ],
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent'
    );
    expect(mocks.updateSegment).toHaveBeenCalledTimes(1);
    // The base / layer results must not auto-load.
    expect(mocks.loadUrls).not.toHaveBeenCalled();
    expect(mocks.addLayer).not.toHaveBeenCalled();
  });

  it('applies nothing when there is no originating dataset', async () => {
    await autoLoadProcessingResults(
      [result({ role: 'segmentGroup', segments: [] })],
      context(undefined)
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.loadUrls).not.toHaveBeenCalled();
  });

  it('keeps applying after one segment-group result throws', async () => {
    mocks.orderByParent.value = { parent: ['group-1'] };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.convertImageToLabelmap
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    await autoLoadProcessingResults(
      [
        result({ id: 'a', role: 'segmentGroup', segments: [] }),
        result({ id: 'b', role: 'segmentGroup', segments: [] }),
      ],
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
  });
});
