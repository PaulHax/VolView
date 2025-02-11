<script setup lang="ts">
import { computed, ref } from 'vue';
import { useCurrentImage } from '@/src/composables/useCurrentImage';
import { useServerStore, ConnectionState } from '@/src/store/server';

const serverStore = useServerStore();
const { client } = serverStore;
const ready = computed(
  () => serverStore.connState === ConnectionState.Connected
);

const diagnosis = ref('Possible pneumonia detected.');
const loading = ref(false);

const { currentImageID } = useCurrentImage();
const getTrivia = async () => {
  const id = currentImageID.value;
  if (!id) return;
  loading.value = true;

  try {
    const category = (await client.call('categorize_image', [id])) as string;

    diagnosis.value = category
      ? 'No pneumonia detected'
      : 'Possible pneumonia detected.';
  } finally {
    loading.value = false;
  }
};

const hasCurrentImage = computed(() => !!currentImageID.value);

const panel = ref([0, 1]);
const selectedExplanation = ref('grad-cam');
const selectedUncertainty = ref('');
</script>

<template>
  <v-col class="overflow-y-auto overflow-x-hidden ma-2 fill-height">
    <v-alert v-if="!ready" color="info">Not connected to the server.</v-alert>
    <v-divider v-if="!ready" />
    <v-row class="pb-4" justify="center">
      <h2>AI Pneumonia Diagnosis</h2>
    </v-row>
    <v-row align="center" justify="space-evenly">
      <v-btn
        @click="getTrivia"
        :loading="loading"
        :disabled="!ready || !hasCurrentImage"
        append-icon="mdi-checkbox-marked-outline"
      >
        Run AI
      </v-btn>
      <v-icon icon="mdi-arrow-right" />
      <v-btn-group mandatory variant="outlined">
        <v-btn>Normal</v-btn>
        <v-btn variant="tonal">Pneumonia</v-btn>
      </v-btn-group>
    </v-row>
    <v-row class="pt-4">
      <v-expansion-panels v-model="panel">
        <v-expansion-panel>
          <v-expansion-panel-title>
            <h3 class="text-h6">Explanation</h3>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-list-item-group>
              <v-list-item
                :active="selectedExplanation === 'grad-cam'"
                @click="selectedExplanation = 'grad-cam'"
              >
                <v-list-item-title
                  >Gradient-weighted Class Activation Mapping</v-list-item-title
                >
                <v-list-item-subtitle>
                  Shows areas in red that strongly influenced the AI's
                  decisions, areas in blue that are less relevant.
                </v-list-item-subtitle>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Perturbation Analysis</v-list-item-title>
                <v-list-item-subtitle>
                  Assesses the AI's sensitivity to changes in specific regions
                  of the input image.
                </v-list-item-subtitle>
              </v-list-item>
              <v-list-item>
                <v-list-item-title
                  >Counterfactual Explanation</v-list-item-title
                >
                <v-list-item-subtitle>
                  Illustrates how minimal changes to the input can alter the
                  AI's predictions.
                </v-list-item-subtitle>
              </v-list-item>
            </v-list-item-group>
          </v-expansion-panel-text>
        </v-expansion-panel>

        <v-expansion-panel>
          <v-expansion-panel-title>
            <h3 class="text-h6">Uncertainty</h3>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-list-item-group>
              <v-list-item
                :active="selectedUncertainty === 'ensemble'"
                @click="selectedUncertainty = 'ensemble'"
              >
                <v-list-item-title>Ensemble</v-list-item-title>
                <v-list-item-subtitle>
                  Aggregates predictions from multiple AIs to estimate
                  uncertainty.
                </v-list-item-subtitle>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Monte Carlo Dropout</v-list-item-title>
                <v-list-item-subtitle>
                  Estimates uncertainty by running multiple predictions with
                  randomly dropped connections.
                </v-list-item-subtitle>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Evidential Deep Learning</v-list-item-title>
                <v-list-item-subtitle>
                  Uses a probabilistic approach to quantify uncertainty in
                  predictions.
                </v-list-item-subtitle>
              </v-list-item>
              <v-list-item>
                <v-list-item-title>Conformal Uncertainty</v-list-item-title>
                <v-list-item-subtitle>
                  Provides a confidence interval for predictions based on
                  historical data.
                </v-list-item-subtitle>
              </v-list-item>
            </v-list-item-group>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </v-row>
  </v-col>
</template>
