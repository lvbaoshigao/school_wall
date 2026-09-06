<script setup>
import { ref, inject, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore, NAV_ITEMS, ACCENTS } from '../stores/settings'
import { useWallStore } from '../stores/wall'
import { useUserStore } from '../stores/user'
import { useToast } from '../composables/useToast'
import Icon from '../components/Icon.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import api from '../api'

const router = useRouter()
const settingsStore = useSettingsStore()
const wallStore = useWallStore()
const userStore = useUserStore()
const toast = useToast()

const { current: theme, toggle: toggleTheme } = inject('theme', { current: ref('dark'), toggle: () => {} })

// 搜索与隐私开关（全部可自选；真实姓名默认关闭）
const privacy = computed(() => ({
  allow_search_by_id: userStore.user?.allow_search_by_id !== 0,
  allow_search_by_username: userStore.user?.allow_search_by_username !== 0,
  allow_search_by_nickname: userStore.user?.allow_search_by_nickname !== 0,
  allow_search_by_real_name: userStore.user?.allow_search_by_real_name === 1,
  allow_discover: userStore.user?.allow_discover !== 0,
}))

// 四种搜索方式全关时，别人无法主动找到你 —— 明确告知，避免被误当成功能故障
const unfindable = computed(() =>
  !privacy.value.allow_search_by_id &&
  !privacy.value.allow_search_by_username &&
  !privacy.value.allow_search_by_nickname &&
  !privacy.value.allow_search_by_real_name
)

// 没填真实姓名时开了也没意义，直接禁用并提示
const hasRealName = computed(() => !!(userStore.user?.real_name || '').trim())

async function setPrivacy(key, val, label) {
  try {
    await userStore.updateProfile({ [key]: val ? 1 : 0 })
    toast[val ? 'success' : 'info'](`${label}已${val ? '开启' : '关闭'}`)
  } catch (e) {
    toast.error(e.response?.data?.error || '保存失败')
  }
}

// 导航工具项（主题/壁纸）
const TOOL_ITEMS = [
  { key: 'theme', icon: 'moon', label: '主题切换', path: '' },
  { key: 'wallpaper', icon: 'image', label: '换壁纸', path: '' },
]

// 有权限才允许在设置里改的项（树洞）
function canToggle(item) {
  if (!item.requireTreeHole) return true
  return wallStore.canHere('wall.tree_hole')
}

function toggleNav(item, val) {
  if (item.requireTreeHole && !canToggle(item)) return
  settingsStore.setNavPref(item.key, val)
  toast[val ? 'success' : 'info'](`${item.label}已${val ? '显示' : '隐藏'}`)
}

function toggleTool(item, val) {
  settingsStore.setNavPref(item.key, val)
  toast[val ? 'success' : 'info'](`${item.label}已${val ? '显示' : '隐藏'}`)
}

// 下拉型导航项（发布/求助）本身没有单一页面，「进入」跳到它的第一个子项
function entryPath(item) {
  return item.path || item.children?.[0]?.path || ''
}

function entryTitle(item) {
  if (item.path) return `进入${item.label}`
  const first = item.children?.[0]
  return first ? `进入${item.label} · ${first.label}` : ''
}

function go(item) {
  const path = entryPath(item)
  if (path) router.push(path)
}

// ===== 偏好项 =====
const prefs = computed(() => settingsStore.prefs)

// 单选型偏好的可选值
const CHOICES = {
  feed_sort: [{ v: 'latest', l: '最新' }, { v: 'hot', l: '热门' }],
  feed_category: ['全部', '吐槽', '分享', '求助', '讨论', '其他'].map(c => ({ v: c, l: c })),
  density: [{ v: 'comfortable', l: '舒适' }, { v: 'compact', l: '紧凑' }],
  time_format: [{ v: 'relative', l: '相对时间' }, { v: 'absolute', l: '具体时间' }],
  font_scale: [{ v: 'sm', l: '小' }, { v: 'md', l: '标准' }, { v: 'lg', l: '大' }],
  unread_interval: [
    { v: '0', l: '不自动' }, { v: '15', l: '15 秒' }, { v: '30', l: '30 秒' },
    { v: '60', l: '1 分钟' }, { v: '300', l: '5 分钟' },
  ],
}

async function setPref(key, val, label, tip) {
  await settingsStore.setPref(key, val)
  if (tip) toast.info(tip)
  else if (typeof val === 'boolean') toast[val ? 'success' : 'info'](`${label}已${val ? '开启' : '关闭'}`)
  else toast.success(`${label}已设为${label === '主题色' ? val : (CHOICES[key]?.find(c => c.v === val)?.l ?? val)}`)
}

// ===== 导出数据 =====
const exporting = ref(false)
const showClearCacheConfirm = ref(false)

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function exportData() {
  if (exporting.value) return
  exporting.value = true
  try {
    // 后端返回的是 gzip 后的二进制，必须按 blob 收，否则会被当文本破坏
    const res = await api.get('/auth/export', { responseType: 'blob' })
    const disp = res.headers['content-disposition'] || ''
    const name = /filename="([^"]+)"/.exec(disp)?.[1] || 'schoolwall-export.json.gz'
    const raw = Number(res.headers['x-uncompressed-size']) || 0

    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 立刻 revoke 会让部分浏览器的下载中断，延后释放
    setTimeout(() => URL.revokeObjectURL(url), 10000)

    const ratio = raw ? `，已压缩 ${formatSize(raw)} → ${formatSize(res.data.size)}` : ''
    toast.success(`导出完成${ratio}`)
  } catch (e) {
    toast.error('导出失败，请稍后再试')
  } finally {
    exporting.value = false
  }
}

function clearLocalCache() {
  showClearCacheConfirm.value = true
}

function doClearLocalCache() {
  const theme = localStorage.getItem('theme')
  localStorage.clear()
  sessionStorage.clear()
  if (theme) localStorage.setItem('theme', theme)
  location.href = '/login'
}

// 近一小时访问量。服务端是内存统计，重启会清零。
// 每分钟刷一次就够，这个数字本来就是个粗略的体感值，没必要更勤。
const visitStats = ref(null)
let visitTimer = null

async function loadVisitStats() {
  try {
    visitStats.value = (await api.get('/stats/visits')).data
  } catch {
    // 取不到就不显示，不要为一个装饰性数字弹错误提示
    visitStats.value = null
  }
}

onMounted(() => {
  if (!settingsStore.loaded) settingsStore.loadSettings()
  loadVisitStats()
  visitTimer = setInterval(loadVisitStats, 60000)
})

onUnmounted(() => {
  if (visitTimer) clearInterval(visitTimer)
})
</script>

<template>
  <div class="settings-page">
    <div class="settings-header glass-strong">
      <div class="settings-title-row">
        <h2>设置</h2>
        <span v-if="visitStats" class="visit-badge" :title="`近 ${visitStats.windowMinutes} 分钟内有 ${visitStats.visitors} 位访客，共 ${visitStats.requests} 次请求`">
          <Icon name="chart" :size="14" />
          近1小时 {{ visitStats.visitors }} 人访问
        </span>
      </div>
      <p class="text-muted">个性化你的校园墙体验</p>
    </div>

    <!-- 导航栏显示项 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>导航栏显示项</h3>
        <span class="text-muted">关闭的选项卡会从顶部导航隐藏，可随时回来重新开启</span>
      </div>

      <div class="pref-list">
        <div v-for="item in NAV_ITEMS" :key="item.key" class="pref-row">
          <input
            type="checkbox"
            class="pref-check"
            :checked="!!settingsStore.nav[item.key]"
            :disabled="!canToggle(item)"
            @change="toggleNav(item, $event.target.checked)"
          />
          <span class="pref-icon"><Icon :name="item.icon" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">
              {{ item.label }}
              <Icon v-if="item.requireTreeHole && !canToggle(item)" class="pref-lock" name="lock" :size="12" label="无权限修改" />
            </span>
            <span class="pref-desc">{{ item.desc }}</span>
          </span>
          <button v-if="entryPath(item)" class="pref-enter" :title="entryTitle(item)" :aria-label="entryTitle(item)" @click="go(item)">
            <Icon name="arrow-right" :size="15" />
          </button>
        </div>

        <div class="pref-divider"></div>

        <!-- 导航工具项：主题/壁纸 -->
        <div v-for="item in TOOL_ITEMS" :key="item.key" class="pref-row">
          <input
            type="checkbox"
            class="pref-check"
            :checked="!!settingsStore.tools[item.key]"
            @change="toggleTool(item, $event.target.checked)"
          />
          <span class="pref-icon">
            <Icon :name="item.key === 'theme' ? (theme === 'dark' ? 'moon' : 'sun') : item.icon" :size="16" />
          </span>
          <span class="pref-info">
            <span class="pref-name">{{ item.label }}</span>
            <span class="pref-desc">{{ item.key === 'theme' ? '顶部亮/暗切换按钮' : '顶部随机壁纸按钮' }}</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 搜索与隐私 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>搜索与隐私</h3>
        <span class="text-muted">控制别人能否通过哪些方式找到你</span>
      </div>

      <div class="pref-list">
        <div class="pref-row">
          <input
            type="checkbox"
            class="pref-check"
            :checked="privacy.allow_search_by_id"
            @change="setPrivacy('allow_search_by_id', $event.target.checked, 'ID 搜索')"
          />
          <span class="pref-icon"><Icon name="tag" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">允许通过 ID 搜索到我</span>
            <span class="pref-desc">你的 ID 是 {{ userStore.user?.id }}，它始终是账号的唯一标识，关闭后别人只是无法用它搜到你</span>
          </span>
        </div>

        <div class="pref-row">
          <input
            type="checkbox"
            class="pref-check"
            :checked="privacy.allow_search_by_username"
            @change="setPrivacy('allow_search_by_username', $event.target.checked, '账号搜索')"
          />
          <span class="pref-icon">@</span>
          <span class="pref-info">
            <span class="pref-name">允许通过账号搜索到我</span>
            <span class="pref-desc">账号名 @{{ userStore.user?.username }} 不可修改</span>
          </span>
        </div>

        <div class="pref-row">
          <input
            type="checkbox"
            class="pref-check"
            :checked="privacy.allow_search_by_nickname"
            @change="setPrivacy('allow_search_by_nickname', $event.target.checked, '昵称搜索')"
          />
          <span class="pref-icon"><Icon name="edit" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">允许通过昵称搜索到我</span>
            <span class="pref-desc">别人可用你的昵称找到你</span>
          </span>
        </div>

        <div class="pref-row">
          <input
            type="checkbox"
            class="pref-check"
            :checked="privacy.allow_search_by_real_name"
            :disabled="!hasRealName"
            @change="setPrivacy('allow_search_by_real_name', $event.target.checked, '真实姓名搜索')"
          />
          <span class="pref-icon"><Icon name="user" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">
              允许通过真实姓名搜索到我
              <Icon v-if="!hasRealName" class="pref-lock" name="lock" :size="12" label="需先填写真实姓名" />
            </span>
            <span class="pref-desc">
              {{ hasRealName
                ? '默认关闭；开启后同学可用你的真实姓名找到你（搜索结果只显示昵称，不会展示姓名）'
                : '请先在个人资料里填写真实姓名' }}
            </span>
          </span>
          <button class="pref-enter" title="去个人资料填写真实姓名" aria-label="去个人资料填写真实姓名" @click="router.push('/profile')">
            <Icon name="arrow-right" :size="15" />
          </button>
        </div>

        <div class="pref-divider"></div>

        <div class="pref-row">
          <input
            type="checkbox"
            class="pref-check"
            :checked="privacy.allow_discover"
            @change="setPrivacy('allow_discover', $event.target.checked, '发现好友')"
          />
          <span class="pref-icon"><Icon name="compass" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">允许将我公布到「发现好友」</span>
            <span class="pref-desc">关闭后不会出现在聊天页的发现列表中</span>
          </span>
        </div>

        <p v-if="unfindable" class="privacy-warn" role="status">
          四种搜索方式都已关闭，现在没有人能主动搜到你 —— 只能由你去添加别人。
        </p>
      </div>
    </div>

    <!-- 阅读与浏览 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>阅读与浏览</h3>
        <span class="text-muted">影响帖子列表与正文的默认呈现方式</span>
      </div>
      <div class="pref-list">
        <div class="pref-row">
          <span class="pref-icon"><Icon name="chart" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">主页默认排序</span>
            <span class="pref-desc">每次进入主页时默认按哪种顺序排列</span>
          </span>
          <div class="seg" role="radiogroup" aria-label="主页默认排序">
            <button v-for="c in CHOICES.feed_sort" :key="c.v" class="seg-btn" role="radio"
                    :aria-checked="prefs.feed_sort === c.v" :class="{ active: prefs.feed_sort === c.v }"
                    @click="setPref('feed_sort', c.v, '默认排序')">{{ c.l }}</button>
          </div>
        </div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="tag" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">默认话题分类</span>
            <span class="pref-desc">进入主页时默认停在哪个分类</span>
          </span>
          <select class="pref-select" :value="prefs.feed_category" aria-label="默认话题分类"
                  @change="setPref('feed_category', $event.target.value, '默认分类')">
            <option v-for="c in CHOICES.feed_category" :key="c.v" :value="c.v">{{ c.l }}</option>
          </select>
        </div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="list" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">列表密度</span>
            <span class="pref-desc">紧凑模式压缩卡片留白，一屏能看到更多帖子</span>
          </span>
          <div class="seg" role="radiogroup" aria-label="列表密度">
            <button v-for="c in CHOICES.density" :key="c.v" class="seg-btn" role="radio"
                    :aria-checked="prefs.density === c.v" :class="{ active: prefs.density === c.v }"
                    @click="setPref('density', c.v, '列表密度')">{{ c.l }}</button>
          </div>
        </div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="clock" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">时间显示</span>
            <span class="pref-desc">「3 小时前」还是「08-04 09:12」</span>
          </span>
          <div class="seg" role="radiogroup" aria-label="时间显示">
            <button v-for="c in CHOICES.time_format" :key="c.v" class="seg-btn" role="radio"
                    :aria-checked="prefs.time_format === c.v" :class="{ active: prefs.time_format === c.v }"
                    @click="setPref('time_format', c.v, '时间显示')">{{ c.l }}</button>
          </div>
        </div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="heading" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">正文字号</span>
            <span class="pref-desc">整体缩放全站文字，立即生效</span>
          </span>
          <div class="seg" role="radiogroup" aria-label="正文字号">
            <button v-for="c in CHOICES.font_scale" :key="c.v" class="seg-btn" role="radio"
                    :aria-checked="prefs.font_scale === c.v" :class="{ active: prefs.font_scale === c.v }"
                    @click="setPref('font_scale', c.v, '正文字号')">{{ c.l }}</button>
          </div>
        </div>

        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.auto_load_images"
                 @change="setPref('auto_load_images', $event.target.checked, '图片自动加载')" />
          <span class="pref-icon"><Icon name="image" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">自动加载帖子图片</span>
            <span class="pref-desc">关闭后图片显示为占位块，点击才加载，省流量</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 发布默认值 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>发布默认值</h3>
        <span class="text-muted">每次打开发布页时这些开关的初始状态</span>
      </div>
      <div class="pref-list">
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.default_anonymous_post"
                 @change="setPref('default_anonymous_post', $event.target.checked, '默认匿名发帖')" />
          <span class="pref-icon"><Icon name="user" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">默认匿名发帖</span>
            <span class="pref-desc">开启后发帖页的「匿名发布」默认勾选，仍可单次取消</span>
          </span>
        </div>

        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.default_markdown"
                 @change="setPref('default_markdown', $event.target.checked, '默认 Markdown')" />
          <span class="pref-icon"><Icon name="code" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">默认使用 Markdown</span>
            <span class="pref-desc">发帖时直接进入带工具栏的 Markdown 编辑器</span>
          </span>
        </div>

        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.confirm_before_post"
                 @change="setPref('confirm_before_post', $event.target.checked, '发布前二次确认')" />
          <span class="pref-icon"><Icon name="check-circle" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">发布前二次确认</span>
            <span class="pref-desc">点发布后先弹窗确认，避免手滑发出去</span>
          </span>
        </div>

        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.default_anonymous_confession"
                 @change="setPref('default_anonymous_confession', $event.target.checked, '表白信默认匿名')" />
          <span class="pref-icon"><Icon name="mail" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">表白信默认匿名</span>
            <span class="pref-desc">默认开启；关掉后对方能看到是你发的</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 通知与提醒 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>通知与提醒</h3>
        <span class="text-muted">控制顶栏红点计入哪些消息，以及别人的互动是否提醒你</span>
      </div>
      <div class="pref-list">
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.badge_interaction"
                 @change="setPref('badge_interaction', $event.target.checked, '互动计入红点')" />
          <span class="pref-icon"><Icon name="heart" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">互动消息计入未读红点</span>
            <span class="pref-desc">被评论、被点赞的通知</span>
          </span>
        </div>
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.badge_announcement"
                 @change="setPref('badge_announcement', $event.target.checked, '公告计入红点')" />
          <span class="pref-icon"><Icon name="megaphone" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">公告计入未读红点</span>
            <span class="pref-desc">校园墙管理员发布的公告</span>
          </span>
        </div>
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.badge_system"
                 @change="setPref('badge_system', $event.target.checked, '系统通知计入红点')" />
          <span class="pref-icon"><Icon name="bell" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">系统通知计入未读红点</span>
            <span class="pref-desc">好友请求、审批结果、角色变更等</span>
          </span>
        </div>
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.badge_report"
                 @change="setPref('badge_report', $event.target.checked, '举报通知计入红点')" />
          <span class="pref-icon"><Icon name="flag" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">举报通知计入未读红点</span>
            <span class="pref-desc">举报进度与处理结果</span>
          </span>
        </div>

        <p class="pref-note text-muted">私信与树洞始终计入红点 —— 它们是点对点对话，漏看代价太大。</p>

        <div class="pref-divider"></div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="refresh" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">未读检查频率</span>
            <span class="pref-desc">顶栏多久向服务器查一次新消息</span>
          </span>
          <select class="pref-select" :value="prefs.unread_interval" aria-label="未读检查频率"
                  @change="setPref('unread_interval', $event.target.value, '未读检查频率')">
            <option v-for="c in CHOICES.unread_interval" :key="c.v" :value="c.v">{{ c.l }}</option>
          </select>
        </div>

        <div class="pref-divider"></div>

        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.notify_on_comment"
                 @change="setPref('notify_on_comment', $event.target.checked, '被评论提醒')" />
          <span class="pref-icon"><Icon name="message" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">有人评论我的帖子时提醒我</span>
            <span class="pref-desc">关闭后服务器不再为此写入站内信（不是前端藏起来）</span>
          </span>
        </div>
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.notify_on_like"
                 @change="setPref('notify_on_like', $event.target.checked, '被点赞提醒')" />
          <span class="pref-icon"><Icon name="heart" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">有人点赞我的帖子时提醒我</span>
            <span class="pref-desc">帖子热度高时这类通知会很多，可以关掉</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 无障碍与动效 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>无障碍与动效</h3>
        <span class="text-muted">全部即时生效，无需刷新</span>
      </div>
      <div class="pref-list">
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.reduce_motion"
                 @change="setPref('reduce_motion', $event.target.checked, '减少动效')" />
          <span class="pref-icon"><Icon name="minus" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">减少动效</span>
            <span class="pref-desc">关闭入场动画与过渡；系统已开启「减少动态效果」时本来就会生效，这里可单独强制</span>
          </span>
        </div>
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.high_contrast"
                 @change="setPref('high_contrast', $event.target.checked, '高对比度')" />
          <span class="pref-icon"><Icon name="eye" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">高对比度</span>
            <span class="pref-desc">加深卡片底色与边框，提高文字对比度</span>
          </span>
        </div>
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.always_focus_ring"
                 @change="setPref('always_focus_ring', $event.target.checked, '始终显示焦点框')" />
          <span class="pref-icon"><Icon name="tag" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">始终显示焦点框</span>
            <span class="pref-desc">默认只在键盘操作时显示；开启后鼠标点击也保留，便于确认当前位置</span>
          </span>
        </div>
        <div class="pref-row">
          <input type="checkbox" class="pref-check" :checked="prefs.disable_blur"
                 @change="setPref('disable_blur', $event.target.checked, '毛玻璃模糊')" />
          <span class="pref-icon"><Icon name="image" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">关闭毛玻璃模糊</span>
            <span class="pref-desc">模糊很吃显卡，低配设备上滚动发卡时建议关闭</span>
          </span>
        </div>
      </div>
    </div>

    <!-- 外观 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>外观</h3>
        <span class="text-muted">主题模式与全站主题色</span>
      </div>

      <div class="theme-row">
        <span class="row-label">
          <Icon :name="theme === 'dark' ? 'moon' : 'sun'" :size="18" />
          主题模式
        </span>
        <button class="btn btn-secondary btn-sm" @click="toggleTheme">
          {{ theme === 'dark' ? '切换到亮色' : '切换到暗色' }}
        </button>
      </div>

      <div class="accent-block">
        <div class="accent-label">
          <span class="pref-name">主题色</span>
          <span class="pref-desc">按钮、选中态、焦点框与背景叠加层都会跟着变</span>
        </div>
        <div class="accent-swatches" role="radiogroup" aria-label="主题色">
          <button
            v-for="a in ACCENTS" :key="a.key"
            class="swatch" role="radio"
            :class="{ active: prefs.accent === a.key }"
            :aria-checked="prefs.accent === a.key"
            :aria-label="a.label"
            :title="a.label"
            :style="{ background: `linear-gradient(180deg, ${a.c1} 0%, ${a.c2} 100%)` }"
            @click="setPref('accent', a.key, '主题色', `主题色已设为${a.label}`)"
          >
            <Icon v-if="prefs.accent === a.key" name="check" :size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- 账号与数据 -->
    <div class="settings-card glass">
      <div class="card-head">
        <h3>账号与数据</h3>
        <span class="text-muted">你的数据始终属于你，可随时带走</span>
      </div>
      <div class="pref-list">
        <div class="pref-row">
          <span class="pref-icon"><Icon name="lock" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">修改密码</span>
            <span class="pref-desc">在个人主页中修改</span>
          </span>
          <button class="pref-enter" title="去个人主页修改密码" aria-label="去个人主页修改密码"
                  @click="router.push('/profile')"><Icon name="arrow-right" :size="15" /></button>
        </div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="file" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">导出我的数据</span>
            <span class="pref-desc">资料、帖子、评论、消息、投票、好友、收藏，打包为 gzip 压缩的 .json.gz</span>
          </span>
          <button class="btn btn-secondary btn-sm" :disabled="exporting" @click="exportData">
            {{ exporting ? '打包中…' : '导出' }}
          </button>
        </div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="trash" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">清空本地缓存</span>
            <span class="pref-desc">清掉本机保存的登录态与临时数据；账号偏好存在服务器上，不受影响</span>
          </span>
          <button class="btn btn-secondary btn-sm" @click="clearLocalCache">清空</button>
        </div>

        <div class="pref-divider"></div>

        <div class="pref-row">
          <span class="pref-icon"><Icon name="alert-triangle" :size="16" /></span>
          <span class="pref-info">
            <span class="pref-name">Bug 反馈</span>
            <span class="pref-desc">遇到了问题？告诉我们，我们会尽快处理</span>
          </span>
          <button class="pref-enter" title="提交 Bug 反馈" aria-label="提交 Bug 反馈"
                  @click="router.push('/bug-report')"><Icon name="arrow-right" :size="15" /></button>
        </div>
      </div>
    </div>

    <div class="settings-foot">
      <p class="text-muted">偏好储存在账号中，换设备登录也会同步。</p>
    </div>

    <!-- 清空缓存确认 -->
    <ConfirmModal
      :show="showClearCacheConfirm"
      title="清空本地缓存"
      message="清空本地缓存会退出登录，需要重新输入账号密码。确定继续吗？"
      confirm-text="确定清空"
      cancel-text="取消"
      :danger="true"
      @confirm="doClearLocalCache"
      @update:show="showClearCacheConfirm = $event"
    />
  </div>
</template>

<style scoped>
.settings-title-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
}
.visit-badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 11px; border-radius: var(--radius-pill);
  font-size: 12.5px; font-weight: 500; white-space: nowrap;
  color: var(--text-secondary);
  background: var(--bg-input);
  border: 1px solid var(--border);
}
@media (max-width: 480px) {
  .visit-badge { font-size: 12px; padding: 3px 9px; }
}
.settings-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.settings-header { padding: 24px; margin-bottom: 16px; border-radius: var(--radius-lg); }
.settings-header h2 { font-size: 24px; margin-bottom: 4px; }

.settings-card { padding: 20px 24px; margin-bottom: 16px; border-radius: var(--radius-lg); }
.settings-card h3 { font-size: 17px; margin-bottom: 12px; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px; }

/* 紧凑单行列表 — 两列，节省空间 */
.pref-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
  margin-top: 12px;
}

@media (max-width: 640px) {
  .pref-list { grid-template-columns: 1fr; }
}

.pref-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  transition: background 0.15s ease;
  min-width: 0;
}
.pref-row:hover { background: var(--bg-card-hover); }

.pref-check { flex-shrink: 0; }

.pref-icon {
  font-size: 16px;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
}

.pref-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pref-name { font-size: 14px; font-weight: 600; }
.pref-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
}
.pref-lock { color: var(--text-muted); vertical-align: baseline; }

.pref-enter {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}
.pref-enter:hover {
  background: var(--btn-fill);
  color: #fff;
  box-shadow: var(--btn-shadow);
}

.pref-divider { height: 1px; background: var(--border); margin: var(--space-2) var(--space-1); }

.pref-note {
  font-size: 12px;
  line-height: 1.5;
  padding: var(--space-1) var(--space-2);
}

/* 分段选择器：两三个互斥选项时比下拉更直观 */
.seg {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  padding: 2px;
  background: var(--bg-input);
  border-radius: var(--radius-pill);
}
.seg-btn {
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.2s var(--ease), color 0.2s var(--ease);
}
.seg-btn:hover { color: var(--text-primary); }
.seg-btn.active {
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  padding: 3px 11px;
  color: var(--text-primary);
  font-weight: 600;
}

.pref-select {
  flex-shrink: 0;
  width: auto;
  min-width: 96px;
  padding: 5px 10px;
  font-size: 13px;
  border-radius: var(--radius-sm);
}

/* 主题色色板 */
.accent-block {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: 14px 16px;
  margin-top: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-card);
  border: 1px solid var(--border);
}
.accent-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.accent-swatches { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.swatch {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  padding: 0;
  transition: transform 0.2s var(--ease), border-color 0.2s var(--ease);
}
.swatch:hover { transform: scale(1.1); }
.swatch.active { border-color: var(--text-primary); }
.swatch:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

.privacy-warn {
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: rgba(255, 165, 2, 0.12);
  border: 1px solid rgba(255, 165, 2, 0.28);
  color: var(--warning-light);
  font-size: 13px;
  line-height: 1.5;
}

.theme-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px; border-radius: var(--radius-md);
  background: var(--bg-card); border: 1px solid var(--border);
}
.row-label { display: flex; align-items: center; gap: 8px; }

.settings-foot { text-align: center; color: var(--text-muted); font-size: 13px; padding: 8px; }

@media (max-width: 480px) {
  .pref-desc { display: none; }
}
</style>
