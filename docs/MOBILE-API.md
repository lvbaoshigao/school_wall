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

上例 prefs 仅演示包络位置；实际偏好接口返回完整 41 项。失败 JSON：

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

JWT 目前有效期为 7 天，但修改密码、封禁、账号删除等会提前失效。PUT /auth/password 使用 {oldPassword,newPassword}，返回新 token 并使旧 token_version 失效。网页新增 POST /auth/refresh（Cookie 恢复）与 POST /auth/logout（清除 Cookie），普通业务接口仍仅使用 Bearer。SDK 不存储 token，不使用 localStorage，不自动接受登录/改密返回的 token；调用方应将其写入平台安全存储并更新 getToken() 的来源。

网页登录、注册、正式初始化和改密成功时，服务器写入 sw_session：HttpOnly、SameSite=Lax、Path=/api、host-only、固定 30 天，HTTPS 下设置 Secure。Cookie 使用独立 aud=school-wall-session，不能直接充当普通 API Bearer。POST /auth/refresh 返回 {token}（v1 放在 data 中），新令牌最多有效 7 天且不超过原 Cookie 到期时间；它不轮换或延长 Cookie。恢复时重新核对账号、用户名、token_version 和状态；封禁账号取得的令牌仍受全部业务封禁守卫限制，仅保留申诉能力。POST /auth/logout 无需有效 Bearer，删除 Cookie；网页同步清除本地会话并记录退出状态。上述两接口强制 X-Requested-With: school-wall，携带 Origin 时必须同源或在明确配置的允许来源内；登录、注册、初始化也必须使用 application/json 并通过来源检查。Cookie 缺失、损坏、到期或凭据已撤销为 401，CSRF 检查失败为 403。一次性测试不设置持久 Cookie。这两个网页会话操作不纳入使用 credentials:omit 的移动 SDK 目录。

帖子、评论、投票等墙内资源使用 X-Wall-Id。只返回当前有效成员可见的该墙数据；管理员也按现有权限集检查。不要把墙 ID 当作访问授权。路径墙 ID 与头、query 或 body 的墙上下文不能冲突。私聊不依赖当前墙头来扩大历史可见范围；发送表白信必须显式选择双方均为有效成员的墙。表白统计、收信列表和身份申请列表接受可选 wall_id 或 X-Wall-Id；都省略时仅合并本人当前所有有效墙，多个来源必须一致，显式指定墙仍要求本人是有效成员。SDK 默认继承当前所选墙；需要本人跨墙汇总时显式传 requestOptions.wallId=null。

匿名帖子/投票的公共响应中 author_id、昵称等为 null，IP 哈希不外发。收到的匿名表白信隐藏发送者身份；不要从引用、会话卡片或旧预览反推。树洞继续沿用已有专用接口和匿名身份规则，本 SDK 不把树洞映射成普通私聊，也不承诺树洞引用能力。

DELETE /messages/{id} 和 DELETE /messages/chat/{userId} 都是**单侧隐藏**：只影响当前账号视图，另一方仍可见。PUT /messages/{id}/revoke 才是发送方在服务器判定的 5 分钟内对双方撤回。引用预览依当前用户可见性动态生成，原消息不可见/撤回后不得显示缓存的敏感预览。

## 全量覆盖与调用边界

本规范覆盖真实 Express 注册的 **171 个显式方法/路径组合、156 个路径模板**：159 个 /api 注册（包括仅在 /api/v1 暴露的三个发现入口）和 12 个 /dashboard/api 内部注册。按参数名 :id → {id} 正规化后，与隔离真实 index 实例枚举的双向差集均为空，双方均无重复。旧 52 个 operationId 保持原名；其余 119 个操作包含新增的公开壁纸图片、本人账户统计、管理概览、永久删除校园墙及看板内部读取/导出接口，既有鉴权与内部操作排除策略保持一致。

| 范围 | 操作数 | 鉴权与用途 |
| --- | ---: | --- |
| 普通族及有权限的墙内操作 | 120 | 对应公开入口、Bearer、有效墙成员身份及各操作权限；详细字段见规范 |
| 管理族、建墙审核及看板票据入口 | 39 | 管理操作仍要求对应 global 或 wall 权限；票据入口要求 global.dashboard |
| /dashboard/api 内部操作 | 12 | 原有端点接受看板票据或 Cookie，新增概览/导出仅 Cookie 同源；Cookie 写操作另需 CSRF；不由公共移动客户端调用 |

公共 SDK 操作目录覆盖 **156 个**标准 API 操作，使用 callOperation(operationId, {path, query, body, wallId}, requestOptions)；已有易用方法继续保留。网页 Cookie 票据入口 /dashboard/session（实际 /api/v1/dashboard/session）、网页 /auth/refresh、/auth/logout 和 12 个看板内部操作有明确排除策略；目录化调用没有任意路径或 opt-in 开关。低层 request<T>() 保持既有兼容能力，不是服务端授权边界；不要用它替代网页的 Cookie/CSRF 流程。目录完整也不表示账号有相应权限，服务器仍实时裁定。

OpenAPI 顶层 servers 是 /api/v1；除 x-versioned-only 标记的 /、/capabilities、/openapi.json 外，标准 /api 路径可通过旧 /api 前缀使用。旧 /api 本身不是能力发现入口。内部操作逐项 servers: [{url:"/"}]，最终路径严格为同一部署源上的 /dashboard/api/...，不能把它们拼到 /api/v1 下，也不能把根服务器地址当作任意外域授权。

静态文件（/uploads、/rele 等）、站点页面和 SPA 路由不计 API。GET 的隐式 HEAD 行为由 Express 或发现路由提供：响应头遵循 GET，响应无正文；它们不另计为新业务操作。允许源的浏览器 CORS 预检 OPTIONS 由全局 CORS 中间件处理，不代表绕过 Bearer、Cookie、IP 白名单或操作权限，也不增加任意跨源访问许可。发现入口的其他方法返回 405。

### 同源看板与管理安全边界

取得看板票据：携带普通 Bearer 调 POST /api/v1/dashboard/session，要求 global.dashboard。服务器种入 sw_dash HttpOnly、SameSite=Strict、Path=/dashboard、有效期一小时的 Cookie；HTTPS 请求另带 Secure。此响应仍为 v1 JSON 包络，不返回 Cookie 中的票据值。禁止把票据放进 query 或公开日志。

/dashboard/api/... 是内部原始 JSON/二进制 API，成功和错误均不使用 v1 包络。Cookie 认证的写操作要求 X-Dashboard-Csrf 与票据内 CSRF 值匹配；若请求带 Origin，还必须匹配服务器所见 protocol://host 的同源 origin。既有数据库管理与 /dashboard/api/token 端点继续接受 aud=dashboard 票据的 Bearer 作为脚本认证替代；普通账号 JWT 不能直接冒充看板票据。新增 /dashboard/api/overview 与 /dashboard/api/export 是 Cookie-only 例外，不能使用 Bearer-only 替代。所有内部操作要求 global.dashboard；数据库管理还要求 global.db.manage，并经过既有管理面 IP 守卫。

这两个新增 GET 必须携带有效 sw_dash Cookie；仅带普通 JWT 或 aud=dashboard Bearer 票据均返回401。Origin 存在时必须同源；Sec-Fetch-Site 存在时仅允许 same-origin 或 none，same-site/cross-site 返回403。它们是只读 GET，无需 CSRF 请求头，响应（包括错误）均为 no-store，路径在部署源根目录，不在 /api/v1 下，也不进入公共 SDK。

| 内部方法与路径 | 参数、响应和额外权限 |
| --- | --- |
| GET /dashboard/api/overview | days=7/30/90（默认7）、wall_id 可选；复用 AdminOverview 字段、逐墙权限、null、时间与500墙限制，直接返回原始对象，不加 data/error/meta 包络；错误为 {error,code?} |
| GET /dashboard/api/export | 必传 type=users/posts/announcements；成功返回 text/csv; charset=utf-8 附件；users 另需 global.user.manage，posts 另需 global.moderate，announcements 另需 global.announcement；未知/缺失 type 为400，匹配超过10000行为413，不返回部分导出 |

CSV 导出支持与看板相同的当前筛选：users 使用 user_q（用户名/昵称）、user_role（user/admin/super_admin）、user_status（active/banned）；posts 使用 post_q（正文/分类）；全局 announcements 使用 announcement_q（标题）。文本筛选去首尾空白后截到100字符，以字面子串匹配，SQL 通配符不会扩大匹配；非字符串文本筛选及未知角色/状态值被忽略。其他数据集的筛选无效，不支持分页参数或调用方自定上限。users/posts 按创建时间降序，全局公告按置顶、创建时间降序。

CSV 使用 UTF-8 BOM、CRLF、单元格引号转义及公式前缀防护，文件名固定为 users.csv、posts.csv 或 announcements.csv。用户导出仅在 show_real_name=1 时写入已公开真实姓名，否则该列为空；帖子作者只给显示名，匿名作者仍为“匿名”，不导出作者ID。导出不包含私信、IP、未公开姓名或匿名身份归属；下载结果应按管理数据妥善保管。

公共移动 SDK 始终拒绝内部端点和看板票据代理，不提供绕过开关。确需维护看板的受控客户端必须先确认选定 HTTPS 部署 origin，以该 origin 解析根路径，单独管理看板 Cookie/票据与 CSRF，核对 operation.security、x-required-permissions 和响应类型；不得沿用公共调用的普通 Bearer、X-Wall-Id 或跨源目标。本文仅记录既有接口，不新增权限、公开票据或放宽 Origin/CORS。

## 核心端点与界限

以下路径均相对 /api/v1。OpenAPI 列出具体请求/响应字段、状态和参数。

| 资源 | 真实端点与说明 |
| --- | --- |
| 账号 | POST /auth/login；GET /auth/me、/auth/statistics；PUT /auth/profile；PUT /auth/password |
| 偏好 | GET /auth/prefs；PUT /auth/prefs；GET /auth/prefs/schema；POST /auth/prefs/reset |
| 墙 | GET /walls、/walls/discover、/walls/{id}；POST /walls/{id}/join、/leave |
| 永久删墙 | GET /walls/admin/{id}/deletion-preview；DELETE /walls/admin/{id}；仅 global.wall.manage，见下节 |
| 帖子 | GET/POST /posts；GET /posts/search；GET/DELETE /posts/{id} |
| 评论 | POST /posts/{id}/comments；DELETE /posts/{postId}/comments/{commentId} |
| 私聊 | GET /messages/conversations；GET /messages/conversation/{userId}；POST /messages |
| 消息操作 | PUT /messages/read-batch、/read-all、/{id}/read、/{id}/revoke；DELETE /messages/{id}、/messages/chat/{userId} |
| 好友 | GET /friends、/friends/pending；POST /friends/add、/block、/unblock；PUT /friends/{id}/respond；DELETE /friends/{id} |
| 投票 | GET/POST /votes；GET/DELETE /votes/{id}；POST /votes/{id}/vote |
| 上传 | POST /upload/image、/upload/bug-image；PUT /avatar/upload |
| 壁纸 | GET /wallpaper?source=bing&idx=0；GET /wallpaper/image/{file} 返回缓存 JPEG |
| 管理概览 | GET /admin/overview；days 为7、30或90，wall_id 可选；按有效权限汇总，见下节 |

普通 JSON 请求体上限 128 KiB；图片上传 JSON 上限 5 MiB。消息最多 2000 字符，标题 100；表白信和 Markdown 帖子保留开头缩进，仅去除末尾空白；普通文本帖子和私聊仍去除首尾空白。帖子正文 2000；评论 500；投票标题 100、描述 500，2–10 个非空且去空格后不同的选项，每项 50 字符。密码上限是 1024 **UTF-8 字节**，新密码至少 6 字符；用户名 3–20 字符且不能带首尾空白/控制字符。资料字段具体上限见 OpenAPI，不传字段表示保留，不要将本地整份陈旧 profile 覆盖回服务器。

## 永久删除校园墙

GET /api/v1/walls/admin/{id}/deletion-preview（操作名 adminGetWallDeletionPreview）预览删除影响，DELETE /api/v1/walls/admin/{id}（操作名 adminDeleteWall）执行永久删除；旧 /api/walls/admin/{id}/deletion-preview 与 DELETE /api/walls/admin/{id} 复用同一路由及业务逻辑。旧 /api 成功直接返回下述业务对象，v1 将它放入 data，并保留 error:null 与 meta 包络。

两个操作均使用普通 Bearer，要求当前操作者具有有效 global.wall.manage。无需选择当前墙、无需目标墙成员身份；目标只由路径 id 指定，不由 X-Wall-Id、当前所选墙或墙主身份授权。id 必须为严格正安全整数。本路由响应（包括错误）使用 Cache-Control: no-store。

预览 data 为 {wall:{id,name,description,status,owner_id,created_at},counts,warnings:[string],can_delete:true}。owner_id 可为 null；created_at 沿用服务端本地时间字符串，不自动追加 UTC 偏移。can_delete 为 true 仅表示授权操作者取得当前预览；预览不锁定数据，也不替代删除时的再次校验。

DELETE 必须提交 JSON 对象 {confirm_name,password}，两个字段均必填。confirm_name 必须与目标墙**当前完整名称精确相同**，不去空白、不忽略大小写、不作 Unicode 归一化；password 必须是**当前操作者的现密码**。不要将密码、完整请求体或预览保存在日志、离线队列或持久缓存中。成功 data 为 {message,deleted_wall_id,counts,warnings:[string]}。

预览和删除结果均完整包含以下19个 counts 字段，全部为非负整数，无记录为0；它们描述目标墙的记录和附件候选，不是全站账号统计。本版全部候选附件保留，deletable_attachments 恒为0，retained_attachments=attachments；附件计数不表示已删除磁盘文件。

| counts 字段 | 范围 |
| --- | --- |
| members | 目标墙成员记录 |
| wall_applications | 与目标墙关联的建墙申请 |
| ban_logs | 目标墙封禁日志 |
| posts | 目标墙帖子 |
| comments | 目标墙相关评论 |
| likes | 目标墙相关点赞 |
| bookmarks | 目标墙相关收藏 |
| messages | 归属于目标墙的消息 |
| announcements | 目标墙公告 |
| votes | 目标墙投票 |
| vote_options | 目标墙相关投票选项 |
| vote_records | 目标墙相关投票记录 |
| reports | 目标墙安全举报 |
| post_reports | 目标墙帖子举报 |
| user_reports | 目标墙用户举报 |
| user_permissions | 目标墙范围内的权限记录 |
| attachments | 目标墙关联的附件候选 |
| deletable_attachments | 本版恒为0，不执行物理文件删除 |
| retained_attachments | 本版保留全部候选，恒等于 attachments |

数据库内目标墙及其所属记录在**单一事务**内删除；任何数据库故障均全回滚。事务内预检若发现投票记录与选项归属不一致（其他墙的 vote_records.option_id 指向待删墙的 vote_options，或本墙记录指向其他投票、失效选项），会拒绝删除并返回409 WALL_REFERENCE_CONFLICT，全量回滚、保留全部数据，不执行附件清理。用户/账号、账号偏好、全局数据和其他墙的数据不会被删除。允许删除最后一面墙，但不会重置 setup/首次设置状态。**本版删墙仅清数据库，全部候选附件保留，不执行物理 unlink，也不在提交后删除磁盘文件。** 现有上传未记录墙归属，编码或文本引用不能完备证明附件专属，不能据此安全删除文件。warnings 说明附件保留及独立存储清理仍需重新核对引用，应展示给操作者；成功响应只确认数据库删除已提交，不表示磁盘文件已删除。

| HTTP | code | 处理 |
| --- | --- | --- |
| 400 | INVALID_WALL_ID | 修正路径 id |
| 400 | INVALID_CONFIRMATION | 补齐确认字段，重新核对目标墙当前精确名称 |
| 403 | PASSWORD_INVALID | 由操作者重新输入现密码 |
| 403 | PERMISSION_DENIED | 当前账号缺少 global.wall.manage，不能靠换墙重试 |
| 404 | WALL_NOT_FOUND | 目标墙不存在，刷新管理列表 |
| 409 | WALL_REFERENCE_CONFLICT | 异常跨墙投票引用阻止删除；全部数据保留，先修复引用，再由操作者决定是否重试 |

401、413、429及500仍遵循通用响应规则。SDK 通过已支持的 operations/callOperation 入口调用；无需新增便捷方法。它不读取 getWallId()，即使提供 params.wallId 或 requestOptions.wallId，也不为这两个操作发送 X-Wall-Id。通用入口校验路径 id、允许的 query 键和 JSON 对象正文是否存在；字段内容、精确墙名、现密码及实时权限均由服务端校验。

~~~js
const preview = await api.operations.adminGetWallDeletionPreview({ path: { id: targetWallId } });
// 展示 preview.data.wall、counts 和 warnings；由操作者输入完整墙名及现密码并确认。
const deleted = await api.callOperation('adminDeleteWall', {
  path: { id: targetWallId },
  body: { confirm_name: enteredWallName, password: enteredCurrentPassword },
});
// 展示 deleted.data.warnings，并刷新墙列表及当前界面状态。
~~~

**不得自动重试破坏性 DELETE。** SDK 本身不自动重试；网络中断、TIMEOUT、ABORTED 或网关错误不代表服务端未提交。前端会清除旧预览、确认信息和密码，提示结果未确认，要求先重新读取管理列表或预览确认服务器状态，再由操作者重新确认后决定后续动作；不要复用密码请求做后台循环重放。

## 本人账户统计

GET /auth/statistics（操作名 getAccountStatistics）需要 Bearer，仅返回当前登录账号的全局账户概览。无需加入墙；X-Wall-Id 不影响 counts，不能用切换墙头查询其他范围。它不是全站统计，也不同于本人收到的表白信统计。传入任何 user_id 查询参数（包括本人 ID、空值或数组）均返回400；不提供查询他人统计的路径。响应使用 Cache-Control: no-store。

旧 /api 返回以下对象；/api/v1 将它放在 data 中：

~~~json
{"registered_at":"2024-03-02 13:14:15","counts":{"walls_joined":2,"friends":3,"named_posts":4,"comments":5,"bookmarks":6,"votes_participated":7}}
~~~

registered_at 原样来自 users.created_at，历史缺失为 null；通常是服务端本地时间 YYYY-MM-DD HH:mm:ss，无时区后缀，不能擅自追加 Z 当作 UTC。joined_days 由前端依据注册日期计算，不在响应中。所有计数总是非负整数，无记录返回0。

| counts 字段 | 统计口径 |
| --- | --- |
| walls_joined | 本人已加入且墙与成员状态都为 active 的不同墙数；待审、被封、停用或已不存在的墙不计 |
| friends | accepted 关系中仍存在的不同对端账号数，不额外限制对端账号状态；正反重复合并，自关联、孤儿关系、pending、blocked 行不计 |
| named_posts | author_id 为本人且 is_anonymous=0 的实名发帖数；author_id 为 null 或历史保留 author_id 的匿名贴均不计，不按 IP/正文追溯归属 |
| comments | author_id 为本人的评论数 |
| bookmarks | 本人收藏且帖子仍存在的不同帖子数 |
| votes_participated | 本人参与且投票仍存在的不同 vote_id 数；历史重复记录只计一次 |

除加入墙数的有效成员条件外，活动计数是本人跨墙汇总，不随当前墙或成员退出改变查询范围；删除的资源及对应无效收藏/投票参与不计。接口只返回注册时间和上述计数，不返回内容、匿名归属、对端身份或其他账号数据。SDK 提供 getAccountStatistics(options)，并支持 operations.getAccountStatistics() / callOperation('getAccountStatistics')；三种入口都省略当前墙头，不读取 getWallId()，不接受 user_id 查询。

## 管理概览

GET /admin/overview（操作名 adminGetOverview）使用普通 Bearer；完整路径是 GET /api/v1/admin/overview，旧 GET /api/admin/overview 返回同一业务对象，v1 将其放入 data。接口只读，支持隐式 HEAD；其他方法在认证后返回405 OVERVIEW_METHOD_NOT_ALLOWED，并带 Allow: GET, HEAD。本路由响应（包括错误）使用 Cache-Control: no-store；不接受看板 Cookie 代替账号 Bearer，也不返回看板票据。

查询参数 days 仅接受7、30、90，默认7；wall_id 可选，必须是严格正安全整数。重复/数组/对象、小数或非法范围返回400。省略 wall_id 表示全局概览，**X-Wall-Id 单独出现会被忽略**，不会按当前所选墙缩小范围；显式 wall_id 与同时提供的 X-Wall-Id 必须一致，否则400 OVERVIEW_WALL_CONFLICT。公共 SDK 只通过 query.wall_id 选择范围，不读取或发送当前墙头。

全局入口要求 global.moderate 或 global.dashboard；单墙入口要求该墙为 active，且拥有有效成员身份（含已到期墙内封禁）或 global.moderate，同时必须具有该墙的有效 wall.stats.view。每个汇总候选墙仍独立检查 wall.stats.view，显式 deny 不因全局入口权限而失效；单有 global.dashboard 不能看无成员身份的其他墙。已删除的墙不计；disabled 墙只可能由 global.moderate 在未筛墙的全局概览中统计，显式筛选停用/不存在墙返回404。权限在每次请求重新计算，不以角色名称或客户端界面代替授权。

响应 schema_version 固定为1，顶层字段如下；精确结构见 OpenAPI 的 AdminOverview 及其组件：

| 字段 | 语义与边界 |
| --- | --- |
| generated_at | 生成快照的 UTC ISO 时间；其余日期分桶按下面的服务器本地日历口径 |
| scope | kind=global/wall、wall_id=null/显式ID、available_wall_count=完整授权墙数；global_stats 表示是否可看全局账号计数 |
| range | days、start_date/end_date（含两端）、timezone（当前 IANA 时区）、utc_offset_minutes（当前偏移）、date_basis=server-local、includes_today=true、timestamp_storage=local-naive |
| totals | 当前仍存记录的全量计数：users、active_users、banned_users、walls、active_walls、members、posts、anonymous_posts、comments、votes、likes、announcements、pending；不受 daily 窗口或列表截断影响 |
| today / daily | users、posts、comments、votes、members；daily 另有 date，按日期正序且补齐无活动日，恰有 range.days 行；today 对应最后一天 |
| walls / walls_meta | 墙行含 id/name/status、members、pending_members、posts/comments/votes、posts_in_range、pending_post_reports、pending_safety_reports；name 最多200字符；按窗口帖子数降序、全部帖子数降序、ID升序，最多100行；元数据含 limit=100、完整 total 与 truncated |
| pending | members、wall_applications、post_reports、safety_reports、user_reports、bug_reports 及 total；total 只加总已授权类别，等于 totals.pending |
| todos / todos_meta | 仅为已授权且 count>0 的队列生成 {key,title,count,wall_id,permission}；按 count 降序、key、wall_id 升序，最多30行；元数据含 limit=30、完整行数 total 与 truncated，total 不是事项数之和 |
| system | 无 global.dashboard 时为 null；有权限时返回 uptime_seconds、memory 的 rss_bytes/heap_used_bytes/heap_total_bytes、database 的 engine=sql.js/dirty/temporary、visits 摘要；筛单墙也不改变此权限要求 |

**null 表示无权限、不可用或不适用，0 才表示有权查看但为空。** 全局账号计数仅在未传 wall_id 且有 global.moderate 或 global.user.manage 时可用（入口权限仍须满足），否则 totals 的三个账号字段与 today/daily.users 都为 null。members 统计 active 成员关系行，不是跨墙去重人数；daily.members 使用这些当前仍 active 的关系原创建日期。likes 数实际点赞关系，announcements 只计墙公告。匿名字段仅有总数，不返回作者归属；响应不包含私信正文、举报详情、真实姓名、用户/IP标识或配置秘密。

| pending / todo.key | 额外所需权限与统计口径 |
| --- | --- |
| members | wall.member.approve；只计可统计墙的 pending 成员 |
| wall_applications | global.wall.approve；仅全局模式可用，只计 pending 建墙申请 |
| post_reports | wall.post.report；只计可统计墙的 pending 帖子举报 |
| safety_reports | global.safety.handle 或该墙 wall.safety.report；只计可统计墙的 pending、processing 安全举报 |
| user_reports | global.report.handle；全局模式为全部 pending 用户举报，单墙模式仅指定墙 |
| bug_reports | global.bug.handle；仅全局模式可用，计 pending、processing 反馈 |

以上权限独立于 wall.stats.view。某墙待办必须先满足该墙统计可见性；没有任何可授权墙的墙类别为 null。members、post_reports、safety_reports 待办逐墙给出 wall_id，安全队列 permission 优先使用已授予的 global.safety.handle；user_reports 为筛选墙ID或全局 null；建墙与 Bug 待办 wall_id 恒为 null。title 是展示文案，业务判断使用 key 与 permission，执行处理仍须调用原业务端点并重新鉴权。

窗口包含今天，按服务器本地日历做日期运算，夏令时日不假定恒为24小时。SQLite 历史 created_at 没有时区后缀，按原样分组，不能追加 Z 改成 UTC。timezone/utc_offset_minutes 只描述当前运行环境，不能重建历史服务器时区变更。计数是现存记录快照，删除资源、成员状态变更会改变过去日的值，不能当作不可变审计事件或严格新增人数。

候选墙在**逐墙权限筛选前**最多500个，超过即400 OVERVIEW_SCOPE_TOO_LARGE，不返回部分合计；客户端应显式传 wall_id 缩小范围。100行 walls 和30行 todos 只是展示截断，totals、pending 与 daily 仍覆盖完整授权范围，不能只把返回行相加当合计。visits 是滚动60分钟、当前进程内的近似计数（scope=process、reset_on_restart=true、visitor_definition=authenticated-user-or-guest-ip、identity_limit=50000、bounded=true、traffic=tracked-api-requests），重启清空、达到容量可能少计，不代表独立自然人、页面浏览量或全站持久访问审计。

校验错误 code 包含 INVALID_OVERVIEW_DAYS、INVALID_OVERVIEW_WALL、OVERVIEW_WALL_CONFLICT、OVERVIEW_SCOPE_TOO_LARGE；无登录/失效账号为401，权限/不可用账号为403（OVERVIEW_FORBIDDEN、OVERVIEW_ACCOUNT_UNAVAILABLE、OVERVIEW_WALL_FORBIDDEN），墙不存在或停用为404 OVERVIEW_WALL_UNAVAILABLE。数据库异常返回500且不暴露内部细节。SDK 按原样保留业务 code 与 requestId；days 枚举和 wall_id 范围最终由服务器验证，不把 SDK 参数检查当成授权。

~~~js
const all = await api.operations.adminGetOverview({ query: { days: 30 } });
const wall = await api.callOperation('adminGetOverview', { query: { days: 7, wall_id: selectedWallId } });
// 展示时保留 null 与 0 的区别，并检查 walls_meta/todos_meta.truncated。
~~~

## 表白信、线程与身份申请

以下路径均相对 /api/v1；所有请求需要 Bearer。新操作复用旧 /api 路由和原有 v1 包络，未新增一套认证或权限。POST /messages 的 type=confession 继续接受原有标题、正文、匿名标记、墙上下文和 client_message_id，新增 allow_replies:boolean，省略默认为 false。既有 private 消息不受该开关影响。

| 方法与路径 | 请求与返回 |
| --- | --- |
| GET /messages/confessions/stats | 可选 wall_id；返回 {anonymous,named,total} |
| GET /messages/confessions/received | 可选 wall_id、page（默认1）、limit（默认20，最大100）、anonymous（all/1/0）；返回 {messages,total,page,limit,hasMore} |
| POST /messages/confessions/direct | {receiver_id,wall_id?,client_message_id?}，必须有墙上下文；返回现有发送确认 |
| GET /messages/confessions/{id}/thread | 可选 wall_id、before、limit（默认50，最大100）；返回 {confession,messages,hasMore,next_before_id} |
| POST /messages/confessions/{id}/replies | {content,client_message_id?,wall_id?}；返回现有发送确认 |
| POST /messages/confessions/{id}/identity-requests | {confirmed:true,message?,wall_id?}；返回 {request} |
| GET /messages/confessions/identity-requests | 可选 wall_id、status（pending/approved/rejected）；返回 {requests}，最多检查最新500条候选后过滤权限 |
| PUT /messages/confessions/identity-requests/{requestId} | {decision:approve/reject,wall_id?}；返回 {request} |

统计与收信列表仅含本人收到的原始 letter/direct，排除回复、撤回、收件人已删除副本与不再有效的墙。线程消息在一页内按回复 ID 正序；before 读取更早回复。GET 线程不自动标记已读，继续使用 read/read-batch。读取只要求本人原信副本可见且仍是有效墙成员；保留的历史不代表当前仍可互动，原信任何一方副本删除后不再返回回复。新增回复最多2000字，保留开头的 Markdown 缩进、移除末尾空白，服务器重新核查原信双方未删除、原信未撤回、双方账号/成员身份有效且没有拉黑；allow_replies=false 时返回403。匿名原作者的回复保持匿名，收件人自己回复时 receiver_id 也可能为 null，不能从回复参与者字段反推原作者。

直接表白不支持回复，由服务器生成实名文案“xxx在此网站的表白信界面对你进行表白”。禁止伪造 content、title、is_anonymous 或 sender_id。线程回复也不允许调用方提供 receiver_id、sender_id 或 is_anonymous；参与者与匿名规则由服务器决定。

所有 confession 消息（含原收件箱、已发送列表）新增 confession_kind:letter/direct/reply、confession_root_id（原信为0、回复为原信ID）、allow_replies、can_reply、identity_request 和 revealed_sender。新增字段不会替代原消息外形；通用 Message 声明将其设为可选，专用 ConfessionMessage 声明保证其存在。界面应按当前 can_reply 显示可用动作，不能只依赖本地保存的 allow_replies。

匿名原信收件人提出身份申请前必须明确确认，并发送 confirmed:true。message 是可选的0–2000字 Markdown 说明，必须使用共享安全 Markdown 渲染入口。每封原信仅一次申请，重复申请、重复决定均返回409；仅原作者可以批准或拒绝。request={id,message_id,wall_id,status,message,created_at,decided_at,is_author,requester:{id,nickname,avatar}}；status 为 pending/approved/rejected，requester 是原收件人，不包含匿名原作者身份。

批准只为原信指定收件人提供 revealed_sender:{id,nickname,avatar}；sender_id/nickname/avatar/link 仍隐藏，拒绝不会提供身份。identity_request 是当前原信上的 {id,status,message,created_at,decided_at} 或 null。不要把身份披露数据写入公共缓存、其他账号状态或公开会话摘要。

SDK 新增 getConfessionStats、getReceivedConfessions、getConfessionThread、sendDirectConfession、replyToConfession、requestConfessionIdentity、getConfessionIdentityRequests 和 decideConfessionIdentity。prepareDirectConfession 与 prepareConfessionReply 可在请求前生成并冻结稳定 cid：先持久化准备对象，再调用发送方法；重试必须复用该对象。两个发送方法与 sendMessage 一样返回 clientMessageId，ApiError 也保留该字段。低层 callOperation/operations 仅转发调用方 body，不自动生成 cid。示例：

~~~js
const letter = api.prepareMessage({ receiver_id: peerId, type: 'confession',
  content: letterText, is_anonymous: true, allow_replies: true, wall_id: wallId });
await api.sendMessage(letter);
const direct = api.prepareDirectConfession({ receiver_id: peerId, wall_id: wallId });
await api.sendDirectConfession(direct);
const reply = api.prepareConfessionReply({ content: replyText, wall_id: wallId });
await api.replyToConfession(originalId, reply);
await api.requestConfessionIdentity(originalId, { confirmed: true, message: '**请问你是谁？**', wall_id: wallId });
~~~

## 偏好与分组重置

GET /auth/prefs 返回 {prefs,storedKeys?}；prefs 是完整合并结果。storedKeys 表示真正持久化的合法键，可区分“未存 theme_mode”与“明确选择 system”。PUT /auth/prefs 发送 {prefs:{...增量}}；为兼容旧客户端，未知键或非法值会被忽略，不会覆盖已存合法值。新界面应先读 schema 本地校验，并读取保存结果确认。

GET /auth/prefs/schema 返回 {version:1,schema,defaults,scopes}。schema 每项使用 type、default、scope，枚举另有 values。POST /auth/prefs/reset 的 body 必须恰为 {scope}，允许 all、appearance、chat、notifications、navigation、reading、publishing；额外键、未知分组或非字符串明确 400。它只重置偏好，不改 profile、账号隐私、密码或 token；局部分组不改变其他偏好。

新增共享键：

| 键 | 允许值 | 默认 |
| --- | --- | --- |
| liquid_glass | boolean；appearance 分组 | true |
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

显示引用应优先用 reply_to.available/content/sender_nickname/reason。兼容字段 reply_to_content 仍存在，但必须跟随实时可见性，不能把客户端缓存当作访问许可。私聊发送对象必须是好友或共享有效墙的成员、账号可用且双方无拉黑；引用还要求原消息可见、同双方/类型/墙、非匿名、未撤回。表白信同样遵循对应墙授权；新信默认 allow_replies=false，只有原信允许回复时才能在专用线程端点继续，不能用旧 reply_to_id 发送绕过。

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

生产必须使用 HTTPS，避免明文 bearer/password。浏览器/WebView 跨源调用只允许部署明确配置的 CORS 源；v1 不放宽 CORS；网页会话 Cookie 只用于上述恢复/退出流程，普通 API 不接受 Cookie 代替 Bearer。原生 HTTP 客户端虽不受浏览器 CORS 机制约束，仍必须满足服务器认证、IP 守卫、墙成员身份及权限。不要使用外部图片代理/日志平台传输证据或完整 token。

## 契约维护与当前限制

完整 SDK 操作目录由 `node sdk/generate-v1-operations.cjs` 从规范生成；`--check` 只检查版本一致性，不写入文件。当前规范覆盖 171 个操作，其中 156 个提供公共 SDK 目录入口，13 个看板票据或内部操作明确排除，另排除 2 个网页 Cookie 会话操作。SDK 回归测试保留在 sdk/test，可运行 node --test sdk/test/*.mjs；生成一致性检查不写文件。服务端测试使用隔离临时 DATA_DIR，运行 npm test --prefix server；网页回归运行 npm test --prefix client，构建检查运行 npm run build --prefix client。不要用真实生产数据库启动服务来代替隔离验收。

当前限制：移动 SDK 不自动刷新 token；无离线冲突合并、后台推送、WebSocket 或设备管理；历史本地时间缺少 offset；after 不包含既有消息的变更事件；朋友列表及墙列表仍是原有数组而不是统一分页；帖子搜索 total 是截断数量。调用方应按 capabilities/真实端点工作，不将文档或 SDK 视为未来功能承诺。
