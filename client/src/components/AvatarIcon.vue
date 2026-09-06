<script setup>
import { computed } from 'vue'

const props = defineProps({
  /** 图片 URL，有则显示图片 */
  src: { type: String, default: '' },
  /** 显示文字（取首字），没有 src 时使用 */
  name: { type: String, default: '?' },
  /** 尺寸 'sm' | 'md' | 'lg' | 'xl' */
  size: { type: String, default: 'md' },
  /** 是否为匿名模式 */
  anonymous: { type: Boolean, default: false },
})

const sizeMap = { sm: 28, md: 36, lg: 44, xl: 64 }
const fontSizeMap = { sm: 12, md: 14, lg: 18, xl: 28 }

const avatarSize = computed(() => sizeMap[props.size] || 36)
const avatarFontSize = computed(() => fontSizeMap[props.size] || 14)
const firstChar = computed(() => (props.name || '?')[0])

const bgGradient = computed(() =>
  props.anonymous
    ? 'linear-gradient(180deg, #6b7378 0%, #3d4548 100%)'
    : 'var(--btn-fill)'
)
</script>

<template>
  <div
    class="avatar-icon"
    :class="{ anonymous }"
    :style="{
      width: avatarSize + 'px',
      height: avatarSize + 'px',
      fontSize: avatarFontSize + 'px',
      background: bgGradient,
    }"
  >
    <img v-if="src" :src="src" class="avatar-img" alt="" />
    <span v-else class="avatar-text">{{ firstChar }}</span>
  </div>
</template>

<style scoped>
.avatar-icon {
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.2);
}

.avatar-icon.anonymous {
  border-color: rgba(255, 255, 255, 0.1);
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-text {
  line-height: 1;
  user-select: none;
}
</style>
