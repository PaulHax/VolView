#!/usr/bin/env python3
"""Generate the Japanese-Patient-Name DICOM fixture for the dicom-japanese-name
e2e spec.

Run from the VolView repo root:

    python3 tests/data/create-dicom-japanese-patient-name.py

Output goes to .tmp/ (the wdio static-server mount and shared dump folder),
which is gitignored.

The patient name (山田倍太郎) is encoded with Specific Character Set
"ISO 2022 IR 87" (JIS X 0208). Character 倍 has JIS code 0x475C, whose
trailing byte is 0x5C — the original "Unterminated string in JSON" failure
mode in #841 surfaces from that 0x5C leaking into JSON output.
"""

from pathlib import Path
import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import CTImageStorage, generate_uid

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = REPO_ROOT / ".tmp"
OUT = OUT_DIR / "dicom-japanese-patient-name.dcm"


def build() -> FileDataset:
    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = CTImageStorage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = pydicom.uid.ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = generate_uid()

    ds = FileDataset(str(OUT), {}, file_meta=file_meta, preamble=b"\x00" * 128)

    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = "CT"

    ds.SpecificCharacterSet = ["", "ISO 2022 IR 87"]
    ds.PatientName = "山田倍太郎"
    ds.PatientID = "TEST001"
    ds.StudyDate = "20240101"
    ds.StudyDescription = "Test"
    ds.SeriesNumber = "1"
    ds.InstanceNumber = "1"

    ds.ImagePositionPatient = [0.0, 0.0, 0.0]
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    ds.PixelSpacing = [1.0, 1.0]
    ds.SliceThickness = 1.0
    ds.RescaleIntercept = -1024
    ds.RescaleSlope = 1

    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = 64
    ds.Columns = 64
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0

    pixels = np.zeros((64, 64), dtype=np.uint16)
    cy, cx = 32, 32
    for i in range(64):
        for j in range(64):
            d = ((i - cy) ** 2 + (j - cx) ** 2) ** 0.5
            pixels[i, j] = max(0, int(2000 - d * 30))
    ds.PixelData = pixels.tobytes()

    return ds


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ds = build()
    ds.save_as(OUT, write_like_original=False)
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
