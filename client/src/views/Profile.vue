<script setup>
import { ref, computed } from 'vue'
import { useUserStore } from '../stores/user'
import api from '../api'
import { useToast } from '../composables/useToast'
import { useTimeAgo } from '../composables/useTimeAgo'
import Icon from '../components/Icon.vue'

const userStore = useUserStore()
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
  class_number: 0, is_graduate: false, graduation_year: 2024
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
let deleteTimer = null

const successMsg = ref('')
const errorMsg = ref('')
const avatarUploading = ref(false)

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
    graduation_year: user.value?.graduation_year || 2024
  }
  editMode.value = true
}

async function saveProfile() {
  try {
    await userStore.updateProfile({
      nickname: editForm.value.nickname,
      real_name: editForm.value.real_name,
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
    setTimeout(() => successMsg.value = '', 3000)
  } catch (e) {
    errorMsg.value = e.response?.data?.error || '更新失败'
    setTimeout(() => errorMsg.value = '', 3000)
  }
}

async function changePassword() {
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
  if (passwordForm.value.newPassword.length < 6) {
    passwordError.value = '新密码至少6个字符'
    return
  }
  try {
    await userStore.changePassword(passwordForm.value.oldPassword, passwordForm.value.newPassword)
    passwordSuccess.value = '密码修改成功'
    passwordForm.value = { oldPassword: '', newPassword: '', confirmPassword: '' }
    setTimeout(() => { passwordSuccess.value = ''; showPasswordForm.value = false }, 2000)
  } catch (e) {
    passwordError.value = e.response?.data?.error || '修改失败'
  }
}

async function loadBlacklist() {
  try {
    const res = await api.get('/friends/blocked')
    blacklist.value = res.data
  } catch (e) {
    console.error('加载黑名单失败', e)
  }
}

async function unblockUser(userId) {
  try {
    await api.post('/friends/unblock', { user_id: userId })
    loadBlacklist()
  } catch (e) {
    toast.error(e.response?.data?.error || '操作失败')
  }
}

function handleAvatarUpload(e) {
  const file = e.target.files[0]
  if (!file) return
  if (file.size > 5 * 1024 * 1024) {
    errorMsg.value = '图片不能超过5MB'
    setTimeout(() => errorMsg.value = '', 3000)
    return
  }

  avatarUploading.value = true
  const reader = new FileReader()
  reader.onload = async (ev) => {
    const img = new Image()
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      const size = 256
      const minDim = Math.min(img.width, img.height)
      const sx = (img.width - minDim) / 2
      const sy = (img.height - minDim) / 2
      canvas.width = size
      canvas.height = size
      canvas.getContext('2d').drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size)

      let quality = 0.85
      let base64 = canvas.toDataURL('image/jpeg', quality)
      while (base64.length > 150 * 1024 && quality > 0.3) {
        quality -= 0.1
        base64 = canvas.toDataURL('image/jpeg', quality)
      }

      try {
        await userStore.updateAvatar(base64)
        successMsg.value = '头像更新成功'
        setTimeout(() => successMsg.value = '', 3000)
      } catch (err) {
        errorMsg.value = err.response?.data?.error || '上传失败'
        setTimeout(() => errorMsg.value = '', 3000)
      } finally {
        avatarUploading.value = false
      }
    }
    img.src = ev.target.result
  }
  reader.readAsDataURL(file)
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
  if (!deleteReadTerms.value) {
    toast.error('请先阅读并同意注销须知')
    return
  }
  if (deleteCountdown.value > 0) {
    toast.error(`请等待 ${deleteCountdown.value} 秒后再确认`)
    return
  }
  if (!confirm('最终确认：确定注销账号？此操作不可恢复！')) return

  try {
    await api.delete('/auth/account')
    toast.success('账号已注销')
    userStore.logout()
    window.location.href = '/login'
  } catch (e) {
    toast.error(e.response?.data?.error || '注销失败')
  }
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
        <img v-if="user.avatar" :src="user.avatar" class="avatar-lg-img" />
        <div v-else class="avatar-lg">{{ (user.nickname || user.username)[0] }}</div>
        <label class="avatar-upload-btn">
          <Icon name="image" :size="18" />
          <input type="file" accept="image/*" @change="handleAvatarUpload" hidden />
        </label>
      </div>
      <div class="profile-info">
        <h2>{{ user.nickname || user.username }}</h2>
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
      <button class="btn btn-secondary" @click="startEdit">编辑资料</button>
      <button class="btn btn-secondary" @click="togglePassword">修改密码</button>
      <button class="btn btn-secondary" @click="toggleBlacklist">黑名单</button>
      <button class="btn btn-secondary" @click="toggleRoleApply">角色申请</button>
      <router-link to="/inbox" class="btn btn-secondary">收件箱</router-link>
      <router-link to="/bookmarks" class="btn btn-secondary">我的收藏</router-link>
      <button class="btn btn-danger" @click="openDeleteAccount">注销账号</button>
    </div>

    <div v-if="successMsg" class="toast toast-success">{{ successMsg }}</div>
    <div v-if="errorMsg" class="toast toast-error">{{ errorMsg }}</div>

    <!-- 编辑资料 -->
    <div v-if="editMode" class="section glass">
      <h3>编辑资料</h3>
      <div class="edit-grid">
        <div class="form-group">
          <label>昵称</label>
          <input v-model="editForm.nickname" placeholder="你的昵称" />
        </div>
        <div class="form-group">
          <label>真实姓名</label>
          <input v-model="editForm.real_name" placeholder="真实姓名" />
        </div>
        <div class="form-group">
          <label>性别</label>
          <select v-model="editForm.gender">
            <option value="">未设置</option>
            <option value="male">男</option>
            <option value="female">女</option>
            <option value="other">其他</option>
          </select>
        </div>
        <div class="form-group">
          <label>班级</label>
          <input v-model="editForm.class_number" type="number" min="0" placeholder="班级号" />
        </div>
      </div>

      <div class="form-group">
        <label>自我介绍</label>
        <textarea v-model="editForm.bio" placeholder="介绍一下自己..." rows="3" maxlength="200"></textarea>
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
          <label>QQ</label>
          <input v-model="editForm.contact_qq" placeholder="QQ号" />
        </div>
        <div class="form-group">
          <label>微信</label>
          <input v-model="editForm.contact_wechat" placeholder="微信号" />
        </div>
        <div class="form-group">
          <label>微博</label>
          <input v-model="editForm.contact_weibo" placeholder="微博名" />
        </div>
        <div class="form-group">
          <label>B站</label>
          <input v-model="editForm.contact_bilibili" placeholder="B站用户名" />
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
        <label>毕业届数</label>
        <input v-model="editForm.graduation_year" type="number" min="1900" max="2030" placeholder="如：2024" />
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" @click="saveProfile">保存</button>
        <button class="btn btn-secondary" @click="editMode = false">取消</button>
      </div>
    </div>

    <!-- 修改密码 -->
    <div v-if="showPasswordForm" class="section glass">
      <h3>修改密码</h3>
      <div v-if="passwordError" class="error-msg">{{ passwordError }}</div>
      <div v-if="passwordSuccess" class="success-msg">{{ passwordSuccess }}</div>
      <div class="form-group">
        <label>旧密码</label>
        <input v-model="passwordForm.oldPassword" type="password" placeholder="当前密码" />
      </div>
      <div class="form-group">
        <label>新密码</label>
        <input v-model="passwordForm.newPassword" type="password" placeholder="至少6个字符" />
      </div>
      <div class="form-group">
        <label>确认新密码</label>
        <input v-model="passwordForm.confirmPassword" type="password" placeholder="再次输入" @keyup.enter="changePassword" />
      </div>
      <button class="btn btn-primary" @click="changePassword">修改密码</button>
    </div>

    <!-- 黑名单 -->
    <div v-if="showBlacklist" class="section glass">
      <h3>黑名单</h3>
      <p class="text-muted mb-2" style="font-size:13px">被拉黑的用户无法给你发消息或添加好友</p>
      <div v-if="blacklist.length === 0" class="empty-state" style="padding: 20px;">
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

  <div v-else class="loading">加载中</div>

  <!-- 注销账号弹窗 -->
  <div v-if="showDeleteAccount" class="modal-overlay" @click.self="showDeleteAccount = false">
    <div class="modal glass-strong">
      <h3>注销账号</h3>
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
      <div class="modal-actions">
        <button
          class="btn btn-danger"
          :disabled="!deleteReadTerms || deleteCountdown > 0"
          @click="deleteAccount"
        >
          {{ deleteCountdown > 0 ? `请等待 ${deleteCountdown} 秒` : '确定注销' }}
        </button>
        <button class="btn btn-secondary" @click="showDeleteAccount = false">取消</button>
      </div>
    </div>
  </div>
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

.profile-info h2 { font-size: 22px; margin-bottom: 4px; }
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

.action-bar { display: flex; gap: 12px; padding: 16px; margin-bottom: 16px; flex-wrap: wrap; }

.section { padding: 24px; margin-bottom: 16px; }
.section h3 { margin-bottom: 16px; font-size: 18px; }

/* 移动端两列排布 */
.edit-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 600px) {
  .edit-grid { grid-template-columns: 1fr 1fr; }
}

select { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 12px 16px; border-radius: var(--radius-md); font-size: 14px; width: 100%; }
select option { background: #333; color: #fff; }

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
</style>
