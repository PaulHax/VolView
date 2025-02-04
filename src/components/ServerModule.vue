<script setup lang="ts">
import { computed, ref } from 'vue';
import { useCurrentImage } from '@/src/composables/useCurrentImage';
import { useServerStore, ConnectionState } from '@/src/store/server';

const serverStore = useServerStore();
const { client } = serverStore;
const ready = computed(
  () => serverStore.connState === ConnectionState.Connected
);

const trivia = ref('');
const triviaLoading = ref(false);

const { currentImageID } = useCurrentImage();
const getTrivia = async () => {
  const id = currentImageID.value;
  if (!id) return;
  triviaLoading.value = true;

  try {
    trivia.value = (await client.call('categorize_image', [id])) as string;
  } finally {
    triviaLoading.value = false;
  }
};

const hasCurrentImage = computed(() => !!currentImageID.value);
</script>

<template>
  <div class="overflow-y-auto overflow-x-hidden ma-2 fill-height">
    <v-alert v-if="!ready" color="info">Not connected to the server.</v-alert>
    <v-divider />
    <v-list-subheader>Cure AI</v-list-subheader>
    <v-row>
      <v-btn
        @click="getTrivia"
        :loading="triviaLoading"
        :disabled="!ready || !hasCurrentImage"
      >
        Compute Category
      </v-btn>
    </v-row>
    <v-row>
      <v-col>
        <label for="remote-trivia-text">
          <textarea
            id="remote-trivia-text"
            readonly
            class="text-white"
            style="width: 100%"
            :value="trivia"
          />
        </label>
      </v-col>
    </v-row>
  </div>
</template>
