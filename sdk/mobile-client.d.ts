/** IDs are positive safe integers. The API retains endpoint-specific payloads inside v1 data. */
export type Id = number | string;
export type Flag = 0 | 1;
export type MessageType = 'private' | 'confession' | 'system' | 'announcement' | 'interaction' | 'tree_hole' | 'report_notification' | 'role_application';
export type PreferenceScope = 'all' | 'appearance' | 'chat' | 'notifications' | 'navigation' | 'reading' | 'publishing';
export interface ApiMeta { apiVersion: '1'; requestId: string; }
export interface ApiResponse<T> { data: T; error: null; meta: ApiMeta; status: number; headers: Headers; }
export interface ApiErrorOptions {
  status?: number; code?: string; details?: unknown; requestId?: string | null;
  apiVersion?: string | null; retryAfter?: string | null; clientMessageId?: string | null; cause?: unknown;
}
export class ApiError extends Error {
  constructor(message: string, options?: ApiErrorOptions);
  readonly status: number; readonly code: string; readonly details: unknown;
  readonly requestId: string | null; readonly apiVersion: string | null; readonly retryAfter: string | null;
  clientMessageId: string | null;
}
export interface CryptoSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}
export interface ClientOptions {
  /** Full versioned base path, e.g. https://your-host/api/v1; relative /api/v1 works in browsers. */
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  getWallId?: () => Id | null | undefined | Promise<Id | null | undefined>;
  /** Milliseconds including token/wall resolution, fetch and response parsing; 0 disables the timer. */
  timeoutMs?: number;
  crypto?: CryptoSource;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** null explicitly omits the selected wall for this request. */
  wallId?: Id | null;
  token?: string | null;
}
export type Query = Record<string, string | number | boolean | null | undefined>;
export interface RawRequestOptions extends RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';
  query?: Query; body?: unknown; auth?: boolean;
}
export interface Profile {
  id: number; username: string; nickname: string; real_name: string; show_real_name: Flag;
  avatar: string; bio: string; gender: '' | 'male' | 'female' | 'other';
  contact_qq: string; contact_wechat: string; contact_weibo: string; contact_bilibili: string;
  show_contact: Flag; class_number: number; is_graduate: Flag; graduation_year: number; role: string;
  status?: string; ban_until?: string; ban_reason?: string; ban_level?: string;
  allow_search_by_id?: Flag; allow_search_by_username?: Flag; allow_search_by_nickname?: Flag;
  allow_search_by_real_name?: Flag; allow_discover?: Flag; created_at?: string;
}
export interface ProfileUpdate {
  nickname?: string; real_name?: string; bio?: string; gender?: '' | 'male' | 'female' | 'other';
  contact_qq?: string; contact_wechat?: string; contact_weibo?: string; contact_bilibili?: string;
  class_number?: number; graduation_year?: number;
  show_real_name?: boolean | Flag; show_contact?: boolean | Flag; is_graduate?: boolean | Flag;
  allow_search_by_id?: boolean | Flag; allow_search_by_username?: boolean | Flag;
  allow_search_by_nickname?: boolean | Flag; allow_search_by_real_name?: boolean | Flag; allow_discover?: boolean | Flag;
}
export interface Preferences {
  home: boolean; publish: boolean; search: boolean; votes: boolean; chat: boolean; inbox: boolean;
  treehole: boolean; bookmarks: boolean; help: boolean; theme: boolean; wallpaper: boolean;
  feed_sort: 'latest' | 'hot'; feed_category: '全部' | '吐槽' | '分享' | '求助' | '讨论' | '其他';
  density: 'comfortable' | 'compact'; time_format: 'relative' | 'absolute'; font_scale: 'sm' | 'md' | 'lg'; auto_load_images: boolean;
  default_anonymous_post: boolean; default_markdown: boolean; confirm_before_post: boolean; default_anonymous_confession: boolean;
  badge_interaction: boolean; badge_announcement: boolean; badge_system: boolean; badge_report: boolean;
  unread_interval: '0' | '15' | '30' | '60' | '300'; notify_on_comment: boolean; notify_on_like: boolean;
  reduce_motion: boolean; high_contrast: boolean; always_focus_ring: boolean; disable_blur: boolean;
  accent: 'indigo' | 'teal' | 'forest' | 'amber' | 'rose' | 'slate';
  theme_mode: 'system' | 'light' | 'dark'; wallpaper_enabled: boolean;
  chat_send_shortcut: 'enter' | 'modifier'; chat_density: 'comfortable' | 'compact';
  chat_show_timestamps: boolean; chat_poll_interval: '10' | '20' | '30' | '60';
}
export type PreferenceKey = keyof Preferences;
export type PreferenceDefinition =
  | { type: 'bool'; default: boolean; scope: Exclude<PreferenceScope, 'all'> }
  | { type: 'enum'; default: string; values: string[]; scope: Exclude<PreferenceScope, 'all'> };
export interface PreferencesSchema {
  version: 1; schema: Record<PreferenceKey, PreferenceDefinition>; defaults: Preferences;
  scopes: Record<PreferenceScope, PreferenceKey[]>;
}
export interface PreferencesResult { prefs: Preferences; storedKeys?: PreferenceKey[]; }
export interface MessageAcknowledgment { message: string; }
export interface Wall {
  id: number; name: string; description: string; require_join_approval: Flag;
  owner_id?: number; owner_name?: string | null; status?: string; wall_role?: string;
  member_status?: string; member_count?: number; my_status?: string | null; my_role?: string | null;
}
export interface PageQuery { page?: number; limit?: number; }
export interface PostsQuery extends PageQuery { category?: string; sort?: 'latest' | 'hot'; }
export interface Post {
  id: number; wall_id: number; content: string; category: string; is_anonymous: Flag; author_id: number | null;
  like_count: number; comment_count: number; is_markdown: Flag; created_at: string;
  author_nickname: string | null; author_avatar: string | null; author_class: number | null;
  liked?: boolean; bookmarked?: boolean;
}
export interface Comment {
  id: number; post_id: number; content: string; author_id: number; created_at: string;
  nickname: string; avatar: string; class_number: number;
}
export interface PostInput { content: string; category?: string; is_anonymous?: boolean | Flag; is_markdown?: boolean | Flag; }
export interface PostPage { posts: Post[]; total: number; page: number; limit: number; categories: string[]; }
export interface PostDetail {
  post: Post; comments: Comment[]; comments_total: number; comments_page: number; comments_limit: number;
}
export interface CommentsQuery { comments_page?: number; comments_limit?: number; }
export interface ReplyPreview {
  id: number; available: boolean; content: string; is_mine: boolean | null;
  sender_id: number | null; sender_nickname: string | null; created_at: string | null;
  is_revoked: boolean; reason: 'revoked' | 'unavailable' | null;
}
export interface Message {
  id: number; sender_id: number | null; receiver_id: number; wall_id: number; type: MessageType;
  title: string; content: string; is_anonymous: Flag; is_read: Flag; is_revoked: Flag;
  reply_to_id: number; reply_to_content: string; link: string; created_at: string;
  is_mine: boolean; client_message_id: string | null; reply_to: ReplyPreview | null;
  reply_to_missing: boolean; reply_to_revoked: boolean; reply_to_sender_id: number | null; reply_to_sender_name: string | null;
}
export interface Conversation {
  user_id: number; other_user: { id: number; nickname: string; avatar: string; available: boolean };
  last_message: Message; last_message_id: number; last_time: string; unread_count: number; can_send: boolean;
}
export interface ConversationsQuery { limit?: number; before?: Id; }
export interface ConversationsPage { conversations: Conversation[]; hasMore: boolean; next_before_id: number | null; next_before: number | null; }
/** before/after/around_id are mutually exclusive; q only combines with before. */
export interface MessagesQuery {
  limit?: number; before?: Id; after?: Id; around_id?: Id; q?: string; mark_read?: 0 | 1 | '0' | '1';
}
export interface MessagesPage {
  messages: Message[]; hasMore: boolean; hasMoreBefore: boolean; hasMoreAfter: boolean;
  next_before_id: number | null; next_after_id: number | null; next_before: number | null; unreadMarked: number;
}
export interface SendMessageInput {
  receiver_id: Id; content: string; type?: 'private' | 'confession'; title?: string;
  is_anonymous?: boolean | Flag; reply_to_id?: Id | 0; client_message_id?: string;
}
export type PreparedMessage = Readonly<SendMessageInput & { type: 'private' | 'confession'; client_message_id: string }>;
export interface SendMessageData extends MessageAcknowledgment { id: number; client_message_id: string | null; deduplicated: boolean; message_item: Message; }
export type SendMessageResponse = ApiResponse<SendMessageData> & { clientMessageId: string };
export interface Friend { id: number; friend_id: number; friend_nickname: string; friend_avatar: string; status: string; created_at: string; }
export interface PendingFriend { id: number; sender_id: number; sender_nickname: string; sender_avatar: string; created_at: string; }
export interface VoteOption { id: number; vote_id: number; option_text: string; vote_count: number; }
export interface Vote {
  id: number; wall_id: number; title: string; description: string; author_id: number | null;
  is_anonymous: Flag; end_at: string; created_at: string; author_nickname: string | null;
  total_votes: number; options: VoteOption[]; voted: number | null;
}
export interface VoteInput { title: string; description?: string; options: string[]; is_anonymous?: boolean | Flag; end_at?: string; }
export interface Capabilities {
  apiVersion: '1'; basePath: string; legacyBasePath: string;
  authentication: { scheme: string; header: string; format: string; wallHeader: string };
  pagination: Record<string, unknown>; limits: Record<string, number>; features: Record<string, boolean>; openApi: string;
}
export function createClientMessageId(cryptoSource?: CryptoSource): string;
export class SchoolWallClient {
  constructor(options?: ClientOptions);
  readonly baseURL: string;
  request<T = unknown>(path: string, options?: RawRequestOptions): Promise<ApiResponse<T>>;
  getCapabilities(options?: RequestOptions): Promise<ApiResponse<Capabilities>>;
  login(credentials: { username: string; password: string }, options?: RequestOptions): Promise<ApiResponse<{ token: string; user: Profile }>>;
  getMe(options?: RequestOptions): Promise<ApiResponse<Profile>>;
  updateProfile(profile: ProfileUpdate, options?: RequestOptions): Promise<ApiResponse<Profile>>;
  changePassword(passwords: { oldPassword: string; newPassword: string }, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment & { token: string }>>;
  getPreferences(options?: RequestOptions): Promise<ApiResponse<PreferencesResult>>;
  getPreferencesSchema(options?: RequestOptions): Promise<ApiResponse<PreferencesSchema>>;
  updatePreferences(prefs: Partial<Preferences>, options?: RequestOptions): Promise<ApiResponse<PreferencesResult>>;
  resetPreferences(scope?: PreferenceScope, options?: RequestOptions): Promise<ApiResponse<PreferencesResult>>;
  getWalls(options?: RequestOptions): Promise<ApiResponse<Wall[]>>;
  discoverWalls(query?: { q?: string }, options?: RequestOptions): Promise<ApiResponse<Wall[]>>;
  getWall(wallId: Id, options?: RequestOptions): Promise<ApiResponse<Wall>>;
  joinWall(wallId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment & { status: 'active' | 'pending' }>>;
  leaveWall(wallId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  getPosts(query?: PostsQuery, options?: RequestOptions): Promise<ApiResponse<PostPage>>;
  searchPosts(q: string, options?: RequestOptions): Promise<ApiResponse<{ posts: Post[]; total: number; hasMore?: boolean; hint?: string }>>;
  getPost(postId: Id, query?: CommentsQuery, options?: RequestOptions): Promise<ApiResponse<PostDetail>>;
  createPost(post: PostInput, options?: RequestOptions): Promise<ApiResponse<Post>>;
  createComment(postId: Id, content: string, options?: RequestOptions): Promise<ApiResponse<Comment>>;
  getConversations(query?: ConversationsQuery, options?: RequestOptions): Promise<ApiResponse<ConversationsPage>>;
  getMessages(userId: Id, query?: MessagesQuery, options?: RequestOptions): Promise<ApiResponse<MessagesPage>>;
  prepareMessage(input: SendMessageInput): PreparedMessage;
  sendMessage(input: SendMessageInput, options?: RequestOptions): Promise<SendMessageResponse>;
  readMessage(messageId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  readMessages(ids: Id[], options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  readAllMessages(type?: MessageType, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  deleteMessage(messageId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  deleteConversation(userId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  revokeMessage(messageId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  getFriends(options?: RequestOptions): Promise<ApiResponse<Friend[]>>;
  getPendingFriends(options?: RequestOptions): Promise<ApiResponse<PendingFriend[]>>;
  addFriend(friendId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  respondToFriend(relationshipId: Id, action: 'accept' | 'reject', options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  getVotes(query?: PageQuery, options?: RequestOptions): Promise<ApiResponse<{ votes: Vote[]; total: number; page: number; limit: number }>>;
  getVote(voteId: Id, options?: RequestOptions): Promise<ApiResponse<Vote>>;
  createVote(vote: VoteInput, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment & { id: number }>>;
  castVote(voteId: Id, optionId: Id, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment>>;
  uploadImage(image: string, options?: RequestOptions): Promise<ApiResponse<{ url: string }>>;
  uploadPrivateImage(image: string, options?: RequestOptions): Promise<ApiResponse<{ url: string }>>;
  uploadAvatar(avatar: string, options?: RequestOptions): Promise<ApiResponse<MessageAcknowledgment & { avatar: string }>>;
}
export function createMobileClient(options?: ClientOptions): SchoolWallClient;
