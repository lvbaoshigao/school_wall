import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '../api'
import { useUserStore } from './user'

export const useWallStore = defineStore('wall', () => {
  const myWalls = ref([])
  const currentWallId = ref(localStorage.getItem('currentWallId') ? parseInt(localStorage.getItem('currentWallId')) : null)
  const loaded = ref(false)

  const currentWall = computed(() => myWalls.value.find(w => w.id === currentWallId.value) || null)
  const currentWallRole = computed(() => currentWall.value?.wall_role || null)
  const hasWall = computed(() => myWalls.value.length > 0)

  // 当前墙内是否拥有某权限。名号（wall_role）只用来显示头衔，
  // 能不能做事一律问这里 —— 单独授予/收回的权限也才会被反映出来。
  function canHere(perm) {
    return useUserStore().canInWall(perm, currentWallId.value)
  }

  async function fetchMyWalls() {
    try {
      const res = await api.get('/walls')
      myWalls.value = res.data || []
      // 若当前墙已失效，回退到第一个
      if (!myWalls.value.find(w => w.id === currentWallId.value)) {
        setCurrentWall(myWalls.value[0]?.id ?? null)
      }
    } catch {
      myWalls.value = []
    } finally {
      loaded.value = true
    }
    return myWalls.value
  }

  function setCurrentWall(id) {
    currentWallId.value = id ? parseInt(id) : null
    if (currentWallId.value) {
      localStorage.setItem('currentWallId', String(currentWallId.value))
    } else {
      localStorage.removeItem('currentWallId')
    }
  }

  function switchWall(id) {
    setCurrentWall(id)
  }

  function reset() {
    myWalls.value = []
    setCurrentWall(null)
    loaded.value = false
  }

  return {
    myWalls, currentWallId, loaded, currentWall, currentWallRole, hasWall,
    canHere,
    fetchMyWalls, setCurrentWall, switchWall, reset,
  }
})
