<script setup>
import { computed } from 'vue'
const props = defineProps({
  lines: { type: Number, default: 3 },
  imageCount: { type: Number, default: 0 },
})
const safeLines = computed(() => Math.max(1, Math.min(6, Math.trunc(Number(props.lines) || 3))))
const safeImageCount = computed(() => Math.max(0, Math.min(9, Math.trunc(Number(props.imageCount) || 0))))
</script>

<template>
  <div class="skeleton-card glass" role="status" aria-busy="true" aria-label="正在加载内容">
    <div class="skeleton-header" aria-hidden="true">
      <div class="skeleton-avatar shimmer" />
      <div class="skeleton-info">
        <div class="skeleton-line shimmer" style="width: 80px" />
        <div class="skeleton-line shimmer" style="width: 50px; height: 10px" />
      </div>
    </div>
    <div class="skeleton-body" aria-hidden="true">
      <div v-for="i in safeLines" :key="i" class="skeleton-line shimmer" :style="{ width: (90 - (i - 1) * 15) + '%' }" />
    </div>
    <div v-if="safeImageCount > 0" class="skeleton-images" aria-hidden="true">
      <div v-for="i in safeImageCount" :key="i" class="skeleton-img shimmer" />
    </div>
    <div class="skeleton-footer" aria-hidden="true">
      <div class="skeleton-line shimmer" style="width: 60px" />
      <div class="skeleton-line shimmer" style="width: 60px" />
    </div>
  </div>
</template>

<style scoped>
.skeleton-card {
  padding: 20px;
  border-radius: var(--radius-lg);
}

.skeleton-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.skeleton-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--bg-input);
  flex-shrink: 0;
}

.skeleton-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.skeleton-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.skeleton-line {
  height: 14px;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}

.skeleton-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.skeleton-img {
  width: 80px;
  height: 80px;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}

.skeleton-footer {
  display: flex;
  gap: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.shimmer {
  position: relative;
  overflow: hidden;
}

.shimmer::after {
  content: '';
  position: absolute;
  top: 0; left: 0;
  transform: translateX(-100%);
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.06) 50%,
    transparent 100%
  );
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  100% { transform: translateX(100%); }
}
</style>
