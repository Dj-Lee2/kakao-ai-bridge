import { EventEmitter } from 'events';
import { KAKAO_EMOTICON_KIND_BY_TYPE, } from './types.js';
function longToString(v) {
    if (v && typeof v === 'object' && 'high' in v && 'low' in v) {
        const { high, low } = v;
        return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)).toString();
    }
    return String(v ?? 0);
}
function isEmoticonType(type) {
    return type in KAKAO_EMOTICON_KIND_BY_TYPE;
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
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function extractPackIdFromPath(path) {
    if (!path)
        return null;
    const dotIndex = path.indexOf('.');
    if (dotIndex <= 0)
        return null;
    const head = path.slice(0, dotIndex);
    return /^\d+$/.test(head) ? head : null;
}
export class KakaoTalkListener {
    client;
    running = false;
    emitter = new EventEmitter();
    unsubscribePush = null;
    unsubscribeSession = null;
    constructor(client) {
        this.client = client;
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        this.unsubscribePush = this.client.onPush((packet) => this.handlePush(packet));
        this.unsubscribeSession = this.client.onSessionEvent((event) => this.handleSessionEvent(event));
        const alreadyConnected = this.client.isConnected();
        try {
            await this.client.acquireSession();
            if (!this.running)
                return;
            if (alreadyConnected) {
                const { userId } = this.client.getCredentials();
                this.emitter.emit('connected', { userId });
            }
        }
        catch (error) {
            this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
            this.running = false;
            this.teardown();
        }
    }
    stop() {
        if (!this.running) {
            this.teardown();
            return;
        }
        this.running = false;
        this.teardown();
    }
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return this;
    }
    teardown() {
        this.unsubscribePush?.();
        this.unsubscribePush = null;
        this.unsubscribeSession?.();
        this.unsubscribeSession = null;
    }
    handleSessionEvent(event) {
        if (!this.running)
            return;
        switch (event.type) {
            case 'connected':
                this.emitter.emit('connected', { userId: event.userId });
                break;
            case 'disconnected':
                this.emitter.emit('disconnected');
                break;
            case 'kicked':
                this.emitter.emit('error', new Error(event.reason));
                this.running = false;
                this.teardown();
                break;
        }
    }
    handlePush(packet) {
        const { method, body } = packet;
        switch (method) {
            case 'MSG': {
                const chatLog = body.chatLog;
                const chatId = longToString(body.chatId);
                const authorId = chatLog.authorId;
                const logId = longToString(chatLog.logId);
                const messageType = chatLog.type;
                const authorName = this.client.lookupAuthorName?.(chatId, authorId) ?? null;
                const sentAt = chatLog.sendAt;
                const attachment = parseAttachmentJson(chatLog.attachment);
                const messageEvent = {
                    type: 'MSG',
                    chat_id: chatId,
                    log_id: logId,
                    author_id: authorId,
                    author_name: authorName,
                    message: chatLog.message,
                    message_type: messageType,
                    attachment,
                    sent_at: sentAt,
                };
                this.emitter.emit('message', messageEvent);
                if (isEmoticonType(messageType)) {
                    const stickerPath = nonEmptyString(attachment?.path) ?? nonEmptyString(attachment?.emoticonItemPath);
                    const emoticonEvent = {
                        type: 'EMOTICON',
                        chat_id: chatId,
                        log_id: logId,
                        author_id: authorId,
                        author_name: authorName,
                        message_type: messageType,
                        emoticon_kind: KAKAO_EMOTICON_KIND_BY_TYPE[messageType],
                        pack_id: extractPackIdFromPath(stickerPath),
                        sticker_path: stickerPath,
                        sent_at: sentAt,
                    };
                    this.emitter.emit('emoticon', emoticonEvent);
                }
                this.emitter.emit('kakaotalk_event', { type: method, ...body });
                break;
            }
            case 'NEWMEM': {
                const chatLog = body.chatLog;
                const event = {
                    type: 'NEWMEM',
                    chat_id: longToString(body.chatId),
                    member: { user_id: chatLog.authorId },
                };
                this.emitter.emit('member_joined', event);
                this.emitter.emit('kakaotalk_event', { type: method, ...body });
                break;
            }
            case 'DELMEM': {
                const chatLog = body.chatLog;
                const event = {
                    type: 'DELMEM',
                    chat_id: longToString(body.chatId),
                    member: { user_id: chatLog.authorId },
                };
                this.emitter.emit('member_left', event);
                this.emitter.emit('kakaotalk_event', { type: method, ...body });
                break;
            }
            case 'DECUNREAD': {
                const event = {
                    type: 'DECUNREAD',
                    chat_id: longToString(body.chatId),
                    user_id: body.userId,
                    watermark: longToString(body.watermark),
                };
                this.emitter.emit('read', event);
                this.emitter.emit('kakaotalk_event', { type: method, ...body });
                break;
            }
            default: {
                const event = { type: method, ...body };
                this.emitter.emit('kakaotalk_event', event);
                break;
            }
        }
    }
}
//# sourceMappingURL=listener.js.map