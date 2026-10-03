import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fail } from './errors.mjs';
const require=createRequire(import.meta.url);
export function assertSdkPackage() {
  const pkg=JSON.parse(fs.readFileSync(require.resolve('@kakao-ai-bridge/kakao-sdk/package.json'),'utf8'));
  if(pkg.name!=='@kakao-ai-bridge/kakao-sdk' || pkg.version!=='2.38.1-kakao.1'
    || pkg.upstream?.name!=='agent-messenger' || pkg.upstream?.version!=='2.38.1'
    || pkg.upstream?.sha256!=='e72b7af4ad4a61c6263c9814438019ae043a1a339520addfddfa9591b5e4e22a'
    || pkg.dependencies?.bson!=='6.10.4' || pkg.dependencies?.zod!=='4.6.5')fail('unsupported_sdk_version');
  return pkg;
}
export async function loadSdk(store) {
  process.umask(0o077);
  store.init();
  // Keep upstream's environment name: override any inherited global SDK state.
  process.env.AGENT_MESSENGER_CONFIG_DIR=path.join(store.root,'sdk');
  assertSdkPackage();
  const sdk=await import('@kakao-ai-bridge/kakao-sdk');
  const {Long}=await import('bson');
  return {...sdk,Long};
}
