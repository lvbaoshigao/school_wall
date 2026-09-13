<script setup>
import Icon from './Icon.vue'

// 统一空状态：替代原先 .empty-state / .empty / 内联 padding 三套并存的写法
defineProps({
  /** Icon.vue 图标名 */
  icon: { type: String, default: 'file' },
  /** 主标题 */
  title: { type: String, default: '这里空空如也' },
  /** 辅助说明（可选） */
  desc: { type: String, default: '' },
  /** 引导按钮文字（不传则不显示按钮） */
  actionText: { type: String, default: '' },
  /** 紧凑模式：用于卡片内嵌（如侧栏、抽屉） */
  compact: { type: Boolean, default: false },
})

const emit = defineEmits(['action'])
</script>

<template>
  <div class="state-block empty-state-block" :class="{ compact }">
    <div class="state-icon"><Icon :name="icon" :size="compact ? 26 : 34" /></div>
    <p class="state-title">{{ title }}</p>
    <p v-if="desc" class="state-desc">{{ desc }}</p>
    <button v-if="actionText" class="btn btn-primary btn-sm mt-2" @click="emit('action')">
      {{ actionText }}
    </button>
    <!-- 默认插槽：放自定义操作区 -->
    <slot />
  </div>
</template>

<style scoped>
.empty-state-block.compact {
  padding: var(--space-4) var(--space-3);
}
.empty-state-block.compact .state-title {
  font-size: var(--font-md);
}
</style>
