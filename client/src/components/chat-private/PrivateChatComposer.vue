<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  sending: { type: Boolean, default: false },
  sendBlocked: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  shortcut: { type: String, default: 'enter' },
  replying: { type: Boolean, default: false },
  emojiOpen: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'send', 'emoji'])
const input = ref(null)
const mobileInput = ref(false)
const hint = computed(() => mobileInput.value ? '回车换行，点击发送' : props.shortcut === 'modifier' ? 'Ctrl / ⌘ + Enter 发送，Enter 换行' : 'Enter 发送，Shift + Enter 换行')
let media = null
function updateInputMode() {
  mobileInput.value = !!media?.matches || (navigator.maxTouchPoints > 0 && window.innerWidth <= 768)
}
function resize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(Math.max(el.scrollHeight, 46), 160) + 'px'
  el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden'
}
function update(event) { emit('update:modelValue', event.target.value); resize() }
function onKeydown(event) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.repeat || event.shiftKey || event.altKey) return
  const modifier = event.ctrlKey || event.metaKey
  if (mobileInput.value && !modifier) return
  if (props.shortcut === 'modifier' && !modifier) return
  if (props.disabled || props.sending || props.sendBlocked || !props.modelValue.trim()) return
  event.preventDefault()
  emit('send')
}
function focus() { input.value?.focus({ preventScroll: true }) }
function insertText(text) {
  const el = input.value
  const start = el?.selectionStart ?? props.modelValue.length
  const end = el?.selectionEnd ?? start
  const next = props.modelValue.slice(0, start) + text + props.modelValue.slice(end)
  if (next.length > 2000) return
  emit('update:modelValue', next)
  nextTick(() => { focus(); input.value?.setSelectionRange(start + text.length, start + text.length) })
}
watch(() => props.modelValue, () => nextTick(resize))
onMounted(() => {
  media = window.matchMedia?.('(hover: none) and (pointer: coarse)')
  updateInputMode()
  media?.addEventListener?.('change', updateInputMode)
  window.addEventListener('resize', updateInputMode)
  resize()
})
onBeforeUnmount(() => {
  media?.removeEventListener?.('change', updateInputMode)
  window.removeEventListener('resize', updateInputMode)
})
defineExpose({ focus, insertText })
</script>

<template>
  <div class="private-composer glass">
    <div class="composer-row">
      <button type="button" class="composer-emoji" aria-label="插入表情" :aria-expanded="emojiOpen" :disabled="disabled" @click="emit('emoji')"><Icon name="smile" :size="21" /></button>
      <textarea ref="input" :value="modelValue" aria-label="消息内容" aria-describedby="private-compose-help" :placeholder="replying ? '写下你的回复…' : '写一条消息…'" rows="1" maxlength="2000" :disabled="disabled" @input="update" @keydown="onKeydown" />
      <button type="button" class="btn btn-primary composer-send" :disabled="disabled || sending || sendBlocked || !modelValue.trim()" @click="emit('send')"><Icon name="send" :size="16" /><span>{{ sending ? '发送中' : '发送' }}</span></button>
    </div>
    <div id="private-compose-help" class="composer-help"><span>{{ hint }}</span><span aria-live="off">{{ modelValue.length }} / 2000</span></div>
  </div>
</template>

<style scoped>
.private-composer { flex-shrink: 0; padding: 10px 12px 8px; border-radius: var(--radius-lg); }
.composer-row { display: flex; gap: 8px; align-items: flex-end; }
.composer-emoji { display: inline-flex; align-items: center; justify-content: center; width: 44px; min-height: 46px; flex-shrink: 0; background: transparent; border: 0; color: var(--text-secondary); border-radius: var(--radius-sm); cursor: pointer; }
.composer-emoji:hover, .composer-emoji[aria-expanded="true"] { background: var(--accent-soft); color: var(--text-link); }
textarea { flex: 1; min-width: 0; min-height: 46px; max-height: 160px; resize: none; padding: 11px 12px; line-height: 1.5; font: inherit; font-size: 1rem; }
.composer-send { min-height: 46px; flex-shrink: 0; }
.composer-help { display: flex; justify-content: space-between; gap: 12px; margin: 6px 3px 0; color: var(--text-muted); font-size: 0.75rem; line-height: 1.5; font-variant-numeric: tabular-nums; }
@media (max-width: 480px) { .private-composer { padding: 8px; } .composer-row { gap: 4px; } .composer-emoji { width: 44px; } .composer-send { padding: 10px 12px; } .composer-send .icon { display: none; } }
</style>
