import { serialize } from '@/src/io/state-file/serialize';
import { useMessageStore } from '@/src/store/messages';
import { isOriginAllowed } from '@/src/io/originGate';
import { $fetch } from '@/src/utils/fetch';
import { defineStore } from 'pinia';
import { ref } from 'vue';

const useRemoteSaveStateStore = defineStore('remoteSaveState', () => {
  const saveUrl = ref('');
  const isSaving = ref(false);

  const messageStore = useMessageStore();

  // The remote-save target passes the SAME runtime egress gate as processing
  // providers — one gate for all configured egress. A disallowed origin never
  // reaches `saveUrl`, so the remote-save surface (gated on `saveUrl !== ''`)
  // and its egress both stay inert. Same-origin passes with zero config; a
  // cross-origin target needs the deployment's allow-list.
  const setSaveUrl = async (url: string) => {
    if (await isOriginAllowed(url)) {
      saveUrl.value = url;
    } else {
      saveUrl.value = '';
      console.warn(
        `Ignoring remote-save URL because its origin is not allowed: ${url}`
      );
    }
  };

  const saveState = async () => {
    if (!saveUrl.value || isSaving.value) return;
    try {
      isSaving.value = true;

      const blob = await serialize();
      const saveResult = await $fetch(saveUrl.value, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': blob.size.toString(),
        },
        body: blob,
      });

      if (saveResult.ok) messageStore.addSuccess('Save Successful');
      else
        messageStore.addError('Save Failed', {
          details: 'Network response not OK',
        });
    } catch (error) {
      messageStore.addError('Save Failed with error', {
        details: `Failed from: ${error}`,
      });
    } finally {
      isSaving.value = false;
    }
  };

  return {
    saveUrl,
    setSaveUrl,
    isSaving,
    saveState,
  };
});

export default useRemoteSaveStateStore;
