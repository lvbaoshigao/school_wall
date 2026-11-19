<script setup>
import { ref, watch } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import Icon from './Icon.vue'

const props = defineProps({
  images: { type: Array, default: () => [] },
  /** 当前显示索引 */
  modelValue: { type: Number, default: 0 },
})

const emit = defineEmits(['update:modelValue', 'close'])

const visible = ref(false)
const currentIndex = ref(0)
const overlayRef = ref(null)
const imageFailed = ref(false)
useFocusTrap(visible, overlayRef, close)

watch(currentIndex, index => {
  imageFailed.value = false
  emit('update:modelValue', index)
})
watch(() => props.modelValue, index => {
  if (visible.value) currentIndex.value = normalizeIndex(index)
})
watch(() => props.images.length, length => {
  if (!visible.value) return
  if (!length) close()
  else currentIndex.value = normalizeIndex(currentIndex.value)
})

function normalizeIndex(index) {
  return Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : 0, props.images.length - 1))
}

function open(index = props.modelValue) {
  if (!props.images.length) return
  currentIndex.value = normalizeIndex(index)
  imageFailed.value = false
  visible.value = true
}

function close() {
  if (!visible.value) return
  visible.value = false
  emit('close')
}

function prev() {
  if (currentIndex.value > 0) currentIndex.value--
}

function next() {
  if (currentIndex.value < props.images.length - 1) currentIndex.value++
}

function onKeydown(e) {
  if (!visible.value) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    if (e.key === 'ArrowLeft') prev()
    else next()
  }
}

defineExpose({ open, close })
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox">
      <div v-if="visible" ref="overlayRef" tabindex="-1" class="lightbox-overlay" role="dialog" aria-modal="true" aria-label="图片预览" @keydown="onKeydown" @click.self="close">
        <button class="lightbox-close" aria-label="关闭图片" @click="close"><Icon name="close" :size="20" /></button>

        <button v-if="currentIndex > 0" class="lightbox-nav lightbox-prev" aria-label="上一张图片" @click.stop="prev">
          ‹
        </button>

        <div class="lightbox-content">
          <p v-if="imageFailed" class="lightbox-error" role="status">图片加载失败，请关闭后重试。</p>
          <img v-else :key="images[currentIndex]" :src="images[currentIndex]" :alt="`第 ${currentIndex + 1} 张图片，共 ${images.length} 张`" class="lightbox-img" @error="imageFailed = true" />
        </div>

        <button v-if="currentIndex < images.length - 1" class="lightbox-nav lightbox-next" aria-label="下一张图片" @click.stop="next">
          ›
        </button>

        <div v-if="images.length > 1" class="lightbox-counter" aria-live="polite" aria-atomic="true">
          {{ currentIndex + 1 }} / {{ images.length }}
        </div>

        <div v-if="images.length > 1" class="lightbox-dots" role="group" aria-label="选择图片">
          <button
            v-for="(img, i) in images"
            :key="i"
            class="lightbox-dot"
            :class="{ active: i === currentIndex }"
            :aria-label="`查看第 ${i + 1} 张图片`"
            :aria-current="i === currentIndex ? 'true' : undefined"
            @click="currentIndex = i"
          />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lightbox-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.92);
  z-index: var(--z-modal);
  outline: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: #fff;
  font-size: 24px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  transition: background 0.2s;
}

.lightbox-close:hover { background: rgba(255, 255, 255, 0.2); }

.lightbox-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.08);
  border: none;
  color: #fff;
  font-size: 48px;
  width: 56px;
  height: 80px;
  cursor: pointer;
  z-index: 10;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox-nav:hover { background: rgba(255, 255, 255, 0.18); }

.lightbox-prev { left: 0; border-radius: 0 var(--radius-md) var(--radius-md) 0; }
.lightbox-next { right: 0; border-radius: var(--radius-md) 0 0 12px; }

.lightbox-content {
  max-width: 90vw;
  max-height: calc(100dvh - 160px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox-img {
  max-width: 90vw;
  max-height: calc(100dvh - 160px);
  object-fit: contain;
  border-radius: var(--radius-xs);
  user-select: none;
}

.lightbox-counter {
  position: absolute;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
}

.lightbox-dots {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 0;
  max-width: 90vw;
  overflow-x: auto;
}

.lightbox-dot {
  width: 36px;
  height: 44px;
  border-radius: 0;
  border: none;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.45) 4px, transparent 5px);
  cursor: pointer;
  padding: 0;
  transition: all 0.2s;
}

.lightbox-dot.active {
  background: radial-gradient(circle, #fff 4px, transparent 5px);
}

.lightbox-error { color: #fff; padding: 24px; text-align: center; }
.lightbox-overlay :focus-visible { outline-color: #acd8c3; }
@media (max-width: 480px) {
  .lightbox-nav { width: 44px; height: 64px; font-size: 36px; }
  .lightbox-close { top: max(12px, env(safe-area-inset-top)); }
}

/* 过渡动画 */
.lightbox-enter-active { transition: opacity 0.25s ease; }
.lightbox-leave-active { transition: opacity 0.2s ease; }
.lightbox-enter-from, .lightbox-leave-to { opacity: 0; }
</style>
