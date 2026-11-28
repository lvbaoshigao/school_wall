import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import api, { readStorage, setRequestWallId, getSessionToken, subscribeSessionChange, getApiErrorMessage } from '../api'
import { useUserStore } from './user'

function wallId(value) {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export const useWallStore = defineStore('wall', () => {
  const myWalls = ref([])
  const currentWallId = ref(wallId(readStorage('currentWallId')))
  const loaded = ref(false)
  const loadError = ref('')
  // 仅记录本会话中成功的发布，用于唤醒缓存中的信息流。
  const lastPublishedPost = ref(null)
  // 删墙成功结果只在当前内存会话里短暂保留，供 App 的 keep-alive 重建后的
  // 新 Admin 实例恢复提示与焦点；绝不写入 localStorage。
  const lastWallDeletion = ref(null)
  let pendingRequest = null
  let loadVersion = 0
  const currentWall = computed(() => myWalls.value.find(w => w.id === currentWallId.value && (!w.member_status || w.member_status === 'active')) || null)
  const currentWallRole = computed(() => currentWall.value?.wall_role || null)
  const hasWall = computed(() => myWalls.value.some(w => !w.member_status || w.member_status === 'active'))

  function canHere(perm) { return useUserStore().canInWall(perm, currentWallId.value) }

  async function fetchMyWalls() {
    if (!getSessionToken()) return myWalls.value
    if (pendingRequest) return pendingRequest
    const requestedToken = getSessionToken()
    const requestedVersion = loadVersion
    const request = (async () => {
      loadError.value = ''
      try {
        const res = await api.get('/walls')
        if (getSessionToken() !== requestedToken || requestedVersion !== loadVersion) return myWalls.value
        if (!Array.isArray(res.data)) throw new Error('校园墙列表格式无效')
        myWalls.value = res.data.filter(w => wallId(w.id)).map(w => ({ ...w, id: wallId(w.id) }))
        loaded.value = true
        if (!currentWall.value) setCurrentWall(myWalls.value.find(w => !w.member_status || w.member_status === 'active')?.id ?? null)
      } catch (error) {
        if (getSessionToken() === requestedToken && requestedVersion === loadVersion) loadError.value = getApiErrorMessage(error, '校园墙加载失败，请重试')
        // 短暂网络故障不抹掉已加载的墙，也不把失败记成成功。
      }
      return myWalls.value
    })()
    pendingRequest = request
    try { return await request } finally { if (pendingRequest === request) pendingRequest = null }
  }

  function setCurrentWall(value) {
    const id = wallId(value)
    if (value !== null && value !== undefined && value !== '' && !id) return false
    if (id && loaded.value && !myWalls.value.some(w => w.id === id && (!w.member_status || w.member_status === 'active'))) return false
    currentWallId.value = id
    setRequestWallId(id)
    return true
  }
  function switchWall(id) { return setCurrentWall(id) }
  function markPostPublished(value) {
    const id = wallId(value)
    if (!id || id !== currentWallId.value) return false
    lastPublishedPost.value = { wallId: id }
    return true
  }
  function normalizeWallDeletion(value, result) {
    const id = wallId(value)
    if (!id || !result || typeof result !== 'object') return null
    const userStore = useUserStore()
    return {
      wallId: id,
      warnings: Array.isArray(result.warnings) ? result.warnings.filter(warning => typeof warning === 'string') : [],
      focusAllWalls: result.focusAllWalls === true,
      sessionRevision: userStore.sessionRevision,
      userId: userStore.user?.id ?? null,
    }
  }
  function consumeLastWallDeletion() {
    const result = lastWallDeletion.value
    lastWallDeletion.value = null
    if (!result) return null
    const userStore = useUserStore()
    if (result.sessionRevision !== userStore.sessionRevision || result.userId !== (userStore.user?.id ?? null)) return null
    return result
  }
  // 永久删除成功后立即清掉本地上下文，并使删除前的列表请求失效。
  // 结果必须在 currentWallId 改变前写入，供 App 重建的新 Admin 一次性消费。
  function removeDeletedWall(value, result = null) {
    const id = wallId(value)
    if (!id) return false
    const deletion = normalizeWallDeletion(id, result)
    lastWallDeletion.value = deletion?.focusAllWalls ? deletion : null
    loadVersion++
    pendingRequest = null
    myWalls.value = myWalls.value.filter(w => w.id !== id)
    if (lastPublishedPost.value?.wallId === id) lastPublishedPost.value = null
    const userStore = useUserStore()
    if (userStore.perms?.walls && Object.prototype.hasOwnProperty.call(userStore.perms.walls, id)) {
      const walls = { ...userStore.perms.walls }
      delete walls[id]
      userStore.perms = { ...userStore.perms, walls }
    }
    if (currentWallId.value === id) setCurrentWall(myWalls.value.find(w => !w.member_status || w.member_status === 'active')?.id ?? null)
    return true
  }
  function reset() {
    loadVersion++
    myWalls.value = []
    lastPublishedPost.value = null
    lastWallDeletion.value = null
    setCurrentWall(null)
    loaded.value = false
    loadError.value = ''
    pendingRequest = null
  }
  onScopeDispose(subscribeSessionChange(event => { if (event.resetContext) reset() }))

  return {
    myWalls, currentWallId, loaded, loadError, currentWall, currentWallRole, hasWall,
    canHere, fetchMyWalls, setCurrentWall, switchWall, removeDeletedWall, reset, lastPublishedPost, markPostPublished,
    lastWallDeletion, consumeLastWallDeletion,
  }
})
