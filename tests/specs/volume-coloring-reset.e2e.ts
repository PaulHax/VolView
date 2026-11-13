import { applyTestViewport, CONTENT_VIEWPORT } from '../../wdio.shared.conf';
import { volViewPage } from '../pageobjects/volview.page';
import { captureViewPixels, waitForModuleTransitions } from './utils';
import {
  differingFraction,
  floatVoxels,
  nrrd,
  openWith3DLayout,
  pressOn,
  radialRamp,
  sliderThumb,
  stablePixels,
  writeNrrd,
} from './volumeTestUtils';

const SIZE = 64;
const VIEW = '[data-testid~="vtk-volume-view"]';
const EDITOR = '[data-testid="volume-opacity-editor"]';
const RESET = '[data-testid="volume-reset-color-opacity"]';

const shiftThumb = () => sliderThumb('volume-color-shift');
const widthThumb = () => sliderThumb('volume-color-width');
const ambientThumb = () => $('.v-slider*=Ambient').$('[role="slider"]');
const sliderValue = async (slider: ChainablePromiseElement) =>
  String(await slider.getAttribute('aria-valuenow'));

async function pixels(selector: string, inset: number, file: string) {
  const [{ data }] = await captureViewPixels(selector, inset, file);
  return data;
}

async function waitForPixels(
  selector: string,
  inset: number,
  expected: Buffer,
  matches: boolean,
  timeoutMsg: string
) {
  await browser.waitUntil(
    async () => {
      const fraction = differingFraction(
        await pixels(selector, inset, 'volume-coloring-reset.png'),
        expected
      );
      return matches ? fraction < 0.01 : fraction > 0.05;
    },
    { timeoutMsg }
  );
}

async function dragOpacityCurve(steps: number) {
  const editor = $(EDITOR).$('canvas');
  await editor.scrollIntoView({ block: 'center', behavior: 'instant' });
  const drag = browser
    .action('pointer')
    .move({ origin: editor, x: -60, y: 0 })
    .down();
  for (let step = 0; step < steps; step++)
    drag.move({ origin: 'pointer', x: 30, y: 0, duration: 50 });
  await drag.up().perform();
}

const t0 = { v: Date.now() };
const mark = (label: string) =>
  console.log(`STEP ${((Date.now() - t0.v) / 1000).toFixed(1)}s ${label}`);

describe('3D rendering color and opacity reset', () => {
  it('restores Shift, Width, and the opacity curve while keeping lighting', async () => {
    t0.v = Date.now();
    // Bound software 3D rendering cost.
    await browser.setViewport({
      ...CONTENT_VIEWPORT,
      height: 400,
      devicePixelRatio: 1,
    });
    try {
      const name = 'volume-coloring-reset';
      const voxels = floatVoxels(SIZE, radialRamp(SIZE));
      await openWith3DLayout(
        writeNrrd(name, nrrd([], 'float', SIZE), voxels),
        name
      );
      mark('opened 3D layout');
      await volViewPage.renderingModuleTab.waitForClickable();
      await volViewPage.renderingModuleTab.click();
      await waitForModuleTransitions();
      mark('rendering tab open');
      const reset = $(RESET);
      await expect(reset).toBeEnabled();
      await expect(reset).toHaveAttribute(
        'aria-label',
        'Reset color and opacity'
      );

      // A gaussian stays highlighted once clicked, so select it before the baseline.
      await dragOpacityCurve(0);
      await pressOn(ambientThumb(), 'ArrowRight');
      await expect(ambientThumb()).toHaveAttribute('aria-valuenow', '0.3');

      mark('gaussian selected + ambient');
      const shift = await sliderValue(shiftThumb());
      const width = await sliderValue(widthThumb());
      const editor = await stablePixels(EDITOR, 0);
      mark('editor baseline stable');
      const view = await stablePixels(VIEW, 40);

      mark('view baseline stable');
      await dragOpacityCurve(3);
      await waitForPixels(
        EDITOR,
        0,
        editor,
        false,
        'Expected dragging to change the opacity curve'
      );
      mark('curve changed');
      await pressOn(shiftThumb(), 'End');
      await pressOn(widthThumb(), 'Home');
      await expect(shiftThumb()).not.toHaveAttribute('aria-valuenow', shift);
      await expect(widthThumb()).not.toHaveAttribute('aria-valuenow', width);
      mark('sliders moved');
      await waitForPixels(
        VIEW,
        40,
        view,
        false,
        'Expected the edits to change the 3D rendering'
      );

      mark('view changed');
      await browser.keys('Tab');
      await expect(reset).toBeFocused();
      await browser.keys('Enter');

      mark('reset pressed');
      await expect(shiftThumb()).toHaveAttribute('aria-valuenow', shift);
      await expect(widthThumb()).toHaveAttribute('aria-valuenow', width);
      mark('sliders restored');
      await waitForPixels(
        EDITOR,
        0,
        editor,
        true,
        'Expected reset to restore the opacity curve'
      );
      mark('editor restored');
      await waitForPixels(
        VIEW,
        40,
        view,
        true,
        'Expected reset to restore the 3D rendering'
      );
      mark('view restored');
      await expect(ambientThumb()).toHaveAttribute('aria-valuenow', '0.3');
    } finally {
      await applyTestViewport(browser);
    }
  }).timeout(300_000);
});
