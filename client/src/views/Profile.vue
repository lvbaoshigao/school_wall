<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '../stores/user'
import api, { getApiErrorMessage, getPasswordError } from '../api'
import { useToast } from '../composables/useToast'
import { useTimeAgo } from '../composables/useTimeAgo'
import Icon from '../components/Icon.vue'

const userStore = useUserStore()
const router = useRouter()
const toast = useToast()
const { timeAgo } = useTimeAgo()
const user = computed(() => userStore.user)

// 注册时间。created_at 是不带时区的裸串（'YYYY-MM-DD HH:MM:SS'），
// 直接给 new Date() 在部分浏览器上解析会失败，统一换成 ISO 的 T 分隔。
const joinedAt = computed(() => {
  const raw = user.value?.created_at
  if (!raw) return null
  const d = new Date(String(raw).replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
})
const joinedText = computed(() => joinedAt.value
  ? joinedAt.value.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  : '')
// 加入天数：注册当天算第 1 天
const joinedDays = computed(() => joinedAt.value
  ? Math.max(1, Math.floor((Date.now() - joinedAt.value.getTime()) / 86400000) + 1)
  : 0)

const editMode = ref(false)
const editForm = ref({
  nickname: '', real_name: '', show_real_name: false,
  bio: '', gender: '',
  contact_qq: '', contact_wechat: '', contact_weibo: '', contact_bilibili: '', show_contact: false,
  class_number: 0, is_graduate: false, graduation_year: new Date().getFullYear()
})

const showPasswordForm = ref(false)
const passwordForm = ref({ oldPassword: '', newPassword: '', confirmPassword: '' })
const passwordError = ref('')
const passwordSuccess = ref('')

const showBlacklist = ref(false)
const blacklist = ref([])

const showDeleteAccount = ref(false)
const deleteCountdown = ref(10)
const deleteReadTerms = ref(false)
// 注销必须输入密码：服务端会验证，防止偷到会话的人直接毁号
const deletePassword = ref('')
let deleteTimer = null

const successMsg = ref('')
const errorMsg = ref('')
const avatarUploading = ref(false)
const profileSaving = ref(false)
const passwordSaving = ref(false)
const deletingAccount = ref(false)
const blacklistLoading = ref(false)
const blacklistError = ref('')
const avatarInput = ref(null)
const deleteDialog = ref(null)
const currentYear = new Date().getFullYear()

watch(showDeleteAccount, async open => {
  await nextTick()
  if (open) deleteDialog.value?.showModal()
  else { deleteDialog.value?.close(); clearInterval(deleteTimer); deletePassword.value = '' }
})
onUnmounted(() => clearInterval(deleteTimer))

function startEdit() {
  showPasswordForm.value = false
  showBlacklist.value = false
  editForm.value = {
    nickname: user.value?.nickname || '',
    real_name: user.value?.real_name || '',
    show_real_name: !!user.value?.show_real_name,
    bio: user.value?.bio || '',
    gender: user.value?.gender || '',
    contact_qq: user.value?.contact_qq || '',
    contact_wechat: user.value?.contact_wechat || '',
    contact_weibo: user.value?.contact_weibo || '',
    contact_bilibili: user.value?.contact_bilibili || '',
    show_contact: !!user.value?.show_contact,
    class_number: user.value?.class_number || 0,
    is_graduate: !!user.value?.is_graduate,
    graduation_year: user.value?.graduation_year || currentYear
  }
  editMode.value = true
}

async function saveProfile() {
  if (profileSaving.value) return
  errorMsg.value = ''; successMsg.value = ''
  const f = editForm.value
  if (f.nickname.trim().length > 30 || f.real_name.trim().length > 20 || f.bio.length > 200) { errorMsg.value = '昵称最多30字，真实姓名最多20字，自我介绍最多200字'; return }
  if (['contact_qq', 'contact_wechat', 'contact_weibo', 'contact_bilibili'].some(key => f[key].trim().length > 50)) { errorMsg.value = '每项联系方式最多50个字符'; return }
  if (!Number.isInteger(Number(f.class_number)) || Number(f.class_number) < 0 || Number(f.class_number) > 9999) { errorMsg.value = '班级号需要是0–9999的整数'; return }
  if (f.is_graduate && (!Number.isInteger(Number(f.graduation_year)) || Number(f.graduation_year) < 1900 || Number(f.graduation_year) > 2100)) { errorMsg.value = '毕业届数需要是1900–2100的整数'; return }
  profileSaving.value = true
  try {
    await userStore.updateProfile({
      nickname: editForm.value.nickname.trim(),
      real_name: editForm.value.real_name.trim(),
      show_real_name: editForm.value.show_real_name ? 1 : 0,
      bio: editForm.value.bio,
      gender: editForm.value.gender,
      contact_qq: editForm.value.contact_qq,
      contact_wechat: editForm.value.contact_wechat,
      contact_weibo: editForm.value.contact_weibo,
      contact_bilibili: editForm.value.contact_bilibili,
      show_contact: editForm.value.show_contact ? 1 : 0,
      class_number: parseInt(editForm.value.class_number) || 0,
      is_graduate: editForm.value.is_graduate ? 1 : 0,
      graduation_year: editForm.value.is_graduate ? parseInt(editForm.value.graduation_year) : 0
    })
    editMode.value = false
    successMsg.value = '资料更新成功'

  } catch (e) {
    errorMsg.value = getApiErrorMessage(e, '更新失败，请重试')
  } finally { profileSaving.value = false }
}

async function changePassword() {
  if (passwordSaving.value) return
  passwordError.value = ''
  passwordSuccess.value = ''
  if (!passwordForm.value.oldPassword || !passwordForm.value.newPassword) {
    passwordError.value = '请填写完整'
    return
  }
  if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) {
    passwordError.value = '两次密码不一致'
    return
  }
  const validation = getPasswordError(passwordForm.value.newPassword)
  if (validation) { passwordError.value = validation; return }
  if (passwordForm.value.oldPassword === passwordForm.value.newPassword) { passwordError.value = '新密码不能与当前密码相同'; return }
  passwordSaving.value = true
  try {
    await userStore.changePassword(passwordForm.value.oldPassword, passwordForm.value.newPassword)
    passwordSuccess.value = '密码修改成功'
    passwordForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' }

  } catch (e) {
    passwordError.value = getApiErrorMessage(e, '修改失败，请重试')
  } finally { passwordSaving.value = false }
}

async function loadBlacklist() {
  blacklistLoading.value = true
  blacklistError.value = ''
  try {
    const res = await api.get('/friends/blocked')
    blacklist.value = res.data
  } catch (e) {
    blacklistError.value = getApiErrorMessage(e, '黑名单加载失败，请重试')
  } finally { blacklistLoading.value = false }
}

async function unblockUser(userId) {
  try {
    await api.post('/friends/unblock', { user_id: userId })
    await loadBlacklist()
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
}

async function handleAvatarUpload(event) {
  const input = event.target
  const file = input.files?.[0]
  if (!file || avatarUploading.value) return
  errorMsg.value = ''; successMsg.value = ''
  if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    errorMsg.value = '请选择不超过5MB的JPEG、PNG、WebP或GIF图片'
    input.value = ''
    return
  }
  avatarUploading.value = true
  try {
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reader.onabort = () => reject(new Error('图片读取失败'))
      reader.readAsDataURL(file)
    })
    const image = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('图片无法解码'))
      img.src = source
    })
    if (!image.width || !image.height || image.width * image.height > 40000000) throw new Error('图片尺寸过大，请缩小后上传')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法处理图片')
    const edge = Math.min(image.width, image.height)
    context.drawImage(image, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 0, 0, 256, 256)
    await userStore.updateAvatar(canvas.toDataURL('image/jpeg', .85))
    successMsg.value = '头像已更新'
  } catch (error) {
    errorMsg.value = getApiErrorMessage(error, error.message || '头像上传失败，请重试')
  } finally { avatarUploading.value = false; input.value = '' }
}

function togglePassword() {
  editMode.value = false
  showBlacklist.value = false
  showPasswordForm.value = !showPasswordForm.value
}

function toggleBlacklist() {
  editMode.value = false
  showPasswordForm.value = false
  showBlacklist.value = !showBlacklist.value
  if (showBlacklist.value) loadBlacklist()
}

function openDeleteAccount() {
  showDeleteAccount.value = true
  deleteReadTerms.value = false
  deletePassword.value = ''
  deleteCountdown.value = 10
  clearInterval(deleteTimer)
  deleteTimer = setInterval(() => {
    deleteCountdown.value--
    if (deleteCountdown.value <= 0) {
      clearInterval(deleteTimer)
    }
  }, 1000)
}

async function deleteAccount() {
  if (deletingAccount.value) return
  if (!deleteReadTerms.value) {
    toast.error('请先阅读并同意注销须知')
    return
  }
  if (deleteCountdown.value > 0) {
    toast.error(`请等待 ${deleteCountdown.value} 秒后再确认`)
    return
  }
  if (!deletePassword.value) {
    toast.error('请输入密码以确认是本人操作')
    return
  }
  deletingAccount.value = true
  try {
    await api.delete('/auth/account', { data: { password: deletePassword.value } })
    toast.success('账号已注销')
    userStore.logout()
    await router.replace('/login')
  } catch (e) {
    toast.error(getApiErrorMessage(e, '注销失败，请重试'))
  } finally { deletingAccount.value = false }
}

const roleLabel = computed(() => {
  const map = { super_admin: '超级管理员', admin: '全局管理员', user: '普通用户' }
  return map[user.value?.role] || user.value?.role
})

const genderLabel = computed(() => {
  const map = { male: '男', female: '女', other: '其他' }
  return map[user.value?.gender] || ''
})

const showRoleApply = ref(false)
const myWalls = ref([])

async function loadMyWalls() {
  try {
    const res = await api.get('/walls')
    myWalls.value = res.data
  } catch {}
}

function toggleRoleApply() {
  editMode.value = false
  showPasswordForm.value = false
  showBlacklist.value = false
  showRoleApply.value = !showRoleApply.value
  if (showRoleApply.value) loadMyWalls()
}

const wallRoleLabel = (r) => ({ owner: '墙主', admin: '校园墙管理员', tree_hole: '树洞志愿者', member: '成员' })[r] || r
</script>

<template>
  <div class="profile-page" v-if="user">
    <div class="profile-header glass-strong">
      <div class="avatar-wrapper">
        <img v-if="user.avatar" :src="user.avatar" class="avatar-lg-img" alt="我的头像" />
        <div v-else class="avatar-lg">{{ (user.nickname || user.username)[0] }}</div>
        <button type="button" class="avatar-upload-btn" :disabled="avatarUploading" :aria-label="avatarUploading ? '头像上传中' : '更换头像'" @click="avatarInput?.click()"><Icon name="image" :size="18" /></button>
        <input ref="avatarInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="选择头像图片" @change="handleAvatarUpload" hidden />
      </div>
      <div class="profile-info">
        <h1>{{ user.nickname || user.username }}</h1>
        <p class="text-muted">@{{ user.username }}</p>
        <div class="profile-tags">
          <span class="tag role-tag" :class="user.role">{{ roleLabel }}</span>
          <span v-if="genderLabel" class="tag">{{ genderLabel }}</span>
          <span v-if="user.class_number" class="tag">{{ user.class_number }}班</span>
          <span v-if="user.is_graduate" class="tag">{{ user.graduation_year }}届</span>
        </div>
        <p v-if="joinedText" class="joined text-muted" :title="timeAgo(user.created_at)">
          <Icon name="clock" :size="13" />
          {{ joinedText }} 加入 · 第 {{ joinedDays }} 天
        </p>
      </div>
    </div>

    <div v-if="user.bio" class="bio-section glass">
      <p>{{ user.bio }}</p>
    </div>

    <div class="action-bar glass">
      <!-- 主操作区：常用动作直接平铺 -->
      <div class="action-main">
        <button class="btn btn-secondary" @click="startEdit">编辑资料</button>
        <button class="btn btn-secondary" @click="togglePassword">修改密码</button>
        <button class="btn btn-secondary" @click="toggleBlacklist">黑名单</button>
        <button class="btn btn-secondary" @click="toggleRoleApply">角色申请</button>
        <router-link to="/inbox" class="btn btn-secondary">收件箱</router-link>
        <router-link to="/bookmarks" class="btn btn-secondary">我的收藏</router-link>
      </div>
      <!-- 危险操作单独成区、拉开分隔。原先 7 个按钮等权平铺，
           「注销账号」与「我的收藏」视觉层级相同，极易误点 -->
      <div class="action-danger">
        <button class="btn btn-danger" @click="openDeleteAccount">注销账号</button>
      </div>
    </div>

    <p v-if="avatarUploading" role="status">正在处理并上传头像…</p>
    <div v-if="successMsg" class="inline-feedback success-msg" role="status">{{ successMsg }}</div>
    <div v-if="errorMsg" class="inline-feedback error-msg" role="alert">{{ errorMsg }}</div>

    <!-- 编辑资料 -->
    <form v-if="editMode" class="section glass" :aria-busy="profileSaving" @submit.prevent="saveProfile">
      <h3>编辑资料</h3>
      <div class="edit-grid">
        <div class="form-group">
          <label for="profile-nickname">昵称</label>
          <input id="profile-nickname" v-model="editForm.nickname" maxlength="30" placeholder="你的昵称" />
        </div>
        <div class="form-group">
          <label for="profile-real_name">真实姓名</label>
          <input id="profile-real_name" v-model="editForm.real_name" maxlength="20" placeholder="真实姓名" />
        </div>
        <div class="form-group">
          <label for="profile-gender">性别</label>
          <select id="profile-gender" v-model="editForm.gender">
            <option value="">未设置</option>
            <option value="male">男</option>
            <option value="female">女</option>
            <option value="other">其他</option>
          </select>
        </div>
        <div class="form-group">
          <label for="profile-class_number">班级</label>
          <input id="profile-class_number" v-model="editForm.class_number" type="number" min="0" max="9999" step="1" placeholder="班级号" />
        </div>
      </div>

      <div class="form-group">
        <label for="profile-bio">自我介绍</label>
        <textarea id="profile-bio" v-model="editForm.bio" placeholder="介绍一下自己..." rows="3" maxlength="200"></textarea>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="editForm.show_real_name" />
          对外显示真实姓名
        </label>
      </div>

      <h4 style="margin: 16px 0 12px; font-size: 15px;">联系方式</h4>
      <div class="edit-grid">
        <div class="form-group">
          <label for="profile-contact_qq">QQ</label>
          <input id="profile-contact_qq" v-model="editForm.contact_qq" maxlength="50" placeholder="QQ号" />
        </div>
        <div class="form-group">
          <label for="profile-contact_wechat">微信</label>
          <input id="profile-contact_wechat" v-model="editForm.contact_wechat" maxlength="50" placeholder="微信号" />
        </div>
        <div class="form-group">
          <label for="profile-contact_weibo">微博</label>
          <input id="profile-contact_weibo" v-model="editForm.contact_weibo" maxlength="50" placeholder="微博名" />
        </div>
        <div class="form-group">
          <label for="profile-contact_bilibili">B站</label>
          <input id="profile-contact_bilibili" v-model="editForm.contact_bilibili" maxlength="50" placeholder="B站用户名" />
        </div>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="editForm.show_contact" />
          对外显示联系方式
        </label>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="editForm.is_graduate" />
          我是毕业生
        </label>
      </div>
      <div v-if="editForm.is_graduate" class="form-group">
        <label for="profile-graduation_year">毕业届数</label>
        <input id="profile-graduation_year" v-model="editForm.graduation_year" type="number" min="1900" max="2100" :placeholder="String(currentYear)" />
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary" :disabled="profileSaving">{{ profileSaving ? '保存中…' : '保存资料' }}</button>
        <button type="button" class="btn btn-secondary" :disabled="profileSaving" @click="editMode = false">取消</button>
      </div>
    </form>

    <!-- 修改密码 -->
    <form v-if="showPasswordForm" class="section glass" :aria-busy="passwordSaving" @submit.prevent="changePassword">
      <h3>修改密码</h3>
      <div v-if="passwordError" id="password-error" class="error-msg" role="alert">{{ passwordError }}</div>
      <div v-if="passwordSuccess" class="success-msg" role="status">{{ passwordSuccess }}</div>
      <div class="form-group">
        <label for="profile-oldPassword">旧密码</label>
        <input id="profile-oldPassword" v-model="passwordForm.oldPassword" autocomplete="current-password" maxlength="1024" required :aria-invalid="!!passwordError" :aria-describedby="passwordError ? 'password-error' : undefined" type="password" placeholder="当前密码" />
      </div>
      <div class="form-group">
        <label for="profile-newPassword">新密码</label>
        <input id="profile-newPassword" v-model="passwordForm.newPassword" autocomplete="new-password" maxlength="1024" required :aria-invalid="!!passwordError" :aria-describedby="passwordError ? 'password-error' : undefined" type="password" placeholder="至少6个字符" />
      </div>
      <div class="form-group">
        <label for="profile-confirmPassword">确认新密码</label>
        <input id="profile-confirmPassword" v-model="passwordForm.confirmPassword" autocomplete="new-password" maxlength="1024" required :aria-invalid="!!passwordError" :aria-describedby="passwordError ? 'password-error' : undefined" type="password" placeholder="再次输入" />
      </div>
      <button type="submit" class="btn btn-primary" :disabled="passwordSaving">{{ passwordSaving ? '修改中…' : '确认修改密码' }}</button>
    </form>

    <!-- 黑名单 -->
    <div v-if="showBlacklist" class="section glass">
      <h3>黑名单</h3>
      <p class="text-muted mb-2" style="font-size:13px">被拉黑的用户无法给你发消息或添加好友</p>
      <p v-if="blacklistLoading" role="status">正在加载黑名单…</p>
      <div v-else-if="blacklistError" role="alert">{{ blacklistError }} <button class="btn btn-secondary" @click="loadBlacklist">重试</button></div>
      <div v-else-if="blacklist.length === 0" class="empty-state" style="padding: 20px;">
        <p>黑名单为空</p>
      </div>
      <div v-else class="blacklist-list">
        <div v-for="item in blacklist" :key="item.id" class="blacklist-item">
          <div class="blacklist-info">
            <span class="blacklist-avatar">{{ (item.blocked_nickname || '?')[0] }}</span>
            <span>{{ item.blocked_nickname }}</span>
          </div>
          <button class="btn btn-sm btn-primary" @click="unblockUser(item.blocked_id)">移除</button>
        </div>
      </div>
    </div>

    <!-- 我的角色与校园墙 -->
    <div v-if="showRoleApply" class="section glass">
      <h3>我的角色</h3>
      <p class="text-muted mb-2" style="font-size:13px">全局角色: {{ roleLabel }}</p>
      <p class="text-muted mb-2" style="font-size:12px">墙内角色（墙主/校园墙管理员/树洞志愿者）由各校园墙墙主或超级管理员分配。</p>

      <div v-if="myWalls.length > 0" class="app-history">
        <h4 style="font-size:14px; margin:16px 0 8px; color: var(--text-secondary)">我加入的校园墙</h4>
        <div v-for="w in myWalls" :key="w.id" class="app-item">
          <span>{{ w.name }}</span>
          <span class="app-status" :class="w.wall_role">{{ wallRoleLabel(w.wall_role) }}</span>
        </div>
      </div>
      <div v-else class="text-muted" style="padding:8px 0">你还没有加入任何校园墙</div>
    </div>
  </div>

  <div v-else class="empty-state" :role="userStore.restoreError ? 'alert' : 'status'">
    <p>{{ userStore.restoreError || '正在恢复账户资料…' }}</p>
    <button v-if="userStore.restoreError" class="btn btn-primary" @click="userStore.fetchUser">重新加载</button>
  </div>

  <!-- 注销账号弹窗 -->
  <dialog v-if="showDeleteAccount" ref="deleteDialog" class="account-dialog" aria-labelledby="delete-account-title" @cancel.prevent="!deletingAccount && (showDeleteAccount = false)" @close="showDeleteAccount = false">
    <div class="modal glass-strong">
      <h3 id="delete-account-title">注销账号</h3>
      <div class="delete-terms">
        <h4>注销须知：</h4>
        <ul>
          <li>账号注销后<strong>无法恢复</strong></li>
          <li>你发布的所有帖子、评论将被删除</li>
          <li>你的好友关系将被清除</li>
          <li>你的私信记录将被删除</li>
          <li>你创建的投票将被删除</li>
          <li>其他用户的好友列表会显示"该账号已注销"</li>
        </ul>
      </div>
      <label class="checkbox-label" style="margin: 16px 0;">
        <input type="checkbox" v-model="deleteReadTerms" />
        我已阅读并同意注销须知
      </label>
      <div class="form-group">
        <label for="delete-password">确认密码</label>
        <input
          type="password"
          id="delete-password"
          v-model="deletePassword" maxlength="1024"
          placeholder="输入登录密码以确认本人操作"
          autocomplete="current-password"
          style="width: 100%;"
        />
      </div>
      <div class="modal-actions">
        <button
          class="btn btn-danger"
          :disabled="!deleteReadTerms || deleteCountdown > 0 || !deletePassword || deletingAccount"
          @click="deleteAccount"
        >
          {{ deletingAccount ? '注销中…' : deleteCountdown > 0 ? `请等待 ${deleteCountdown} 秒` : '永久注销账号' }}
        </button>
        <button class="btn btn-secondary" :disabled="deletingAccount" autofocus @click="showDeleteAccount = false">取消</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.profile-page { animation: fadeIn 0.5s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.profile-header { display: flex; align-items: center; gap: 20px; padding: 24px; margin-bottom: 16px; }

.avatar-wrapper { position: relative; flex-shrink: 0; }
.avatar-lg { width: 72px; height: 72px; border-radius: 50%; background: var(--btn-fill); display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; color: #fff; }
.avatar-lg-img { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; }

.avatar-upload-btn {
  position: absolute; bottom: -2px; right: -2px; width: 28px; height: 28px; border-radius: 50%;
  background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
  font-size: 14px; cursor: pointer; border: 2px solid rgba(255,255,255,0.3); transition: all 0.2s;
}
.avatar-upload-btn:hover { background: rgba(0,0,0,0.8); transform: scale(1.1); }

.profile-info h1 { font-size: 22px; margin-bottom: 4px; }
.joined {
  display: flex; align-items: center; gap: 5px;
  margin-top: 8px; font-size: 12.5px;
}
.profile-tags { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }

.role-tag.super_admin { background: rgba(255,215,0,0.2); border-color: rgba(255,215,0,0.3); color: #ffd700; }
.role-tag.admin { background: color-mix(in srgb, var(--accent-1) 20%, transparent); border-color: color-mix(in srgb, var(--accent-1) 30%, transparent); color: #a8b8ff; }
.role-tag.tree_hole { background: rgba(46,213,115,0.2); border-color: rgba(46,213,115,0.3); color: #b8ffb8; }
.role-tag.member { background: rgba(46,213,115,0.2); border-color: rgba(46,213,115,0.3); color: #b8ffb8; }

.bio-section { padding: 14px 16px; margin-bottom: 16px; }
.bio-section p { font-size: 14px; line-height: 1.6; color: var(--text-secondary); }

.action-bar { display: flex; gap: var(--space-3); padding: var(--space-4); margin-bottom: var(--space-4); flex-wrap: wrap; align-items: center; justify-content: space-between; }
.action-main { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.action-danger { border-left: 1px solid var(--border-strong); padding-left: var(--space-3); }

.section { padding: var(--space-5); margin-bottom: var(--space-4); }
.section h3 { margin-bottom: var(--space-4); font-size: var(--font-lg); }

/* 移动端两列排布 */
.edit-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

/* 600px 以下表单改单列 —— 原先这里仍保持 1fr 1fr，320px 屏输入框只剩 ~130px */
@media (max-width: 600px) {
  .edit-grid { grid-template-columns: 1fr; }
  .action-bar { flex-direction: column; align-items: stretch; }
  .action-danger { border-left: none; border-top: 1px solid var(--border-strong); padding-left: 0; padding-top: var(--space-3); }
  .action-danger .btn { width: 100%; }
}

select { background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text-primary); padding: 12px 16px; border-radius: var(--radius-md); font-size: 14px; width: 100%; }
select option { background: var(--bg-main); color: var(--text-primary); }

textarea { resize: vertical; }

.form-actions { display: flex; gap: 12px; margin-top: 8px; }

.error-msg { background: rgba(255,107,107,0.2); border: 1px solid rgba(255,107,107,0.3); color: #ffb8b8; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; margin-bottom: 16px; }
.success-msg { background: rgba(46,213,115,0.2); border: 1px solid rgba(46,213,115,0.3); color: #b8ffb8; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 14px; margin-bottom: 16px; }

/* 黑名单 */
.blacklist-list { display: flex; flex-direction: column; gap: 8px; }
.blacklist-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: rgba(255,255,255,0.05); border-radius: var(--radius-md); }
.blacklist-info { display: flex; align-items: center; gap: 10px; }
.blacklist-avatar { width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #636e72, #2d3436); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; color: #fff; }

/* 注销弹窗 */
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); display: flex; justify-content: center; align-items: center; z-index: 2000; }
.modal { padding: 28px; border-radius: var(--radius-lg); width: 90%; max-width: 450px; }
.modal h3 { margin-bottom: 16px; font-size: 20px; color: #ff6b6b; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 20px; }

.delete-terms { background: rgba(255,107,107,0.1); border: 1px solid rgba(255,107,107,0.2); border-radius: var(--radius-md); padding: 16px; }
.delete-terms h4 { font-size: 15px; margin-bottom: 10px; color: #ffb8b8; }
.delete-terms ul { padding-left: 20px; }
.delete-terms li { font-size: 14px; line-height: 1.8; color: var(--text-secondary); }
.delete-terms strong { color: #ff6b6b; }

.role-apply-btns { display: flex; gap: 12px; flex-wrap: wrap; }
.app-history { border-top: 1px solid rgba(255,255,255,0.08); }
.app-item { display: flex; align-items: center; gap: 12px; padding: 8px 0; font-size: 14px; }
.app-status { font-size: 12px; padding: 2px 8px; border-radius: var(--radius-xs); }
.app-status.pending { background: rgba(255,200,0,0.2); color: #ffeaa7; }
.app-status.approved { background: rgba(46,213,115,0.2); color: #b8ffb8; }
.app-status.rejected { background: rgba(255,107,107,0.2); color: #ffb8b8; }
.profile-page { max-width: 52rem; margin-inline: auto; }
.profile-header { border-top: 3px solid var(--accent-1); }
.profile-info { min-width: 0; overflow-wrap: anywhere; }
.profile-info h1 { letter-spacing: -.025em; }
.avatar-lg, .avatar-lg-img { border-radius: var(--radius-lg); }
.avatar-upload-btn { width: 2.75rem; height: 2.75rem; bottom: -.6rem; right: -.6rem; color: white; }
.role-tag.super_admin, .role-tag.admin, .role-tag.tree_hole, .role-tag.member { color: var(--text-link); background: var(--accent-soft); border-color: var(--accent-line); }
.error-msg { color: var(--danger-light); background: var(--bg-input); border-color: var(--danger); }
.success-msg { color: var(--text-link); background: var(--accent-soft); border-color: var(--accent-line); }
.account-dialog { padding: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); color: var(--text-primary); background: var(--bg-main); width: min(92vw, 30rem); max-height: 90dvh; margin: auto; }
.account-dialog::backdrop { background: rgba(10, 30, 27, .65); }
.account-dialog .modal { width: 100%; max-width: none; padding: 1.5rem; }
.delete-terms h4 { color: var(--danger-light); }
.bio-section p, .contact-item { overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .profile-page { animation: none; } }
@media (max-width: 400px) { .profile-header { gap: 1rem; padding: 1.25rem; } .modal-actions { flex-wrap: wrap; } }
</style>
