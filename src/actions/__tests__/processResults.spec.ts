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
  // The corroboration guard (Chunk 22) reads the loaded child + parent images.
  getImage: vi.fn(),
  // The live-only "new job result" badge (Chunk 22).
  markNew: vi.fn(),
  // Scene segment-group metadata, read by the tier-2 idempotency guard
  // (Chunk 19). Keyed by group id; only `source` matters here.
  metadataByID: {} as Record<
    string,
    { source?: { jobId: string; outputId: string } }
  >,
  // Message center. applyIntent no longer messages directly (#7): it reports
  // failure via its return value and JobList.dispatch owns the user-facing toast,
  // so these tests assert the applier NEVER calls addError.
  addError: vi.fn(),
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
vi.mock('@/src/utils/dataSelection', () => ({
  getImage: mocks.getImage,
}));
vi.mock('@/src/store/datasets-layers', () => ({
  useLayersStore: () => ({ addLayer: mocks.addLayer }),
}));
vi.mock('@/src/store/segmentGroups', () => ({
  useSegmentGroupStore: () => ({
    convertImageToLabelmap: mocks.convertImageToLabelmap,
    updateSegment: mocks.updateSegment,
    metadataByID: mocks.metadataByID,
  }),
}));
vi.mock('@/src/store/jobResultReview', () => ({
  useJobResultReviewStore: () => ({ markNew: mocks.markNew }),
}));
vi.mock('@/src/store/messages', () => ({
  useMessageStore: () => ({ addError: mocks.addError }),
}));

const file = { url: 'https://example/out.nrrd', name: 'out.nrrd' };
const rgba = (r: number, g: number, b: number, a: number) =>
  [r, g, b, a] as [number, number, number, number];

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

// A fake vtkImageData for the corroboration guard: `max` is the top of the
// scalar range (>= 1 = non-empty), `bounds` is the physical AABB.
const OVERLAP = [0, 10, 0, 10, 0, 10];
const DISJOINT = [100, 110, 100, 110, 100, 110];
const makeImage = (max: number, bounds: number[] = OVERLAP) => ({
  getPointData: () => ({ getScalars: () => ({ getRange: () => [0, max] }) }),
  getBounds: () => bounds,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadataByID = {};
  mocks.uriToDataSource.mockReturnValue({ type: 'uri' });
  mocks.importDataSources.mockResolvedValue([
    { type: 'data', dataID: 'child-1' },
  ]);
  mocks.isVolumeResult.mockReturnValue(true);
  mocks.toDataSelection.mockReturnValue('child-selection');
  // Default: the loaded labelmap corroborates (non-empty + overlaps the parent).
  mocks.getImage.mockImplementation(() => makeImage(3, OVERLAP));
  // convertImageToLabelmap now returns the created group id(s); descriptors +
  // the badge key off the returned ids.
  mocks.convertImageToLabelmap.mockResolvedValue(['seg-group']);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyIntent', () => {
  it('add-base-image opens the file as a new dataset', async () => {
    const applied = await applyIntent(
      { intent: 'add-base-image', ...file },
      context('parent')
    );
    expect(applied).toBe(true);
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
    const applied = await applyIntent(
      { intent: 'add-layer', ...file },
      context('parent')
    );
    expect(applied).toBe(true);
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

  it('add-segment-group converts the labelmap and applies descriptors to the created group', async () => {
    // Descriptors key off the id convertImageToLabelmap returns, not a racing
    // read of orderByParent (Chunk 22).
    mocks.convertImageToLabelmap.mockResolvedValue(['group-1']);
    const segments = [
      { value: 1, name: 'liver', color: rgba(255, 0, 0, 255) },
      { value: 2, name: 'tumor', color: rgba(0, 255, 0, 255), visible: false },
    ];
    await applyIntent(
      { intent: 'add-segment-group', ...file, segments },
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent',
      undefined
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

  it('add-segment-group with no segments still converts (embedded metadata)', async () => {
    await applyIntent(
      { intent: 'add-segment-group', ...file },
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent',
      undefined
    );
    // No folded sidecar -> the group keeps its own decoded segments.
    expect(mocks.updateSegment).not.toHaveBeenCalled();
  });

  it('stamps the source:{jobId,outputId} tag on the created group', async () => {
    const source = { jobId: 'job-abc123', outputId: 'outputLabelmap' };
    await applyIntent(
      { intent: 'add-segment-group', ...file, source },
      context('parent')
    );
    // The tag threads through convertImageToLabelmap -> addLabelmap so it
    // round-trips the .volview.zip (Chunk 11 stamp; Chunk 19 idempotency).
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent',
      source
    );
  });

  it('add-segment-group with no originating dataset falls back to opening', async () => {
    await applyIntent(
      { intent: 'add-segment-group', ...file },
      context(undefined)
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.loadUrls).toHaveBeenCalledWith({
      urls: [file.url],
      names: [file.name],
    });
  });

  it('add-segment-group reports failure (false) when the result fails to load (#7)', async () => {
    // loadAsImport returns null (404/corrupt/non-volume). applyIntent reports the
    // failure via its return value rather than messaging; JobList.dispatch owns
    // the toast so the same site also covers a THROWN apply failure.
    mocks.importDataSources.mockResolvedValue([]);
    const applied = await applyIntent(
      { intent: 'add-segment-group', ...file },
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(applied).toBe(false);
    expect(mocks.addError).not.toHaveBeenCalled();
  });

  it('add-layer reports failure (false) when the result fails to load (#7)', async () => {
    mocks.importDataSources.mockResolvedValue([]);
    const applied = await applyIntent(
      { intent: 'add-layer', ...file },
      context('parent')
    );
    expect(mocks.addLayer).not.toHaveBeenCalled();
    expect(applied).toBe(false);
    expect(mocks.addError).not.toHaveBeenCalled();
  });

  it('is additive-only: writes into the NEW group, never a pre-existing one', async () => {
    // A pre-existing group is present for the parent. Applying a segment-group
    // result must create a NEW group (convertImageToLabelmap) and apply
    // descriptors to it — never merge into the existing group.
    mocks.metadataByID = { 'existing-group': {} };
    mocks.convertImageToLabelmap.mockResolvedValue(['new-group']);
    await applyIntent(
      {
        intent: 'add-segment-group',
        ...file,
        segments: [{ value: 1, name: 'liver', color: rgba(1, 2, 3, 4) }],
      },
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
    // Descriptors land on the freshly-created group, not the existing one.
    expect(mocks.updateSegment).toHaveBeenCalledWith(
      'new-group',
      1,
      expect.anything()
    );
    expect(mocks.updateSegment).not.toHaveBeenCalledWith(
      'existing-group',
      expect.anything(),
      expect.anything()
    );
  });

  it('degrades an UNKNOWN intent to download (no store mutation)', async () => {
    await applyIntent(
      { intent: 'add-polygon', ...file } as never,
      context('parent')
    );
    expect(mocks.loadUrls).not.toHaveBeenCalled();
    expect(mocks.addLayer).not.toHaveBeenCalled();
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
  });

  it('degrades a known name with an INVALID payload to download', async () => {
    // `add-segment-group` name but a shape-invalid segment (value 0 = the
    // reserved background) fails the strict member — it must NOT be applied as
    // a segment group; it degrades to the download floor (in-flight decision).
    await applyIntent(
      {
        intent: 'add-segment-group',
        ...file,
        segments: [{ value: 0, name: 'bad', color: rgba(1, 2, 3, 4) }],
      },
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.loadUrls).not.toHaveBeenCalled();
  });
});

describe('autoLoadProcessingResults', () => {
  it('auto-applies only add-segment-group results, ignoring the rest', async () => {
    mocks.convertImageToLabelmap.mockResolvedValue(['seg-group']);
    await autoLoadProcessingResults(
      [
        result({ id: 'a', intent: 'add-base-image' }),
        result({ id: 'b', intent: 'add-layer' }),
        result({
          id: 'c',
          intent: 'add-segment-group',
          source: { jobId: 'j1', outputId: 'seg' },
          segments: [{ value: 1, name: 'liver', color: rgba(1, 2, 3, 4) }],
        }),
      ],
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent',
      { jobId: 'j1', outputId: 'seg' }
    );
    expect(mocks.updateSegment).toHaveBeenCalledTimes(1);
    // The corroborated group is badged as a new job result (born-persistent).
    expect(mocks.markNew).toHaveBeenCalledTimes(1);
    expect(mocks.markNew).toHaveBeenCalledWith('seg-group');
    // The base / layer results must not auto-load.
    expect(mocks.loadUrls).not.toHaveBeenCalled();
    expect(mocks.addLayer).not.toHaveBeenCalled();
  });

  it('does not auto-apply an unknown intent (degraded to download)', async () => {
    await autoLoadProcessingResults(
      [result({ intent: 'add-polygon' })],
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.markNew).not.toHaveBeenCalled();
    expect(mocks.loadUrls).not.toHaveBeenCalled();
  });

  it('applies nothing when there is no originating dataset', async () => {
    await autoLoadProcessingResults(
      [result({ intent: 'add-segment-group' })],
      context(undefined)
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.markNew).not.toHaveBeenCalled();
    expect(mocks.loadUrls).not.toHaveBeenCalled();
  });

  it('keeps applying after one segment-group result throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.convertImageToLabelmap
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(['g2']);
    await autoLoadProcessingResults(
      [
        result({ id: 'a', intent: 'add-segment-group' }),
        result({ id: 'b', intent: 'add-segment-group' }),
      ],
      context('parent')
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Corroboration guard (Chunk 22, work item 1): auto-show ONLY a validated
// labelmap (decodes / non-empty / segments resolve / overlaps the parent). A
// failing result is NOT auto-shown — it falls back to the explicit JobList path
// as a downloadable file. The explicit `applyIntent` path is NOT gated (a user
// click is the fallback itself).
// ---------------------------------------------------------------------------

describe('autoLoadProcessingResults — corroboration guard', () => {
  const segResult = () => result({ id: 'seg', intent: 'add-segment-group' });

  it('auto-shows a corroborated result and badges it new', async () => {
    mocks.convertImageToLabelmap.mockResolvedValue(['seg-group']);
    await autoLoadProcessingResults([segResult()], context('parent'));
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
    expect(mocks.markNew).toHaveBeenCalledWith('seg-group');
  });

  it('does NOT auto-show an empty labelmap (no segment resolves)', async () => {
    // Child scalar range tops out at background (0): nothing to show.
    mocks.getImage.mockImplementation((id: string) =>
      makeImage(id === 'parent' ? 3 : 0, OVERLAP)
    );
    await autoLoadProcessingResults([segResult()], context('parent'));
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.markNew).not.toHaveBeenCalled();
  });

  it('does NOT auto-show a labelmap that does not overlap the parent', async () => {
    mocks.getImage.mockImplementation((id: string) =>
      makeImage(3, id === 'parent' ? OVERLAP : DISJOINT)
    );
    await autoLoadProcessingResults([segResult()], context('parent'));
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.markNew).not.toHaveBeenCalled();
  });

  it('does NOT auto-show a result that fails to decode', async () => {
    // No importable volume -> loadAsImport returns null.
    mocks.importDataSources.mockResolvedValue([]);
    await autoLoadProcessingResults([segResult()], context('parent'));
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    expect(mocks.markNew).not.toHaveBeenCalled();
    // The AUTO-SHOW path stays fail-closed SILENT (#7 messages only on the
    // explicit JobList action) — the result is still reachable as a JobList file.
    expect(mocks.addError).not.toHaveBeenCalled();
  });

  it('a failing guard is a pure no-op (still a JobList/download file)', async () => {
    mocks.getImage.mockImplementation((id: string) =>
      makeImage(id === 'parent' ? 3 : 0, OVERLAP)
    );
    await autoLoadProcessingResults([segResult()], context('parent'));
    // No dataset opened, no layer, no segment group — the applier made no scene
    // change, so the result remains only in JobList (downloadable).
    expect(mocks.loadUrls).not.toHaveBeenCalled();
    expect(mocks.addLayer).not.toHaveBeenCalled();
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Born-persistent review model (Chunk 22 in-flight call, D6 "Review UX"): a
// validated result is a NORMAL, deletable segment group — no confirm/reject
// gate, no promotion state machine. The ONLY review surface is the live-only
// badge (markNew) + the existing visibility/delete UI.
// ---------------------------------------------------------------------------

describe('autoLoadProcessingResults — born-persistent (no confirm gate)', () => {
  it('applies the group immediately and its only review surface is the badge', async () => {
    const source = { jobId: 'j1', outputId: 'seg' };
    mocks.convertImageToLabelmap.mockResolvedValue(['seg-group']);
    await autoLoadProcessingResults(
      [result({ id: 'seg', intent: 'add-segment-group', source })],
      context('parent')
    );
    // The group is created straight away (born-persistent), stamped with source.
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent',
      source
    );
    // The badge is the whole review surface — there is no confirm/promotion call
    // the applier could make beyond marking the group new.
    expect(mocks.markNew).toHaveBeenCalledTimes(1);
    expect(mocks.markNew).toHaveBeenCalledWith('seg-group');
  });
});

// ---------------------------------------------------------------------------
// Tier-2 auto-re-attach gating (Chunk 19, D5): the SAME applier serves tier-1
// (in-session, no `finishedAt`) and tier-2 (cold-reload) completions. The
// session watermark is the primary reject-durability + accretion bound; the
// scene-state `source` tag is the secondary idempotency guard.
// ---------------------------------------------------------------------------

describe('autoLoadProcessingResults — tier-2 watermark + idempotency', () => {
  const source = { jobId: 'j1', outputId: 'seg' };
  const segResult = () =>
    result({ id: 'seg', intent: 'add-segment-group', source });
  const tier2Context = (
    activeDatasetId: string | undefined,
    finishedAt: string
  ): SubmittedJobContext => ({ ...context(activeDatasetId), finishedAt });

  it('re-discovered (tier-2) job auto-re-attaches born-persistent — no confirm gate', async () => {
    // A job from a prior page life (carries `finishedAt`, past the watermark)
    // re-attaches with the identical flow as tier-1: applied + badged, with no
    // extra confirm/review step gating it.
    mocks.convertImageToLabelmap.mockResolvedValue(['seg-group']);
    await autoLoadProcessingResults(
      [segResult()],
      tier2Context('parent', '2026-07-03T20:00:00Z'),
      '2026-07-03T12:00:00Z'
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
    expect(mocks.markNew).toHaveBeenCalledWith('seg-group');
  });

  it('watermark: a job finished AFTER sessionSavedAt attaches', async () => {
    await autoLoadProcessingResults(
      [segResult()],
      tier2Context('parent', '2026-07-03T20:00:00Z'),
      '2026-07-03T12:00:00Z'
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
  });

  it('watermark: a job finished BEFORE sessionSavedAt does not attach (reject-then-save stays rejected)', async () => {
    await autoLoadProcessingResults(
      [segResult()],
      tier2Context('parent', '2026-07-03T10:00:00Z'),
      '2026-07-03T12:00:00Z'
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
  });

  it('watermark: no watermark → attach all (MVP parity), even a pre-dated job', async () => {
    await autoLoadProcessingResults(
      [segResult()],
      tier2Context('parent', '2020-01-01T00:00:00Z'),
      undefined
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
  });

  it('watermark: kept-result case — session restored the group AND the job is pre-watermark → exactly one group (no re-apply)', async () => {
    // The restored scene already holds the group (its source round-tripped the
    // zip); the job sits behind the watermark. Neither gate re-applies it, so
    // the single restored group stays exactly one.
    mocks.metadataByID = { restored: { source } };
    await autoLoadProcessingResults(
      [segResult()],
      tier2Context('parent', '2026-07-03T10:00:00Z'),
      '2026-07-03T12:00:00Z'
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
  });

  it('idempotency: no watermark, the tagged group already in the scene → no duplicate', async () => {
    mocks.metadataByID = { restored: { source } };
    await autoLoadProcessingResults(
      [segResult()],
      context('parent'),
      undefined
    );
    expect(mocks.convertImageToLabelmap).not.toHaveBeenCalled();
    // A session-restored (already-reviewed) group is not re-badged.
    expect(mocks.markNew).not.toHaveBeenCalled();
  });

  it('idempotency: no watermark, a fresh scene (tag absent) → re-applies exactly once', async () => {
    mocks.metadataByID = {}; // fresh scene
    mocks.convertImageToLabelmap.mockResolvedValue(['seg-group']);
    await autoLoadProcessingResults(
      [segResult()],
      context('parent'),
      undefined
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledWith(
      'child-selection',
      'parent',
      source
    );
  });

  it('idempotency: a hand-painted group (no source) never blocks a job group', async () => {
    // A group with no `source` (native/hand-painted) must not shadow the job's
    // group — the tag, not mere presence, is the key.
    mocks.metadataByID = { painted: {} };
    await autoLoadProcessingResults(
      [segResult()],
      context('parent'),
      undefined
    );
    expect(mocks.convertImageToLabelmap).toHaveBeenCalledTimes(1);
  });
});
