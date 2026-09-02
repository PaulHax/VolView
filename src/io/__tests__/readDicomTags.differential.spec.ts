/**
 * `readDicomTagsNode` runs the itk-wasm pipeline over a file path, with no
 * worker and no browser, so the JS reader can be compared against it here.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDicomTagsNode } from '@itk-wasm/dicom';
import { readDicomTags } from '@/src/io/readDicomTags';
import { tagReaderCorpus } from './readDicomTagsFixtures';

let workDir = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volview-dicom-tags-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const itkTags = async (name: string, bytes: Uint8Array) => {
  const file = path.join(workDir, `${name.replace(/[^a-z0-9]+/gi, '-')}.dcm`);
  fs.writeFileSync(file, bytes);
  const { tags } = await readDicomTagsNode(file);
  return tags;
};

describe('readDicomTags against the itk-wasm reader', () => {
  it.each(tagReaderCorpus())(
    'reads $name the same way',
    async ({ name, bytes }) => {
      const expected = await itkTags(name, bytes);
      expect(expected.length).toBeGreaterThan(0);

      expect(await readDicomTags(bytes)).toEqual(expected);
    },
    60000
  );
});
