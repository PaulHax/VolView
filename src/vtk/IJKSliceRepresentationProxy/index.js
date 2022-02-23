import macro from '@kitware/vtk.js/macro';

import vtkSliceRepresentationProxy from '@kitware/vtk.js/Proxy/Representations/SliceRepresentationProxy';

function vtkIJKSliceRepresentationProxy(publicAPI, model) {
  model.classHierarchy.push('vtkIJKSliceRepresentationProxy');

  // don't set colors on slices
  publicAPI.setColorBy = () => {};
}

// ----------------------------------------------------------------------------
// Object factory
// ----------------------------------------------------------------------------

const DEFAULT_VALUES = {};

// ----------------------------------------------------------------------------

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, DEFAULT_VALUES, initialValues);

  // Object methods
  vtkSliceRepresentationProxy.extend(publicAPI, model);

  // Object specific methods
  vtkIJKSliceRepresentationProxy(publicAPI, model);
}

// ----------------------------------------------------------------------------

export const newInstance = macro.newInstance(
  extend,
  'vtkIJKSliceRepresentationProxy'
);

// ----------------------------------------------------------------------------

export default { newInstance, extend };
