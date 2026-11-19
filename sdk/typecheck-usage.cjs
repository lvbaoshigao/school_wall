// @ts-check
// Compile with TypeScript --allowJs --checkJs --strict; not invoked, so no HTTP/storage side effects.
async function verifyMobileDeclarations() {
  const { createMobileClient, ApiError } = await import('./mobile-client.mjs');
  const api = createMobileClient({
    baseURL: 'https://school.invalid/api/v1',
    fetch: async () => new Response('{}'),
    getToken: async () => null,
    getWallId: () => 1,
  });
  const prefs = await api.getPreferences();
  /** @type {'10' | '20' | '30' | '60'} */
  const interval = prefs.data.prefs.chat_poll_interval;
  /** @type {string | undefined} */
  const persisted = prefs.data.storedKeys?.[0];
  const prepared = api.prepareMessage({ receiver_id: 2, content: 'draft', reply_to_id: 1 });
  /** @type {string} */
  const cid = prepared.client_message_id;
  const sent = await api.sendMessage(prepared);
  /** @type {number} */
  const messageId = sent.data.message_item.id;
  /** @type {boolean} */
  const available = sent.data.message_item.reply_to?.available ?? false;
  await api.getMessages(2, { around_id: messageId, mark_read: 0 });
  await api.resetPreferences('chat');
  const error = new ApiError('test', { status: 409, clientMessageId: cid });
  /** @type {string | null} */
  const retryCid = error.clientMessageId;
  // @ts-expect-error numeric enum is not the string API preference
  api.updatePreferences({ chat_poll_interval: 20 });
  // @ts-expect-error unknown reset scope
  api.resetPreferences('privacy');
  // @ts-expect-error prepared payload must remain stable for retries
  prepared.content = 'changed';
  // @ts-expect-error getMessages limit is numeric
  api.getMessages(2, { limit: '100' });
  // @ts-expect-error response is an envelope, not a bare profile
  api.getMe().then(result => result.nickname);
  // @ts-expect-error HTTP status is a number
  error.status = '409';
  return { interval, persisted, cid, messageId, available, retryCid };
}
