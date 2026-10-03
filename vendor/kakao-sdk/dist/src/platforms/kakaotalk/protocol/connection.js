import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { debug } from '../../../shared/utils/stderr.js';
import { LocoCrypto } from './crypto.js';
import { decodePacket, encodePacket } from './packet.js';
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
export class LocoConnection {
    socket = null;
    crypto = null;
    buffer = Buffer.alloc(0);
    decryptedBuffer = Buffer.alloc(0);
    packetIdCounter = 0;
    pendingResolvers = new Map();
    timedOutIds = new Set();
    pushHandler = null;
    closeHandler = null;
    async connectTls(host, port) {
        await new Promise((resolve, reject) => {
            const socket = tlsConnect({ host, port, rejectUnauthorized: true }, () => resolve());
            this.socket = socket;
            socket.on('error', reject);
            socket.on('data', (data) => this.onData(data));
            socket.on('close', () => this.handleClose());
        });
    }
    async connectSecure(host, port) {
        await new Promise((resolve, reject) => {
            const socket = netConnect({ host, port }, () => resolve());
            this.socket = socket;
            socket.on('error', reject);
            socket.on('data', (data) => this.onData(data));
            socket.on('close', () => this.handleClose());
        });
        await this.performHandshake();
    }
    async performHandshake() {
        this.crypto = new LocoCrypto();
        const handshakePacket = this.crypto.buildHandshakePacket();
        await this.write(handshakePacket);
    }
    // Writes raw bytes onto the LOCO stream after applying the same AES-128-GCM
    // framing as encrypted packets — used by the media-upload POST step where
    // the protocol expects the file payload to follow the POST request inside
    // the same encrypted channel (chunked into N frames automatically by the
    // crypto layer's 4-byte-size + nonce + ciphertext + tag wrapping).
    async writeRaw(data) {
        if (!this.crypto)
            throw new Error('crypto not initialised');
        const encrypted = this.crypto.encrypt(data);
        await this.write(encrypted);
    }
    async sendPacket(method, body = {}) {
        const packetId = ++this.packetIdCounter;
        const packet = {
            packetId,
            statusCode: 0,
            method,
            bodyType: 0,
            body,
        };
        const raw = encodePacket(packet);
        const data = this.crypto ? this.crypto.encrypt(raw) : raw;
        return new Promise((resolve, reject) => {
            let entry;
            const timer = setTimeout(() => {
                if (this.pendingResolvers.get(packetId) !== entry)
                    return;
                this.pendingResolvers.delete(packetId);
                this.timedOutIds.add(packetId);
                reject(new Error(`LOCO packet timeout: ${method} (${DEFAULT_SEND_TIMEOUT_MS}ms)`));
            }, DEFAULT_SEND_TIMEOUT_MS);
            entry = { resolve, timer };
            this.pendingResolvers.set(packetId, entry);
            void this.write(data).catch((error) => {
                if (this.pendingResolvers.get(packetId) !== entry)
                    return;
                clearTimeout(entry.timer);
                this.pendingResolvers.delete(packetId);
                this.timedOutIds.add(packetId);
                reject(error);
            });
        });
    }
    onPush(handler) {
        this.pushHandler = handler;
    }
    onClose(handler) {
        this.closeHandler = handler;
    }
    close() {
        this.socket?.destroy();
        this.socket = null;
        this.timedOutIds.clear();
    }
    write(data) {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('Socket not connected'));
                return;
            }
            this.socket.write(data, (err) => (err ? reject(err) : resolve()));
        });
    }
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
    }
    processBuffer() {
        while (this.buffer.length > 0) {
            if (this.crypto) {
                // Decrypt each frame and accumulate into decryptedBuffer.
                // A single LOCO packet may span multiple encrypted frames.
                if (this.buffer.length < 4)
                    return;
                const frameSize = this.buffer.readUInt32LE(0);
                if (this.buffer.length < 4 + frameSize)
                    return;
                const encryptedBody = this.buffer.subarray(4, 4 + frameSize);
                this.buffer = this.buffer.subarray(4 + frameSize);
                let decrypted;
                try {
                    decrypted = this.crypto.decrypt(encryptedBody);
                }
                catch (err) {
                    debug(`[loco] decrypt failed: ${err.message}`);
                    continue;
                }
                this.decryptedBuffer = Buffer.concat([this.decryptedBuffer, decrypted]);
                let result = decodePacket(this.decryptedBuffer);
                while (result) {
                    this.decryptedBuffer = this.decryptedBuffer.subarray(result.bytesConsumed);
                    this.dispatchPacket(result.packet);
                    result = decodePacket(this.decryptedBuffer);
                }
            }
            else {
                const result = decodePacket(this.buffer);
                if (!result)
                    return;
                this.buffer = this.buffer.subarray(result.bytesConsumed);
                this.dispatchPacket(result.packet);
            }
        }
    }
    dispatchPacket(packet) {
        if (this.timedOutIds.delete(packet.packetId))
            return;
        const entry = this.pendingResolvers.get(packet.packetId);
        if (entry) {
            clearTimeout(entry.timer);
            this.pendingResolvers.delete(packet.packetId);
            entry.resolve(packet);
        }
        else {
            this.pushHandler?.(packet);
        }
    }
    handleClose() {
        for (const entry of this.pendingResolvers.values()) {
            clearTimeout(entry.timer);
            entry.resolve({ packetId: 0, statusCode: -1, method: '', bodyType: 0, body: { error: 'connection closed' } });
        }
        this.pendingResolvers.clear();
        this.closeHandler?.();
    }
}
//# sourceMappingURL=connection.js.map