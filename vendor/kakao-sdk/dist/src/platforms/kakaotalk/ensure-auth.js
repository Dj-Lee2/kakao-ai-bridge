import { CredentialManager } from './credential-manager.js';
export async function ensureKakaoAuth(accountId) {
    const credManager = new CredentialManager();
    const account = await credManager.getAccount(accountId);
    if (account?.oauth_token) {
        return account;
    }
    throw new Error('No KakaoTalk credentials found. Run:\n' +
        '  agent-kakaotalk auth login     (recommended — registers as sub-device, desktop app stays running)');
}
//# sourceMappingURL=ensure-auth.js.map