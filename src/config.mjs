import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fail } from './errors.mjs';
import { checkPrivateFile } from './store.mjs';
export function validId(v) {
  return typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && !/[^0-9]/.test(v) && BigInt(v) <= 9223372036854775807n;
}
function integer(env, key, fallback, min, max) {
  const raw = env[key] ?? String(fallback);
  if (typeof raw !== 'string' || !raw || /[^0-9]/.test(raw)) fail('invalid_' + key);
  const n = Number(raw); if (!Number.isSafeInteger(n) || n < min || n > max) fail('invalid_' + key); return n;
}
function endpoint(base, name, openclaw = false) {
  // The explicit Gateway path is deliberately stricter: reject repaired input.
  if (openclaw && (typeof base !== 'string' || /[\s\x00-\x1f\x7f\\]/u.test(base) || /\/\.{1,2}(?:\/|$)/.test(base))) fail('invalid_' + name);
  let url; try { url = new URL(base); } catch { fail('invalid_' + name); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) fail('invalid_' + name);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('insecure_' + name);
  if (openclaw && (!url.pathname.replace(/\/$/, '').endsWith('/v1') || url.pathname.includes('%'))) fail('invalid_' + name);
  return url.href.replace(/\/$/, '') + '/chat/completions';
}
export function configFrom(env, cwd = process.cwd()) {
  const provider = env.AI_PROVIDER ?? 'openai-compatible';
  if (!['openai-compatible', 'openclaw'].includes(provider)) fail('invalid_AI_PROVIDER');
  let target, model = '', key = '', agentId = '', gatewayToken = '';
  if (provider === 'openclaw') {
    target = endpoint(env.OPENCLAW_BASE_URL ?? 'http://127.0.0.1:18789/v1', 'OPENCLAW_BASE_URL', true);
    agentId = env.OPENCLAW_AGENT_ID ?? '';
    // 'default' is an alias, not a stable dedicated agent. Never trim/lowercase IDs.
    if (typeof agentId !== 'string' || (agentId && (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId) || /[^a-z0-9_-]/.test(agentId) || agentId === 'default'))) fail('invalid_OPENCLAW_AGENT_ID');
    gatewayToken = env.OPENCLAW_GATEWAY_TOKEN ?? '';
    if (typeof gatewayToken !== 'string' || gatewayToken.length > 4096 || /[^\x21-\x7e]/.test(gatewayToken)) fail('invalid_OPENCLAW_GATEWAY_TOKEN');
    model = agentId ? 'openclaw/' + agentId : '';
    // AI_* credentials/models do not select or authenticate a Gateway request.
  } else {
    target = endpoint(env.AI_BASE_URL || 'https://api.openai.com/v1', 'AI_BASE_URL');
    model = env.AI_MODEL || ''; key = env.AI_API_KEY || '';
    if (model.length > 200 || /[\r\n\x00]/u.test(model) || /[\r\n\x00]/u.test(key)) fail('invalid_ai_credentials');
  }
  const raw = env.KAKAO_ALLOWED_ROOMS || '';
  const rooms = raw === '' ? [] : raw.split(',');
  if (rooms.length > 10 || rooms.some(r => !validId(r)) || new Set(rooms).size !== rooms.length) fail('invalid_KAKAO_ALLOWED_ROOMS');
  const prefix = env.KAKAO_TRIGGER_PREFIX ?? '!ai';
  if (!/^\S{1,32}$/u.test(prefix) || /[\s\x00-\x1f\x7f]/u.test(prefix)) fail('invalid_KAKAO_TRIGGER_PREFIX');
  // auto: 1:1 rooms answer every text; group rooms answer only what is addressed to the bot.
  const replyMode = env.KAKAO_REPLY_MODE || 'auto';
  if (!['auto', 'prefix'].includes(replyMode)) fail('invalid_KAKAO_REPLY_MODE');
  const rawNames = env.KAKAO_BOT_NAMES || '';
  const botNames = rawNames === '' ? [] : rawNames.split(',').map(n => n.trim());
  if (botNames.length > 10 || botNames.some(n => !n || Array.from(n).length > 20 || /[\x00-\x1f\x7f]/u.test(n))) fail('invalid_KAKAO_BOT_NAMES');
  return Object.freeze({
    provider, endpoint: target, model, key, agentId, gatewayToken, rooms: Object.freeze(rooms), prefix, replyMode, botNames: Object.freeze(botNames),
    stateDir: path.resolve(cwd, env.BRIDGE_STATE_DIR || '.state'),
    aiTimeout: integer(env, 'AI_TIMEOUT_MS', 60000, 100, 120000),
    maxTokens: integer(env, 'AI_MAX_OUTPUT_TOKENS', 800, 16, 4096),
    maxInput: integer(env, 'BRIDGE_MAX_INPUT_CHARS', 4000, 16, 16000),
    maxOutput: integer(env, 'BRIDGE_MAX_OUTPUT_CHARS', 1800, 32, 3000),
    cooldown: integer(env, 'BRIDGE_COOLDOWN_MS', 5000, 1000, 3600000),
    perHour: integer(env, 'BRIDGE_MAX_REQUESTS_PER_HOUR', 30, 1, 120),
    judgesPerHour: integer(env, 'BRIDGE_MAX_JUDGES_PER_HOUR', 60, 1, 600),
    followupMs: integer(env, 'BRIDGE_GROUP_FOLLOWUP_MS', 180000, 0, 1800000),
    contextSize: 8,
    maxQueue: 20, maxAgeMs: 120000
  });
}
export function loadConfig(cwd = process.cwd(), external = process.env) {
  const filename = path.join(cwd, '.env'); let env = {};
  if (fs.existsSync(filename) || (() => {try{return fs.lstatSync(filename).isSymbolicLink();}catch{return false;}})()) {
    checkPrivateFile(filename); env = parseEnv(fs.readFileSync(filename, 'utf8'));
  }
  return configFrom({...env, ...external}, cwd);
}
export function requireAi(cfg) {
  if (cfg.provider === 'openclaw') {
    if (!cfg.agentId) fail('OPENCLAW_AGENT_ID_required');
    if (!cfg.gatewayToken) fail('OPENCLAW_GATEWAY_TOKEN_required');
  } else {
    if (!cfg.model) fail('AI_MODEL_required');
    if (new URL(cfg.endpoint).protocol === 'https:' && !cfg.key) fail('AI_API_KEY_required');
  }
}
export function requireRunnable(cfg) {
  if (!cfg.rooms.length) fail('room_allowlist_empty');
  requireAi(cfg);
}
