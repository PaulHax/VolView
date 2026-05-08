import * as path from 'path';
import * as fs from 'fs';
import { TEMP_DIR } from '../../wdio.shared.conf';
import { volViewPage } from '../pageobjects/volview.page';
import { openVolViewPage } from './utils';

const FIXTURE_NAME = 'dicom-japanese-patient-name.dcm';

describe('DICOM with Japanese Patient Name (ISO 2022 IR 87)', () => {
  before(() => {
    const fixturePath = path.join(TEMP_DIR, FIXTURE_NAME);
    if (!fs.existsSync(fixturePath)) {
      throw new Error(
        `Missing fixture ${fixturePath}. Generate it once with:\n` +
          `  python3 tests/data/create-dicom-japanese-patient-name.py`
      );
    }
  });

  it('should load without errors', async () => {
    await openVolViewPage(FIXTURE_NAME);

    const views = await volViewPage.views;
    const viewCount = await views.length;
    expect(viewCount).toBeGreaterThan(0);
  });
});
