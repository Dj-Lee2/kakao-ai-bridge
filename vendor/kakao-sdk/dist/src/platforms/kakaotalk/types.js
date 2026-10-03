import { z } from 'zod';
export const KAKAO_NEXT_ACTIONS = {
    provide_email: { next_action: 'provide_email', message: 'Provide --email flag.' },
    provide_password: { next_action: 'provide_password', message: 'Provide --password flag.' },
    provide_passcode: {
        next_action: 'provide_passcode',
        message: 'SMS passcode sent to your phone. Provide --passcode flag.',
    },
    choose_device: {
        next_action: 'choose_device',
        message: 'Tablet slot occupied. Provide --device-type pc or --device-type tablet with --force to replace.',
    },
};
export const KNOWN_KAKAO_CHAT_STRING_TYPES = ['DirectChat', 'MultiChat', 'PlusChat', 'MemoChat', 'OM', 'OD'];
export function isKnownKakaoChatStringType(value) {
    return (typeof value === 'string' &&
        KNOWN_KAKAO_CHAT_STRING_TYPES.includes(value));
}
// LOCO message_type values. Source: KakaoTalk APK 26.4.2 + typeclaw inbound parser.
export const KAKAO_MESSAGE_TYPE = {
    TEXT: 1,
    PHOTO: 2,
    VIDEO: 3,
    AUDIO: 5,
    FILE: 18,
    REPLY: 26,
    MULTIPHOTO: 27,
};
export const KakaoChatSchema = z.object({
    chat_id: z.string(),
    type: z.union([z.number(), z.string().min(1)]),
    display_name: z.string().nullable(),
    title: z.string().nullable(),
    active_members: z.number(),
    unread_count: z.number(),
    last_message: z
        .object({
        author_id: z.number(),
        author_name: z.string().nullable(),
        message: z.string(),
        sent_at: z.number(),
    })
        .nullable(),
});
export const KakaoMessageSchema = z.object({
    log_id: z.string(),
    type: z.number(),
    author_id: z.number(),
    author_name: z.string().nullable(),
    message: z.string(),
    attachment: z.record(z.string(), z.unknown()).nullable(),
    sent_at: z.number(),
});
export const KakaoMessagePageSchema = z.object({
    messages: z.array(KakaoMessageSchema),
    next_cursor: z.string().nullable(),
    complete: z.boolean(),
});
export const KakaoMemberSchema = z.object({
    user_id: z.string(),
    nickname: z.string(),
    profile_image_url: z.string().nullable(),
    full_profile_image_url: z.string().nullable(),
    original_profile_image_url: z.string().nullable(),
    status_message: z.string().nullable(),
    country_iso: z.string().nullable(),
    user_type: z.number().nullable(),
    open_token: z.number().nullable(),
    open_profile_link_id: z.string().nullable(),
    open_permission: z.number().nullable(),
});
export const KakaoMemberSnapshotSchema = z.object({
    chat_id: z.string(),
    active_members: z.number().int().nonnegative(),
    members: z.array(KakaoMemberSchema),
    complete: z.literal(true),
    consistency_basis: z.literal('stable_double_read_chatinfo_getmem'),
});
export const KakaoSendResultSchema = z.object({
    success: z.boolean(),
    status_code: z.number(),
    chat_id: z.string(),
    log_id: z.string(),
    sent_at: z.number(),
});
export const KakaoMarkReadResultSchema = z.object({
    success: z.boolean(),
    status_code: z.number(),
    chat_id: z.string(),
    watermark: z.string(),
});
export const KakaoLeaveChatResultSchema = z.object({
    success: z.boolean(),
    status_code: z.number(),
    chat_id: z.string(),
});
export const KakaoTypingResultSchema = z.object({
    success: z.boolean(),
    status_code: z.number(),
    chat_id: z.string(),
});
export const KakaoProfileSchema = z.object({
    user_id: z.string(),
    nickname: z.string(),
    profile_image_url: z.string().nullable(),
    original_profile_image_url: z.string().nullable(),
    background_image_url: z.string().nullable().optional(),
    original_background_image_url: z.string().nullable().optional(),
    fullname: z.string().nullable().optional(),
    status_message: z.string().nullable(),
    account_display_id: z.string().nullable(),
    account_email: z.string().nullable().optional(),
    pstn_number: z.string().nullable().optional(),
    email_verified: z.boolean().nullable().optional(),
});
export const KakaoAccountCredentialsSchema = z.object({
    account_id: z.string(),
    oauth_token: z.string(),
    user_id: z.string(),
    refresh_token: z.string().optional(),
    device_uuid: z.string(),
    device_type: z.enum(['pc', 'tablet']),
    auth_method: z.enum(['login', 'extract']).optional(),
    created_at: z.string(),
    updated_at: z.string(),
});
export const KakaoConfigSchema = z.object({
    current_account: z.string().nullable(),
    accounts: z.record(z.string(), KakaoAccountCredentialsSchema),
});
export const KAKAO_EMOTICON_KIND_BY_TYPE = {
    6: 'ditem_emoticon',
    12: 'sticker',
    20: 'sticker_ani',
    22: 'actioncon',
    25: 'sticker_gif',
};
export const KAKAO_EMOTICON_MESSAGE_TYPES = Object.keys(KAKAO_EMOTICON_KIND_BY_TYPE).map(Number);
export const KakaoTalkPushMessageEventSchema = z.object({
    type: z.literal('MSG'),
    chat_id: z.string(),
    log_id: z.string(),
    author_id: z.number(),
    author_name: z.string().nullable(),
    message: z.string(),
    message_type: z.number(),
    attachment: z.record(z.string(), z.unknown()).nullable(),
    sent_at: z.number(),
});
export const KakaoTalkPushEmoticonEventSchema = z.object({
    type: z.literal('EMOTICON'),
    chat_id: z.string(),
    log_id: z.string(),
    author_id: z.number(),
    author_name: z.string().nullable(),
    message_type: z.union([z.literal(6), z.literal(12), z.literal(20), z.literal(22), z.literal(25)]),
    emoticon_kind: z.enum(['sticker', 'sticker_ani', 'actioncon', 'sticker_gif', 'ditem_emoticon']),
    pack_id: z.string().nullable(),
    sticker_path: z.string().nullable(),
    sent_at: z.number(),
});
export const KakaoTalkPushMemberEventSchema = z.object({
    type: z.enum(['NEWMEM', 'DELMEM']),
    chat_id: z.string(),
    member: z.object({ user_id: z.number() }),
});
export const KakaoTalkPushReadEventSchema = z.object({
    type: z.literal('DECUNREAD'),
    chat_id: z.string(),
    user_id: z.number(),
    watermark: z.string(),
});
//# sourceMappingURL=types.js.map