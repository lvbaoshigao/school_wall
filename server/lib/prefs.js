// 用户偏好的唯一定义来源：键名、类型、取值范围、默认值。
// 前端 client/src/stores/settings.js 的 PREF_SCHEMA 与本文件保持一致；
// 校验放在后端，前端只负责展示，改前端改不动这里的约束。
//
// 历史上 PUT /auth/prefs 把所有值 `!!v` 转成布尔，所以只能存开关。
// 现在按 schema 逐项校验：bool 存布尔，enum 只接受白名单里的字符串，
// 未知键直接丢弃，非法值回落到默认值而不是整体 400 —— 避免前端多传一个键就全盘保存失败。

const PREF_SCHEMA = {
  // ===== 导航栏选项卡（与前端 NAV_ITEMS 一致） =====
  home:      { type: 'bool', def: true },
  publish:   { type: 'bool', def: true },
  search:    { type: 'bool', def: true },
  votes:     { type: 'bool', def: false },
  chat:      { type: 'bool', def: true },
  inbox:     { type: 'bool', def: true },
  treehole:  { type: 'bool', def: false },
  bookmarks: { type: 'bool', def: false },
  help:      { type: 'bool', def: false },
  theme:     { type: 'bool', def: true },
  wallpaper: { type: 'bool', def: true },

  // ===== 阅读与浏览 =====
  feed_sort:        { type: 'enum', values: ['latest', 'hot'], def: 'latest' },
  feed_category:    { type: 'enum', values: ['全部', '吐槽', '分享', '求助', '讨论', '其他'], def: '全部' },
  density:          { type: 'enum', values: ['comfortable', 'compact'], def: 'comfortable' },
  time_format:      { type: 'enum', values: ['relative', 'absolute'], def: 'relative' },
  font_scale:       { type: 'enum', values: ['sm', 'md', 'lg'], def: 'md' },
  auto_load_images: { type: 'bool', def: true },

  // ===== 发布默认值 =====
  default_anonymous_post:       { type: 'bool', def: false },
  default_markdown:             { type: 'bool', def: false },
  confirm_before_post:          { type: 'bool', def: false },
  default_anonymous_confession: { type: 'bool', def: true },

  // ===== 通知与提醒 =====
  badge_interaction:  { type: 'bool', def: true },
  badge_announcement: { type: 'bool', def: true },
  badge_system:       { type: 'bool', def: true },
  badge_report:       { type: 'bool', def: true },
  // 顶栏未读轮询间隔（秒）；0 表示只在打开页面时查一次
  unread_interval:    { type: 'enum', values: ['0', '15', '30', '60', '300'], def: '30' },
  // 这两项由后端在写入互动站内信前读取，关掉就真的不写，而不是前端藏起来
  notify_on_comment:  { type: 'bool', def: true },
  notify_on_like:     { type: 'bool', def: true },

  // ===== 无障碍与动效 =====
  reduce_motion:     { type: 'bool', def: false },
  high_contrast:     { type: 'bool', def: false },
  always_focus_ring: { type: 'bool', def: false },
  disable_blur:      { type: 'bool', def: false },

  // ===== 主题色 =====
  accent: { type: 'enum', values: ['indigo', 'teal', 'forest', 'amber', 'rose', 'slate'], def: 'indigo' },
};

// 把存储值 + 默认值合并成完整、类型正确的偏好对象
function mergePrefs(stored) {
  const src = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const [key, spec] of Object.entries(PREF_SCHEMA)) {
    const raw = src[key];
    if (spec.type === 'bool') {
      out[key] = typeof raw === 'boolean' ? raw : spec.def;
    } else if (spec.type === 'enum') {
      out[key] = spec.values.includes(raw) ? raw : spec.def;
    } else {
      out[key] = spec.def;
    }
  }
  return out;
}

// 只保留 schema 里存在且取值合法的键
function sanitizePrefs(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [key, spec] of Object.entries(PREF_SCHEMA)) {
    if (!(key in src)) continue;
    const raw = src[key];
    if (spec.type === 'bool') {
      out[key] = !!raw;
    } else if (spec.type === 'enum' && spec.values.includes(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

// 供后端其它路由读取某个用户的单项偏好（如互动通知开关）
function readPrefs(db, userId) {
  try {
    const row = db.prepare("SELECT pref_value FROM user_prefs WHERE user_id=? AND pref_key='navbar'").get(userId);
    if (!row?.pref_value) return mergePrefs({});
    return mergePrefs(JSON.parse(row.pref_value));
  } catch {
    return mergePrefs({});
  }
}

module.exports = { PREF_SCHEMA, mergePrefs, sanitizePrefs, readPrefs };
