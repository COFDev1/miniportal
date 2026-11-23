// Portal B2B - Cloudflare Worker (ES module)
// Configure bindings/secrets as documented in README.md.
const enc = new TextEncoder();
const dec = new TextDecoder();
const COOKIE = '__Host-b2b_session';
const DEFAULT_TTL = 1800;
const MAX_BODY = 1024 * 1024;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64url(value) { const s = value.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); }
function safeEq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }
async function signSession(payload, secret) {
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(p)));
  return `${p}.${b64url(sig)}`;
}
async function verifySession(value, secret) {
  try {
    if (!value || value.length > 4096) return null;
    const [p, s, ...extra] = value.split('.'); if (!p || !s || extra.length) return null;
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(p)));
    if (!safeEq(expected, fromB64url(s))) return null;
    const obj = JSON.parse(dec.decode(fromB64url(p)));
    if (obj.v !== 1 || typeof obj.sub !== 'string' || !obj.sub || typeof obj.exp !== 'number' || obj.exp <= Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch { return null; }
}
function cookies(request) { return Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(x => x.trim()).filter(Boolean).map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; })); }
function cookieHeader(token, age) { return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${age}`; }
function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' };
  return { 'Vary': 'Origin' };
}
function originOK(request, env) {
  const origin = request.headers.get('Origin');
  return !!origin && (env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).includes(origin);
}
function cfgUrl(env, path) {
  const base = new URL(env.PROTHEUS_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid backend URL');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[?#]/.test(path)) throw new Error('Invalid backend path');
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) throw new Error('Cross-origin backend URL');
  return url.toString();
}
async function readJson(request, max = MAX_BODY) {
  const size = Number(request.headers.get('Content-Length') || 0);
  if (size > max) return { error: json({ erro: 'Corpo muito grande' }, 413) };
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return { error: json({ erro: 'Content-Type deve ser application/json' }, 415) };
  const raw = await request.text();
  if (enc.encode(raw).length > max) return { error: json({ erro: 'Corpo muito grande' }, 413) };
  try { const value = JSON.parse(raw); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return { value, raw }; }
  catch { return { error: json({ erro: 'JSON inválido' }, 400) }; }
}
async function backend(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try { return await fetch(url, { ...options, signal: controller.signal, redirect: 'manual', cf: { cacheTtl: 0, cacheEverything: false } }); }
  finally { clearTimeout(timeout); }
}
// OAuth2 técnico: senha somente na obtenção do token, nunca nas APIs de negócio.
// A versão atual do Protheus informada utiliza parâmetros na query string.
// Não registrar a URL completa, pois ela contém credenciais.
const TOKEN_CACHE_KEY = 'protheus:technical-token:v2';
let memoryToken = null; // Apenas dados resolvidos: nunca compartilhar Promises entre requisições.

function usable(record) {
  return record && typeof record.access_token === 'string' &&
    record.access_token.length > 0 && record.expires_at > Date.now() + 60000;
}
async function requestPasswordToken(env) {
  if (!env.PROTHEUS_USER || !env.PROTHEUS_PASS) throw new Error('Technical credentials missing');
  const url = new URL(cfgUrl(env, env.PROTHEUS_TOKEN_PATH || '/rest/api/oauth2/v1/token'));
  url.search = new URLSearchParams({
    grant_type: 'password', username: env.PROTHEUS_USER, password: env.PROTHEUS_PASS
  }).toString();


  // Nunca enviar Basic Auth. O token é obtido com OAuth2 password grant.
  const response = await backend(url.toString(), {
    method: 'POST', headers: { 'Accept': 'application/json', 'Cache-Control': 'no-store' }
  });
  if (!response.ok) throw new Error(`Technical OAuth2 HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16000 ||
    (data.token_type && data.token_type.toLowerCase() !== 'bearer')) {
    throw new Error('Invalid OAuth2 token response');
  }
  const seconds = Number(data.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 90) throw new Error('Invalid OAuth2 expiration');
  return { access_token: data.access_token, expires_at: Date.now() + Math.floor(seconds) * 1000 };
}
async function technicalToken(env, force = false) {
  if (!force && usable(memoryToken)) return memoryToken.access_token;
  if (!force && env.TOKEN_KV) {
    const cached = await env.TOKEN_KV.get(TOKEN_CACHE_KEY, 'json');
    if (usable(cached)) { memoryToken = cached; return cached.access_token; }
  }
  const record = await requestPasswordToken(env);
  memoryToken = record;
  if (env.TOKEN_KV) {
    // KV expira antes do token; o token permanece apenas no Worker/KV.
    const ttl = Math.floor((record.expires_at - Date.now()) / 1000) - 60;
    if (ttl >= 60) await env.TOKEN_KV.put(TOKEN_CACHE_KEY, JSON.stringify(record), { expirationTtl: ttl });
  }
  return record.access_token;
}
async function callProtheus(env, path, body, method = 'POST') {
  let token = await technicalToken(env);
  const send = (t) => backend(cfgUrl(env, path), { method, headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let res = await send(token);
  if (res.status === 401) { memoryToken = null; token = await technicalToken(env, true); res = await send(token); }
  return res;
}
async function parseBackend(res) {
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (raw.length > 2 * 1024 * 1024) throw new Error('Backend response too large');
  if (!ct.includes('application/json')) throw new Error('Backend did not return JSON');
  return JSON.parse(raw);
}
function backendError(status) {
  if (status === 400 || status === 422) return json({ erro: 'Dados inválidos' }, 400);
  if (status === 401 || status === 403) return json({ erro: 'Acesso não autorizado' }, 401);
  if (status === 404) return json({ erro: 'Recurso não encontrado' }, 404);
  if (status === 429) return json({ erro: 'Muitas tentativas' }, 429);
  return json({ erro: 'Serviço temporariamente indisponível' }, 502);
}
async function limited(env, request, key) {
  // Binding must implement limit({key}) e.g. Cloudflare Rate Limiting binding.
  if (!env.RATE_LIMITER) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await env.RATE_LIMITER.limit({ key: `${key}:${ip}` });
  return !result.success;
}
export default {
  async fetch(request, env) {
    const id = crypto.randomUUID();
    const ch = cors(request, env);
    const reply = (res) => { const h = new Headers(res.headers); for (const [k, v] of Object.entries(ch)) h.set(k, v); h.set('X-Request-ID', id); h.set('Cache-Control', 'no-store'); return new Response(res.body, { status: res.status, headers: h }); };
    try {
      const path = new URL(request.url).pathname;
      const routes = new Set(['/api/b2b/auth/login', '/api/b2b/auth/logout', '/api/b2b/auth/me']);
      if (!routes.has(path)) return reply(json({ erro: 'Rota não encontrada' }, 404));
      if (request.method === 'OPTIONS') return originOK(request, env) ? reply(new Response(null, { status: 204 })) : reply(json({ erro: 'Origem não autorizada' }, 403));
      if (!originOK(request, env)) return reply(json({ erro: 'Origem não autorizada' }, 403));
      const expected = path.endsWith('/me') ? 'GET' : 'POST';
      if (request.method !== expected) return reply(json({ erro: 'Método não permitido' }, 405, { 'Allow': expected + ', OPTIONS' }));
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.PROTHEUS_BASE_URL) return reply(json({ erro: 'Configuração indisponível' }, 503));
      if (path.endsWith('/logout')) return reply(json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) }));
      const session = await verifySession(cookies(request)[COOKIE], env.SESSION_SECRET);
      if (path.endsWith('/me')) return reply(session ? json({ authenticated: true, cliente: session.sub }) : json({ authenticated: false }, 401));
      if (await limited(env, request, 'login')) return reply(json({ erro: 'Muitas tentativas' }, 429));
      const input = await readJson(request, 16384); if (input.error) return reply(input.error);
      if (!env.PROTHEUS_LOGIN_PATH) return reply(json({ erro: 'Configuração indisponível' }, 503));
      const res = await callProtheus(env, env.PROTHEUS_LOGIN_PATH, input.value);
      console.log('[LOGIN] Status Protheus:', res.status);
      if (!res.ok) return reply(backendError(res.status));
      const data = await parseBackend(res);
      if (data?.autenticado !== true) return reply(json({ erro: 'Credenciais inválidas' }, 401));
      // A identidade vem exclusivamente do retorno autenticado do Protheus.
      const sub = data?.cliente?.id;
      if (typeof sub !== 'string' || !sub || sub.length > 128) throw new Error('Login contract missing cliente.id');
      const ttl = Math.min(3600, Math.max(300, Number(env.SESSION_TTL_SECONDS) || DEFAULT_TTL));
      const now = Math.floor(Date.now() / 1000);
      const signed = await signSession({ v: 1, sub, iat: now, exp: now + ttl }, env.SESSION_SECRET);
      return reply(json({ authenticated: true, cliente: sub }, 200, { 'Set-Cookie': cookieHeader(signed, ttl) }));
    } catch (e) { console.error('b2b-worker-error', { requestId: id, message: String(e?.message || 'unknown').slice(0, 160) }); return reply(json({ erro: 'Falha ao processar solicitação', requestId: id }, 502)); }
  }
};
