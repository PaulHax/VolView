<script setup lang="ts">
import { computed } from 'vue';
import ViewTypeSwitcher from '@/src/components/ViewTypeSwitcher.vue';
import { useViewStore } from '@/src/store/views';

const props = defineProps<{ viewId: string; error?: Error }>();
const views = useViewStore();
const imageId = computed(() => views.getView(props.viewId)?.dataID);
</script>

<template>
  <div class="enface-load-error">
    <p role="alert">
      En face view could not load. Choose another view to continue.
    </p>
    <ViewTypeSwitcher :view-id="viewId" :image-id="imageId" />
  </div>
</template>

<style scoped>
.enface-load-error {
  position: absolute;
  inset: 0;
  z-index: 11;
  background: black;
  color: white;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  width: 100%;
  height: 100%;
  padding: 16px;
  box-sizing: border-box;
}
</style>
