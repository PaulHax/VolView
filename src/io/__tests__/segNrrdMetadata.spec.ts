import { describe, it, expect } from 'vitest';

import {
  buildSegNrrdMetadata,
  maybeBuildSegNrrdMetadata,
} from '@/src/io/segNrrdMetadata';
import type { SegmentGroupMetadata } from '@/src/store/segmentGroups';

// ---------------------------------------------------------------------------
// Serialization "round-trips segment names/colors" (Chunk 15 acceptance).
//
// `writeSegmentation('seg.nrrd', …)` embeds the segment names/colors by handing
// this metadata Map to the NRRD writer (readWriteImage.ts). The ITK-wasm write
// itself needs a web worker + wasm the happy-dom unit env cannot run, so the
// faithful, hermetic proof is at the metadata-embedding layer that DECIDES what
// gets written: the names/colors are embedded under the LITERAL 'seg.nrrd'
// format token, and dropped for any other token. That format-token gate is the
// load-bearing gotcha — passing 'nrrd' would silently ship a labelmap with no
// segment names/colors.
// ---------------------------------------------------------------------------

const metadata: SegmentGroupMetadata = {
  name: 'Tumor group',
  parentImage: 'img-1',
  segments: {
    order: [1, 2],
    byValue: {
      1: {
        value: 1,
        name: 'Tumor',
        color: [255, 0, 0, 255],
        visible: true,
        locked: false,
      },
      2: {
        value: 2,
        name: 'Edema',
        color: [0, 128, 255, 255],
        visible: true,
        locked: false,
      },
    },
  },
};

const dims: [number, number, number] = [4, 4, 2];

describe('buildSegNrrdMetadata embeds segment names + colors', () => {
  it('writes a Name / Color / LabelValue entry per segment, in order', () => {
    const m = buildSegNrrdMetadata(metadata, dims);

    // Segment 0 (label value 1) — pure red.
    expect(m.get('Segment0_Name')).toBe('Tumor');
    expect(m.get('Segment0_Color')).toBe('1.000000 0.000000 0.000000');
    expect(m.get('Segment0_LabelValue')).toBe('1');

    // Segment 1 (label value 2) — 128/255 → 0.501961, 255/255 → 1.
    expect(m.get('Segment1_Name')).toBe('Edema');
    expect(m.get('Segment1_Color')).toBe('0.000000 0.501961 1.000000');
    expect(m.get('Segment1_LabelValue')).toBe('2');
  });

  it('stamps the Slicer segmentation representation + extent from dimensions', () => {
    const m = buildSegNrrdMetadata(metadata, dims);
    expect(m.get('Segmentation_MasterRepresentation')).toBe('Binary labelmap');
    // extent = 0..dim-1 per axis.
    expect(m.get('Segment0_Extent')).toBe('0 3 0 3 0 1');
  });
});

describe('maybeBuildSegNrrdMetadata gates on the exact seg.nrrd token', () => {
  it('embeds names/colors ONLY for the literal "seg.nrrd" format', () => {
    const m = maybeBuildSegNrrdMetadata('seg.nrrd', metadata, dims);
    expect(m).toBeInstanceOf(Map);
    expect(m?.get('Segment0_Name')).toBe('Tumor');
    expect(m?.get('Segment1_Name')).toBe('Edema');
  });

  it('drops the metadata for any other token (the load-bearing gotcha)', () => {
    // Passing 'nrrd' (or 'nii.gz', 'vti', …) silently omits segment names/colors
    // — Chunk 15 must serialize with 'seg.nrrd', never saveFormat's 'vti' default.
    expect(maybeBuildSegNrrdMetadata('nrrd', metadata, dims)).toBeUndefined();
    expect(maybeBuildSegNrrdMetadata('nii.gz', metadata, dims)).toBeUndefined();
    expect(maybeBuildSegNrrdMetadata('vti', metadata, dims)).toBeUndefined();
  });
});
