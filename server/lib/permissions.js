// 权限体系。
//
// 角色（users.role / wall_members.wall_role）在这里降级为「名号」：它本身不再是
// 鉴权依据，只用来带出一组默认权限。实际判定一律走 can()。
//
// 设计要点：
//   1. 数据库里只存「覆盖项」(user_permissions)，角色的默认集留在本文件。
//      这样调整某个名号的默认权限对所有持有者立即生效，表也不随用户数膨胀。
//   2. 覆盖分 grant / deny 两种，越具体的作用域优先（墙级 > 全局 > 角色默认）。
//   3. 默认集刻意与重构前的行为逐条对齐，见下方每组的注释。
//      重构后所有人能做的事应当和以前完全一致，只是判定路径变了。

// ===== 权限目录 =====
// scope: 'global' 只能在全局授予；'wall' 可全局授予（对所有墙生效）也可限定某墙。
const PERMISSIONS = {
  // ---- 全局 ----
  'global.moderate':          { label: '全局审核',        scope: 'global', group: '全局' },
  'global.user.manage':       { label: '全局用户管理',    scope: 'global', group: '全局' },
  'global.user.role':         { label: '设置全局角色',    scope: 'global', group: '全局' },
  'global.user.ban':          { label: '全局封禁',        scope: 'global', group: '全局' },
  'global.user.delete':       { label: '删除账号',        scope: 'global', group: '全局' },
  'global.report.handle':     { label: '用户举报处理',    scope: 'global', group: '全局' },
  'global.safety.handle':     { label: '安全举报处理',    scope: 'global', group: '全局' },
  'global.wall.approve':      { label: '建墙申请审批',    scope: 'global', group: '全局' },
  'global.wall.manage':       { label: '校园墙管理',      scope: 'global', group: '全局' },
  'global.bug.handle':        { label: 'Bug 反馈处理',    scope: 'global', group: '全局' },
  'global.announcement':      { label: '发布全局公告',    scope: 'global', group: '全局' },
  'global.permission.manage': { label: '分配他人权限',    scope: 'global', group: '全局' },
  'global.dashboard':         { label: '运行看板',        scope: 'global', group: '全局' },

  // ---- 墙级 ----
  'wall.edit':           { label: '编辑墙资料',      scope: 'wall', group: '校园墙' },
  'wall.stats.view':     { label: '查看本墙概况',    scope: 'wall', group: '校园墙' },
  'wall.member.view':    { label: '查看成员名单',    scope: 'wall', group: '成员' },
  'wall.member.approve': { label: '审批进墙申请',    scope: 'wall', group: '成员' },
  'wall.member.remove':  { label: '移除成员',        scope: 'wall', group: '成员' },
  'wall.member.ban':     { label: '墙内封禁',        scope: 'wall', group: '成员' },
  'wall.member.role':    { label: '分配墙内角色',    scope: 'wall', group: '成员' },
  'wall.transfer':       { label: '转让墙主',        scope: 'wall', group: '成员' },
  'wall.ban_log.view':   { label: '查看封禁日志',    scope: 'wall', group: '成员' },
  'wall.post.delete':    { label: '删除帖子/评论',   scope: 'wall', group: '内容' },
  'wall.post.report':    { label: '处理帖子举报',    scope: 'wall', group: '内容' },
  'wall.safety.report':  { label: '处理安全举报',    scope: 'wall', group: '内容' },
  'wall.announcement':   { label: '本墙公告管理',    scope: 'wall', group: '内容' },
  'wall.category':       { label: '分类管理',        scope: 'wall', group: '内容' },
  'wall.tree_hole':      { label: '树洞响应',        scope: 'wall', group: '内容' },
};

const ALL_PERMS = Object.keys(PERMISSIONS);
const WALL_PERMS = ALL_PERMS.filter(p => PERMISSIONS[p].scope === 'wall');

// 超级管理员的默认集：全部权限，**但不含 wall.tree_hole**。
// 树洞是「被指派的志愿者」身份而不是管理权限 —— 重构前判据是 wall_members.wall_role，
// 超管不在墙里就不是志愿者。匿名倾诉的可见范围不该因为这次重构被放大。
// 超管若确实要做志愿者，加入该墙拿 tree_hole 名号，或单独授予即可。
const SUPER_ADMIN_PERMS = ALL_PERMS.filter(p => p !== 'wall.tree_hole');

// 不可被 deny 的权限。只保留「把权限改回来」所必需的两条：
// 否则给唯一的超级管理员 deny 掉分配权限的能力，系统就再也没人能恢复了。
// 其余权限（含超管的）都允许被剥夺 —— 那是可逆的管理动作。
const UNDENIABLE = ['global.permission.manage', 'global.user.role'];

// 重构前 wallModRequired（= canModerateWall）覆盖的墙级操作。
// 全局管理员当时靠 isGlobalAdmin 直接命中这一组，所以它同时是全局 admin 的默认墙级权限。
const WALL_MOD_PERMS = [
  'wall.stats.view', 'wall.member.view', 'wall.member.approve', 'wall.member.ban',
  'wall.ban_log.view', 'wall.post.delete', 'wall.post.report',
  'wall.announcement', 'wall.category',
];

// ===== 名号 → 默认权限 =====

const GLOBAL_ROLE_PERMS = {
  super_admin: SUPER_ADMIN_PERMS,

  // 全局管理员。严格对齐重构前 isGlobalAdmin 能做到的事：
  //   - adminRequired 守卫的全部全局后台功能
  //   - canModerateWall 放行的墙级操作（WALL_MOD_PERMS）
  // 刻意**不含**：
  //   - wall.member.remove / wall.member.role / wall.transfer
  //     （原 wallOwnerRequired 只放行 super_admin 与本墙 owner，全局管理员进不去）
  //   - wall.safety.report（reports.js 里判的是 super_admin 或本墙 owner/admin，同样不含全局管理员）
  //   - wall.tree_hole（树洞按 wall_members.wall_role 判定，全局管理员不是成员就没有）
  //   - wall.edit（新增能力，按需求只给墙主与超管）
  //   - global.wall.approve / global.wall.manage / global.user.role / global.user.delete
  //     / global.permission.manage（原 superAdminRequired）
  admin: [
    'global.moderate', 'global.user.manage', 'global.user.ban',
    'global.report.handle', 'global.bug.handle', 'global.dashboard',
    ...WALL_MOD_PERMS,
  ],

  user: [],
};

const WALL_ROLE_PERMS = {
  // 墙主：本墙全部墙级权限
  owner: WALL_PERMS,

  // 墙管理员：原 wallModRequired 的那一组，外加安全举报
  //（reports.js 判的是本墙 owner/admin，所以墙管理员有）。
  // 不含 transfer / member.remove / member.role / wall.edit —— 那些原本是 wallOwnerRequired。
  admin: [...WALL_MOD_PERMS, 'wall.safety.report', 'wall.tree_hole'],

  tree_hole: ['wall.tree_hole'],
  member: [],
};

// ===== 解析 =====

// 纯函数：给定名号与覆盖项，算出某个作用域下的有效权限集合。
//
// overrides 形如 [{ wall_id, perm, effect }]，effect 为 'grant' | 'deny'。
// wallId 传 0 表示只问全局权限。
//
// 优先级（越具体越先）：
//   1. 墙级覆盖（wall_id === wallId，仅当 wallId > 0）
//   2. 全局覆盖（wall_id === 0）
//   3. 墙内名号默认集（仅当 wallId > 0）
//   4. 全局名号默认集
function effectivePerms({ globalRole, wallRole, overrides = [], wallId = 0 }) {
  const base = new Set(GLOBAL_ROLE_PERMS[globalRole] || []);
  if (wallId > 0) {
    (WALL_ROLE_PERMS[wallRole] || []).forEach(p => base.add(p));
  }

  const apply = (scopeId) => {
    for (const o of overrides) {
      if (o.wall_id !== scopeId) continue;
      // 全局作用域下不处理墙级权限的授予结果之外的事：wall.* 在 wall_id=0 授予时
      // 表示「对所有墙生效」，这里照常并入即可。
      if (o.effect === 'grant') base.add(o.perm);
      else if (o.effect === 'deny') base.delete(o.perm);
    }
  };

  // 先全局后墙级：墙级覆盖后写，于是更具体的一层胜出
  apply(0);
  if (wallId > 0) apply(wallId);

  // 恢复通道不可被剥夺，最后无条件补回。这条是硬性不变量，不要改成「约定」。
  if (globalRole === 'super_admin') UNDENIABLE.forEach(p => base.add(p));

  return base;
}

// 读取某人的全部覆盖项（一次请求查一次，挂到 req 上复用）
function loadOverrides(db, userId) {
  try {
    return db.prepare(
      'SELECT wall_id, perm, effect FROM user_permissions WHERE user_id = ?'
    ).all(userId);
  } catch {
    // 迁移尚未跑完时不要让整站 500
    return [];
  }
}

const isWallPerm = (perm) => PERMISSIONS[perm]?.scope === 'wall';
const isKnownPerm = (perm) => Object.prototype.hasOwnProperty.call(PERMISSIONS, perm);

// 判断**任意**用户是否拥有某权限（不是当前请求者）。
// 用于「谁是这个墙的树洞志愿者」这类要按权限筛人的场景 —— 光查 wall_role 会漏掉
// 通过覆盖项单独授予的人，也不会剔除被 deny 掉的人。
//
// 每次调用要查 2~3 条，只适合在小集合上循环（一个墙的成员量级）。
// 如果将来要在大列表上按权限过滤，应改成批量取 overrides 后在内存里算。
function userCan(db, userId, perm, wallId = 0) {
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(userId);
  if (!u) return false;
  let wallRole = null;
  if (wallId > 0) {
    const m = db.prepare(
      "SELECT wall_role FROM wall_members WHERE wall_id=? AND user_id=? AND status='active'"
    ).get(wallId, userId);
    wallRole = m ? m.wall_role : null;
  }
  return effectivePerms({
    globalRole: u.role, wallRole, overrides: loadOverrides(db, userId), wallId,
  }).has(perm);
}

module.exports = {
  PERMISSIONS, ALL_PERMS, WALL_PERMS,
  GLOBAL_ROLE_PERMS, WALL_ROLE_PERMS,
  effectivePerms, loadOverrides, isWallPerm, isKnownPerm, userCan,
};
