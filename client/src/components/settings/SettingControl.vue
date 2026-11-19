<script setup>
const props = defineProps({
  setting: { type: Object, required: true },
  value: { default: undefined },
  disabled: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  disabledReason: { type: String, default: '' },
})
const emit = defineEmits(['change', 'action'])
function changeBoolean(event) {
  const value = event.target.checked
  event.target.checked = !!props.value
  emit('change', value)
}
function changeChoice(event) {
  const value = event.target.value
  event.target.value = String(props.value)
  emit('change', value)
}
</script>

<template>
  <div class="setting-control" :class="{ 'setting-disabled': disabled }" :aria-busy="busy">
    <div class="setting-copy">
      <label v-if="setting.type !== 'action'" class="setting-name" :for="'setting-' + setting.key">{{ setting.label }}</label>
      <h3 v-else class="setting-name">{{ setting.label }}</h3>
      <p :id="'setting-' + setting.key + '-help'" class="setting-description">{{ setting.description }}<span v-if="disabledReason" class="disabled-reason">{{ disabledReason }}</span></p>
    </div>
    <div class="setting-input">
      <label v-if="setting.type === 'bool'" class="switch-target" :for="'setting-' + setting.key">
        <input :id="'setting-' + setting.key" class="setting-switch" type="checkbox" :checked="!!value" :disabled="disabled || busy" :aria-describedby="'setting-' + setting.key + '-help'" @change="changeBoolean" />
        <span class="switch-state" aria-hidden="true">{{ value ? '开启' : '关闭' }}</span>
      </label>
      <select v-else-if="setting.type === 'enum'" :id="'setting-' + setting.key" :value="value" :disabled="disabled || busy" :aria-describedby="'setting-' + setting.key + '-help'" @change="changeChoice">
        <option v-for="option in setting.options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <button v-else type="button" class="btn btn-secondary" :disabled="disabled || busy" :aria-label="setting.label + '：' + setting.button" @click="emit('action')">{{ busy ? '处理中…' : setting.button }}</button>
    </div>
  </div>
</template>

<style scoped>
.setting-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 1.5rem; padding: 1.2rem 0; }
.setting-control + .setting-control { border-top: 1px solid var(--border); }
.setting-copy { min-width: 0; }
.setting-name { display: block; margin: 0; font-size: .96rem; font-weight: 600; line-height: 1.6; color: var(--text-primary); cursor: pointer; }
h3.setting-name { cursor: auto; }
.setting-description { color: var(--text-muted); font-size: .84rem; line-height: 1.8; margin: .25rem 0 0; max-width: 43rem; text-wrap: pretty; }
.disabled-reason { display: block; color: var(--text-secondary); margin-top: .25rem; }
.setting-input { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
.setting-input select { min-height: max(44px, 2.8rem); max-width: 15rem; width: auto; min-width: 9rem; padding: .55rem 2rem .55rem .8rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); font: inherit; font-size: .85rem; }
.setting-input option { background: var(--bg-main); color: var(--text-primary); }
.setting-input .btn { white-space: normal; min-width: 6.5rem; min-height: max(44px, 2.8rem); font-size: .85rem; }
.switch-target { min-height: max(44px, 2.8rem); display: flex; align-items: center; gap: .6rem; cursor: pointer; padding-inline: .2rem; }
.setting-switch { appearance: none; width: 2.7rem; height: 1.6rem; border-radius: 2rem; border: 1px solid var(--border-strong); background: var(--bg-input); position: relative; flex-shrink: 0; cursor: pointer; transition: background .18s ease; }
.setting-switch::after { content: ''; position: absolute; width: 1.05rem; height: 1.05rem; top: calc(50% - .525rem); left: .2rem; border-radius: 50%; background: var(--text-muted); transition: transform .18s ease; }
.setting-switch:checked { background: var(--accent-2); border-color: var(--accent-2); }
.setting-switch:checked::after { background: #fff; transform: translateX(1.05rem); }
.switch-state { width: 2em; font-size: .78rem; color: var(--text-secondary); }
.setting-disabled .setting-input { opacity: .65; }
@media (max-width: 620px) { .setting-control { gap: .7rem; } .setting-input select { min-width: 8rem; max-width: 11rem; } .switch-state { display: none; } }
@media (max-width: 420px) { .setting-control:has(select) { grid-template-columns: minmax(0, 1fr); gap: .65rem; } .setting-control:has(select) .setting-input { justify-content: stretch; } .setting-input select { width: 100%; max-width: none; } .setting-input .btn { min-width: 5.5rem; max-width: 7rem; } }
@media (prefers-reduced-motion: reduce) { .setting-switch, .setting-switch::after { transition: none; } }
</style>
