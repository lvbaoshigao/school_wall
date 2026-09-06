<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'

const visible = ref(false)
const threshold = 400

function onScroll() {
  visible.value = window.scrollY > threshold
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }))
onUnmounted(() => window.removeEventListener('scroll', onScroll))
</script>

<template>
  <Transition name="fab">
    <button v-if="visible" class="back-to-top glass-strong" @click="scrollToTop" title="回到顶部" aria-label="回到顶部">
      <Icon class="arrow" name="arrow-up" :size="20" />
    </button>
  </Transition>
</template>

<style scoped>
.back-to-top {
  position: fixed;
  bottom: 28px;
  right: 28px;
  z-index: 900;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-md);
  transition: transform 0.2s, box-shadow 0.2s;
}

.back-to-top:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.arrow { color: #fff; }

.fab-enter-active { transition: all 0.3s ease; }
.fab-leave-active { transition: all 0.2s ease; }
.fab-enter-from, .fab-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.8);
}
</style>
