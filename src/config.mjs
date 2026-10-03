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
export function configFrom(env, cwd = process.cwd()) {
  let url; try { url = new URL(env.AI_BASE_URL || 'https://api.openai.com/v1'); } catch { fail('invalid_AI_BASE_URL'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) fail('invalid_AI_BASE_URL');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('insecure_AI_BASE_URL');
  const raw = env.KAKAO_ALLOWED_ROOMS || '';
  const rooms = raw === '' ? [] : raw.split(',');
  if (rooms.length > 10 || rooms.some(r => !validId(r)) || new Set(rooms).size !== rooms.length) fail('invalid_KAKAO_ALLOWED_ROOMS');
  const prefix = env.KAKAO_TRIGGER_PREFIX ?? '!ai';
  if (!/^\S{1,32}$/u.test(prefix) || /[\s\x00-\x1f\x7f]/u.test(prefix)) fail('invalid_KAKAO_TRIGGER_PREFIX');
  const model = env.AI_MODEL || ''; const key = env.AI_API_KEY || '';
  if (model.length > 200 || /[\r\n\x00]/u.test(model) || /[\r\n\x00]/u.test(key)) fail('invalid_ai_credentials');
  return Object.freeze({
    endpoint: url.href.replace(/\/$/, '') + '/chat/completions', model, key, rooms: Object.freeze(rooms), prefix,
    stateDir: path.resolve(cwd, env.BRIDGE_STATE_DIR || '.state'),
    aiTimeout: integer(env, 'AI_TIMEOUT_MS', 60000, 100, 120000),
    maxTokens: integer(env, 'AI_MAX_OUTPUT_TOKENS', 800, 16, 4096),
    maxInput: integer(env, 'BRIDGE_MAX_INPUT_CHARS', 4000, 16, 16000),
    maxOutput: integer(env, 'BRIDGE_MAX_OUTPUT_CHARS', 1800, 32, 3000),
    cooldown: integer(env, 'BRIDGE_COOLDOWN_MS', 5000, 1000, 3600000),
    perHour: integer(env, 'BRIDGE_MAX_REQUESTS_PER_HOUR', 30, 1, 120),
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
export function requireRunnable(cfg) {
  if (!cfg.rooms.length) fail('room_allowlist_empty');
  if (!cfg.model) fail('AI_MODEL_required');
  if (new URL(cfg.endpoint).protocol === 'https:' && !cfg.key) fail('AI_API_KEY_required');
}
