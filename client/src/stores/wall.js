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
  let pendingRequest = null
  const currentWall = computed(() => myWalls.value.find(w => w.id === currentWallId.value && (!w.member_status || w.member_status === 'active')) || null)
  const currentWallRole = computed(() => currentWall.value?.wall_role || null)
  const hasWall = computed(() => myWalls.value.some(w => !w.member_status || w.member_status === 'active'))

  function canHere(perm) { return useUserStore().canInWall(perm, currentWallId.value) }

  async function fetchMyWalls() {
    if (!getSessionToken()) return myWalls.value
    if (pendingRequest) return pendingRequest
    const requestedToken = getSessionToken()
    const request = (async () => {
      loadError.value = ''
      try {
        const res = await api.get('/walls')
        if (getSessionToken() !== requestedToken) return myWalls.value
        if (!Array.isArray(res.data)) throw new Error('校园墙列表格式无效')
        myWalls.value = res.data.filter(w => wallId(w.id)).map(w => ({ ...w, id: wallId(w.id) }))
        loaded.value = true
        if (!currentWall.value) setCurrentWall(myWalls.value.find(w => !w.member_status || w.member_status === 'active')?.id ?? null)
      } catch (error) {
        if (getSessionToken() === requestedToken) loadError.value = getApiErrorMessage(error, '校园墙加载失败，请重试')
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
  function reset() {
    myWalls.value = []
    setCurrentWall(null)
    loaded.value = false
    loadError.value = ''
    pendingRequest = null
  }
  onScopeDispose(subscribeSessionChange(event => { if (event.resetContext) reset() }))

  return {
    myWalls, currentWallId, loaded, loadError, currentWall, currentWallRole, hasWall,
    canHere, fetchMyWalls, setCurrentWall, switchWall, reset,
  }
})
