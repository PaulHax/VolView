import { describe, expect, it } from 'vitest';
import { DicomMetaLoader } from '@/src/core/streaming/dicom/dicomMetaLoader';
import { Tags } from '@/src/core/dicomTags';
import { readDicomTags } from '@/src/io/readDicomTags';
import {
  bytesFetcher,
  countingFetcher,
  deliveredBytes,
  pixelDataStart,
  syntheticSlice,
  withoutPixelData,
} from './dicomSourceFixtures';

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

const REGION = { physicalDeltaX: 0.0625, physicalDeltaY: 0.125 };

describe('DicomMetaLoader over a byte source', () => {
  it('reads the file tags with the JS reader by default', async () => {
    const bytes = syntheticSlice({ patientName: 'DOE^JOHN', modality: 'CT' });
    const loader = new DicomMetaLoader(bytesFetcher(bytes));

    await loader.load();

    expect(loader.meta).toEqual(readDicomTags(bytes));
  });

  it('stops at Pixel Data and keeps the header bytes verbatim', async () => {
    const bytes = syntheticSlice();
    const offset = pixelDataStart(bytes);
    const loader = new DicomMetaLoader(bytesFetcher(bytes));

    await loader.load();

    expect(loader.pixelDataOffset).toBe(offset);
    expect(loader.metaBlob).toBeTruthy();
    expect(await bytesOf(loader.metaBlob!)).toEqual(bytes.slice(0, offset));
  });

  it('leaves the byte source undelivered past Pixel Data', async () => {
    const bytes = syntheticSlice();
    const fetcher = bytesFetcher(bytes, 64);
    const loader = new DicomMetaLoader(fetcher);

    await loader.load();

    expect(loader.meta).toEqual(readDicomTags(bytes));
    expect(deliveredBytes(fetcher)).toBeLessThan(bytes.length);
  });

  it('hands the reader the header bytes, once', async () => {
    const bytes = syntheticSlice();
    const seen: Uint8Array[] = [];
    const loader = new DicomMetaLoader(bytesFetcher(bytes), (headerBytes) => {
      seen.push(headerBytes);
      return [];
    });

    await loader.load();
    await loader.load();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect(seen[0]).toEqual(bytes.slice(0, pixelDataStart(bytes)));
  });

  it('takes tags, offset and ultrasound regions from one pass', async () => {
    const bytes = syntheticSlice({ modality: 'US', ultrasoundRegion: REGION });
    const { fetcher, counts } = countingFetcher(bytesFetcher(bytes));
    const loader = new DicomMetaLoader(fetcher);

    await loader.load();

    expect(loader.meta).toEqual(readDicomTags(bytes));
    expect(loader.pixelDataOffset).toBe(pixelDataStart(bytes));
    expect(loader.ultrasoundRegions?.regionCount).toBe(1);
    expect(loader.ultrasoundRegions?.region?.physicalDeltaX).toBeCloseTo(
      REGION.physicalDeltaX
    );
    expect(loader.ultrasoundRegions?.region?.physicalDeltaY).toBeCloseTo(
      REGION.physicalDeltaY
    );
    // One stream, and never the whole blob: the regions cost no second read.
    expect(counts.getStream).toBe(1);
    expect(counts.blob).toBe(0);
  });

  it('reports no ultrasound regions for a non-ultrasound modality', async () => {
    const bytes = syntheticSlice({ modality: 'MR', ultrasoundRegion: REGION });
    const loader = new DicomMetaLoader(bytesFetcher(bytes));

    await loader.load();

    expect(loader.ultrasoundRegions).toBeUndefined();
  });

  it('reads every tag of an RT object that has no Pixel Data', async () => {
    const bytes = withoutPixelData(syntheticSlice({ modality: 'RTSTRUCT' }));
    const loader = new DicomMetaLoader(bytesFetcher(bytes));

    await loader.load();

    expect(loader.meta).toEqual(readDicomTags(bytes));
    expect(loader.meta!.length).toBeGreaterThan(1);
    expect(Object.fromEntries(loader.meta!)[Tags.Modality].trim()).toBe(
      'RTSTRUCT'
    );
    expect(loader.pixelDataOffset).toBe(bytes.length);
    expect(await bytesOf(loader.metaBlob!)).toEqual(bytes);
  });

  it('closes the byte source once the header is read', async () => {
    const { fetcher, counts } = countingFetcher(bytesFetcher(syntheticSlice()));
    const loader = new DicomMetaLoader(fetcher);

    await loader.load();

    expect(counts.close).toBeGreaterThanOrEqual(1);
  });

  it('closes the byte source on stop', async () => {
    const { fetcher, counts } = countingFetcher(bytesFetcher(syntheticSlice()));
    const loader = new DicomMetaLoader(fetcher);

    await loader.stop();

    expect(counts.close).toBeGreaterThanOrEqual(1);
  });

  it('rejects a byte source that is not DICOM', async () => {
    const loader = new DicomMetaLoader(bytesFetcher(new Uint8Array(512)));

    await expect(loader.load()).rejects.toThrow();
  });
});
