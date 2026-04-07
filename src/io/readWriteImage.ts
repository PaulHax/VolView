import vtkITKHelper from '@kitware/vtk.js/Common/DataModel/ITKHelper';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import { copyImage } from 'itk-wasm';
import {
  readImage as readImageItk,
  writeImage as writeImageItk,
} from '@itk-wasm/image-io';
import { vtiReader, vtiWriter } from '@/src/io/vtk/async';
import { getWorker } from '@/src/io/itk/worker';
import type { SegmentGroupMetadata } from '@/src/store/segmentGroups';
import { maybeBuildSegNrrdMetadata } from '@/src/io/segNrrdMetadata';

export const readImage = async (file: File, webWorker?: Worker | null) => {
  if (file.name.endsWith('.vti'))
    return (await vtiReader(file)) as vtkImageData;

  const { image } = await readImageItk(file, {
    webWorker: webWorker ?? getWorker(),
  });
  return vtkITKHelper.convertItkToVtkImage(image);
};

export const writeImage = async (
  format: string,
  image: vtkImageData,
  options?: { webWorker?: Worker | null; metadata?: Map<string, string> }
) => {
  if (format === 'vti') {
    return vtiWriter(image);
  }
  // copyImage so writeImage does not detach live data when passing to worker
  const itkImage = copyImage(vtkITKHelper.convertVtkToItkImage(image));

  if (options?.metadata) {
    itkImage.metadata = options.metadata;
  }

  const result = await writeImageItk(itkImage, `image.${format}`, {
    webWorker: options?.webWorker ?? getWorker(),
    useCompression: true,
  });
  return result.serializedImage.data as Uint8Array<ArrayBuffer>;
};

export const writeSegmentation = (
  format: string,
  image: vtkImageData,
  segMetadata: SegmentGroupMetadata,
  webWorker?: Worker | null
) => {
  const metadata = maybeBuildSegNrrdMetadata(
    format,
    segMetadata,
    image.getDimensions() as [number, number, number]
  );
  return writeImage(format, image, { metadata, webWorker });
};
