<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { shouldSendMessage } from './socialState'

const props = defineProps({
  modelValue: { type: String, default: '' }, disabled: Boolean, sending: Boolean,
  shortcut: { type: String, default: 'enter' }, label: { type: String, default: '消息内容' },
})
const emit = defineEmits(['update:modelValue', 'submit'])
const textarea = ref(null)
const mobile = ref(false)
const composing = ref(false)
function syncMobile() { mobile.value = window.innerWidth <= 768 || !!window.matchMedia?.('(pointer: coarse)').matches }
function resize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
}
function focus() { textarea.value?.focus() }
function submit() { if (!props.disabled && !props.sending && props.modelValue.trim() && props.modelValue.length <= 2000) emit('submit') }
function onKeydown(event) {
  if (!composing.value && shouldSendMessage(event, props.shortcut, mobile.value)) { event.preventDefault(); submit() }
}
function onInput(event) { emit('update:modelValue', event.target.value); resize() }
function insertText(text) {
  if (props.disabled) return
  const el = textarea.value
  const start = el?.selectionStart ?? props.modelValue.length
  const end = el?.selectionEnd ?? start
  const next = props.modelValue.slice(0, start) + text + props.modelValue.slice(end)
  if (next.length > 2000) return
  emit('update:modelValue', next)
  nextTick(() => { focus(); el?.setSelectionRange(start + text.length, start + text.length); resize() })
}
watch(() => props.modelValue, () => nextTick(resize))
onMounted(() => { syncMobile(); resize(); window.addEventListener('resize', syncMobile) })
onBeforeUnmount(() => window.removeEventListener('resize', syncMobile))
defineExpose({ focus, insertText })
</script>

<template>
  <form class="social-composer glass" :aria-busy="sending" @submit.prevent="submit">
    <div class="composer-row">
      <slot name="tools" />
      <label class="composer-field"><span class="sr-only">{{ label }}</span><textarea ref="textarea" :value="modelValue" :aria-label="label" :disabled="disabled" rows="1" maxlength="2000" placeholder="慢慢说，我在听…" @input="onInput" @keydown="onKeydown" @compositionstart="composing = true" @compositionend="composing = false"></textarea></label>
      <button class="btn btn-primary send-button" type="submit" :disabled="disabled || sending || !modelValue.trim() || modelValue.length > 2000">{{ sending ? '发送中…' : '发送' }}</button>
    </div>
    <div class="composer-help"><span>{{ mobile ? 'Enter 换行，点击按钮发送' : shortcut === 'modifier' ? 'Ctrl / ⌘ + Enter 发送，Enter 换行' : 'Enter 发送，Shift + Enter 换行' }}</span><span>{{ modelValue.length }}/2000</span></div>
  </form>
</template>

<style scoped>
.social-composer { flex-shrink: 0; padding: var(--space-3) var(--space-4) max(var(--space-3), env(safe-area-inset-bottom)); border-radius: var(--radius-md); }
.composer-row { display: flex; align-items: flex-end; gap: var(--space-2); }
.composer-field { display: flex; min-width: 0; flex: 1; }
.composer-field textarea { display: block; width: 100%; min-width: 0; min-height: 2.75rem; max-height: 10rem; resize: none; overflow-y: auto; line-height: 1.6; font-size: 1rem; padding: .6rem .75rem; }
.send-button { flex-shrink: 0; min-width: 44px; min-height: 44px; }
.composer-help { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--font-xs); color: var(--text-muted); line-height: 1.6; margin-top: var(--space-2); font-variant-numeric: tabular-nums; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 480px) { .social-composer { padding-inline: var(--space-2); } .send-button { padding-inline: var(--space-3); } .composer-help { gap: var(--space-2); } }
</style>
