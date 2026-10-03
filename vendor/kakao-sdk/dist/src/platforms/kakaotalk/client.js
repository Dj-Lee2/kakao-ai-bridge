import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Long } from 'bson';
import { getConfigDir } from '../../shared/utils/config-dir.js';
import { warn } from '../../shared/utils/stderr.js';
import { planAttachments } from './attachment-router.js';
import { isOpenKakaoChatType } from './chat-classifier.js';
import { detectImageDimensions } from './image-meta.js';
import { sha1Hex } from './media-upload.js';
import { LANG, PC_OS_NAME, getLocoDeviceConfig } from './protocol/config.js';
import { isSyntheticConnectionClose } from './protocol/login-response.js';
import { uploadMediaToLoco, uploadMultiMediaEntry } from './protocol/media-uploader.js';
import { LocoSession } from './protocol/session.js';
import { KAKAO_MESSAGE_TYPE, } from './types.js';
export class KakaoTalkError extends Error {
    code;
    serverStatus;
    responseFailureKind;
    responseStatusSource;
    getChatFailureReason;
    constructor(message, code, options) {
        super(message, options);
        this.name = 'KakaoTalkError';
        this.code = code;
        this.serverStatus = options?.serverStatus;
        this.responseFailureKind = options?.responseFailureKind;
        this.responseStatusSource = options?.responseStatusSource;
        this.getChatFailureReason = options?.getChatFailureReason;
    }
}
class LocoResponseError extends Error {
    serverStatus;
    responseFailureKind;
    responseStatusSource;
    constructor(message, responseFailureKind, options) {
        super(message);
        this.name = 'LocoResponseError';
        this.serverStatus = options?.serverStatus;
        this.responseFailureKind = responseFailureKind;
        this.responseStatusSource = options?.responseStatusSource;
    }
}
class MemberNameCache {
    byChatId = new Map();
    ingest(chatDatas) {
        for (const chat of chatDatas) {
            const ids = chat.i;
            const names = chat.k;
            if (!Array.isArray(ids) || !Array.isArray(names))
                continue;
            const chatId = longToString(chat.c);
            let map = this.byChatId.get(chatId);
            if (!map) {
                map = new Map();
                this.byChatId.set(chatId, map);
            }
            const len = Math.min(ids.length, names.length);
            for (let i = 0; i < len; i++) {
                const numericId = toNumericUserId(ids[i]);
                if (numericId === null)
                    continue;
                const name = names[i];
                if (typeof name === 'string' && name.length > 0) {
                    map.set(numericId, name);
                }
            }
        }
    }
    lookup(chatId, userId) {
        return this.byChatId.get(chatId)?.get(userId) ?? null;
    }
    forget(chatId) {
        this.byChatId.delete(chatId);
    }
    clear() {
        this.byChatId.clear();
    }
}
function toNumericUserId(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    if (v && typeof v === 'object' && 'low' in v && 'high' in v) {
        const { low, high } = v;
        // chatDatas[].i entries are member user IDs. KakaoTalk user IDs fit in
        // 53 bits — safe to flatten the BSON Long pair to a JS number for keying.
        return (high >>> 0) * 0x100000000 + (low >>> 0);
    }
    return null;
}
function bsonToLong(v) {
    if (v && typeof v === 'object' && 'high' in v && 'low' in v) {
        const { high, low } = v;
        return new Long(low, high);
    }
    return undefined;
}
// LCHATLIST cursor fields (lastTokenId/lastChatId) arrive as plain numbers when the
// value fits in a safe integer, because bson promotes them, and as { low, high }
// otherwise. bsonToLong only accepts the object form, so a numeric cursor became
// undefined and getChatList() re-requested the first page until MAX_PAGES.
// Kept separate from bsonToLong on purpose: its other callers (log ids, open link
// ids) rely on a numeric 0 staying absent rather than becoming a Long.
function cursorToLong(v) {
    if (typeof v === 'number' && Number.isSafeInteger(v))
        return Long.fromNumber(v);
    if (typeof v === 'bigint')
        return Long.fromBigInt(v);
    return bsonToLong(v);
}
function longToString(v) {
    if (v && typeof v === 'object' && 'high' in v && 'low' in v) {
        const { high, low } = v;
        return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)).toString();
    }
    return String(v ?? 0);
}
function parseAttachmentJson(raw) {
    if (typeof raw !== 'string' || raw.length === 0)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        const attachment = parsed;
        return Object.keys(attachment).length > 0 ? attachment : null;
    }
    catch {
        return null;
    }
}
function parseLong(s) {
    const big = BigInt(s);
    const low = Number(big & 0xffffffffn);
    const high = Number((big >> 32n) & 0xffffffffn);
    return new Long(low, high);
}
function parseChatId(chatId) {
    try {
        return parseLong(chatId);
    }
    catch (cause) {
        throw new KakaoTalkError(`Invalid chatId: ${chatId}`, 'invalid_chat_id', { cause });
    }
}
function parseUserId(userId) {
    try {
        return parseLong(userId);
    }
    catch (cause) {
        throw new KakaoTalkError(`Invalid userId: ${userId}`, 'invalid_user_id', { cause });
    }
}
function parseLogId(logId) {
    try {
        return parseLong(logId);
    }
    catch (cause) {
        throw new KakaoTalkError(`Invalid logId: ${logId}`, 'invalid_log_id', { cause });
    }
}
function parseLinkId(linkId) {
    try {
        return parseLong(linkId);
    }
    catch (cause) {
        throw new KakaoTalkError(`Invalid linkId: ${linkId}`, 'invalid_link_id', { cause });
    }
}
function formatChat(chat, title, nameCache) {
    const memberNames = (chat.k ?? []);
    const lastLog = chat.l;
    const displayName = memberNames.join(', ') || null;
    const chatId = longToString(chat.c);
    return {
        chat_id: chatId,
        type: requiredChatType(chat.t),
        display_name: displayName,
        title,
        active_members: chat.a,
        unread_count: chat.n,
        last_message: lastLog
            ? {
                author_id: lastLog.authorId,
                author_name: nameCache.lookup(chatId, lastLog.authorId),
                message: lastLog.message,
                sent_at: lastLog.sendAt,
            }
            : null,
    };
}
const META_TYPE_TITLE = 3;
function extractTitle(body) {
    const info = body.chatInfo;
    const metas = info?.chatMetas;
    if (!Array.isArray(metas))
        return null;
    const titleMeta = metas.find((m) => m?.type === META_TYPE_TITLE);
    const content = titleMeta?.content;
    return typeof content === 'string' && content.length > 0 ? content : null;
}
function extractChannelInfo(body, expectedChatId) {
    const info = body.chatInfo;
    if (!info || typeof info !== 'object') {
        throw new Error('CHATINFO response missing chatInfo');
    }
    const responseChatId = longToString(info.chatId);
    if (responseChatId !== expectedChatId) {
        throw new Error('CHATINFO response chatId mismatch');
    }
    return info;
}
function requiredNonNegativeInteger(value, field) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`CHATINFO response invalid ${field}`);
    }
    return value;
}
function requiredChatType(value) {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }
    return requiredNonNegativeInteger(value, 'type');
}
function channelInfoToChatData(body, expectedChatId) {
    const info = extractChannelInfo(body, expectedChatId);
    const type = requiredChatType(info.type);
    const activeMembers = requiredNonNegativeInteger(info.activeMembersCount, 'activeMembersCount');
    const unreadCount = info.invalidNewMessageCount === true ? 0 : requiredNonNegativeInteger(info.newMessageCount, 'newMessageCount');
    const displayMembers = Array.isArray(info.displayMembers) ? info.displayMembers : [];
    const memberIds = [];
    const memberNames = [];
    for (const member of displayMembers) {
        if (!member || typeof member !== 'object')
            continue;
        if (member.userId === undefined || typeof member.nickName !== 'string')
            continue;
        memberIds.push(member.userId);
        memberNames.push(member.nickName);
    }
    return {
        c: info.chatId,
        t: type,
        a: activeMembers,
        n: unreadCount,
        l: info.lastChatLog ?? null,
        ll: info.lastLogId,
        i: memberIds,
        k: memberNames,
        li: info.li,
    };
}
function extractChannelMaxLogId(body, expectedChatId) {
    const info = extractChannelInfo(body, expectedChatId);
    const maxLogId = bsonToLong(info.lastLogId);
    if (!maxLogId)
        throw new Error('CHATINFO response missing lastLogId');
    return maxLogId;
}
function extractOpenLinkName(body) {
    const ols = body.ols;
    if (!Array.isArray(ols) || ols.length === 0)
        return null;
    const ln = ols[0]?.ln;
    return typeof ln === 'string' && ln.length > 0 ? ln : null;
}
function isOpenChat(chat) {
    return isOpenKakaoChatType(chat.t);
}
function getOpenLinkId(chat) {
    return bsonToLong(chat.li) ?? null;
}
function getLoginMaxLogId(loginResult, chatId) {
    const chat = (loginResult.chatDatas ?? []).find((entry) => longToString(entry.c) === chatId);
    if (!chat)
        return null;
    const lastLog = chat.l;
    return bsonToLong(chat.ll) ?? bsonToLong(lastLog?.logId) ?? null;
}
function matchesSearch(chat, term) {
    const names = (chat.k ?? []);
    const lower = term.toLowerCase();
    return names.some((n) => n.toLowerCase().includes(lower));
}
function findMaxLogId(logs, field) {
    return logs.reduce((max, log) => {
        const current = bsonToLong(log[field]);
        if (!current)
            return max;
        return !max || current.greaterThan(max) ? current : max;
    }, null);
}
function collectChats(chatDatas, into, seen) {
    for (const chat of chatDatas) {
        const id = longToString(chat.c);
        if (!seen.has(id)) {
            seen.add(id);
            into.push(chat);
        }
    }
}
function wrapError(error, code, options) {
    if (error instanceof KakaoTalkError) {
        const responseFailureKind = error.responseFailureKind ?? (options?.classifyResponseFailure ? 'transient_or_unknown' : undefined);
        const getChatFailureReason = error.getChatFailureReason ?? (options?.classifyGetChatFailure ? 'transport_or_unknown' : undefined);
        if (responseFailureKind === error.responseFailureKind && getChatFailureReason === error.getChatFailureReason) {
            return error;
        }
        return new KakaoTalkError(error.message, error.code, {
            cause: error.cause ?? error,
            serverStatus: error.serverStatus,
            responseFailureKind,
            responseStatusSource: error.responseStatusSource,
            getChatFailureReason,
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new KakaoTalkError(message, code, {
        cause: error,
        serverStatus: error instanceof LocoResponseError ? error.serverStatus : undefined,
        responseStatusSource: error instanceof LocoResponseError ? error.responseStatusSource : undefined,
        responseFailureKind: error instanceof LocoResponseError
            ? error.responseFailureKind
            : options?.classifyResponseFailure
                ? 'transient_or_unknown'
                : undefined,
        getChatFailureReason: options?.classifyGetChatFailure
            ? error instanceof LocoResponseError && error.responseFailureKind === 'provider_rejection'
                ? 'provider_rejection'
                : error instanceof LocoResponseError && error.responseStatusSource === 'packet' && error.serverStatus === -1
                    ? 'synthetic_connection_close'
                    : 'transport_or_unknown'
            : undefined,
    });
}
function isLoginResponseError(error) {
    if (!(error instanceof Error))
        return false;
    const candidate = error;
    return ((candidate.code === 'invalid_access_token' || candidate.code === 'login_rejected') &&
        typeof candidate.serverStatus === 'number');
}
const MAX_PAGES = 50;
function syncStatePath(deviceUuid) {
    return join(getConfigDir(), `kakaotalk-sync-state-${deviceUuid}.json`);
}
async function loadSyncState(deviceUuid) {
    const path = syncStatePath(deviceUuid);
    if (!existsSync(path))
        return undefined;
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed.version !== 2 ||
        typeof parsed.revision !== 'number' ||
        !Array.isArray(parsed.chatIds) ||
        !Array.isArray(parsed.maxIds) ||
        parsed.chatIds.length !== parsed.maxIds.length ||
        !parsed.lastTokenId ||
        typeof parsed.lbk !== 'number') {
        return undefined;
    }
    return parsed;
}
async function saveSyncState(deviceUuid, state) {
    await mkdir(getConfigDir(), { recursive: true });
    const path = syncStatePath(deviceUuid);
    await writeFile(path, JSON.stringify(state, null, 2));
    await chmod(path, 0o600);
}
function toLongLike(v) {
    if (v && typeof v === 'object' && 'low' in v && 'high' in v) {
        const { low, high } = v;
        return { low, high };
    }
    if (typeof v === 'number') {
        const big = BigInt(v);
        return { low: Number(big & 0xffffffffn), high: Number((big >> 32n) & 0xffffffffn) };
    }
    return { low: 0, high: 0 };
}
function buildSyncState(loginResult, previousRevision) {
    const chatDatas = (loginResult.chatDatas ?? []);
    return {
        version: 2,
        revision: typeof loginResult.revision === 'number' ? loginResult.revision : previousRevision,
        chatIds: chatDatas.map((chat) => toLongLike(chat.c)),
        maxIds: chatDatas.map((chat) => toLongLike(chat.ll)),
        lastTokenId: toLongLike(loginResult.lastTokenId),
        lbk: typeof loginResult.lbk === 'number' ? loginResult.lbk : 0,
    };
}
function deleteFromSyncState(state, chatId) {
    const index = state.chatIds.findIndex((entry) => longToString(entry) === chatId);
    if (index === -1)
        return;
    state.chatIds.splice(index, 1);
    state.maxIds.splice(index, 1);
}
function upsertSyncState(state, chatId, maxId) {
    const chatIdString = longToString(chatId);
    const nextChatId = toLongLike(chatId);
    const nextMaxId = toLongLike(maxId);
    const index = state.chatIds.findIndex((entry) => longToString(entry) === chatIdString);
    if (index === -1) {
        state.chatIds.push(nextChatId);
        state.maxIds.push(nextMaxId);
        return;
    }
    state.chatIds[index] = nextChatId;
    state.maxIds[index] = nextMaxId;
}
function mergeSyncState(previous, loginResult) {
    const next = previous
        ? {
            version: 2,
            revision: previous.revision,
            chatIds: [...previous.chatIds],
            maxIds: [...previous.maxIds],
            lastTokenId: previous.lastTokenId,
            lbk: previous.lbk,
        }
        : buildSyncState(loginResult, 0);
    next.revision = typeof loginResult.revision === 'number' ? loginResult.revision : next.revision;
    next.lastTokenId = toLongLike(loginResult.lastTokenId);
    next.lbk = typeof loginResult.lbk === 'number' ? loginResult.lbk : next.lbk;
    const delChatIds = Array.isArray(loginResult.delChatIds) ? loginResult.delChatIds : [];
    for (const chatId of delChatIds) {
        deleteFromSyncState(next, longToString(chatId));
    }
    const chatDatas = Array.isArray(loginResult.chatDatas) ? loginResult.chatDatas : [];
    for (const chat of chatDatas) {
        upsertSyncState(next, chat.c, chat.ll);
    }
    return next;
}
function nullableString(v) {
    return typeof v === 'string' && v.length > 0 ? v : null;
}
function nullableNumber(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function isNonZeroLong(v) {
    if (typeof v === 'number')
        return v !== 0;
    if (v && typeof v === 'object' && 'low' in v && 'high' in v) {
        const { low, high } = v;
        return low !== 0 || high !== 0;
    }
    return v !== undefined && v !== null;
}
// Reject synthetic LocoConnection close packets ({ statusCode: -1, body.error: 'connection closed' })
// and explicit body-level failures. Required for any SDK method whose response body has no
// caller-visible error channel (e.g. GETMEM/MEMBER return `[]` for both empty rooms and dead
// sockets). Throwing here lets executeWithReconnect detect session death and reconnect.
function assertLocoOk(response, command) {
    if (typeof response.statusCode !== 'number' || !Number.isFinite(response.statusCode)) {
        throw new LocoResponseError(`${command} failed: response status unavailable`, 'transient_or_unknown');
    }
    if (isSyntheticConnectionClose(response)) {
        throw new LocoResponseError(`${command} failed: connection closed`, 'transient_or_unknown', {
            serverStatus: response.statusCode,
            responseStatusSource: 'packet',
        });
    }
    if (response.statusCode !== 0) {
        throw new LocoResponseError(`${command} failed: statusCode=${response.statusCode}`, 'provider_rejection', {
            serverStatus: response.statusCode,
            responseStatusSource: 'packet',
        });
    }
    const bodyStatus = response.body.status;
    if (typeof bodyStatus === 'number' && bodyStatus !== 0) {
        throw new LocoResponseError(`${command} failed: body.status=${bodyStatus}`, 'provider_rejection', {
            serverStatus: bodyStatus,
            responseStatusSource: 'body',
        });
    }
}
function formatMember(member) {
    return {
        user_id: longToString(member.userId),
        nickname: typeof member.nickName === 'string' ? member.nickName : '',
        profile_image_url: nullableString(member.profileImageUrl ?? member.pi),
        full_profile_image_url: nullableString(member.fullProfileImageUrl ?? member.fpi),
        original_profile_image_url: nullableString(member.originalProfileImageUrl ?? member.opi),
        status_message: nullableString(member.statusMessage),
        country_iso: nullableString(member.countryIso),
        user_type: nullableNumber(member.type),
        open_token: nullableNumber(member.opt),
        open_profile_link_id: isNonZeroLong(member.pli) ? longToString(member.pli) : null,
        open_permission: nullableNumber(member.mt),
    };
}
function memberIdKey(member) {
    const value = member.userId;
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    if (!value || typeof value !== 'object' || !('low' in value) || !('high' in value)) {
        return null;
    }
    const { low, high } = value;
    if (!Number.isInteger(low) ||
        !Number.isInteger(high) ||
        low < -0x80000000 ||
        low > 0xffffffff ||
        high < -0x80000000 ||
        high > 0xffffffff) {
        return null;
    }
    const numeric = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
    return numeric > 0n && numeric <= BigInt(Number.MAX_SAFE_INTEGER) ? numeric.toString() : null;
}
function mergeMemberRecords(primaryMembers, fallbackMembers) {
    const merged = [];
    const indexByUserId = new Map();
    const upsert = (member) => {
        const userId = memberIdKey(member);
        if (!userId)
            return;
        const existingIndex = indexByUserId.get(userId);
        if (existingIndex === undefined) {
            indexByUserId.set(userId, merged.length);
            merged.push(member);
            return;
        }
        merged[existingIndex] = { ...member, ...merged[existingIndex] };
    };
    for (const member of primaryMembers)
        upsert(member);
    for (const member of fallbackMembers)
        upsert(member);
    return merged;
}
function exactMemberRecords(value, source) {
    if (!Array.isArray(value)) {
        throw new Error(`${source} member snapshot missing`);
    }
    const records = [];
    const ids = new Set();
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error(`${source} member snapshot invalid`);
        }
        const record = raw;
        const id = memberIdKey(record);
        if (!id || ids.has(id)) {
            throw new Error(`${source} member snapshot invalid`);
        }
        ids.add(id);
        records.push(record);
    }
    return { records, ids };
}
function sameIds(left, right) {
    return left.size === right.size && [...left].every((id) => right.has(id));
}
function subsetIds(subset, superset) {
    return [...subset].every((id) => superset.has(id));
}
function channelMemberView(body, expectedChatId) {
    const info = extractChannelInfo(body, expectedChatId);
    const activeMembers = requiredNonNegativeInteger(info.activeMembersCount, 'activeMembersCount');
    const displayMembers = exactMemberRecords(info.displayMembers ?? [], 'CHATINFO');
    if (displayMembers.records.length > activeMembers) {
        throw new Error('CHATINFO member snapshot invalid');
    }
    return {
        activeMembers,
        ...displayMembers,
    };
}
function formatMessages(logs, count, chatId, nameCache) {
    logs.sort((a, b) => a.sendAt - b.sendAt);
    return logs.slice(-count).map((log) => ({
        log_id: longToString(log.logId),
        type: log.type,
        author_id: log.authorId,
        author_name: nameCache.lookup(chatId, log.authorId),
        message: log.message,
        attachment: parseAttachmentJson(log.attachment),
        sent_at: log.sendAt,
    }));
}
function formatForwardMessage(log, chatId, nameCache) {
    return {
        log_id: longToString(log.logId),
        type: log.type,
        author_id: log.authorId,
        author_name: nameCache.lookup(chatId, log.authorId),
        message: log.message,
        attachment: parseAttachmentJson(log.attachment),
        sent_at: log.sendAt,
    };
}
function buildMessagePage(logs, count, cursor, protocolComplete, chatId, nameCache) {
    const cursorValue = BigInt(cursor.toString());
    const unique = new Map();
    for (const log of logs) {
        const logId = longToString(log.logId);
        if (BigInt(logId) <= cursorValue)
            continue;
        if (!unique.has(logId))
            unique.set(logId, log);
    }
    const ordered = [...unique.entries()].sort(([left], [right]) => {
        const a = BigInt(left);
        const b = BigInt(right);
        return a < b ? -1 : a > b ? 1 : 0;
    });
    const selected = ordered.slice(0, count);
    const nextCursor = selected.at(-1)?.[0] ?? null;
    return {
        messages: selected.map(([, log]) => formatForwardMessage(log, chatId, nameCache)),
        next_cursor: nextCursor,
        complete: protocolComplete && ordered.length <= count,
    };
}
function buildReplyExtra(target) {
    return {
        attach_only: false,
        attach_type: target.type,
        src_logId: target.log_id,
        src_userId: target.author_id,
        src_message: target.message,
        src_type: target.type,
        src_mentions: [],
        mentions: [],
    };
}
export class KakaoTalkClient {
    oauthToken = null;
    userId = null;
    deviceUuid = null;
    deviceType = 'tablet';
    state = null;
    initPromise = null;
    closed = false;
    pushHandlers = new Set();
    sessionEventHandlers = new Set();
    nameCache = new MemberNameCache();
    async login(credentials, accountId) {
        if (credentials) {
            if (!credentials.oauthToken)
                throw new KakaoTalkError('OAuth token is required', 'missing_token');
            if (!credentials.userId)
                throw new KakaoTalkError('User ID is required', 'missing_user_id');
            this.oauthToken = credentials.oauthToken;
            this.userId = credentials.userId;
            this.deviceUuid = credentials.deviceUuid ?? `agent-messenger-${credentials.userId}`;
            this.deviceType = credentials.deviceType ?? 'tablet';
            return this;
        }
        const { ensureKakaoAuth } = await import('./ensure-auth.js');
        const account = await ensureKakaoAuth(accountId);
        return this.login({
            oauthToken: account.oauth_token,
            userId: account.user_id,
            deviceUuid: account.device_uuid,
            deviceType: account.device_type,
        });
    }
    getCredentials() {
        this.ensureAuth();
        return {
            oauthToken: this.oauthToken,
            userId: this.userId,
            deviceUuid: this.deviceUuid,
            deviceType: this.deviceType,
        };
    }
    ensureAuth() {
        if (this.oauthToken === null) {
            throw new KakaoTalkError('Not authenticated. Call .login() first.', 'not_authenticated');
        }
    }
    async ensureSession() {
        this.ensureAuth();
        if (this.closed)
            throw new KakaoTalkError('Client is closed', 'client_closed');
        if (this.state)
            return this.state;
        // Guard against concurrent init — reuse the in-flight promise
        const isOwner = !this.initPromise;
        if (!this.initPromise) {
            this.initPromise = this.connect();
        }
        try {
            const state = await this.initPromise;
            // close() may have been called while we were awaiting connect()
            if (this.closed) {
                state.session.close();
                throw new KakaoTalkError('Client is closed', 'client_closed');
            }
            const wasNew = this.state !== state;
            this.state = state;
            if (isOwner && wasNew) {
                this.emitSessionEvent({ type: 'connected', userId: this.userId });
            }
            return state;
        }
        catch (error) {
            // Reset so next call retries cleanly; connect() already wraps in KakaoTalkError
            this.state = null;
            this.initPromise = null;
            throw error;
        }
    }
    async acquireSession() {
        const state = await this.ensureSession();
        return state.session;
    }
    onPush(handler) {
        this.pushHandlers.add(handler);
        return () => {
            this.pushHandlers.delete(handler);
        };
    }
    onSessionEvent(handler) {
        this.sessionEventHandlers.add(handler);
        return () => {
            this.sessionEventHandlers.delete(handler);
        };
    }
    isConnected() {
        return this.state !== null && !this.closed;
    }
    async executeWithReconnect(operation) {
        let state = await this.ensureSession();
        try {
            return await operation(state);
        }
        catch (error) {
            // Only retry when the session we started with is dead (desktop app eviction,
            // network drop, etc.). Comparing session identity (not just null) handles the case
            // where a concurrent call already reconnected and replaced this.state.
            if (this.state?.session === state.session)
                throw error;
            try {
                state.session.close();
            }
            catch { }
            // initPromise is intentionally NOT cleared here: a concurrent caller may already
            // be awaiting an in-flight replacement, and starting a parallel one would send a
            // second LOGINLIST with the same duuid — re-introducing the very self-eviction
            // this layer prevents. Lifecycle paths (onClose / invalidateSession) own that field.
            state = await this.ensureSession();
            return operation(state);
        }
    }
    async connect() {
        const session = new LocoSession();
        session.onPush((packet) => this.dispatchPush(session, packet));
        session.onClose(() => {
            if (this.state?.session === session) {
                this.state = null;
                this.initPromise = null;
                this.emitSessionEvent({ type: 'disconnected' });
            }
        });
        try {
            const syncState = await loadSyncState(this.deviceUuid);
            const loginResult = await session.login(this.oauthToken, this.userId, this.deviceUuid, syncState, this.deviceType);
            const newSyncState = mergeSyncState(syncState, loginResult);
            await saveSyncState(this.deviceUuid, newSyncState);
            this.nameCache.ingest((loginResult.chatDatas ?? []));
            return { session, loginResult };
        }
        catch (error) {
            session.close();
            const code = isLoginResponseError(error) ? error.code : 'login_failed';
            throw new KakaoTalkError(error instanceof Error ? error.message : String(error), code, {
                cause: error,
                serverStatus: isLoginResponseError(error) ? error.serverStatus : undefined,
            });
        }
    }
    dispatchPush(session, packet) {
        // Only fan out pushes from the currently adopted session. While state is null
        // (pre-adoption during connect, or post-invalidation during reconnect) the
        // packet is discarded — we never want a not-yet-adopted or already-dead session
        // to reach subscribers and look "live".
        if (this.state?.session !== session)
            return;
        if (packet.method === 'KICKOUT') {
            this.emitSessionEvent({ type: 'kicked', reason: 'Session kicked — another device logged in' });
            this.invalidateSession(session);
            return;
        }
        if (packet.method === 'CHANGESVR') {
            for (const handler of this.pushHandlers) {
                try {
                    handler(packet);
                }
                catch { }
            }
            this.invalidateSession(session);
            this.emitSessionEvent({ type: 'disconnected' });
            this.ensureSession().catch(() => {
                // ensureSession already cleared state on failure; subsequent API calls will retry
                // and surface the error. Listeners do not receive 'connected' until a reconnect
                // succeeds, which is the correct outcome.
            });
            return;
        }
        for (const handler of this.pushHandlers) {
            try {
                handler(packet);
            }
            catch { }
        }
    }
    invalidateSession(session) {
        if (this.state?.session === session) {
            this.state = null;
            this.initPromise = null;
        }
        try {
            session.close();
        }
        catch { }
    }
    emitSessionEvent(event) {
        for (const handler of this.sessionEventHandlers) {
            try {
                handler(event);
            }
            catch { }
        }
    }
    async getChats(options) {
        return this.executeWithReconnect(async ({ session, loginResult }) => {
            try {
                const allChats = [];
                const seenChatIds = new Set();
                collectChats((loginResult.chatDatas ?? []), allChats, seenChatIds);
                // Paginate via LCHATLIST when explicitly requested (--all / --search) OR when
                // the login snapshot is empty. New device registrations often return an empty
                // chatDatas with eof=true because the server has no prior sync state for the
                // device — LCHATLIST fetches the canonical chat list regardless of device history.
                const snapshotEmpty = allChats.length === 0;
                if (options?.all || options?.search || snapshotEmpty) {
                    let cursor = loginResult;
                    let pages = 0;
                    const requireCompleteList = options?.all === true;
                    while (pages < MAX_PAGES) {
                        // Trust eof only when the snapshot had data. When the snapshot was empty
                        // (new device), ignore eof for the first iteration so we always attempt
                        // at least one LCHATLIST call.
                        if (cursor.eof && !snapshotEmpty)
                            break;
                        if (cursor.eof && snapshotEmpty && pages > 0)
                            break;
                        const lastTokenId = cursorToLong(cursor.lastTokenId);
                        const lastChatId = cursorToLong(cursor.lastChatId);
                        const response = await session.getChatList(lastTokenId, lastChatId);
                        if (requireCompleteList)
                            assertLocoOk(response, 'LCHATLIST');
                        const body = response.body;
                        if (requireCompleteList && !Array.isArray(body.chatDatas)) {
                            throw new Error('LCHATLIST pagination incomplete: chatDatas unavailable');
                        }
                        const chatDatas = (body.chatDatas ?? []);
                        cursor = body;
                        pages++;
                        if (chatDatas.length === 0) {
                            if (requireCompleteList && body.eof !== true) {
                                throw new Error('LCHATLIST pagination incomplete: empty non-EOF page');
                            }
                            break;
                        }
                        collectChats(chatDatas, allChats, seenChatIds);
                        this.nameCache.ingest(chatDatas);
                    }
                    if (requireCompleteList && cursor.eof !== true) {
                        throw new Error(`LCHATLIST pagination incomplete after ${pages} pages`);
                    }
                }
                allChats.sort((a, b) => (b.o ?? 0) - (a.o ?? 0));
                let results = allChats;
                if (options?.search) {
                    results = allChats.filter((c) => matchesSearch(c, options.search));
                }
                const titles = options?.resolveTitles
                    ? await Promise.all(results.map((chat) => this.fetchChatTitle(session, parseLong(longToString(chat.c)), chat)))
                    : null;
                return results.map((chat, i) => formatChat(chat, titles ? titles[i] : null, this.nameCache));
            }
            catch (error) {
                throw wrapError(error, 'get_chats_failed');
            }
        });
    }
    /**
     * Fetch one chat directly by id via read-only CHATINFO.
     *
     * Unlike `getChats()`, this does not depend on the login-time snapshot or
     * LCHATLIST pagination, so a room first observed from a live push can be
     * resolved without interpreting protocol fields outside this SDK.
     * The returned chat type preserves numeric values and non-empty protocol
     * strings, including DirectChat, MultiChat, PlusChat, MemoChat, OM, and OD;
     * unknown non-empty strings are preserved for forward compatibility.
     */
    async getChat(chatId) {
        const parsedChatId = parseChatId(chatId);
        const normalizedChatId = longToString(parsedChatId);
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const response = await session.getChannelInfo(parsedChatId);
                assertLocoOk(response, 'CHATINFO');
                const body = response.body;
                const chatInfo = body.chatInfo;
                const isLeftChatInfo = chatInfo !== null &&
                    typeof chatInfo === 'object' &&
                    !Array.isArray(chatInfo) &&
                    chatInfo.left === true;
                if (isLeftChatInfo) {
                    extractChannelInfo(body, normalizedChatId);
                }
                if (chatInfo === undefined || chatInfo === null || isLeftChatInfo) {
                    throw new KakaoTalkError('CHATINFO response missing chatInfo', 'get_chat_failed', {
                        responseFailureKind: 'transient_or_unknown',
                        getChatFailureReason: 'chat_info_absent',
                    });
                }
                const chat = channelInfoToChatData(body, normalizedChatId);
                this.nameCache.ingest([chat]);
                let title = extractTitle(body);
                if (!title && isOpenChat(chat)) {
                    const linkId = getOpenLinkId(chat);
                    if (linkId) {
                        try {
                            const openLinkResponse = await session.getOpenLinkInfo([linkId]);
                            title = extractOpenLinkName(openLinkResponse.body);
                        }
                        catch {
                            title = null;
                        }
                    }
                }
                return formatChat(chat, title, this.nameCache);
            }
            catch (error) {
                throw wrapError(error, 'get_chat_failed', {
                    classifyResponseFailure: true,
                    classifyGetChatFailure: true,
                });
            }
        });
    }
    /**
     * Resolve the user-set room title via CHATINFO. Returns null on any error
     * (network, malformed response, or no TITLE meta present). Designed to be
     * fire-and-forget per chat — failures don't poison the whole `getChats` call.
     */
    async getChatTitle(chatId) {
        let parsed;
        try {
            parsed = parseLong(chatId);
        }
        catch {
            return null;
        }
        return this.executeWithReconnect(async ({ session, loginResult }) => {
            const chat = (loginResult.chatDatas ?? []).find((c) => String(c.c) === chatId);
            return this.fetchChatTitle(session, parsed, chat);
        });
    }
    async fetchChatTitle(session, chatId, chat) {
        let title = null;
        try {
            const response = await session.getChannelInfo(chatId);
            title = extractTitle(response.body);
        }
        catch {
            title = null;
        }
        if (title)
            return title;
        if (!chat || !isOpenChat(chat))
            return null;
        const linkId = getOpenLinkId(chat);
        if (!linkId)
            return null;
        try {
            const response = await session.getOpenLinkInfo([linkId]);
            return extractOpenLinkName(response.body);
        }
        catch {
            return null;
        }
    }
    /**
     * Fetch one forward-only, lossless history page after `from`.
     *
     * The page never keeps only the newest `count` entries. If the protocol
     * returns more entries than requested, the oldest entries are returned and
     * `complete` remains false so callers can continue from `next_cursor`.
     */
    async getMessagePage(chatId, options) {
        const count = options?.count ?? 100;
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            throw new KakaoTalkError('Message page count must be an integer between 1 and 100', 'invalid_message_page_count');
        }
        const parsedChatId = parseChatId(chatId);
        const normalizedChatId = longToString(parsedChatId);
        const cursor = options?.from ? parseLogId(options.from) : Long.fromNumber(0);
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const response = await session.getChatLogs([parsedChatId], [cursor]);
                assertLocoOk(response, 'MCHATLOGS');
                const batch = (response.body.chatLogs ?? []).filter((log) => longToString(log.chatId) === normalizedChatId);
                if (batch.length > 0) {
                    return buildMessagePage(batch, count, cursor, response.body.eof === true, normalizedChatId, this.nameCache);
                }
                // CHATINFO is read-only and supplies a fresh lastLogId even for rooms
                // absent from the login snapshot. This avoids CHATONROOM, which can
                // advance server-side unread state.
                const chatInfoResponse = await session.getChannelInfo(parsedChatId);
                assertLocoOk(chatInfoResponse, 'CHATINFO');
                const maxLogId = extractChannelMaxLogId(chatInfoResponse.body, normalizedChatId);
                if (maxLogId.lessThanOrEqual(cursor)) {
                    return { messages: [], next_cursor: null, complete: true };
                }
                const syncResponse = await session.syncMessages(parsedChatId, Math.min(count, 80), cursor, maxLogId);
                assertLocoOk(syncResponse, 'SYNCMSG');
                const syncBatch = (syncResponse.body.chatLogs ?? []).filter((log) => longToString(log.chatId) === normalizedChatId);
                const maxReturned = findMaxLogId(syncBatch, 'logId');
                const protocolComplete = syncResponse.body.isOK === true || (maxReturned !== null && maxReturned.greaterThanOrEqual(maxLogId));
                return buildMessagePage(syncBatch, count, cursor, protocolComplete, normalizedChatId, this.nameCache);
            }
            catch (error) {
                throw wrapError(error, 'get_message_page_failed');
            }
        });
    }
    async getMessages(chatId, options) {
        return this.executeWithReconnect(async ({ session, loginResult }) => {
            try {
                const count = options?.count ?? 20;
                const cursor = options?.from ? parseLong(options.from) : undefined;
                const cid = parseLong(chatId);
                const allMessages = [];
                const seenLogIds = new Set();
                let cur = cursor ?? Long.fromNumber(0);
                try {
                    for (let page = 0; page < MAX_PAGES; page++) {
                        const response = await session.getChatLogs([cid], [cur]);
                        const responseStatus = response.body.status;
                        if (typeof responseStatus === 'number' && responseStatus !== 0) {
                            throw new Error(`MCHATLOGS failed: ${responseStatus}`);
                        }
                        const batch = (response.body.chatLogs ?? []).filter((log) => longToString(log.chatId) === chatId);
                        if (batch.length === 0) {
                            if (allMessages.length === 0)
                                break;
                            return formatMessages(allMessages, count, chatId, this.nameCache);
                        }
                        for (const log of batch) {
                            const lid = longToString(log.logId);
                            if (!seenLogIds.has(lid)) {
                                seenLogIds.add(lid);
                                allMessages.push(log);
                            }
                        }
                        const maxLog = findMaxLogId(batch, 'logId');
                        if (!maxLog || maxLog.equals(cur) || response.body.eof) {
                            return formatMessages(allMessages, count, chatId, this.nameCache);
                        }
                        cur = maxLog;
                    }
                }
                catch {
                    allMessages.length = 0;
                    seenLogIds.clear();
                    cur = cursor ?? Long.fromNumber(0);
                }
                if (allMessages.length > 0) {
                    warn(`[agent-kakaotalk] Warning: message fetch capped at ${MAX_PAGES} pages. Results may be incomplete.`);
                    return formatMessages(allMessages, count, chatId, this.nameCache);
                }
                // CHATONROOM represents entering a room and can advance unread state on
                // the server. Use the login-time chat-list watermark for the read-only
                // SYNCMSG fallback instead, and skip sync when the cursor is current.
                const maxLogId = getLoginMaxLogId(loginResult, chatId);
                if (!maxLogId || maxLogId.lessThanOrEqual(cur)) {
                    return [];
                }
                let reachedEnd = false;
                for (let page = 0; page < MAX_PAGES; page++) {
                    const response = await session.syncMessages(cid, 80, cur, maxLogId);
                    const batch = (response.body.chatLogs ?? []);
                    if (batch.length === 0) {
                        reachedEnd = true;
                        break;
                    }
                    for (const log of batch) {
                        const lid = longToString(log.logId);
                        if (!seenLogIds.has(lid)) {
                            seenLogIds.add(lid);
                            allMessages.push(log);
                        }
                    }
                    const maxLog = findMaxLogId(batch, 'logId');
                    if (!maxLog || maxLog.equals(cur) || response.body.isOK) {
                        reachedEnd = true;
                        break;
                    }
                    cur = maxLog;
                }
                if (!reachedEnd) {
                    warn(`[agent-kakaotalk] Warning: message fetch capped at ${MAX_PAGES} pages. Results may be incomplete.`);
                }
                return formatMessages(allMessages, count, chatId, this.nameCache);
            }
            catch (error) {
                throw wrapError(error, 'get_messages_failed');
            }
        });
    }
    async getMemberSnapshot(chatId) {
        const parsedChatId = parseChatId(chatId);
        const normalizedChatId = longToString(parsedChatId);
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const firstChatResponse = await session.getChannelInfo(parsedChatId);
                assertLocoOk(firstChatResponse, 'CHATINFO');
                const firstChat = channelMemberView(firstChatResponse.body, normalizedChatId);
                const firstMemberResponse = await session.getAllMembers(parsedChatId);
                assertLocoOk(firstMemberResponse, 'GETMEM');
                const firstMembers = exactMemberRecords(firstMemberResponse.body.members ?? [], 'GETMEM');
                const secondChatResponse = await session.getChannelInfo(parsedChatId);
                assertLocoOk(secondChatResponse, 'CHATINFO');
                const secondChat = channelMemberView(secondChatResponse.body, normalizedChatId);
                const secondMemberResponse = await session.getAllMembers(parsedChatId);
                assertLocoOk(secondMemberResponse, 'GETMEM');
                const secondMembers = exactMemberRecords(secondMemberResponse.body.members ?? [], 'GETMEM');
                if (firstChat.activeMembers !== secondChat.activeMembers ||
                    firstMembers.records.length !== firstChat.activeMembers ||
                    secondMembers.records.length !== secondChat.activeMembers ||
                    !sameIds(firstChat.ids, secondChat.ids) ||
                    !sameIds(firstMembers.ids, secondMembers.ids) ||
                    !subsetIds(secondChat.ids, secondMembers.ids)) {
                    throw new Error('member_snapshot_changed_or_incomplete');
                }
                return {
                    chat_id: normalizedChatId,
                    active_members: secondChat.activeMembers,
                    members: mergeMemberRecords(secondMembers.records, secondChat.records).map(formatMember),
                    complete: true,
                    consistency_basis: 'stable_double_read_chatinfo_getmem',
                };
            }
            catch (error) {
                throw wrapError(error, 'get_member_snapshot_failed');
            }
        });
    }
    async getMembers(chatId) {
        try {
            return (await this.getMemberSnapshot(chatId)).members;
        }
        catch (error) {
            if (error instanceof KakaoTalkError && error.code === 'get_member_snapshot_failed') {
                throw new KakaoTalkError(error.message, 'get_members_failed', {
                    cause: error,
                    serverStatus: error.serverStatus,
                });
            }
            throw error;
        }
    }
    async getMembersByIds(chatId, userIds) {
        if (userIds.length === 0)
            return [];
        const parsedChatId = parseChatId(chatId);
        const memberIds = userIds.map((id) => parseUserId(id));
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const response = await session.getMembersByIds(parsedChatId, memberIds);
                assertLocoOk(response, 'MEMBER');
                const members = (response.body.members ?? []);
                return members.map(formatMember);
            }
            catch (error) {
                throw wrapError(error, 'get_members_failed');
            }
        });
    }
    async sendMessage(chatId, text, options) {
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const response = options?.replyTo
                    ? await session.sendReply(parseLong(chatId), text, buildReplyExtra(options.replyTo))
                    : await session.sendMessage(parseLong(chatId), text);
                return {
                    success: response.statusCode === 0,
                    status_code: response.statusCode,
                    chat_id: chatId,
                    log_id: longToString(response.body.logId),
                    sent_at: response.body.sendAt,
                };
            }
            catch (error) {
                throw wrapError(error, 'send_message_failed');
            }
        });
    }
    async sendTyping(chatId, opts) {
        const parsedChatId = parseChatId(chatId);
        const parsedLinkId = opts?.linkId !== undefined ? parseLinkId(opts.linkId) : undefined;
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const response = await session.sendTyping(parsedChatId, parsedLinkId);
                // Throw on transport-level failure (incl. synthetic { statusCode: -1 }
                // from LocoConnection.handleClose) so executeWithReconnect retries on
                // a fresh session — matches the markRead pattern.
                if (response.statusCode !== 0) {
                    throw new Error(`ACTION failed: statusCode=${response.statusCode}`);
                }
                return {
                    success: true,
                    status_code: response.statusCode,
                    chat_id: chatId,
                };
            }
            catch (error) {
                throw wrapError(error, 'send_typing_failed');
            }
        });
    }
    async sendAttachment(chatId, dataOrAttachments, filename, mimeType) {
        const inputs = Array.isArray(dataOrAttachments)
            ? dataOrAttachments
            : [{ data: dataOrAttachments, filename: filename, mime: mimeType }];
        const plan = planAttachments(inputs);
        switch (plan.kind) {
            case 'single':
                return this.dispatchSingleAttachment(chatId, plan.resolved);
            case 'multiphoto':
                return this.sendMultiPhoto(chatId, plan.items.map((it) => ({ data: it.data, filename: it.filename })));
            case 'sequential': {
                let last = null;
                for (const r of plan.resolved) {
                    const result = await this.dispatchSingleAttachment(chatId, r);
                    if (!result.success)
                        return result;
                    last = result;
                }
                return last;
            }
        }
    }
    dispatchSingleAttachment(chatId, r) {
        switch (r.kind) {
            case 'photo':
                return this.sendPhoto(chatId, r.data, r.filename);
            case 'video':
                return this.sendVideo(chatId, r.data, r.filename);
            case 'audio':
                return this.sendAudio(chatId, r.data, r.filename);
            case 'file':
                return this.sendFile(chatId, r.data, r.filename, r.mime);
        }
    }
    async sendPhoto(chatId, photo, filename = 'image.jpg') {
        this.ensureAuth();
        const data = photo instanceof Uint8Array ? photo : new Uint8Array(photo);
        const dim = detectImageDimensions(data);
        const checksum = await sha1Hex(data);
        const ext = filename.includes('.') ? filename.split('.').pop() : 'jpg';
        return this.sendMediaViaLoco({
            chatId,
            data,
            msgType: KAKAO_MESSAGE_TYPE.PHOTO,
            filename,
            checksum,
            extension: ext,
            width: dim.width,
            height: dim.height,
            errorCode: 'send_photo_failed',
        });
    }
    async sendVideo(chatId, video, filename = 'video.mp4') {
        this.ensureAuth();
        const data = video instanceof Uint8Array ? video : new Uint8Array(video);
        const checksum = await sha1Hex(data);
        const ext = filename.includes('.') ? filename.split('.').pop() : 'mp4';
        return this.sendMediaViaLoco({
            chatId,
            data,
            msgType: KAKAO_MESSAGE_TYPE.VIDEO,
            filename,
            checksum,
            extension: ext,
            errorCode: 'send_video_failed',
        });
    }
    async sendAudio(chatId, audio, filename = 'audio.m4a') {
        this.ensureAuth();
        const data = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
        const checksum = await sha1Hex(data);
        const ext = filename.includes('.') ? filename.split('.').pop() : 'm4a';
        return this.sendMediaViaLoco({
            chatId,
            data,
            msgType: KAKAO_MESSAGE_TYPE.AUDIO,
            filename,
            checksum,
            extension: ext,
            errorCode: 'send_audio_failed',
        });
    }
    async sendFile(chatId, file, filename, mimeType = 'application/octet-stream') {
        void mimeType;
        this.ensureAuth();
        const data = file instanceof Uint8Array ? file : new Uint8Array(file);
        const checksum = await sha1Hex(data);
        const ext = filename.includes('.') ? filename.split('.').pop() : '';
        return this.sendMediaViaLoco({
            chatId,
            data,
            msgType: KAKAO_MESSAGE_TYPE.FILE,
            filename,
            checksum,
            extension: ext,
            errorCode: 'send_file_failed',
        });
    }
    async sendMultiPhoto(chatId, photos) {
        this.ensureAuth();
        if (photos.length < 2) {
            throw new KakaoTalkError('sendMultiPhoto requires at least 2 photos; use sendPhoto for a single image', 'send_multi_photo_failed');
        }
        const prepared = await Promise.all(photos.map(async (p, i) => {
            const bytes = p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data);
            const filename = p.filename ?? `image-${i + 1}.jpg`;
            const dim = detectImageDimensions(bytes);
            const checksum = (await sha1Hex(bytes)).toLowerCase();
            const ext = filename.includes('.') ? filename.split('.').pop() : 'jpg';
            return { bytes, filename, dim, checksum, ext };
        }));
        const parsedChatId = parseChatId(chatId);
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const mshipResp = await session.shipMultiMedia(parsedChatId, KAKAO_MESSAGE_TYPE.MULTIPHOTO, prepared.map((p) => p.bytes.byteLength), prepared.map((p) => p.checksum), prepared.map((p) => p.ext));
                if (mshipResp.statusCode !== 0) {
                    throw new KakaoTalkError(`MSHIP rejected (status ${mshipResp.statusCode})`, 'send_multi_photo_failed');
                }
                const body = mshipResp.body;
                const kl = body.kl;
                const vhl = body.vhl;
                const pl = body.pl;
                if (!kl ||
                    !vhl ||
                    !pl ||
                    kl.length !== prepared.length ||
                    vhl.length !== prepared.length ||
                    pl.length !== prepared.length) {
                    throw new KakaoTalkError(`MSHIP response arrays do not match prepared.length=${prepared.length}: ` +
                        `kl=${kl?.length} vhl=${vhl?.length} pl=${pl?.length}`, 'send_multi_photo_failed');
                }
                await Promise.all(prepared.map((p, i) => uploadMultiMediaEntry({
                    shipToken: kl[i],
                    shipHost: vhl[i],
                    shipPort: pl[i],
                    chatId: parsedChatId,
                    msgType: KAKAO_MESSAGE_TYPE.MULTIPHOTO,
                    userId: this.userId,
                    filename: p.filename,
                    data: p.bytes,
                    width: p.dim.width,
                    height: p.dim.height,
                    deviceType: this.deviceType,
                })));
                const extra = {
                    kl,
                    wl: prepared.map((p) => p.dim.width),
                    hl: prepared.map((p) => p.dim.height),
                    mtl: prepared.map((p) => p.dim.mimeType),
                    sl: prepared.map((p) => p.bytes.byteLength),
                    csl: prepared.map((p) => p.checksum),
                    cmtl: prepared.map(() => ''),
                };
                const forwardResp = await session.forwardChat(parsedChatId, KAKAO_MESSAGE_TYPE.MULTIPHOTO, extra);
                return {
                    success: forwardResp.statusCode === 0,
                    status_code: forwardResp.statusCode,
                    chat_id: chatId,
                    log_id: longToString(forwardResp.body.logId),
                    sent_at: forwardResp.body.sendAt ?? 0,
                };
            }
            catch (error) {
                throw wrapError(error, 'send_multi_photo_failed');
            }
        });
    }
    async sendMediaViaLoco(opts) {
        const parsedChatId = parseChatId(opts.chatId);
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const shipResp = await session.shipMedia(parsedChatId, opts.msgType, opts.data.byteLength, opts.checksum, opts.extension);
                if (shipResp.statusCode !== 0) {
                    throw new KakaoTalkError(`SHIP rejected (status ${shipResp.statusCode})`, opts.errorCode);
                }
                const body = shipResp.body;
                const shipToken = body.k;
                const shipHost = body.vh;
                const shipPort = body.p;
                if (typeof shipToken !== 'string' || typeof shipHost !== 'string' || typeof shipPort !== 'number') {
                    throw new KakaoTalkError(`SHIP response missing fields: k=${shipToken} vh=${shipHost} p=${shipPort}`, opts.errorCode);
                }
                const uploadRes = await uploadMediaToLoco({
                    shipToken,
                    shipHost,
                    shipPort,
                    chatId: parsedChatId,
                    msgType: opts.msgType,
                    userId: this.userId,
                    filename: opts.filename,
                    data: opts.data,
                    width: opts.width,
                    height: opts.height,
                    deviceType: this.deviceType,
                });
                const completeBody = uploadRes.completePacket?.body;
                const chatLog = completeBody?.chatLog;
                const logId = chatLog?.logId;
                return {
                    success: uploadRes.completePacket !== null && uploadRes.postStatusCode === 0,
                    status_code: uploadRes.postStatusCode,
                    chat_id: opts.chatId,
                    log_id: longToString(logId),
                    sent_at: chatLog?.sendAt ?? 0,
                };
            }
            catch (error) {
                throw wrapError(error, opts.errorCode);
            }
        });
    }
    /**
     * Advance the read watermark for `chatId` up to and including `logId`.
     * The caller decides open vs normal: pass `opts.linkId` for open chats
     * (오픈채팅) and omit it for normal chats. Open chats without a `linkId`
     * are rejected by the server with a non-zero `body.status` — this method
     * does not auto-detect.
     */
    async markRead(chatId, logId, opts) {
        const parsedChatId = parseChatId(chatId);
        const parsedWatermark = parseLogId(logId);
        const parsedLinkId = opts?.linkId !== undefined ? parseLinkId(opts.linkId) : undefined;
        return this.executeWithReconnect(async ({ session }) => {
            try {
                const response = await session.markRead(parsedChatId, parsedWatermark, parsedLinkId);
                // Throw on transport-level failure (incl. synthetic { statusCode: -1 }
                // from LocoConnection.handleClose) so executeWithReconnect retries on
                // a fresh session. The NOTIREAD command result lives in body.status.
                if (response.statusCode !== 0) {
                    throw new Error(`NOTIREAD failed: statusCode=${response.statusCode}`);
                }
                const bodyStatus = typeof response.body.status === 'number' ? response.body.status : 0;
                return {
                    success: bodyStatus === 0,
                    status_code: bodyStatus,
                    chat_id: chatId,
                    watermark: logId,
                };
            }
            catch (error) {
                throw wrapError(error, 'mark_read_failed');
            }
        });
    }
    async leaveChat(chatId) {
        const parsedChatId = parseChatId(chatId);
        return this.executeWithReconnect(async ({ session, loginResult }) => {
            try {
                const response = await session.leaveChat(parsedChatId);
                // Throw on transport-level failure (incl. synthetic { statusCode: -1 }
                // from LocoConnection.handleClose) so executeWithReconnect retries on
                // a fresh session. The LEAVE command result lives in statusCode.
                if (response.statusCode !== 0) {
                    throw new Error(`LEAVE failed: statusCode=${response.statusCode}`);
                }
                // Evict the departed chat from in-memory caches so subsequent getChats()
                // calls do not return stale entries for this room.  Normalize via
                // longToString(parsedChatId) so the cache key matches the canonical
                // format used by the server (e.g. "0100" → "100").
                const normalizedChatId = longToString(parsedChatId);
                const raw = (loginResult.chatDatas ?? []);
                const idx = raw.findIndex((c) => longToString(c.c) === normalizedChatId);
                if (idx !== -1)
                    raw.splice(idx, 1);
                this.nameCache.forget(normalizedChatId);
                return {
                    success: true,
                    status_code: 0,
                    chat_id: chatId,
                };
            }
            catch (error) {
                throw wrapError(error, 'leave_chat_failed');
            }
        });
    }
    async getProfile() {
        this.ensureAuth();
        try {
            const deviceConfig = getLocoDeviceConfig(this.deviceType);
            const isPC = deviceConfig.os !== 'android';
            const apiPrefix = isPC ? 'mac' : 'android';
            const userAgent = isPC
                ? `KT/${deviceConfig.appVersion} Md/${PC_OS_NAME} ${LANG}`
                : `KT/${deviceConfig.appVersion} An/13 ${LANG}`;
            const headers = {
                Authorization: `${this.oauthToken}-${this.deviceUuid}`,
                A: `${deviceConfig.os}/${deviceConfig.appVersion}/${LANG}`,
                'User-Agent': userAgent,
                Accept: '*/*',
                'Accept-Language': LANG,
            };
            const [profileRes, settingsRes] = await Promise.all([
                fetch(`https://katalk.kakao.com/${apiPrefix}/profile3/me.json`, { headers }),
                fetch(`https://katalk.kakao.com/${apiPrefix}/account/more_settings.json?since=0&lang=ko`, { headers }),
            ]);
            if (!profileRes.ok) {
                throw new KakaoTalkError(`Profile request failed: ${profileRes.status}`, 'profile_request_failed');
            }
            const profileData = (await profileRes.json());
            const profile = profileData.profile;
            let accountDisplayId = null;
            let accountEmail = null;
            let pstnNumber = null;
            let emailVerified = null;
            if (settingsRes.ok) {
                const settingsData = (await settingsRes.json());
                accountDisplayId = settingsData.accountDisplayId || null;
                accountEmail = settingsData.accountEmail || null;
                pstnNumber = settingsData.pstnNumber || null;
                emailVerified = typeof settingsData.emailVerified === 'boolean' ? settingsData.emailVerified : null;
            }
            return {
                user_id: this.userId,
                nickname: profile?.nickName || '',
                profile_image_url: profile?.profileImageUrl || null,
                original_profile_image_url: profile?.originalProfileImageUrl || null,
                background_image_url: profile?.backgroundImageUrl || null,
                original_background_image_url: profile?.originalBackgroundImageUrl || null,
                fullname: profile?.fullname || null,
                status_message: profile?.statusMessage || null,
                account_display_id: accountDisplayId,
                account_email: accountEmail,
                pstn_number: pstnNumber,
                email_verified: emailVerified,
            };
        }
        catch (error) {
            throw wrapError(error, 'get_profile_failed');
        }
    }
    close() {
        this.closed = true;
        if (this.state) {
            this.state.session.close();
        }
        else if (this.initPromise) {
            this.initPromise.then((s) => s.session.close()).catch(() => { });
        }
        this.state = null;
        this.initPromise = null;
        this.pushHandlers.clear();
        this.sessionEventHandlers.clear();
        this.nameCache.clear();
    }
    lookupAuthorName(chatId, authorId) {
        return this.nameCache.lookup(chatId, authorId);
    }
}
//# sourceMappingURL=client.js.map