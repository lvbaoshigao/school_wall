<script setup>
import Icon from './Icon.vue'

// 统一错误状态：替代原先「catch 里只 console.error，用户无感知」的写法
defineProps({
  /** 主标题 */
  title: { type: String, default: '加载出错了' },
  /** 辅助说明 */
  desc: { type: String, default: '' },
  /** 重试按钮文字（不传则不显示） */
  retryText: { type: String, default: '重试' },
  /** 是否显示重试按钮 */
  showRetry: { type: Boolean, default: true },
})

const emit = defineEmits(['retry'])
</script>

<template>
  <div class="state-block state-error error-state-block">
    <div class="state-icon"><Icon name="alert-triangle" :size="34" /></div>
    <p class="state-title">{{ title }}</p>
    <p v-if="desc" class="state-desc">{{ desc }}</p>
    <button v-if="showRetry" class="btn btn-secondary btn-sm mt-2" @click="emit('retry')">
      {{ retryText }}
    </button>
    <slot />
  </div>
</template>

<style scoped>
.error-state-block .state-title { color: var(--text-primary); }
</style>
