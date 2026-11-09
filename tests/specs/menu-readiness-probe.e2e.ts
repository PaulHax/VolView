import { volViewPage } from '../pageobjects/volview.page';
import { waitForModuleTransitions, writeMetaImage } from './utils';

declare global {
  interface Window {
    ciPausedMenus: Animation[];
  }
}

describe('CI menu readiness', () => {
  it('distinguishes a stable menu from an interactive menu during entry', async () => {
    await browser.addInitScript(() => {
      window.ciPausedMenus = [];
      const animate = Element.prototype.animate;
      const paused = new WeakSet<Element>();
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (
          this.classList.contains('v-overlay__content') &&
          !paused.has(this)
        ) {
          paused.add(this);
          // Keep Vuetify's real entry transition pending at a visible frame.
          // onBeforeEnter disables pointer events until onAfterEnter runs.
          animation.pause();
          animation.currentTime =
            Number(animation.effect?.getTiming().duration) * 0.9;
          window.ciPausedMenus.push(animation);
        }
        return animation;
      };
    });
    const name = writeMetaImage('menu-readiness-probe.mha', { size: 16 });
    await volViewPage.open(`?urls=[tmp/${name}]`);
    await volViewPage.waitForViews();
    await $('[data-testid="module-tab-Data"]').click();
    await waitForModuleTransitions();
    const card = $(`.image-list-card*=${name}`);
    const menu = await volViewPage.openMenu(
      card.$('[data-testid="dataset-menu-button"]')
    );
    const command = menu.$('.v-list-item*=Show in all views');
    try {
      expect(await menu.isStable()).toBe(true);
      expect(await command.isClickable()).toBe(false);
      const snapshot = await browser.execute(
        (element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          );
          return {
            pointerEvents: getComputedStyle(element).pointerEvents,
            interceptedBy: hit?.outerHTML.slice(0, 350),
          };
        },
        await command.getElement()
      );
      console.info('CONTROL: stable menu is not clickable', snapshot);
      let failure = '';
      try {
        await command.click();
      } catch (error) {
        failure = String(error);
      }
      expect(failure).toContain('element click intercepted');
      console.info('CONTROL: the previous direct click fails:', failure);
      let becameClickable = false;
      const waiting = command.waitForClickable().then(() => {
        becameClickable = true;
      });
      expect(await command.isClickable()).toBe(false);
      expect(becameClickable).toBe(false);
      await browser.execute(() =>
        window.ciPausedMenus.forEach((animation) => animation.finish())
      );
      await waiting;
      await command.click();
      await menu.waitForDisplayed({ reverse: true });
      console.info(
        'FIXED: clickability wait stays pending until entry finishes, then the command succeeds'
      );
    } finally {
      await browser.execute(() =>
        window.ciPausedMenus.forEach((animation) => animation.finish())
      );
    }
  });
});
