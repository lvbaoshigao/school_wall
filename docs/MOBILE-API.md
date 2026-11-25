# School Wall 移动端 API 与便携 SDK

本文描述当前真实实现，不承诺尚不存在的移动应用、刷新令牌、WebSocket 或推送服务。机器可读契约见 [openapi.json](./openapi.json)，无第三方运行时依赖的客户端见 [mobile-client.mjs](../sdk/mobile-client.mjs)，类型声明见 [mobile-client.d.ts](../sdk/mobile-client.d.ts)。

## 版本与响应

- 新客户端使用部署站点的 HTTPS 源加 /api/v1，例如由应用配置提供 origin，再拼接 /api/v1。SDK 的 baseURL 是**完整版本前缀**，不会自动追加 /api/v1。
- 旧 /api 路由、HTTP 状态和业务数据形状保持兼容。v1 复用相同鉴权、限流、墙权限和数据，不是另一套数据库。
- GET /api/v1 和 GET /api/v1/capabilities 返回静态能力信息；仍经过部署 IP 守卫和限流，不公开账号、运行状态、密钥或用户数据。
- GET /api/v1/openapi.json 返回原始 OpenAPI JSON，**不包络**。下载附件、流和二进制响应也保持原格式。SDK 的默认 request() 按 JSON 包络读取；完整静态注册表为 getOpenApi 选择原始 JSON 模式，为 exportOwnData、备份下载和 getWallpaperImage 选择二进制模式，调用方不要自行 JSON.parse 下载正文。
- 请求路径只允许正常版本路径；未知版本返回 404 UNSUPPORTED_API_VERSION，危险路径编码返回 400 INVALID_API_PATH。不要依赖大小写、重复斜杠或编码绕行。

成功 JSON：

~~~json
{"data":{"prefs":{}},"error":null,"meta":{"apiVersion":"1","requestId":"server-generated-opaque-id"}}
~~~

上例 prefs 仅演示包络位置；实际偏好接口返回完整 40 项。失败 JSON：

~~~json
{"data":null,"error":{"code":"UNAUTHENTICATED","message":"请先登录"},"meta":{"apiVersion":"1","requestId":"server-generated-opaque-id"}}
~~~

HTTP 状态不被伪装成 200。响应头 X-API-Version: 1 和 X-Request-ID 可用于协议识别及问题关联；requestId 由服务器随机生成，忽略调用方提供的同名 ID。业务错误可包含 error.details，例如封禁 scope/reason/until；这些字段可能涉及个人状态，应按私密数据处理。

| HTTP | 默认 code | 移动端行为 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 修正类型、范围或参数组合 |
| 401 | UNAUTHENTICATED | 清理失效会话并让用户重新登录 |
| 403 | FORBIDDEN，或业务 BANNED | 展示权限/封禁状态，勿换墙绕过 |
| 404 | NOT_FOUND | 资源不存在或因隐私被隐藏；不要据此推断账号/举报是否存在 |
| 409 | CONFLICT，或 CLIENT_MESSAGE_CONFLICT / CLIENT_MESSAGE_UNAVAILABLE | cid 冲突、原消息被本人隐藏或已撤回，不能自动换新 cid 重发 |
| 413 | PAYLOAD_TOO_LARGE | 缩小请求或图片 |
| 429 | RATE_LIMITED | 若有 Retry-After，按其秒数或 HTTP 日期延迟 |
| 500 / 503 | INTERNAL_ERROR / SERVICE_UNAVAILABLE | 展示可恢复错误；不要盲重放非幂等写 |
| 507 | INSUFFICIENT_STORAGE | 上传配额或容量不足 |

其他固定映射包含 405 METHOD_NOT_ALLOWED、415 UNSUPPORTED_MEDIA_TYPE、422 VALIDATION_ERROR、425 TOO_EARLY；文档暂不可用时为 503 OPENAPI_UNAVAILABLE。已有业务 code 优先于默认映射。界面可显示 message，但逻辑必须匹配 HTTP 状态与 code，不能解析中文文案。

## 认证、墙上下文与隐私

登录 POST /auth/login 使用调用方输入的 username/password；不发布或假设任何默认公开用户名、密码。成功返回 data.token 和 data.user。除明确标注的登录、注册、首次设置、健康检查、壁纸及版本发现/静态文档外，标准 API 需要 Authorization: Bearer <token>。公开并不代表绕过部署 IP 守卫或各路由限流；健康检查按既有顺序位于这两者之前。

JWT 目前有效期为 7 天，但修改密码、封禁、账号删除等会提前失效。PUT /auth/password 使用 {oldPassword,newPassword}，返回新 token 并使旧 token_version 失效。没有 refresh/session 续签接口。SDK 不存储 token，不使用 localStorage，不自动接受登录/改密返回的 token；调用方应将其写入平台安全存储并更新 getToken() 的来源。

帖子、评论、投票等墙内资源使用 X-Wall-Id。只返回当前有效成员可见的该墙数据；管理员也按现有权限集检查。不要把墙 ID 当作访问授权。路径墙 ID 与头、query 或 body 的墙上下文不能冲突。私聊不依赖当前墙头来扩大历史可见范围；发送表白信必须显式选择双方均为有效成员的墙。

匿名帖子/投票的公共响应中 author_id、昵称等为 null，IP 哈希不外发。收到的匿名表白信隐藏发送者身份；不要从引用、会话卡片或旧预览反推。树洞继续沿用已有专用接口和匿名身份规则，本 SDK 不把树洞映射成普通私聊，也不承诺树洞引用能力。

DELETE /messages/{id} 和 DELETE /messages/chat/{userId} 都是**单侧隐藏**：只影响当前账号视图，另一方仍可见。PUT /messages/{id}/revoke 才是发送方在服务器判定的 5 分钟内对双方撤回。引用预览依当前用户可见性动态生成，原消息不可见/撤回后不得显示缓存的敏感预览。

## 全量覆盖与调用边界

本规范覆盖真实 Express 注册的 **155 个显式方法/路径组合、140 个路径模板**：145 个 /api 注册（包括仅在 /api/v1 暴露的三个发现入口）和 10 个 /dashboard/api 内部注册。按参数名 :id → {id} 正规化后，与隔离真实 index 实例枚举的双向差集均为空，双方均无重复。旧 52 个 operationId 保持原名；其余 103 个操作包含新增的公开壁纸图片接口，既有鉴权与内部操作排除策略保持一致。

| 范围 | 操作数 | 鉴权与用途 |
| --- | ---: | --- |
| 普通族及有权限的墙内操作 | 109 | 对应公开入口、Bearer、有效墙成员身份及各操作权限；详细字段见规范 |
| 管理族、建墙审核及看板票据入口 | 36 | 管理操作仍要求对应 global 或 wall 权限；票据入口要求 global.dashboard |
| /dashboard/api 内部操作 | 10 | 看板票据或 Cookie；Cookie 写操作另需 CSRF；不由公共移动客户端调用 |

公共 SDK 操作目录覆盖 **144 个**标准 API 操作，使用 callOperation(operationId, {path, query, body, wallId}, requestOptions)；已有易用方法继续保留。网页 Cookie 票据入口 /dashboard/session（实际 /api/v1/dashboard/session）和 10 个看板内部操作有明确排除策略；目录化调用没有任意路径或 opt-in 开关。低层 request<T>() 保持既有兼容能力，不是服务端授权边界；不要用它替代网页的 Cookie/CSRF 流程。目录完整也不表示账号有相应权限，服务器仍实时裁定。

OpenAPI 顶层 servers 是 /api/v1；除 x-versioned-only 标记的 /、/capabilities、/openapi.json 外，标准 /api 路径可通过旧 /api 前缀使用。旧 /api 本身不是能力发现入口。内部操作逐项 servers: [{url:"/"}]，最终路径严格为同一部署源上的 /dashboard/api/...，不能把它们拼到 /api/v1 下，也不能把根服务器地址当作任意外域授权。

静态文件（/uploads、/rele 等）、站点页面和 SPA 路由不计 API。GET 的隐式 HEAD 行为由 Express 或发现路由提供：响应头遵循 GET，响应无正文；它们不另计为新业务操作。允许源的浏览器 CORS 预检 OPTIONS 由全局 CORS 中间件处理，不代表绕过 Bearer、Cookie、IP 白名单或操作权限，也不增加任意跨源访问许可。发现入口的其他方法返回 405。

### 同源看板与管理安全边界

取得看板票据：携带普通 Bearer 调 POST /api/v1/dashboard/session，要求 global.dashboard。服务器种入 sw_dash HttpOnly、SameSite=Strict、Path=/dashboard、有效期一小时的 Cookie；HTTPS 请求另带 Secure。此响应仍为 v1 JSON 包络，不返回 Cookie 中的票据值。禁止把票据放进 query 或公开日志。

/dashboard/api/... 是已有内部原始 JSON/二进制 API，成功和错误均不使用 v1 包络。Cookie 认证的写操作要求 X-Dashboard-Csrf 与票据内 CSRF 值匹配；若请求带 Origin，还必须精确匹配服务器所见 protocol://host。只接受既有 aud=dashboard 票据的 Bearer 作为脚本认证替代；普通账号 JWT 不能直接冒充看板票据。所有内部操作要求 global.dashboard；数据库管理还要求 global.db.manage，并经过既有管理面 IP 守卫。

公共移动 SDK 始终拒绝内部端点和看板票据代理，不提供绕过开关。确需维护看板的受控客户端必须先确认选定 HTTPS 部署 origin，以该 origin 解析根路径，单独管理看板 Cookie/票据与 CSRF，核对 operation.security、x-required-permissions 和响应类型；不得沿用公共调用的普通 Bearer、X-Wall-Id 或跨源目标。本文仅记录既有接口，不新增权限、公开票据或放宽 Origin/CORS。

## 核心端点与界限

以下路径均相对 /api/v1。OpenAPI 列出具体请求/响应字段、状态和参数。

| 资源 | 真实端点与说明 |
| --- | --- |
| 账号 | POST /auth/login；GET /auth/me；PUT /auth/profile；PUT /auth/password |
| 偏好 | GET /auth/prefs；PUT /auth/prefs；GET /auth/prefs/schema；POST /auth/prefs/reset |
| 墙 | GET /walls、/walls/discover、/walls/{id}；POST /walls/{id}/join、/leave |
| 帖子 | GET/POST /posts；GET /posts/search；GET/DELETE /posts/{id} |
| 评论 | POST /posts/{id}/comments；DELETE /posts/{postId}/comments/{commentId} |
| 私聊 | GET /messages/conversations；GET /messages/conversation/{userId}；POST /messages |
| 消息操作 | PUT /messages/read-batch、/read-all、/{id}/read、/{id}/revoke；DELETE /messages/{id}、/messages/chat/{userId} |
| 好友 | GET /friends、/friends/pending；POST /friends/add、/block、/unblock；PUT /friends/{id}/respond；DELETE /friends/{id} |
| 投票 | GET/POST /votes；GET/DELETE /votes/{id}；POST /votes/{id}/vote |
| 上传 | POST /upload/image、/upload/bug-image；PUT /avatar/upload |
| 壁纸 | GET /wallpaper?source=bing&idx=0；GET /wallpaper/image/{file} 返回缓存 JPEG |

普通 JSON 请求体上限 128 KiB；图片上传 JSON 上限 5 MiB。消息最多 2000 字符，标题 100；帖子正文 2000；评论 500；投票标题 100、描述 500，2–10 个非空且去空格后不同的选项，每项 50 字符。密码上限是 1024 **UTF-8 字节**，新密码至少 6 字符；用户名 3–20 字符且不能带首尾空白/控制字符。资料字段具体上限见 OpenAPI，不传字段表示保留，不要将本地整份陈旧 profile 覆盖回服务器。

## 偏好与分组重置

GET /auth/prefs 返回 {prefs,storedKeys?}；prefs 是完整合并结果。storedKeys 表示真正持久化的合法键，可区分“未存 theme_mode”与“明确选择 system”。PUT /auth/prefs 发送 {prefs:{...增量}}；为兼容旧客户端，未知键或非法值会被忽略，不会覆盖已存合法值。新界面应先读 schema 本地校验，并读取保存结果确认。

GET /auth/prefs/schema 返回 {version:1,schema,defaults,scopes}。schema 每项使用 type、default、scope，枚举另有 values。POST /auth/prefs/reset 的 body 必须恰为 {scope}，允许 all、appearance、chat、notifications、navigation、reading、publishing；额外键、未知分组或非字符串明确 400。它只重置偏好，不改 profile、账号隐私、密码或 token；局部分组不改变其他偏好。

新增共享键：

| 键 | 允许值 | 默认 |
| --- | --- | --- |
| theme_mode | system / light / dark | system |
| wallpaper_enabled | boolean | true |
| wallpaper_source | bing / local | bing |
| chat_send_shortcut | enter / modifier | enter |
| chat_density | comfortable / compact | comfortable |
| chat_show_timestamps | boolean | true |
| chat_poll_interval | 字符串 10 / 20 / 30 / 60 | 字符串 20 |

手机 Enter 保留换行；发送快捷键是应用 UI 行为，不能替代显式发送按钮。theme/wallpaper 原导航开关控制入口可见性，实际外观分别由 theme_mode/wallpaper_enabled 控制。wallpaper_source 属于 appearance，重置该组恢复 bing，重置 chat 等其他组会保留已选来源。不要混淆 reading.density 与 chat_density。

## 壁纸来源与图片缓存

GET /wallpaper 默认 source=bing。省略 idx 选择必应当天图片；显式 idx 是 0–7 的整数，按当前可用归档数量取模。source=local 时省略 idx 随机选择本地图片，显式 idx 允许 0–1000000，按本地集合大小取模。非法来源、超范围、数组、对象或小数返回 400。客户端需把已保存的 wallpaper_source 作为 source 传入；公开壁纸接口本身不读取账号偏好。

选择结果包含 file、url、total、idx、source、fallback；source 表示实际来源，必应获取失败且无可用缓存时会回退本地并令 fallback=true。没有本地图片时 file/url 为 null、total/idx 为 0。必应结果另有 copyright 署名。选择响应为 no-store；返回的 url 是部署源根路径，必应使用 /api/wallpaper/image/{file}，本地使用 /rele/{file}，不能直接拼到 /api/v1 后面。

缓存必应图片接口只接受返回的 64 位小写十六进制哈希加 .jpg 文件名，返回原始 image/jpeg 字节；缺失或无效文件返回 404，不会按任意 URL 代理下载。成功响应为 public, max-age=31536000, immutable，支持 ETag/Last-Modified 条件请求和字节范围请求（304 无正文，206 为部分字节）；本地静态图片缓存一天。原生图片组件可用部署源解析返回 URL 并复用 HTTP 缓存。SDK 的 getWallpaperImage 操作通过 /api/v1 别名读取 ArrayBuffer，保留缓存头；SDK 普通请求设置 cache:no-store；公开图片携带 If-None-Match 或 If-Modified-Since 时改用 cache:no-cache 重新验证，避免 Fetch 自动添加的 no-cache 请求头令服务端跳过条件匹配。调用方仍应保存与 ETag 对应的图片字节。两项壁纸操作均不读取或发送 Bearer 和所选墙上下文。

SDK 的操作调用可在第二个参数中传入 `headers`，仅接受该操作在 OpenAPI 中声明的请求头，名称不区分大小写。例如：

~~~js
const image = await api.operations.getWallpaperImage(
  { path: { file: wallpaper.data.file } },
  { headers: { 'If-None-Match': cachedEtag } },
);
if (image.status === 304) {
  // image.data 为 null；继续使用与 cachedEtag 对应的本地缓存字节。
} else {
  // 200/206 的 image.data 为 ArrayBuffer；可读取 image.headers 中的缓存/范围信息。
}
~~~

`Range`、`If-Modified-Since` 也通过同一方式传入。304 仅在二进制条件请求中作为正常缓存命中返回，不会改变普通 JSON 接口的错误处理。`Authorization`、`X-Wall-Id` 仍由 SDK 的凭证与 `wallId` 上下文管理，不能用自定义请求头覆盖。

## 分页、私聊历史、搜索与引用

- 帖子/投票：page 默认 1，上限 1,000,000；limit 默认 20，范围 1–50。严格正整数，数组/对象/小数/超安全整数均无效。列表 total 是实际总数。帖子 sort 只允许 latest/hot。
- 帖子搜索：q 为空、空白或单字时为 200 空结果；2–50 字符进行墙内字面搜索；最多 50 条。此端点 total 是返回数量，hasMore 表示还有匹配，不能作为全量搜索总数。
- 评论：comments_page 默认 1、comments_limit 默认 50，上限 100。响应保留 comments 数组，另含 comments_total/comments_page/comments_limit；created_at ASC、id ASC。未加载全部时新增/删除评论应重载首屏，防止 offset 变化导致遗漏或重复。
- 会话：GET /messages/conversations?limit=30&before=...，limit 上限 100。按当前用户可见的最后消息 ID 降序；next_before_id 用于下一页。只有非匿名私聊会话，返回 can_send、unread_count、other_user.available。
- 历史：GET /messages/conversation/{userId}?limit=100，limit 上限 200。初次返回最新一页，页内总按消息 ID 升序。
- before 拉更早消息；after 拉更晚新增消息；around_id 定位一个可见的同会话锚点。三者互斥；引用不属于当前双方或对本人已隐藏时，around_id 返回 404。
- q 是 1–100 字符的字面搜索，可与 before 结合，不能与 after/around_id 结合；查询中的 %, _、反斜杠按字面匹配。
- mark_read 只接受字符串/查询值 0 或 1，默认 1：GET 历史会将**本次返回**且由本人接收的可见消息标为已读。搜索预览、定位预览可显式传 0。
- 历史响应包含 messages、hasMore、hasMoreBefore、hasMoreAfter、next_before_id、next_after_id、next_before、unreadMarked。游标不是任意用户消息的访问令牌。

显示引用应优先用 reply_to.available/content/sender_nickname/reason。兼容字段 reply_to_content 仍存在，但必须跟随实时可见性，不能把客户端缓存当作访问许可。私聊发送对象必须是好友或共享有效墙的成员、账号可用且双方无拉黑；引用还要求原消息可见、同双方/类型/墙、非匿名、未撤回。表白信同样遵循对应墙授权。

树洞专用 GET /messages/tree-hole/{conversationId} 现在可选传 limit（1–200）与 before、mark_read（0/1，默认 1），before 必须伴随 limit；不支持 after、around_id、q。移动端应显式传 limit 防止加载整个会话。省略 limit 保留旧全历史契约。返回 messages、conversation_id、hasMore、next_before_id/next_before、unreadMarked、is_closed、is_initiator、other_user_id:null、can_report:true；依旧执行匿名授权，不暴露对方用户 ID，也不加入普通私聊引用能力。

after 仅是新增消息游标，**不是变更日志**：旧消息撤回、已读状态、引用可用性和单侧隐藏可能改变既有记录，客户端应在重新进入/恢复前台或必要时重取最近窗口。当前没有 WebSocket、后台推送、全量同步 token 或新增的已读回执事件流。

## 幂等发送与失败重试

POST /messages 接受 client_message_id，长度 1–128，ASCII [A-Za-z0-9._:-]。同一发送者、同 cid、同一归一化 payload 返回原 id，并令 deduplicated=true。不同 payload 返回 409 CLIENT_MESSAGE_CONFLICT；原消息被本人隐藏或撤回返回 409 CLIENT_MESSAGE_UNAVAILABLE。旧调用不传 cid 的行为保留，但不具备安全重放保证。

SDK 总会为 sendMessage 提供 cid：调用方可传入，也可使用安全随机生成。建议**发送前** prepareMessage 并在本地待发队列中保存完整准备对象；失败后由 UI 决定再次发送同一对象。cid 覆盖范围是认证账号，不可跨账号复用待发任务。不要在超时后换新 cid，否则可能发出第二条消息。

~~~js
import { createMobileClient, ApiError } from './sdk/mobile-client.mjs';

let token = null;             // 从本应用的安全存储加载；SDK 不代存
let selectedWallId = null;    // 用户明确选择的墙
const api = createMobileClient({
  baseURL: configuredOrigin + '/api/v1',
  fetch: globalThis.fetch,
  getToken: () => token,
  getWallId: () => selectedWallId,
  timeoutMs: 15000,
});

const login = await api.login({ username: enteredUsername, password: enteredPassword });
token = login.data.token;     // 应用负责持久化到安全存储，勿打印 token
const me = await api.getMe();
const prefs = await api.getPreferences();
const prepared = api.prepareMessage({ receiver_id: chosenPeerId, content: draftText });

try {
  const sent = await api.sendMessage(prepared);
  // sent.data.id / sent.data.deduplicated / sent.clientMessageId
  // 仅在确认成功后移除待发队列中的 prepared
} catch (error) {
  if (error instanceof ApiError) {
    // error.status / code / details / requestId / retryAfter / clientMessageId
    // 保留 prepared；让用户决定何时用同一对象重试，勿立即循环发送
  } else {
    throw error;
  }
}
~~~

所有成功 SDK 方法保留 {data,error:null,meta,status,headers} 外形；普通 JSON 操作的 data 是业务值，getOpenApi 的 data 是原始规范对象，exportOwnData、备份下载和 getWallpaperImage 的 data 是 ArrayBuffer。原始成功响应的 meta 由实际响应头合成，缺失的 requestId 保持为空，不伪造服务端包络。sendMessage 另返回 clientMessageId。它不自动重试任何请求，不自动登录、刷新 token、换墙或写浏览器存储。HTTP 失败、协议失败和网络失败均抛 ApiError；网络/本地失败 status=0，HTTP 错误保留真实 status。NETWORK_ERROR、TIMEOUT、ABORTED 不代表服务器一定未提交。sendMessage 的 ApiError.clientMessageId 可关联待发记录；业务错误 409 不应自动换 ID。

AbortSignal 和 timeoutMs 覆盖 token/wall 回调、fetch 和响应解析；0 可禁用定时器。已取消的请求不发送。SDK 通过 redirect:error 避免自动跨站重定向携带认证信息，credentials:omit 不依赖 Cookie。通用 request() 只接受版本前缀下的相对路径，不接受任意外域 URL 或路径穿越。运行时需提供标准 fetch、Headers/Response、AbortController、URL/URLSearchParams 与安全 crypto；可注入 fetch 和 crypto，不提供不安全随机回退。

TypeScript 的 NodeNext/Bundler 消费 .mjs 时，会通过 [mobile-client.d.mts](../sdk/mobile-client.d.mts) 转到完整 .d.ts；不需要增加项目依赖。已有易用方法继续保持原签名；新增 API 使用静态 operationId 注册表，由 callOperation 校验路径参数及允许的 query 键。操作默认继承规范的 Bearer 策略，X-Wall-Id 仅在该操作接受墙上下文时使用。不要通过通用 request<T>() 访问内部 Dashboard 或自行拼接未知路径。

## 时间、图片与部署约束

旧 created_at、last_time 等保持 SQLite 的服务器本地墙上时间，例如 YYYY-MM-DD HH:mm:ss，**没有时区偏移**。v1 为兼容旧客户端不把这些字符串静默改成 UTC。移动端不能直接追加 Z；若需要准确跨时区换算，部署方必须提供明确服务器时区配置，否则只按原始墙上时间显示。排序/增量同步应使用 ID 游标，不要猜测时间偏移。

新投票 end_at 以 UTC ISO 字符串存储；提交时优先 new Date(localSelection).toISOString() 或带偏移的 RFC3339。空/省略表示无截止；非法日期、过往或等于当前时刻的截止时间拒绝。兼容输入 datetime-local 会按**服务器本地时区**理解，不推荐原生客户端使用。撤回窗口由服务器判断，不要以客户端时钟作为授权依据。

上传接口是 JSON data URL，不是 multipart：支持 JPEG/PNG/GIF/WebP，普通/私密图片解码后最多 2 MiB，头像最多 500 KiB；服务器校验并重新编码。私密证据先上传 /upload/bug-image，使用本人 bug_{uid}_... 路径，不能引用他人私密文件或将任意公开图升级为新证据。已鉴权举报/反馈列表的 images 仍是 JSON 字符串，解析后才是 URL 数组。

私密图片 ticket 有效期 5 分钟；证据 API 及私密图片使用 no-store，不要把完整 URL 写日志、公开分享或长期缓存。过期后重读本人/有处理权限的记录取得新 URL；静态签名不是任意图片访问权。账号 token_version 变化或失效会使关联票据不可用。公开帖子图片和头像仍按原公开规则访问。

生产必须使用 HTTPS，避免明文 bearer/password。浏览器/WebView 跨源调用只允许部署明确配置的 CORS 源；v1 不放宽 CORS，不新增 Cookie 会话。原生 HTTP 客户端虽不受浏览器 CORS 机制约束，仍必须满足服务器认证、IP 守卫、墙成员身份及权限。不要使用外部图片代理/日志平台传输证据或完整 token。

## 契约维护与当前限制

完整 SDK 操作目录由 `node sdk/generate-v1-operations.cjs` 从规范生成；`--check` 只检查版本一致性，不写入文件。当前规范覆盖 155 个操作，其中 144 个提供公共 SDK 目录入口，11 个看板票据或内部操作明确排除。测试源码、类型检查夹具与临时验收数据已清理。

当前限制：无 token refresh、离线冲突合并、后台推送、WebSocket 或设备管理；历史本地时间缺少 offset；after 不包含既有消息的变更事件；朋友列表及墙列表仍是原有数组而不是统一分页；帖子搜索 total 是截断数量。调用方应按 capabilities/真实端点工作，不将文档或 SDK 视为未来功能承诺。
