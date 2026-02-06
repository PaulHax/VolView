import * as path from 'path';
import * as fs from 'fs';
import { TEMP_DIR } from '../../wdio.shared.conf';
import { volViewPage } from '../pageobjects/volview.page';
import { openVolViewPage } from './utils';

const JAPANESE_DICOM = {
  // Test DICOM file with ISO 2022 IR 87 encoded Japanese patient name.
  // The JIS X 0208 encoding contains 0x5C (backslash) bytes that previously
  // caused "Unterminated string in JSON" errors during loading.
  source: path.resolve(
    __dirname,
    '../data/dicom-japanese-patient-name.dcm'
  ),
  name: 'dicom-japanese-patient-name.dcm',
} as const;

describe('DICOM with Japanese Patient Name (ISO 2022 IR 87)', () => {
  it('should load without JSON parse errors', async () => {
    // Copy test DICOM file to temp directory so the static server can serve it
    const destPath = path.join(TEMP_DIR, JAPANESE_DICOM.name);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.copyFileSync(JAPANESE_DICOM.source, destPath);

    // Load the DICOM file in VolView
    await openVolViewPage(JAPANESE_DICOM.name);

    // If we get here without errors, the file loaded successfully.
    // openVolViewPage waits for views to render and checks for 0 notifications.

    // Verify that views are actually rendered
    const views = await volViewPage.views;
    const viewCount = await views.length;
    expect(viewCount).toBeGreaterThan(0);
  });
});
