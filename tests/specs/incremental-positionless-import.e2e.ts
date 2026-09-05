// A second import must not dissolve the volumes the first one earned.
//
// One series holds two overlapping acquisitions, which load as two volumes.
// A later import brings one more slice of that series whose
// ImagePositionPatient is empty, so nothing can be said about where it sits.
// Both volumes must survive, the unplaceable slice must arrive as a volume of
// its own, and the user must be told about it.
//
// Synthetic DICOMs are generated on the fly so the test carries no binary
// fixtures.
import * as path from 'path';
import * as fs from 'fs';
import { volViewPage } from '../pageobjects/volview.page';
import { TEMP_DIR } from '../../wdio.shared.conf';
import { writeManifestToFile } from './utils';
import { buildSyntheticDicom, newUid } from './syntheticDicom';

const SLICE_SPACING = 2.5;
const ORIENTATION = [1, 0, 0, 0, 1, 0] as const;

// Offset by half a slice, so the two passes overlap and the planner separates
// them. Slice counts differ so each volume card is identifiable by its label.
const ACQUISITIONS = [
  { number: 1, firstSliceZ: 0, sliceCount: 5 },
  { number: 2, firstSliceZ: 1.25, sliceCount: 6 },
];

const DIR_NAME = 'incremental-positionless-import';
const MANIFEST_NAME = 'incremental-positionless-import.json';
const POSITIONLESS_NAME = 'positionless.dcm';

const seriesUid = newUid();
const studyUid = newUid();

const dir = () => path.join(TEMP_DIR, DIR_NAME);

function writeSeries() {
  fs.mkdirSync(dir(), { recursive: true });

  let instanceNumber = 0;
  return ACQUISITIONS.flatMap(({ number, firstSliceZ, sliceCount }) =>
    Array.from({ length: sliceCount }, (_, i) => {
      instanceNumber += 1;
      const filename = `acq${number}-slice${i}.dcm`;
      fs.writeFileSync(
        path.join(dir(), filename),
        buildSyntheticDicom({
          studyUid,
          seriesUid,
          sopUid: newUid(),
          instanceNumber,
          acquisitionNumber: number,
          imageOrientationPatient: ORIENTATION,
          imagePositionPatient: [0, 0, firstSliceZ + i * SLICE_SPACING],
          sliceThickness: SLICE_SPACING,
        })
      );
      return { url: `tmp/${DIR_NAME}/${filename}`, name: filename };
    })
  );
}

// Same series and same hard facts as the two passes, so only its unreadable
// geometry can keep it out of them.
function writePositionlessSlice() {
  fs.writeFileSync(
    path.join(dir(), POSITIONLESS_NAME),
    buildSyntheticDicom({
      studyUid,
      seriesUid,
      sopUid: newUid(),
      instanceNumber: 99,
      imageOrientationPatient: ORIENTATION,
      imagePositionPatient: null,
      sliceThickness: SLICE_SPACING,
    })
  );
}

/**
 * Drops one file on the app the way a user does. The app's drop handler asks
 * each dataTransfer item for its filesystem entry, which a synthesized item
 * has none of, so this drop carries the files list only.
 */
async function dropFile(fileName: string, base64: string) {
  const dropped = await browser.execute(
    (name: string, encoded: string) => {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1)
        bytes[i] = binary.charCodeAt(i);

      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name));

      const target = document.querySelector('#app-container');
      if (!target) return false;

      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', {
        value: { items: null, files: transfer.files },
      });
      // dispatchEvent reports the handler's preventDefault, not delivery.
      target.dispatchEvent(drop);
      return true;
    },
    fileName,
    base64
  );

  expect(dropped).toBe(true);
}

describe('Incremental import of a slice with no readable position', () => {
  before(async () => {
    const resources = writeSeries();
    writePositionlessSlice();
    await writeManifestToFile({ resources }, MANIFEST_NAME);
  });

  it('keeps both acquisitions and warns about the slice it cannot place', async () => {
    await volViewPage.open(`?urls=[tmp/${MANIFEST_NAME}]`);
    await volViewPage.waitForViews();

    const passes = ACQUISITIONS.map((a) => a.sliceCount).sort((a, b) => a - b);
    await volViewPage.waitForVolumeCardSliceCounts(passes);
    expect(await volViewPage.getNotificationsCount()).toEqual(0);

    await dropFile(
      POSITIONLESS_NAME,
      fs.readFileSync(path.join(dir(), POSITIONLESS_NAME)).toString('base64')
    );

    // The two passes are untouched, and the unplaceable slice is a volume of
    // its own rather than a member of either.
    await volViewPage.waitForVolumeCardSliceCounts([1, ...passes]);

    await volViewPage.waitForNotification();

    // The toast of that same warning covers the notifications button.
    await browser.waitUntil(
      async () => (await $$('.Vue-Toastification__toast').length) === 0,
      { timeout: 30000, timeoutMsg: 'expected the warning toast to close' }
    );

    await volViewPage.notifications.click();
    const dialog = await $('.message-center');
    await dialog.waitForDisplayed();
    expect(await dialog.getText()).toContain(
      'A DICOM series did not load as one sound volume'
    );
  });
});
