import AppPage from '../pageobjects/volview.page';
import type { ChainablePromiseElement } from 'webdriverio';
import {
  drawSquare,
  nudgeTo,
  rightPressAtPointer,
  setupTest,
} from './annotationTestUtils';
import {
  addSegment,
  lockSegment,
  openAnnotationSegments,
  renameSegment,
  segmentColor,
  segmentNames,
  waitForNamedSegments,
} from './segmentationTestUtils';
import { CINE_US_DATASET } from './configTestUtils';
import { openUrls } from './utils';

const RASTERIZE_ITEM = '.v-list-item-title=Rasterize';

const rasterizeMenuParts = async () => {
  const title = await $(RASTERIZE_ITEM);
  const item = await title.$('..').$('..');
  return { item, activator: await item.$('..') };
};

const tooltipFor = async (element: ChainablePromiseElement) => {
  const id = await element.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  return $(`[id="${id}"]`);
};

// The menu comes off the widget's own pick, so hover the handle first and press
// without moving.
const openPolygonMenuAt = (x: number, y: number) =>
  browser.waitUntil(
    async () => {
      await nudgeTo(x, y);
      await rightPressAtPointer();
      return $(RASTERIZE_ITEM).isDisplayed();
    },
    {
      timeout: 15000,
      interval: 500,
      timeoutMsg: 'Right-clicking a polygon handle should open its menu',
    }
  );

describe('Polygon rasterize target', () => {
  it('rasterizes into the segment the polygon was drawn with', async () => {
    const { centerX, centerY } = await setupTest();
    const half = 60;

    // Paint a stroke first, so the image already holds a segment the polygon
    // must not borrow. Activating the tool alone creates nothing.
    await AppPage.activatePaint();
    const views2D = await AppPage.getViews2D();
    await AppPage.paintStrokeOnView(views2D[0]);
    await AppPage.selectTool('mdi-pentagon-outline');

    // Polygon draws with the entry selected in the Segments list, so the paint
    // stroke's segment is already there and the new one is the second.
    await openAnnotationSegments();
    await waitForNamedSegments();
    await addSegment();
    await renameSegment('Segment 2', 'Lesion');
    const lesionColor = await segmentColor('Lesion');

    await drawSquare(centerX, centerY, half);

    expect(await segmentNames()).toEqual(['Segment 1', 'Lesion']);

    // The context menu belongs to a placed polygon, and the polygon tool keeps
    // a placing one that would swallow the right click.
    await AppPage.selectTool('mdi-cursor-default');
    await openPolygonMenuAt(centerX + half, centerY - half);
    await $(RASTERIZE_ITEM).click();

    // Rasterizing lands in the polygon's own segment: it neither mints a
    // second one nor borrows the segment the paint stroke made.
    expect(await segmentNames()).toEqual(['Segment 1', 'Lesion']);
    expect(await segmentColor('Lesion')).toEqual(lesionColor);
  });

  it('rasterizes a polygon drawn against an empty registry', async () => {
    const { centerX, centerY } = await setupTest();
    const half = 60;

    // No paint stroke and no added entry, so the registry is empty and the
    // polygon mints the segment it needs. Rasterize still has to work.
    await AppPage.selectTool('mdi-pentagon-outline');
    await drawSquare(centerX, centerY, half);

    await AppPage.selectTool('mdi-cursor-default');
    await openPolygonMenuAt(centerX + half, centerY - half);
    await $(RASTERIZE_ITEM).click();

    await openAnnotationSegments();
    await waitForNamedSegments();
    await browser.waitUntil(async () => (await segmentNames()).length === 1, {
      timeoutMsg:
        'Rasterizing against an empty registry should create one segment',
    });
  });

  it('explains a locked rasterize target on hover and keyboard focus', async () => {
    const { centerX, centerY } = await setupTest();
    const half = 60;
    await openAnnotationSegments();
    await addSegment();
    await AppPage.selectTool('mdi-pentagon-outline');
    await drawSquare(centerX, centerY, half);
    await lockSegment('Segment 1');

    await AppPage.selectTool('mdi-cursor-default');
    await openPolygonMenuAt(centerX + half, centerY - half);
    let { item, activator } = await rasterizeMenuParts();
    expect(await item.getAttribute('class')).toContain('v-list-item--disabled');

    await activator.moveTo();
    let tooltip = await tooltipFor(activator);
    await expect(tooltip).toBeDisplayed();
    await expect(tooltip).toHaveText(
      'Unlock this segment to rasterize into it'
    );

    await activator.execute((element) => element.focus());
    tooltip = await tooltipFor(activator);
    await expect(tooltip).toBeDisplayed();

    await browser.keys('Escape');
    const row = await $('[data-testid="segment-list"] .item-row');
    await row.$('button i[class~="mdi-lock"]').click();
    await openPolygonMenuAt(centerX + half, centerY - half);
    ({ item, activator } = await rasterizeMenuParts());
    expect(await item.getAttribute('class')).not.toContain(
      'v-list-item--disabled'
    );
    await item.click();
    await waitForNamedSegments();
  });

  it('keeps Rasterize visible on cine and explains why it is disabled', async () => {
    await openUrls([CINE_US_DATASET]);
    const [view] = await AppPage.getViews2D();
    const canvas = await view.$('canvas');
    const [location, size] = await Promise.all([
      canvas.getLocation(),
      canvas.getSize(),
    ]);
    const centerX = location.x + size.width / 2;
    const centerY = location.y + size.height / 2;
    const half = 30;

    await AppPage.selectTool('mdi-pentagon-outline');
    await drawSquare(centerX, centerY, half);
    await AppPage.selectTool('mdi-cursor-default');
    await openPolygonMenuAt(centerX + half, centerY - half);

    const { item, activator } = await rasterizeMenuParts();
    expect(await item.getAttribute('class')).toContain('v-list-item--disabled');
    await activator.moveTo();
    const tooltip = $('.v-tooltip.v-overlay--active .v-overlay__content');
    await expect(tooltip).toBeDisplayed();
    await expect(tooltip).toHaveText(
      'Rasterization is not supported for cine images'
    );
  });
});
