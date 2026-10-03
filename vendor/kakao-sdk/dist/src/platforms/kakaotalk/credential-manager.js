import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfigDir } from '../../shared/utils/config-dir.js';
export class KakaoCredentialManager {
    configDir;
    credentialsPath;
    pendingLoginPath;
    constructor(configDir) {
        this.configDir = configDir ?? getConfigDir();
        this.credentialsPath = join(this.configDir, 'kakaotalk-credentials.json');
        this.pendingLoginPath = join(this.configDir, 'kakaotalk-pending-login.json');
    }
    async load() {
        if (!existsSync(this.credentialsPath)) {
            return { current_account: null, accounts: {} };
        }
        const content = await readFile(this.credentialsPath, 'utf-8');
        return JSON.parse(content);
    }
    async save(config) {
        await mkdir(this.configDir, { recursive: true });
        // TODO: Windows does not honor mode 0o600 — consider platform-specific credential storage
        await writeFile(this.credentialsPath, JSON.stringify(config, null, 2));
        await chmod(this.credentialsPath, 0o600);
    }
    async getAccount(id) {
        const config = await this.load();
        if (id) {
            return config.accounts[id] ?? null;
        }
        if (!config.current_account) {
            return null;
        }
        return config.accounts[config.current_account] ?? null;
    }
    async setAccount(account) {
        const config = await this.load();
        config.accounts[account.account_id] = account;
        if (!config.current_account) {
            config.current_account = account.account_id;
        }
        await this.save(config);
    }
    async removeAccount(id) {
        const config = await this.load();
        delete config.accounts[id];
        if (config.current_account === id) {
            config.current_account = Object.keys(config.accounts)[0] ?? null;
        }
        await this.save(config);
    }
    async listAccounts() {
        const config = await this.load();
        return Object.values(config.accounts).map((account) => ({
            ...account,
            is_current: account.account_id === config.current_account,
        }));
    }
    async setCurrentAccount(id) {
        const config = await this.load();
        config.current_account = id;
        await this.save(config);
    }
    async savePendingLogin(state) {
        await mkdir(this.configDir, { recursive: true });
        await writeFile(this.pendingLoginPath, JSON.stringify(state, null, 2));
        await chmod(this.pendingLoginPath, 0o600);
    }
    async loadPendingLogin() {
        if (!existsSync(this.pendingLoginPath))
            return null;
        const content = await readFile(this.pendingLoginPath, 'utf-8');
        return JSON.parse(content);
    }
    async clearPendingLogin() {
        if (existsSync(this.pendingLoginPath)) {
            await rm(this.pendingLoginPath, { force: true });
        }
    }
}
export { KakaoCredentialManager as CredentialManager };
//# sourceMappingURL=credential-manager.js.map