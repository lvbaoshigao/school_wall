import { computed, ref, onActivated, onDeactivated, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from '../stores/user'
import { useWallStore } from '../stores/wall'

// 所有请求同时绑定账号、墙及路由；即使传输层不能取消，也不能回写旧页面。
export function useConfessionContext() {
  const userStore = useUserStore()
  const wallStore = useWallStore()
  const route = useRoute()
  const pageRouteName = route.name
  const suspended = ref(false)
  const contextKey = computed(() => [userStore.sessionRevision, userStore.token, userStore.user?.id, wallStore.currentWallId, route.name, route.fullPath, suspended.value].join(':'))
  const wallId = computed(() => Number(wallStore.currentWallId) || 0)
  const active = computed(() => !!userStore.isLoggedIn && !suspended.value && route.name === pageRouteName)
  const controllers = new Set()
  let disposed = false
  function cancel() {
    for (const controller of controllers) controller.abort()
    controllers.clear()
  }
  watch(contextKey, cancel, { flush: 'sync' })
  onActivated(() => { suspended.value = false })
  onDeactivated(() => { suspended.value = true; cancel() })
  onBeforeUnmount(() => { disposed = true; cancel() })
  function capture(targetWallId = wallId.value) {
    const key = contextKey.value
    const controller = new AbortController()
    controllers.add(controller)
    return {
      current: () => !disposed && active.value && !controller.signal.aborted && contextKey.value === key,
      config: { signal: controller.signal, ...(targetWallId ? { headers: { 'X-Wall-Id': targetWallId } } : {}) },
      release: () => controllers.delete(controller),
      abort: () => { controller.abort(); controllers.delete(controller) },
    }
  }
  return { contextKey, wallId, active, capture }
}
