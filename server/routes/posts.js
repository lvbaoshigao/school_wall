const express = require('express');
// Node 20 的全局 crypto 是 WebCrypto，没有 createHash。
// 下面发帖/评论都要用它算 IP 哈希，必须显式引入 node:crypto，否则整条路径 500。
const crypto = require('crypto');
const { authRequired, wallContext } = require('../middleware/auth');
const { readPrefs } = require('../lib/prefs');
const { deletePostImages } = require('../lib/uploads');

const router = express.Router();

// 帖子分类列表（允许用户自定义分类）
const DEFAULT_CATEGORIES = ['吐槽', '分享', '求助', '讨论', '其他'];

// 返回给客户端的帖子列（不含 author_ip —— 安全修复）
const POST_SELECT = `
  p.id, p.wall_id, p.content, p.category, p.is_anonymous, p.author_id,
  p.like_count, p.comment_count, p.is_markdown, p.created_at,
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.nickname END as author_nickname,
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar END as author_avatar,
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.class_number END as author_class
`;

// 搜索帖子（当前墙内）
router.get('/search', authRequired, wallContext, (req, res) => {
  const { q } = req.query;
  const term = (q || '').trim();
  // `content LIKE '%x%'` 带前导通配符，走不了索引，只能全表扫描，而且是同步阻塞的。
  // 单字符关键词几乎必然命中全部帖子，扫描代价最高、结果最没用 —— 直接挡掉。
  if (term.length < 2) {
    return res.json({ posts: [], total: 0, hint: term.length ? '搜索关键词至少 2 个字符' : undefined });
  }
  if (term.length > 50) {
    return res.status(400).json({ error: '搜索关键词过长' });
  }

  const searchTerm = `%${term}%`;
  // 搜索关键词中的 % 和 _ 是 SQLite LIKE 的通配符，需要转义才能按字面匹配
  const escapedTerm = term.replace(/[%_]/g, '\\$&');
  const searchTermEscaped = `%${escapedTerm}%`;
  // 原先 COUNT 和 SELECT 各扫一遍全表，等于把最贵的操作做了两次。
  // 这里只取一遍：多查一条用于判断「是否还有更多」，total 用结果数近似。
  const LIMIT = 50;
  const rows = req.db.prepare(`
    SELECT ${POST_SELECT}
    FROM posts p
    LEFT JOIN users u ON p.author_id = u.id
    WHERE p.wall_id = ? AND p.content LIKE ? ESCAPE '\\'
    ORDER BY p.created_at DESC
    LIMIT ?
  `).all(req.wallId, searchTermEscaped, LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const posts = hasMore ? rows.slice(0, LIMIT) : rows;
  const total = posts.length;

  if (req.user) {
    const likedRows = req.db.prepare('SELECT post_id FROM likes WHERE user_id = ?').all(req.user.id);
    const likedSet = new Set(likedRows.map(r => r.post_id));
    const bmRows = req.db.prepare('SELECT post_id FROM bookmarks WHERE user_id = ?').all(req.user.id);
    const bmSet = new Set(bmRows.map(r => r.post_id));
    posts.forEach(p => { p.liked = likedSet.has(p.id); p.bookmarked = bmSet.has(p.id); });
  }

  res.json({ posts, total, hasMore });
});

// 获取帖子列表（当前墙内，分页 + 分类筛选 + 热门排序）
router.get('/', authRequired, wallContext, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const category = req.query.category;
  const sort = req.query.sort; // 'hot' = 按热度排序

  let where = 'WHERE p.wall_id = ?';
  const params = [req.wallId];
  if (category && category !== '全部') {
    where += ' AND p.category = ?';
    params.push(category);
  }

  // 热门：近7天 + 按点赞数排序
  if (sort === 'hot') {
    where += " AND p.created_at >= datetime('now', '-7 days', 'localtime')";
  }

  const totalRow = req.db.prepare(`SELECT COUNT(*) as count FROM posts p ${where}`).get(...params);
  const total = totalRow ? totalRow.count : 0;

  const orderBy = sort === 'hot' ? 'ORDER BY p.like_count DESC, p.comment_count DESC' : 'ORDER BY p.created_at DESC';

  const posts = req.db.prepare(`
    SELECT ${POST_SELECT}
    FROM posts p
    LEFT JOIN users u ON p.author_id = u.id
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  if (req.user) {
    const likedRows = req.db.prepare('SELECT post_id FROM likes WHERE user_id = ?').all(req.user.id);
    const likedSet = new Set(likedRows.map(r => r.post_id));
    posts.forEach(p => { p.liked = likedSet.has(p.id); });
  }

  // 当前墙用过的分类
  const dbCategories = req.db.prepare('SELECT DISTINCT category FROM posts WHERE wall_id=? ORDER BY category').all(req.wallId).map(r => r.category);
  const allCategories = ['全部', ...new Set([...DEFAULT_CATEGORIES, ...dbCategories])];

  // 注入当前用户的收藏状态
  if (req.user) {
    const bmRows = req.db.prepare('SELECT post_id FROM bookmarks WHERE user_id = ?').all(req.user.id);
    const bmSet = new Set(bmRows.map(r => r.post_id));
    posts.forEach(p => { p.bookmarked = bmSet.has(p.id); });
  }

  res.json({ posts, total, page, limit, categories: allCategories });
});

// 热门帖子（本墙内，按点赞数排序，三天内的帖子）
router.get('/hot', authRequired, wallContext, (req, res) => {
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit) || 10));
  const posts = req.db.prepare(`
    SELECT ${POST_SELECT}
    FROM posts p LEFT JOIN users u ON p.author_id = u.id
    WHERE p.wall_id = ? AND p.created_at >= datetime('now', '-3 days', 'localtime')
    ORDER BY p.like_count DESC, p.comment_count DESC
    LIMIT ?
  `).all(req.wallId, limit);

  if (req.user) {
    const likedRows = req.db.prepare('SELECT post_id FROM likes WHERE user_id = ?').all(req.user.id);
    const likedSet = new Set(likedRows.map(r => r.post_id));
    const bmRows = req.db.prepare('SELECT post_id FROM bookmarks WHERE user_id = ?').all(req.user.id);
    const bmSet = new Set(bmRows.map(r => r.post_id));
    posts.forEach(p => { p.liked = likedSet.has(p.id); p.bookmarked = bmSet.has(p.id); });
  }

  res.json({ posts, total: posts.length });
});

// 发帖（当前墙）
router.post('/', authRequired, wallContext, (req, res) => {
  const { content, category, is_anonymous } = req.body;
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: '内容不能为空' });
  }
  if (content.length > 2000) {
    return res.status(400).json({ error: '内容不能超过2000字' });
  }

  let cat = (category || '分享').trim();
  if (cat.length > 20) cat = cat.substring(0, 20);
  if (!cat) cat = '分享';

  const ip = req.ip || req.connection.remoteAddress;
  // 脱敏存储 IP 地址：取完整 IP 的 SHA256 前 16 字符，既保留去重能力又不暴露原始 IP
  const ipHash = crypto.createHash('sha256').update(ip || '').digest('hex').substring(0, 16);
  const authorId = is_anonymous ? null : req.user.id;

  const result = req.db.prepare(`
    INSERT INTO posts (wall_id, content, category, is_anonymous, author_id, author_ip, is_markdown)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.wallId, content.trim(), cat, is_anonymous ? 1 : 0, authorId, ipHash, req.body.is_markdown ? 1 : 0);

  const post = req.db.prepare(`
    SELECT ${POST_SELECT} FROM posts p LEFT JOIN users u ON p.author_id=u.id WHERE p.id = ?
  `).get(result.lastInsertRowid);
  res.json(post);
});

// 帖子详情 + 评论（校验属于当前墙）
router.get('/:id', authRequired, wallContext, (req, res) => {
  const post = req.db.prepare(`
    SELECT ${POST_SELECT}
    FROM posts p
    LEFT JOIN users u ON p.author_id = u.id
    WHERE p.id = ? AND p.wall_id = ?
  `).get(parseInt(req.params.id), req.wallId);

  if (!post) return res.status(404).json({ error: '帖子不存在' });

  const comments = req.db.prepare(`
    SELECT c.id, c.post_id, c.content, c.author_id, c.created_at, u.nickname, u.avatar, u.class_number
    FROM comments c
    JOIN users u ON c.author_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `).all(post.id);

  if (req.user) {
    const liked = req.db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?')
      .get(post.id, req.user.id);
    post.liked = !!liked;
    const bm = req.db.prepare('SELECT id FROM bookmarks WHERE post_id = ? AND user_id = ?')
      .get(post.id, req.user.id);
    post.bookmarked = !!bm;
  }

  res.json({ post, comments });
});

// 删除帖子（作者或墙管理者）
router.delete('/:id', authRequired, wallContext, (req, res) => {
  const postId = parseInt(req.params.id);
  const post = req.db.prepare('SELECT author_id, content FROM posts WHERE id = ? AND wall_id = ?').get(postId, req.wallId);
  if (!post) return res.status(404).json({ error: '帖子不存在' });

  const isAuthor = post.author_id === req.user.id;
  const isMod = req.can('wall.post.delete');
  if (!isAuthor && !isMod) {
    return res.status(403).json({ error: '无权删除' });
  }

  req.db.prepare('DELETE FROM comments WHERE post_id = ?').run(postId);
  req.db.prepare('DELETE FROM likes WHERE post_id = ?').run(postId);
  req.db.prepare('DELETE FROM post_reports WHERE post_id = ?').run(postId);
  req.db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
  // 同时清掉只被这条帖子引用的图片，否则删帖后文件会永远留在磁盘上累积
  deletePostImages(req.db, post.content, postId);
  res.json({ message: '已删除' });
});

// 发评论
router.post('/:id/comments', authRequired, wallContext, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: '评论不能为空' });
  }

  const post = req.db.prepare('SELECT id, author_id, content FROM posts WHERE id = ? AND wall_id = ?').get(parseInt(req.params.id), req.wallId);
  if (!post) return res.status(404).json({ error: '帖子不存在' });

  const ip = req.ip || req.connection.remoteAddress;
  const ipHash = crypto.createHash('sha256').update(ip || '').digest('hex').substring(0, 16);
  const result = req.db.prepare(`
    INSERT INTO comments (post_id, content, author_id, author_ip) VALUES (?, ?, ?, ?)
  `).run(post.id, content.trim(), req.user.id, ipHash);

  req.db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(post.id);

  // 帖主可在设置里关掉「被评论时提醒我」，关掉就不写这条站内信
  if (post.author_id && post.author_id !== req.user.id && readPrefs(req.db, post.author_id).notify_on_comment) {
    const commenter = req.db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.user.id);
    const postPreview = post.content.substring(0, 30) + (post.content.length > 30 ? '...' : '');
    // 匿名帖子也应隐藏评论者身份，避免通过评论者昵称反推匿名帖子的作者是谁
    const isAnonymousPost = req.db.prepare('SELECT is_anonymous FROM posts WHERE id=?').get(post.id)?.is_anonymous === 1;
    const senderName = isAnonymousPost ? '匿名用户' : (commenter.nickname || '用户');
    const senderId = isAnonymousPost ? null : req.user.id;
    req.db.prepare('INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(senderId, post.author_id, req.wallId, 'interaction', '新评论',
        `${senderName} 评论了你的帖子"${postPreview}"：${content.trim().substring(0, 50)}`,
        `/post/${post.id}`);
  }

  const comment = req.db.prepare(`
    SELECT c.id, c.post_id, c.content, c.author_id, c.created_at, u.nickname, u.avatar, u.class_number
    FROM comments c JOIN users u ON c.author_id = u.id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);

  res.json(comment);
});

// 删除评论（作者或墙管理者）
router.delete('/:postId/comments/:commentId', authRequired, wallContext, (req, res) => {
  const commentId = parseInt(req.params.commentId);
  const postId = parseInt(req.params.postId);
  // 校验帖子属于当前墙
  const post = req.db.prepare('SELECT id FROM posts WHERE id = ? AND wall_id = ?').get(postId, req.wallId);
  if (!post) return res.status(404).json({ error: '帖子不存在' });
  const comment = req.db.prepare('SELECT author_id FROM comments WHERE id = ? AND post_id = ?').get(commentId, postId);
  if (!comment) return res.status(404).json({ error: '评论不存在' });

  const isAuthor = comment.author_id === req.user.id;
  const isMod = req.can('wall.post.delete');
  if (!isAuthor && !isMod) {
    return res.status(403).json({ error: '无权删除' });
  }

  req.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  req.db.prepare('UPDATE posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?').run(postId);
  res.json({ message: '评论已删除' });
});

// 点赞
router.post('/:id/like', authRequired, wallContext, (req, res) => {
  const post = req.db.prepare('SELECT id, author_id, content FROM posts WHERE id = ? AND wall_id = ?').get(parseInt(req.params.id), req.wallId);
  if (!post) return res.status(404).json({ error: '帖子不存在' });

  try {
    req.db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').run(post.id, req.user.id);
    req.db.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').run(post.id);

    // 同上：被点赞提醒由帖主的偏好决定
    if (post.author_id && post.author_id !== req.user.id && readPrefs(req.db, post.author_id).notify_on_like) {
      const liker = req.db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.user.id);
      const postPreview = post.content.substring(0, 30) + (post.content.length > 30 ? '...' : '');
      req.db.prepare('INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, link) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.user.id, post.author_id, req.wallId, 'interaction', '新点赞',
          `${liker.nickname || '用户'} 赞了你的帖子"${postPreview}"`,
          `/post/${post.id}`);
    }

    res.json({ liked: true });
  } catch (e) {
    res.status(400).json({ error: '已经点赞过了' });
  }
});

// 取消点赞
router.delete('/:id/like', authRequired, wallContext, (req, res) => {
  const post = req.db.prepare('SELECT id FROM posts WHERE id = ? AND wall_id = ?').get(parseInt(req.params.id), req.wallId);
  if (!post) return res.status(404).json({ error: '帖子不存在' });
  const result = req.db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?')
    .run(post.id, req.user.id);
  if (result.changes > 0) {
    req.db.prepare('UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?').run(post.id);
  }
  res.json({ liked: false });
});

// 举报帖子（本墙管理者处理）
router.post('/:id/report', authRequired, wallContext, (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.trim().length === 0) return res.status(400).json({ error: '请填写举报原因' });
  if (reason.length > 500) return res.status(400).json({ error: '举报原因不能超过500字' });

  const postId = parseInt(req.params.id);
  const post = req.db.prepare('SELECT id FROM posts WHERE id = ? AND wall_id = ?').get(postId, req.wallId);
  if (!post) return res.status(404).json({ error: '帖子不存在' });

  const existing = req.db.prepare("SELECT id FROM post_reports WHERE post_id = ? AND reporter_id = ? AND status = 'pending'").get(postId, req.user.id);
  if (existing) return res.status(400).json({ error: '你已举报过该帖子' });

  req.db.prepare('INSERT INTO post_reports (wall_id, post_id, reporter_id, reason) VALUES (?,?,?,?)').run(req.wallId, postId, req.user.id, reason.trim());

  // 通知本墙管理者 + 全局管理员
  const mods = req.db.prepare(
    "SELECT user_id as id FROM wall_members WHERE wall_id=? AND status='active' AND wall_role IN ('owner','admin')"
  ).all(req.wallId);
  const globalAdmins = req.db.prepare("SELECT id FROM users WHERE role IN ('admin','super_admin') AND status='active'").all();
  const ids = [...new Set([...mods.map(m => m.id), ...globalAdmins.map(a => a.id)])];
  const reporter = req.db.prepare('SELECT nickname FROM users WHERE id=?').get(req.user.id);
  const ins = req.db.prepare("INSERT INTO messages (sender_id, receiver_id, wall_id, type, title, content, link) VALUES (NULL,?,?,'system',?,?,?)");
  ids.forEach(id => ins.run(id, req.wallId, '帖子举报', `${reporter?.nickname || '用户'} 举报了帖子 #${postId}：${reason.trim().substring(0, 100)}`, '/admin?panel=postReports'));

  res.json({ message: '举报已提交' });
});

// ===== 收藏/书签 =====

// 获取我的收藏列表（必须定义在 GET /:id 之前，避免被 :id 捕获）
// 收藏列表。
// 必须限定在「用户当前仍是 active 成员」的墙内：墙成员身份是帖子内容的访问边界，
// 原先只按 user_id 过滤，用户退墙或被墙管理员踢出/封禁后，仍能通过收藏继续读到该墙的帖子正文。
router.get('/bookmarks/list', authRequired, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = req.db.prepare(`
    SELECT COUNT(*) as c
    FROM bookmarks b
    JOIN posts p ON b.post_id = p.id
    JOIN wall_members wm ON wm.wall_id = p.wall_id AND wm.user_id = b.user_id AND wm.status = 'active'
    WHERE b.user_id = ?
  `).get(req.user.id).c;

  const posts = req.db.prepare(`
    SELECT ${POST_SELECT}
    FROM bookmarks b
    JOIN posts p ON b.post_id = p.id
    JOIN wall_members wm ON wm.wall_id = p.wall_id AND wm.user_id = b.user_id AND wm.status = 'active'
    LEFT JOIN users u ON p.author_id = u.id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);

  // 注入 liked & bookmarked 状态
  if (posts.length > 0) {
    const likedRows = req.db.prepare('SELECT post_id FROM likes WHERE user_id = ?').all(req.user.id);
    const likedSet = new Set(likedRows.map(r => r.post_id));
    posts.forEach(p => { p.liked = likedSet.has(p.id); p.bookmarked = true; });
  }

  res.json({ posts, total, page, limit });
});

// 收藏帖子
router.post('/:id/bookmark', authRequired, wallContext, (req, res) => {
  const postId = parseInt(req.params.id);
  const post = req.db.prepare('SELECT id FROM posts WHERE id = ? AND wall_id = ?').get(postId, req.wallId);
  if (!post) return res.status(404).json({ error: '帖子不存在' });

  try {
    req.db.prepare('INSERT INTO bookmarks (user_id, post_id) VALUES (?, ?)').run(req.user.id, postId);
    res.json({ bookmarked: true });
  } catch (e) {
    res.status(400).json({ error: '已收藏' });
  }
});

// 取消收藏
router.delete('/:id/bookmark', authRequired, wallContext, (req, res) => {
  const postId = parseInt(req.params.id);
  req.db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  res.json({ bookmarked: false });
});

module.exports = router;
