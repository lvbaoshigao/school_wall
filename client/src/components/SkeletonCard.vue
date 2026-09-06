<script setup>
defineProps({
  lines: { type: Number, default: 3 },
  imageCount: { type: Number, default: 0 },
})
</script>

<template>
  <div class="skeleton-card glass">
    <div class="skeleton-header">
      <div class="skeleton-avatar shimmer" />
      <div class="skeleton-info">
        <div class="skeleton-line shimmer" style="width: 80px" />
        <div class="skeleton-line shimmer" style="width: 50px; height: 10px" />
      </div>
    </div>
    <div class="skeleton-body">
      <div v-for="i in lines" :key="i" class="skeleton-line shimmer" :style="{ width: (90 - (i - 1) * 15) + '%' }" />
    </div>
    <div v-if="imageCount > 0" class="skeleton-images">
      <div v-for="i in imageCount" :key="i" class="skeleton-img shimmer" />
    </div>
    <div class="skeleton-footer">
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
  background: rgba(255, 255, 255, 0.08);
}

.skeleton-images {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.skeleton-img {
  width: 80px;
  height: 80px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.08);
}

.skeleton-footer {
  display: flex;
  gap: 24px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.shimmer {
  position: relative;
  overflow: hidden;
}

.shimmer::after {
  content: '';
  position: absolute;
  top: 0; left: -100%;
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
  100% { left: 100%; }
}
</style>
