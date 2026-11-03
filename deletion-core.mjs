// Only the existing authenticated deletion RPCs are used. No admin credential belongs here.
export const FLOW_KEY = 'gachi-delete-flow-v1';
export const RECEIPT_KEY = 'gachi-delete-receipt-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const errors = new Set(['AUTH_REQUIRED','ACCOUNT_CHANGED','REAUTH_REQUIRED','HOST_ACTION_REQUIRED','ACCOUNT_DELETION_PENDING','ACCOUNT_UNAVAILABLE','INVALID_DELETION_REQUEST','FORBIDDEN','NOT_FOUND','ROOM_NOT_ACTIVE','RETRY_LATER']);
export function safeError(data, status) {
  const message = typeof data?.message === 'string' ? data.message : '';
  return errors.has(message) ? message : status === 401 ? 'AUTH_REQUIRED' : 'REQUEST_FAILED';
}
export function validatePreview(value) {
  if (typeof value?.can_delete !== 'boolean' || typeof value?.requested !== 'boolean' || !Array.isArray(value.host_rooms) || value.host_rooms.length > 100) throw new Error('REQUEST_FAILED');
  const ids = new Set();
  for (const room of value.host_rooms) {
    if (!UUID.test(room?.room_id) || ids.has(room.room_id) || typeof room.title !== 'string' || room.title.length > 500) throw new Error('REQUEST_FAILED');
    ids.add(room.room_id);
  }
  if (!value.requested && !value.can_delete && value.host_rooms.length === 0) throw new Error('REQUEST_FAILED');
  if (value.can_delete && value.host_rooms.length > 0) throw new Error('REQUEST_FAILED');
  return value;
}
export function randomSecret(cryptoApi = globalThis.crypto) {
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function makeFlow(config, storage, now = Date.now(), cryptoApi = globalThis.crypto) {
  const verifier = randomSecret(cryptoApi);
  const digest = new Uint8Array(await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  storage.setItem(FLOW_KEY,JSON.stringify({verifier,createdAt:now,redirect:config.redirect}));
  const url = new URL('/auth/v1/authorize',config.supabaseUrl);
  url.search = new URLSearchParams({provider:'google',redirect_to:config.redirect,code_challenge:challenge,code_challenge_method:'s256',prompt:'select_account',scopes:'openid email profile'});
  return url.href;
}
export function takeFlow(storage, redirect, now = Date.now()) {
  let flow;
  try { flow = JSON.parse(storage.getItem(FLOW_KEY)); } catch { /* fail closed */ }
  storage.removeItem(FLOW_KEY);
  if (!flow || !RANDOM.test(flow.verifier) || flow.redirect !== redirect || !Number.isFinite(flow.createdAt) || now < flow.createdAt || now-flow.createdAt > 10*60*1000) throw new Error('LOGIN_EXPIRED');
  return flow;
}
export function readReceipt(storage) {
  let receipt;
  try { receipt = JSON.parse(storage.getItem(RECEIPT_KEY)); } catch { return null; }
  if (!receipt || !UUID.test(receipt.requestId) || !UUID.test(receipt.userId) || !RANDOM.test(receipt.receipt)) return null;
  return receipt;
}
export function prepareReceipt(storage, userId, cryptoApi = globalThis.crypto) {
  if (!UUID.test(userId)) throw new Error('ACCOUNT_CHANGED');
  const previous = readReceipt(storage);
  if (previous) {
    if (previous.userId !== userId) throw new Error('ACCOUNT_CHANGED');
    return previous;
  }
  const receipt = {requestId:cryptoApi.randomUUID(),userId,receipt:randomSecret(cryptoApi)};
  // Persist before sending; an uncertain response must never generate another request.
  storage.setItem(RECEIPT_KEY,JSON.stringify(receipt));
  return receipt;
}
export function createApi(config, fetcher = globalThis.fetch) {
  if (config.supabaseUrl !== 'https://rnihdtlhdfdmjoifknjx.supabase.co' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) throw new Error('CONFIG_UNAVAILABLE');
  async function request(path, body, token) {
    const headers = {apikey:config.publishableKey,'Content-Type':'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try { response = await fetcher(config.supabaseUrl+path,{method:body === undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:AbortSignal.timeout(20000)}); }
    catch { throw new Error('NETWORK_UNCERTAIN'); }
    let result;
    try { result = await response.json(); } catch { throw new Error('REQUEST_FAILED'); }
    if (!response.ok) throw new Error(safeError(result,response.status));
    return result;
  }
  return {
    async exchange(code, verifier) {
      if (typeof code !== 'string' || code.length > 512 || !RANDOM.test(verifier)) throw new Error('LOGIN_EXPIRED');
      const result = await request('/auth/v1/token?grant_type=pkce',{auth_code:code,code_verifier:verifier});
      if (typeof result.access_token !== 'string' || result.access_token.length > 16000) throw new Error('AUTH_REQUIRED');
      const user = await request('/auth/v1/user',undefined,result.access_token);
      if (!UUID.test(user?.id)) throw new Error('AUTH_REQUIRED');
      // Refresh/provider tokens are deliberately discarded, not persisted or logged.
      return {token:result.access_token,user:{id:user.id,email:typeof user.email==='string'?user.email:''}};
    },
    async preview(session) { return validatePreview(await request('/rest/v1/rpc/gachi_account_deletion_preview',{expected_user_id:session.user.id},session.token)); },
    async status(receipt) {
      const result = await request('/rest/v1/rpc/gachi_account_deletion_status',{request_id:receipt.requestId,receipt:receipt.receipt});
      if (!['NOT_FOUND','PENDING','COMPLETED'].includes(result?.status)) throw new Error('REQUEST_FAILED');
      return result.status;
    },
    async submit(session, receipt) {
      if (receipt.userId !== session.user.id) throw new Error('ACCOUNT_CHANGED');
      const prior = await this.status(receipt);
      if (prior !== 'NOT_FOUND') return prior;
      const result = await request('/rest/v1/rpc/gachi_request_account_deletion',{request_id:receipt.requestId,expected_user_id:session.user.id,receipt:receipt.receipt},session.token);
      if (result?.accepted !== true || result.status !== 'PENDING') throw new Error('REQUEST_FAILED');
      return 'PENDING';
    },
    async endHostedRoom(session, roomId, requestId) {
      if (!UUID.test(roomId) || !UUID.test(requestId)) throw new Error('INVALID_DELETION_REQUEST');
      const result = await request('/rest/v1/rpc/gachi_command',{request_id:requestId,operation:'leave_room',payload:{room_id:roomId,record_choice:'DELETE',dissolve:true}},session.token);
      if (result?.error || result?.room_id !== roomId) throw new Error('REQUEST_FAILED');
      return result;
    },
    async signOut(session) {
      if (!session) return;
      // Only this web session; never log out other app devices as a side effect of cancel.
      await request('/auth/v1/logout?scope=local',{},session.token).catch(()=>{});
    }
  };
}
