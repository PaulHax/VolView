declare module 'labelmap-polydata' {
  import type vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
  import type vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';

  export interface LabelmapToPolyDatasOptions {
    segments?: number[];
    worker?: Worker;
  }

  export type PolyDataResult = Record<number, vtkPolyData>;

  export function labelmapToPolyDatas(
    imageData: vtkImageData,
    options?: LabelmapToPolyDatasOptions
  ): Promise<PolyDataResult>;

  export function coreLabelmapToPolyDatas(
    imageData: vtkImageData,
    options?: { segments?: number[] }
  ): PolyDataResult;
}

declare module 'labelmap-polydata/worker?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
