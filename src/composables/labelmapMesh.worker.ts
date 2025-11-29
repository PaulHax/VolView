/* eslint-disable no-restricted-globals */
import { handleLabelmapMessage } from 'labelmap-polydata/workerHandler';

self.onmessage = (e) => {
  const { result, transferables } = handleLabelmapMessage(e.data);
  self.postMessage({ result }, transferables);
};
