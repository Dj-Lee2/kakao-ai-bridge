import { guessMimeFromFilename } from './media-upload.js';
export function resolveAttachment(input) {
    // MIME types are case-insensitive per RFC 2045 §5.1; normalize so an `Image/JPEG`
    // override still routes to `photo` instead of falling through to `file`.
    const mime = (input.mime ?? guessMimeFromFilename(input.filename)).toLowerCase();
    const kind = mime.startsWith('image/')
        ? 'photo'
        : mime.startsWith('video/')
            ? 'video'
            : mime.startsWith('audio/')
                ? 'audio'
                : 'file';
    return { kind, mime, data: input.data, filename: input.filename };
}
export function planAttachments(items) {
    if (items.length === 0) {
        throw new Error('sendAttachment received an empty attachments array');
    }
    if (items.length === 1) {
        return { kind: 'single', resolved: resolveAttachment(items[0]) };
    }
    const resolved = items.map(resolveAttachment);
    // MULTIPHOTO (message_type 27) is image-only by KakaoTalk's wire protocol.
    if (resolved.every((r) => r.kind === 'photo')) {
        return { kind: 'multiphoto', items: items.slice() };
    }
    return { kind: 'sequential', resolved };
}
//# sourceMappingURL=attachment-router.js.map