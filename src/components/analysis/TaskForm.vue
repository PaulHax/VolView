<template>
  <div class="task-form">
    <div class="text-h6 mb-1">{{ doc.title }}</div>
    <div class="text-caption text-medium-emphasis mb-4">
      {{ doc.description }}
    </div>

    <template
      v-for="panel in doc.panels"
      :key="panel.groups[0]?.label ?? Math.random()"
    >
      <v-expansion-panels
        v-if="panel.advanced"
        variant="accordion"
        class="mb-3"
      >
        <v-expansion-panel>
          <v-expansion-panel-title>Advanced parameters</v-expansion-panel-title>
          <v-expansion-panel-text>
            <div
              v-for="group in visibleGroups(panel.groups)"
              :key="group.label"
              class="mb-3"
            >
              <div class="text-subtitle-2">{{ group.label }}</div>
              <div v-if="group.description" class="text-caption mb-2">
                {{ group.description }}
              </div>
              <div
                v-for="p in visibleParams(group.parameters)"
                :key="p.id"
                class="mb-3"
              >
                <component
                  :is="widgetFor(p)"
                  :param="p"
                  :model-value="values[p.id] as never"
                  @update:model-value="(v: ProcessingValue) => update(p.id, v)"
                />
              </div>
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <div v-else class="mb-4">
        <div v-for="group in panel.groups" :key="group.label" class="mb-3">
          <div class="text-subtitle-2">{{ group.label }}</div>
          <div v-if="group.description" class="text-caption mb-2">
            {{ group.description }}
          </div>
          <div
            v-for="p in visibleParams(group.parameters)"
            :key="p.id"
            class="mb-3"
          >
            <component
              :is="widgetFor(p)"
              :param="p"
              :model-value="values[p.id] as never"
              @update:model-value="(v: ProcessingValue) => update(p.id, v)"
            />
          </div>
        </div>
      </div>
    </template>

    <v-alert
      v-if="issues.length > 0"
      type="warning"
      density="compact"
      class="mb-3"
    >
      <div v-for="issue in issues" :key="issue.parameter" class="text-caption">
        {{ issue.message }}
      </div>
    </v-alert>

    <v-btn
      color="primary"
      :disabled="issues.length > 0 || submitting"
      :loading="submitting"
      @click="onSubmit"
    >
      Submit
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

import type { ProcessingValue } from '@/src/processing/types';
import type {
  SlicerCliDocument,
  SlicerCliValidationIssue,
} from '@/src/processing/adapters/slicer-cli';
import type { ParsedParam } from '@/src/processing/adapters/slicer-cli/parser';

import BooleanWidget from './widgets/BooleanWidget.vue';
import NumberWidget from './widgets/NumberWidget.vue';
import StringWidget from './widgets/StringWidget.vue';
import EnumerationWidget from './widgets/EnumerationWidget.vue';
import FileWidget from './widgets/FileWidget.vue';
import NewFileWidget from './widgets/NewFileWidget.vue';

const props = defineProps<{
  doc: SlicerCliDocument;
  initialValues: Record<string, ProcessingValue>;
  issues: SlicerCliValidationIssue[];
  submitting?: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:values', v: Record<string, ProcessingValue>): void;
  (e: 'submit', v: Record<string, ProcessingValue>): void;
}>();

const values = ref<Record<string, ProcessingValue>>({ ...props.initialValues });
watch(
  () => props.initialValues,
  (v) => {
    values.value = { ...v };
  },
  { deep: true }
);

function update(id: string, v: ProcessingValue) {
  values.value = { ...values.value, [id]: v };
  emit('update:values', values.value);
}

function onSubmit() {
  emit('submit', values.value);
}

// Output filenames are auto-generated server-side — never render them in the form.
function visibleParams(params: ParsedParam[]): ParsedParam[] {
  return params.filter((p) => p.channel !== 'output' && p.type !== 'new-file');
}

function visibleGroups<T extends { parameters: ParsedParam[] }>(
  groups: T[]
): T[] {
  return groups.filter((g) => visibleParams(g.parameters).length > 0);
}

function widgetFor(p: ParsedParam) {
  switch (p.type) {
    case 'boolean':
      return BooleanWidget;
    case 'number':
      return NumberWidget;
    case 'string':
      return StringWidget;
    case 'string-enumeration':
    case 'number-enumeration':
      return EnumerationWidget;
    case 'image':
    case 'file':
    case 'item':
      return FileWidget;
    case 'new-file':
      return NewFileWidget;
    default:
      return StringWidget;
  }
}
</script>

<style scoped>
.task-form {
  padding: 8px 0;
}
</style>
