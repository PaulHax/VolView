import 'vue-toastification/dist/index.css';
import 'vuetify/lib/styles/main.css';
import '@/src/global.css';

import '@kitware/vtk.js/Rendering/OpenGL/Profiles/Geometry';
import '@kitware/vtk.js/Rendering/OpenGL/Profiles/Volume';
import '@kitware/vtk.js/Rendering/OpenGL/Profiles/Glyph';

import { createApp } from 'vue';
import VueToast from 'vue-toastification';
import { createPinia } from 'pinia';
import vtkProxyManager from '@kitware/vtk.js/Proxy/Core/ProxyManager';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import { setPipelinesBaseUrl, setPipelineWorkerUrl } from '@itk-wasm/image-io';

import itkConfig from '@/src/io/itk/itkConfig';
import App from './components/App.vue';
import vuetify from './plugins/vuetify';
import { DICOMIO } from './io/dicom';
import { FILE_READERS } from './io';
import { registerAllReaders } from './io/readers';
import proxyConfiguration from './vtk/proxy';
import { CorePiniaProviderPlugin } from './core/provider';
import ProxyManagerWrapper from './core/proxies';
import { patchExitPointerLock } from './utils/hacks';
import { init as initErrorReporting } from './utils/errorReporting';
import { StoreRegistry } from './plugins/storeRegistry';
import { PROXY_MANAGER_WRAPPER_INJECT_KEY } from './composables/useProxyManager';

// patches
patchExitPointerLock();

// Initialize global mapper topologies
// polys and lines in the front
vtkMapper.setResolveCoincidentTopologyToPolygonOffset();
vtkMapper.setResolveCoincidentTopologyPolygonOffsetParameters(-3, -3);
vtkMapper.setResolveCoincidentTopologyLineOffsetParameters(-3, -3);

registerAllReaders(FILE_READERS);

const proxyManagerWrapper = new ProxyManagerWrapper(
  vtkProxyManager.newInstance({ proxyConfiguration })
);

const dicomIO = new DICOMIO();
dicomIO.initialize();

// for @itk-wasm/image-io
setPipelineWorkerUrl(itkConfig.pipelineWorkerUrl);
setPipelinesBaseUrl(itkConfig.imageIOUrl);

const pinia = createPinia();
pinia.use(
  CorePiniaProviderPlugin({
    proxies: proxyManagerWrapper,
    dicomIO,
  })
);
pinia.use(StoreRegistry);

const app = createApp(App);

initErrorReporting(app);

app.provide(PROXY_MANAGER_WRAPPER_INJECT_KEY, proxyManagerWrapper);
app.use(pinia);
app.use(VueToast);
app.use(vuetify);
app.mount('#app');
