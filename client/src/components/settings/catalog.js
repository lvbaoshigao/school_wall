export const SETTINGS_SECTIONS = [
  { id: 'account', title: '账号与隐私', icon: 'user', description: '管理个人资料，决定别人如何找到你。' },
  { id: 'appearance', title: '外观', icon: 'sun', description: '让界面的颜色、背景和阅读辅助更适合你。' },
  { id: 'reading', title: '阅读与发布', icon: 'file', description: '调整动态浏览方式与发布时的默认选项。' },
  { id: 'chat', title: '聊天', icon: 'message', description: '设置发送快捷键、消息密度与同步频率。' },
  { id: 'notifications', title: '通知', icon: 'bell', description: '选择接收哪些提醒，调整未读检查频率。' },
  { id: 'navigation', title: '导航', icon: 'menu', description: '保留常用入口，隐藏暂时不需要的导航项。' },
  { id: 'data', title: '数据与偏好', icon: 'settings', description: '备份偏好、恢复默认，或导出自己的账号数据。' },
]
const options = values => values.map(([value, label]) => ({ value, label }))
const binary = (key, section, label, description, extra = {}) => ({ key, section, label, description, type: 'bool', ...extra })
const choice = (key, section, label, description, values) => ({ key, section, label, description, type: 'enum', options: options(values) })
const action = (key, section, label, description, button, extra = {}) => ({ key, section, label, description, button, type: 'action', ...extra })
export const SETTINGS_ITEMS = [
  action('profile', 'account', '个人资料', '修改头像、昵称、自我介绍和对外展示的联系方式。', '编辑资料', { path: '/profile' }),
  action('password', 'account', '登录密码', '在个人资料页修改密码，旧会话会自动失效。', '修改密码', { path: '/profile' }),
  binary('allow_search_by_id', 'account', '允许通过 ID 搜索到我', '关闭后，同学无法用你的账号 ID 主动搜索你。', { source: 'privacy' }),
  binary('allow_search_by_username', 'account', '允许通过账号搜索到我', '账号名是登录用户名，创建后不可更改。', { source: 'privacy' }),
  binary('allow_search_by_nickname', 'account', '允许通过昵称搜索到我', '同学可以用昵称找到你并发送好友请求。', { source: 'privacy' }),
  binary('allow_search_by_real_name', 'account', '允许通过真实姓名搜索到我', '默认关闭。需要先在个人资料中填写真实姓名；搜索结果仍只展示昵称。', { source: 'privacy' }),
  binary('allow_discover', 'account', '出现在发现好友中', '关闭后，你的账号不会出现在发现好友推荐列表。', { source: 'privacy' }),
  choice('theme_mode', 'appearance', '主题模式', '跟随系统会根据设备的亮暗模式自动切换。', [['system', '跟随系统'], ['light', '亮色'], ['dark', '暗色']]),
  choice('accent', 'appearance', '主题色', '按钮、焦点框和选中状态使用同一主题色。', [['teal', '青碧'], ['indigo', '靛蓝'], ['forest', '松绿'], ['amber', '琥珀'], ['rose', '绛红'], ['slate', '石墨']]),
  binary('wallpaper_enabled', 'appearance', '显示背景壁纸', '使用本站背景图片。关闭后保留清爽的主题底色。'),
  binary('reduce_motion', 'appearance', '减少动效', '减少入场动画和过渡，也会尊重系统的减少动态效果偏好。'),
  binary('high_contrast', 'appearance', '高对比度', '提高文字与边框的对比，减少半透明背景。'),
  binary('always_focus_ring', 'appearance', '始终显示焦点框', '即使使用鼠标操作，也显示当前控件的焦点位置。'),
  binary('disable_blur', 'appearance', '关闭背景模糊', '减少毛玻璃效果，适合性能较低的设备。'),
  choice('feed_sort', 'reading', '动态默认排序', '选择进入主页时优先看到最新内容还是热门讨论。', [['latest', '最新'], ['hot', '热门']]),
  choice('feed_category', 'reading', '默认话题分类', '进入主页后默认显示的话题。', ['全部', '吐槽', '分享', '求助', '讨论', '其他'].map(value => [value, value])),
  choice('density', 'reading', '动态列表密度', '舒适模式留白更多，紧凑模式在一屏内显示更多内容。', [['comfortable', '舒适'], ['compact', '紧凑']]),
  choice('time_format', 'reading', '时间显示方式', '选择相对时间或完整日期时间。', [['relative', '相对时间'], ['absolute', '具体时间']]),
  choice('font_scale', 'reading', '全站文字大小', '文字会整体缩放，页面也会相应调整。', [['sm', '小'], ['md', '标准'], ['lg', '大']]),
  binary('auto_load_images', 'reading', '自动加载帖子图片', '关闭后按需点击加载图片，减少流量使用。'),
  binary('default_anonymous_post', 'reading', '默认匿名发帖', '打开发布页时默认匿名，可在每次发布前单独调整。'),
  binary('default_markdown', 'reading', '默认使用 Markdown', '打开发布页时默认启用 Markdown 编辑。'),
  binary('confirm_before_post', 'reading', '发布前再次确认', '发布帖子前增加一次确认，减少误操作。'),
  binary('default_anonymous_confession', 'reading', '默认匿名表白', '关闭后，收信同学可以看到你的身份。'),
  choice('chat_send_shortcut', 'chat', '消息发送快捷键', '桌面端可选择 Enter 或 Ctrl / ⌘ + Enter 发送；手机上的 Enter 始终换行。', [['enter', 'Enter 发送'], ['modifier', 'Ctrl / ⌘ + Enter 发送']]),
  choice('chat_density', 'chat', '聊天消息密度', '舒适模式保留清晰留白，紧凑模式缩小消息间距。', [['comfortable', '舒适'], ['compact', '紧凑']]),
  binary('chat_show_timestamps', 'chat', '显示聊天时间', '在聊天消息旁显示发送时间。'),
  choice('chat_poll_interval', 'chat', '聊天同步频率', '停留在聊天页时检查新消息的间隔，较慢频率更省流量。', [['10', '10 秒'], ['20', '20 秒'], ['30', '30 秒'], ['60', '60 秒']]),
  binary('badge_interaction', 'notifications', '互动消息计入未读', '评论和点赞通知计入顶栏未读红点。'),
  binary('badge_announcement', 'notifications', '公告计入未读', '校园墙公告计入顶栏未读红点。'),
  binary('badge_system', 'notifications', '系统消息计入未读', '好友请求、审批结果和角色变化计入未读红点。'),
  binary('badge_report', 'notifications', '举报进度计入未读', '举报处理结果与进度计入未读红点。'),
  choice('unread_interval', 'notifications', '未读检查频率', '控制顶栏多久检查一次未读；不自动时仍可进入页面刷新。', [['0', '不自动'], ['15', '15 秒'], ['30', '30 秒'], ['60', '1 分钟'], ['300', '5 分钟']]),
  binary('notify_on_comment', 'notifications', '有人评论时通知我', '关闭后，服务器不再为新评论生成互动通知。'),
  binary('notify_on_like', 'notifications', '有人点赞时通知我', '关闭后，服务器不再为新点赞生成互动通知。'),
  action('export_preferences', 'data', '导出偏好 JSON', '只包含外观、阅读、聊天、通知与导航偏好，不含登录凭证或账号隐私。', '导出偏好'),
  action('import_preferences', 'data', '导入偏好 JSON', '只接受校园墙偏好文件；先校验并确认，再批量保存。', '选择文件'),
  action('reset_preferences', 'data', '恢复默认偏好', '可恢复某个分类或全部偏好，不会修改姓名、联系方式、搜索隐私或账号内容。', '选择范围'),
  action('export_account', 'data', '导出我的账号数据', '将自己的资料、帖子、消息、好友和收藏打包为 gzip 文件。请妥善保管。', '导出数据'),
  action('clear_session', 'data', '清除本机登录状态', '退出当前账号并清除本机临时登录信息，服务器中的偏好保持不变。', '清除并退出'),
  action('bug_report', 'data', '问题反馈', '遇到界面或功能问题时，提交说明与截图。', '提交反馈', { path: '/bug-report' }),
]

export function buildSettingsCatalog(navItems = []) {
  return [...SETTINGS_ITEMS,
    ...navItems.map(item => binary(item.key, 'navigation', '显示' + item.label + '入口', item.desc, { source: 'navigation', requireTreeHole: !!item.requireTreeHole })),
    binary('theme', 'navigation', '显示主题切换按钮', '在导航栏中快速切换亮色与暗色。', { source: 'navigation' }),
    binary('wallpaper', 'navigation', '显示换壁纸按钮', '在导航栏中保留更换背景图片的入口。', { source: 'navigation' }),
  ]
}
export function resolveSettingsSection(value, hash = '') {
  if (typeof value === 'string' && SETTINGS_SECTIONS.some(section => section.id === value)) return value
  let candidate = ''
  try { candidate = typeof hash === 'string' ? decodeURIComponent(hash.replace(/^#/, '')).replace(/^settings-/, '') : '' } catch {}
  return SETTINGS_SECTIONS.some(section => section.id === candidate) ? candidate : 'account'
}
export function searchSettings(items, query) {
  const normalized = typeof query === 'string' ? query.trim().slice(0, 80).toLocaleLowerCase() : ''
  if (!normalized) return items
  const words = normalized.split(/\s+/u)
  return items.filter(item => {
    const section = SETTINGS_SECTIONS.find(section => section.id === item.section)
    const text = [item.label, item.description, item.key, section?.title, ...(item.options || []).map(option => option.label)].join(' ').toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}
