<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  images: { type: Array, default: () => [] },
  /** 当前显示索引 */
  modelValue: { type: Number, default: 0 },
})

const emit = defineEmits(['update:modelValue', 'close'])

const visible = ref(false)
const currentIndex = ref(0)

function open(index = 0) {
  currentIndex.value = Math.max(0, Math.min(index, props.images.length - 1))
  visible.value = true
  document.body.style.overflow = 'hidden'
}

function close() {
  visible.value = false
  document.body.style.overflow = ''
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
  if (e.key === 'Escape') close()
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

defineExpose({ open, close })
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox">
      <div v-if="visible" class="lightbox-overlay" @click.self="close">
        <button class="lightbox-close" aria-label="关闭图片" @click="close"><Icon name="close" :size="20" /></button>

        <button v-if="currentIndex > 0" class="lightbox-nav lightbox-prev" @click.stop="prev">
          ‹
        </button>

        <div class="lightbox-content">
          <img :src="images[currentIndex]" alt="" class="lightbox-img" />
        </div>

        <button v-if="currentIndex < images.length - 1" class="lightbox-nav lightbox-next" @click.stop="next">
          ›
        </button>

        <div v-if="images.length > 1" class="lightbox-counter">
          {{ currentIndex + 1 }} / {{ images.length }}
        </div>

        <div v-if="images.length > 1" class="lightbox-dots">
          <button
            v-for="(img, i) in images"
            :key="i"
            class="lightbox-dot"
            :class="{ active: i === currentIndex }"
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
  z-index: 9000;
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
  max-height: 85vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox-img {
  max-width: 90vw;
  max-height: 85vh;
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
  gap: 8px;
}

.lightbox-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.4);
  background: transparent;
  cursor: pointer;
  padding: 0;
  transition: all 0.2s;
}

.lightbox-dot.active {
  background: #fff;
  border-color: #fff;
}

/* 过渡动画 */
.lightbox-enter-active { transition: opacity 0.25s ease; }
.lightbox-leave-active { transition: opacity 0.2s ease; }
.lightbox-enter-from, .lightbox-leave-to { opacity: 0; }
</style>
