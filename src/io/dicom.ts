import {
  readOverlappingSegmentation,
  ReadOverlappingSegmentationResult,
} from '@itk-wasm/dicom';

import { getWorker } from '@/src/io/itk/worker';

/**
 * Filenames must be sanitized prior to being passed into itk-wasm.
 *
 * In particular, forward slashes cause FS errors in itk-wasm.
 * @param name
 * @returns
 */
function sanitizeFileName(name: string) {
  return name.replace(/\//g, '_');
}

/**
 * Returns a new File instance with a sanitized name.
 * @param file
 */
function sanitizeFile(file: File) {
  return new File([file], sanitizeFileName(file.name));
}

export type Segment = {
  SegmentLabel: string;
  labelID: number;
  recommendedDisplayRGBValue: [number, number, number];
};

export type ReadOverlappingSegmentationMeta = {
  segmentAttributes: Segment[][];
};

type ReadOverlappingSegmentationResultWithRealMeta =
  ReadOverlappingSegmentationResult & {
    metaInfo: ReadOverlappingSegmentationMeta;
  };

export async function buildSegmentGroups(file: File) {
  const inputImage = sanitizeFile(file);
  const result = (await readOverlappingSegmentation(inputImage, {
    webWorker: getWorker(),
    mergeSegments: true,
  })) as ReadOverlappingSegmentationResultWithRealMeta;
  return {
    ...result,
    outputImage: result.segImage,
  };
}
