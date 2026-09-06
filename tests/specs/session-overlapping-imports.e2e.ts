// A session saved after an incremental import must restore what the browser
// shows, not the membership the first import saw.
//
// One series holds two overlapping acquisitions. The first import loads one of
// them; a second import brings the other, and the planner regroups the series
// into two volumes. The session saved afterwards must restore both. Deleting
// one volume and saving again must restore only the survivor: a dataset the
// user removed cannot come back.
//
// Synthetic DICOMs are generated on the fly so the test carries no binary
// fixtures.
import * as path from 'path';
import * as fs from 'fs';
import { volViewPage } from '../pageobjects/volview.page';
import { TEMP_DIR } from '../../wdio.shared.conf';
import {
  SESSION_SAVE_TIMEOUT,
  waitForFileExists,
  writeManifestToFile,
} from './utils';
import { buildSyntheticDicom, newUid } from './syntheticDicom';

const SLICE_SPACING = 2.5;
const ORIENTATION = [1, 0, 0, 0, 1, 0] as const;

// Offset by half a slice, so the two passes overlap and the planner separates
// them. Slice counts differ so each volume card is identifiable by its label.
const FIRST_PASS = { number: 1, firstSliceZ: 0, sliceCount: 5 };
const SECOND_PASS = { number: 2, firstSliceZ: 1.25, sliceCount: 6 };

const DIR_NAME = 'session-overlapping-imports';
const MANIFEST_NAME = 'session-overlapping-imports.json';

const seriesUid = newUid();
const studyUid = newUid();

const dir = () => path.join(TEMP_DIR, DIR_NAME);

type Pass = typeof FIRST_PASS;

function writePass({ number, firstSliceZ, sliceCount }: Pass) {
  fs.mkdirSync(dir(), { recursive: true });

  return Array.from({ length: sliceCount }, (_, i) => {
    const filename = `acq${number}-slice${i}.dcm`;
    fs.writeFileSync(
      path.join(dir(), filename),
      buildSyntheticDicom({
        studyUid,
        seriesUid,
        sopUid: newUid(),
        // Unique across both passes, so no instance looks like a re-send.
        instanceNumber: number * 100 + i,
        acquisitionNumber: number,
        imageOrientationPatient: ORIENTATION,
        imagePositionPatient: [0, 0, firstSliceZ + i * SLICE_SPACING],
        sliceThickness: SLICE_SPACING,
      })
    );
    return { url: `tmp/${DIR_NAME}/${filename}`, name: filename };
  });
}

/**
 * Drops files on the app the way a user does. The app's drop handler asks each
 * dataTransfer item for its filesystem entry, which a synthesized item has none
 * of, so this drop carries the files list only.
 */
async function dropFiles(fileNames: string[]) {
  const encoded = fileNames.map((name) => ({
    name,
    base64: fs.readFileSync(path.join(dir(), name)).toString('base64'),
  }));

  const dropped = await browser.execute(
    (files: Array<{ name: string; base64: string }>) => {
      const transfer = new DataTransfer();
      files.forEach(({ name, base64 }) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1)
          bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], name));
      });

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
    encoded
  );

  expect(dropped).toBe(true);
}

const saveSession = async () => {
  const fileName = await volViewPage.saveSession();
  await waitForFileExists(path.join(TEMP_DIR, fileName), SESSION_SAVE_TIMEOUT);
  return fileName;
};

const openSavedSession = async (fileName: string) => {
  await volViewPage.open(`?urls=[tmp/${fileName}]`);
  await volViewPage.waitForViews();
};

describe('Session saved after an incremental import of one series', () => {
  let secondPassFiles: string[];

  before(async () => {
    const resources = writePass(FIRST_PASS);
    secondPassFiles = writePass(SECOND_PASS).map(({ name }) => name);
    await writeManifestToFile({ resources }, MANIFEST_NAME);
  });

  it('restores both volumes, and drops one the user deleted', async () => {
    await volViewPage.open(`?urls=[tmp/${MANIFEST_NAME}]`);
    await volViewPage.waitForViews();
    await volViewPage.waitForVolumeCardSliceCounts([FIRST_PASS.sliceCount]);

    // The regroup this triggers replaces the volume the first import earned.
    await dropFiles(secondPassFiles);
    const bothPasses = [FIRST_PASS.sliceCount, SECOND_PASS.sliceCount].sort(
      (a, b) => a - b
    );
    await volViewPage.waitForVolumeCardSliceCounts(bothPasses);

    const withBoth = await saveSession();
    await openSavedSession(withBoth);
    await volViewPage.waitForVolumeCardSliceCounts(bothPasses);

    await volViewPage.deleteVolumeCard(0);
    const survivor = bothPasses.slice(1);
    await volViewPage.waitForVolumeCardSliceCounts(survivor);

    const withSurvivor = await saveSession();
    await openSavedSession(withSurvivor);
    await volViewPage.waitForVolumeCardSliceCounts(survivor);
  });
});
