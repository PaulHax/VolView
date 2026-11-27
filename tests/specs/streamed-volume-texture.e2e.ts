import fs from 'node:fs';
import path from 'node:path';
import { volViewPage } from '../pageobjects/volview.page';
import { applyTestViewport, CONTENT_VIEWPORT } from '../../wdio.shared.conf';
import {
  buildSyntheticCineDicom,
  buildSyntheticDicom,
  newUid,
} from './syntheticDicom';
import {
  captureViewPixels,
  makeTempDir,
  openVolViewPage,
  writeManifestToFile,
} from './utils';
import { displayedWindow, WINDOW_TOOL } from './octTestUtils';
import { VIEW } from './volumeTestUtils';

const [COLS, ROWS, SLICES] = [24, 20, 32];
const FULL_WIDTH = 4000;
const TWO_VIEW = 'div[data-testid="vtk-view vtk-two-view"]';
const MULTIFRAME_GRAYSCALE_BYTE = '1.2.840.10008.5.1.4.1.1.7.2';

// The end slices each hold under 5% of the voxels, so High Contrast drops them.
const sliceValue = (index: number) => {
  if (index === 0) return 0;
  return index === SLICES - 1 ? FULL_WIDTH : 1000 + 10 * index;
};

const series = (modality: string) => {
  const [studyUid, seriesUid] = [newUid(), newUid()];
  return Array.from({ length: SLICES }, (_, index): [string, Uint8Array] => [
    `slice-${index}.dcm`,
    buildSyntheticDicom({
      studyUid,
      seriesUid,
      sopUid: newUid(),
      modality,
      instanceNumber: index + 1,
      rows: ROWS,
      cols: COLS,
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      imagePositionPatient: [0, 0, index],
      pixelValue: sliceValue(index),
    }),
  ]);
};

async function open(name: string, files: [string, Uint8Array][]) {
  const directory = makeTempDir(name);
  const resources = files.map(([file, dicom]) => {
    fs.writeFileSync(path.join(directory, file), dicom);
    return { url: `tmp/${name}/${file}`, name: file };
  });
  await writeManifestToFile({ resources }, `${name}.json`);
  await openVolViewPage(`${name}.json`);
  await volViewPage.waitForViewCounts(3, true);
  await volViewPage.waitForLoadingIndicator($(TWO_VIEW));
}

/** High Contrast narrows the window once the presets have their fit too. */
async function waitForStatistics() {
  const view = await $(TWO_VIEW).getElement();
  await view.$('canvas').click();
  const menu = await volViewPage.openMenu($(WINDOW_TOOL));
  await menu
    .$('.v-radio:has(input[value="HighContrast"]) .v-selection-control__input')
    .click();
  await volViewPage.closeMenu($(WINDOW_TOOL));
  await browser.waitUntil(
    async () => (await displayedWindow(view)).width < FULL_WIDTH / 2,
    { timeoutMsg: 'Expected the image statistics to narrow the window' }
  );
}

const canvasWidth = () =>
  $(VIEW)
    .$('canvas')
    .execute((canvas) => (canvas as HTMLCanvasElement).width);

/** A resize redraws the 3D view at once, after every earlier change. */
async function redraw3D() {
  const width = await canvasWidth();
  await browser.setViewport({
    ...CONTENT_VIEWPORT,
    width: CONTENT_VIEWPORT.width - 100,
  });
  await browser.waitUntil(async () => (await canvasWidth()) !== width);
}

/** Share of the 3D view's rows that show any of the volume. */
async function volumeHeight() {
  const [{ width, data }] = await captureViewPixels(VIEW, 60, 'volume.png');
  const rows = data.length / 4 / width;
  const filled = Array.from({ length: rows }, (_, row) =>
    data
      .subarray(row * width * 4, (row + 1) * width * 4)
      .some((value, index) => index % 4 !== 3 && value > 40)
  );
  return filled.filter(Boolean).length / rows;
}

describe('streamed volume textures', () => {
  before(async () => {
    await browser.addInitScript((size) => {
      const gl = WebGL2RenderingContext.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      let count = 0;
      Object.assign(window, { volumeAllocations: () => count });
      ['texImage3D', 'texStorage3D'].forEach((name) => {
        const allocate = gl[name];
        gl[name] = function record(this: unknown, ...args: unknown[]) {
          if (args.slice(3, 6).join('x') === size) count += 1;
          return allocate.apply(this, args);
        };
      });
    }, `${COLS}x${ROWS}x${SLICES}`);
  });

  beforeEach(() => applyTestViewport(browser));

  ['CT', 'MR'].forEach((modality) => {
    it(`uploads a ${modality} series once through loading and its preset fit`, async () => {
      await open(`streamed-${modality}`, series(modality));
      await waitForStatistics();
      await redraw3D();
      const allocations = await browser.execute(() =>
        (
          window as unknown as { volumeAllocations: () => number }
        ).volumeAllocations()
      );
      expect(allocations).toBe(1);
    });
  });

  it('shows every frame of a multi-frame file in 3D', async () => {
    const dicom = buildSyntheticCineDicom({
      studyUid: newUid(),
      seriesUid: newUid(),
      sopUid: newUid(),
      numberOfFrames: 16,
      rows: ROWS,
      cols: COLS,
      sopClassUid: MULTIFRAME_GRAYSCALE_BYTE,
    });
    await open('streamed-frames', [['frames.dcm', dicom]]);
    // One frame alone shows as a thin slab.
    await browser.waitUntil(async () => (await volumeHeight()) > 0.5, {
      timeoutMsg: 'Expected the 3D view to show every frame',
    });
  });
});
