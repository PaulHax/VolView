import { writeManifestToFile, writeMetaImage } from './utils';
import { volViewPage } from '../pageobjects/volview.page';

const panes = () => $$('.grid-item');
const waitForPaneCount = (count: number) =>
  browser.waitUntil(async () => (await panes().length) === count);

const paneBounds = (index: number) =>
  browser.execute(
    (i) =>
      document
        .querySelectorAll('.grid-item')
        [i].getBoundingClientRect()
        .toJSON(),
    index
  );

const cameraSnapshot = (index: number) =>
  browser.execute((i) => {
    const app = Reflect.get(document.getElementById('app')!, '__vue_app__');
    const provides = app._context.provides;
    const pinia = Reflect.ownKeys(provides)
      .map((key) => Reflect.get(provides, key))
      .find((value) => value?._s instanceof Map);
    const view = pinia._s.get('view').visibleViews[i];
    const cameras = pinia._s.get('viewCamera');
    return {
      scale: cameras.getConfig(view.id, view.dataID).parallelScale as number,
      autoFit: cameras.getAutoFitState(view.id, view.dataID) as boolean,
    };
  }, index);
async function viewAction(index: number, title: string) {
  await $$('button[aria-label="Split or close view"]')[index].click();
  const action = $('.v-menu.v-overlay--active').$('div=' + title);
  await action.waitForDisplayed();
  await action.click();
}

async function openSplitFixture() {
  const image = writeMetaImage('view-splitting.mha');
  await writeManifestToFile(
    {
      layouts: { Dual: [['axial', 'axial']] },
    },
    'view-splitting.json'
  );
  await volViewPage.open('?urls=[tmp/' + image + ',tmp/view-splitting.json]');
  await volViewPage.waitForViews();
  await waitForPaneCount(2);
}

describe('Splitting individual views', () => {
  it('retains existing renderers and image settings through nested splits and closes', async () => {
    await openSplitFixture();
    const overview = await paneBounds(0);
    await browser.execute(() => {
      document
        .querySelectorAll('.grid-item canvas')
        .forEach((canvas, index) => {
          (canvas as HTMLElement).dataset.originalRenderer = String(index);
        });
    });
    const sourceSlice = await panes()[1].$('.slice-label').getText();
    await viewAction(1, 'Split top and bottom');
    await waitForPaneCount(3);
    expect(await paneBounds(0)).toEqual(overview);
    expect(await panes()[2].$('.slice-label').getText()).toBe(sourceSlice);
    expect(await $$('canvas[data-original-renderer]').length).toBe(2);

    await viewAction(2, 'Split side by side');
    await waitForPaneCount(4);
    expect(await paneBounds(0)).toEqual(overview);
    expect(await $$('canvas[data-original-renderer]').length).toBe(2);

    await viewAction(2, 'Close view');
    await waitForPaneCount(3);
    expect(await paneBounds(0)).toEqual(overview);
    expect(await $$('canvas[data-original-renderer]').length).toBe(2);
    expect(await panes()[2].$('.slice-label').getText()).toBe(sourceSlice);

    for (let cycle = 0; cycle < 3; cycle++) {
      await viewAction(
        0,
        cycle % 2 ? 'Split top and bottom' : 'Split side by side'
      );
      await waitForPaneCount(4);
      await viewAction(1, 'Close view');
      await waitForPaneCount(3);
    }
    expect(await $$('canvas[data-original-renderer]').length).toBe(2);
  });

  it('preserves manually adjusted zoom when the split renderer mounts and resizes', async () => {
    await openSplitFixture();
    const initial = await cameraSnapshot(1);
    await volViewPage.selectTool('mdi-magnify-plus-outline');
    const bounds = await paneBounds(1);
    const x = Math.round(bounds.left + bounds.width / 2);
    const y = Math.round(bounds.top + bounds.height / 2);
    await browser
      .action('pointer')
      .move({ x, y })
      .down()
      .move({ x, y: y + 60, duration: 200 })
      .up()
      .perform();
    await browser.waitUntil(async () => {
      const state = await cameraSnapshot(1);
      return !state.autoFit && state.scale !== initial.scale;
    });
    const adjusted = await cameraSnapshot(1);
    await viewAction(1, 'Split top and bottom');
    await waitForPaneCount(3);
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done()))
    );
    const source = await cameraSnapshot(1);
    const split = await cameraSnapshot(2);
    expect(source.scale).toBeCloseTo(adjusted.scale, 6);
    expect(split.scale).toBeCloseTo(adjusted.scale, 6);
    expect(split.autoFit).toBe(false);
  });
  it('keeps narrow-pane controls inside the view and guards splits while maximized', async () => {
    await openSplitFixture();
    await viewAction(1, 'Split side by side');
    await waitForPaneCount(3);

    const controlsFit = await browser.execute(() =>
      Array.from(document.querySelectorAll('.grid-item')).every((pane) => {
        const bounds = pane.getBoundingClientRect();
        const controls = pane
          .querySelector('.view-controls')!
          .getBoundingClientRect();
        return (
          controls.left >= bounds.left &&
          controls.right <= bounds.right &&
          controls.top >= bounds.top &&
          controls.bottom <= bounds.bottom
        );
      })
    );
    expect(controlsFit).toBe(true);

    const checkGuard = async () => {
      const row = $('.v-menu.v-overlay--active').$('div=Split side by side');
      await row.waitForDisplayed();
      expect(
        await row.parentElement().parentElement().getAttribute('class')
      ).toContain('v-list-item--disabled');
      await row.parentElement().parentElement().parentElement().moveTo();
      const reason = $('.v-tooltip.v-overlay--active .v-overlay__content');
      await reason.waitForDisplayed();
      expect(await reason.getText()).toBe(
        'This view is too narrow to split side by side'
      );
      expect(
        await $('.v-menu.v-overlay--active')
          .$('div=Split top and bottom')
          .parentElement()
          .parentElement()
          .getAttribute('class')
      ).not.toContain('v-list-item--disabled');
    };

    await $$('button[aria-label="Split or close view"]')[2].click();
    await checkGuard();
    await browser.keys('Escape');
    await panes()[2].$('[data-testid~="vtk-view"] .view').doubleClick();
    await waitForPaneCount(1);
    await $('button[aria-label="Split or close view"]').click();
    await checkGuard();
  });
  it('keeps Close view visible and disabled when only one view remains', async () => {
    await openSplitFixture();
    await viewAction(1, 'Close view');
    await waitForPaneCount(1);
    await $('button[aria-label="Split or close view"]').click();
    const close = $('.v-menu.v-overlay--active .v-list-item--disabled');
    await close.waitForDisplayed();
    expect(await close.getText()).toContain('Close view');
    await close.parentElement().moveTo();
    const reason = $('.v-tooltip.v-overlay--active .v-overlay__content');
    await reason.waitForDisplayed();
    expect(await reason.getText()).toBe('Keep at least one view open');
  });
});
