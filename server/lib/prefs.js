// 用户偏好的唯一定义来源：键名、类型、取值范围、默认值。
// 前端 client/src/stores/settings.js 的 PREF_SCHEMA 与本文件保持一致；
// 校验放在后端，前端只负责展示，改前端改不动这里的约束。
//
// 历史上 PUT /auth/prefs 把所有值 `!!v` 转成布尔，所以只能存开关。
// 现在按 schema 逐项校验：bool 存布尔，enum 只接受白名单里的字符串，
// 旧保存接口忽略未知键和非法值，保留已存合法值；读取时才为缺失/损坏值补默认。

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

  // ===== 外观与聊天 =====
  accent: { type: 'enum', values: ['indigo', 'teal', 'forest', 'amber', 'rose', 'slate'], def: 'teal' },
  theme_mode:        { type: 'enum', values: ['system', 'light', 'dark'], def: 'system' },
  wallpaper_enabled: { type: 'bool', def: true },
  wallpaper_source:  { type: 'enum', values: ['bing', 'local'], def: 'bing' },
  chat_send_shortcut:   { type: 'enum', values: ['enter', 'modifier'], def: 'enter' },
  chat_density:         { type: 'enum', values: ['comfortable', 'compact'], def: 'comfortable' },
  chat_show_timestamps: { type: 'bool', def: true },
  chat_poll_interval:   { type: 'enum', values: ['10', '20', '30', '60'], def: '20' },
};

// 导航的 theme/wallpaper 只控制工具入口；实际显示分别由外观分类的新字段控制。
const PREF_SCOPES = Object.freeze({
  all: Object.freeze(Object.keys(PREF_SCHEMA)),
  appearance: Object.freeze(['accent', 'theme_mode', 'wallpaper_enabled', 'wallpaper_source', 'reduce_motion',
    'high_contrast', 'always_focus_ring', 'disable_blur']),
  chat: Object.freeze(['chat_send_shortcut', 'chat_density', 'chat_show_timestamps', 'chat_poll_interval']),
  notifications: Object.freeze(['badge_interaction', 'badge_announcement', 'badge_system', 'badge_report',
    'unread_interval', 'notify_on_comment', 'notify_on_like']),
  navigation: Object.freeze(['home', 'publish', 'search', 'votes', 'chat', 'inbox', 'treehole',
    'bookmarks', 'help', 'theme', 'wallpaper']),
  reading: Object.freeze(['feed_sort', 'feed_category', 'density', 'time_format', 'font_scale', 'auto_load_images']),
  publishing: Object.freeze(['default_anonymous_post', 'default_markdown', 'confirm_before_post', 'default_anonymous_confession']),
});

const isPrefsObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

// 把存储值 + 默认值合并成完整、类型正确的偏好对象
function mergePrefs(stored) {
  const src = isPrefsObject(stored) ? stored : {};
  const out = {};
  for (const [key, spec] of Object.entries(PREF_SCHEMA)) {
    const raw = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
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
  const src = isPrefsObject(input) ? input : {};
  const out = {};
  for (const [key, spec] of Object.entries(PREF_SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const raw = src[key];
    if (spec.type === 'bool' && typeof raw === 'boolean') {
      out[key] = raw;
    } else if (spec.type === 'enum' && spec.values.includes(raw)) {
      out[key] = raw;
    }
  }
  return out;
}

// 返回可公开的安全契约；每次复制数组，调用者不能改动服务端允许值或重置范围。
function getPrefsSchema() {
  const schema = {};
  for (const [key, spec] of Object.entries(PREF_SCHEMA)) {
    const scope = Object.keys(PREF_SCOPES).find(name => name !== 'all' && PREF_SCOPES[name].includes(key));
    schema[key] = { type: spec.type, default: spec.def, scope };
    if (spec.type === 'enum') schema[key].values = [...spec.values];
  }
  return {
    version: 1, schema, defaults: mergePrefs({}),
    scopes: Object.fromEntries(Object.entries(PREF_SCOPES).map(([scope, keys]) => [scope, [...keys]])),
  };
}

function resetPrefs(stored, scope) {
  if (typeof scope !== 'string' || !Object.prototype.hasOwnProperty.call(PREF_SCOPES, scope)) {
    throw new TypeError('无效的偏好重置范围');
  }
  const prefs = mergePrefs(stored);
  for (const key of PREF_SCOPES[scope]) prefs[key] = PREF_SCHEMA[key].def;
  return prefs;
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

module.exports = { PREF_SCHEMA, PREF_SCOPES, mergePrefs, sanitizePrefs, readPrefs, getPrefsSchema, resetPrefs };
