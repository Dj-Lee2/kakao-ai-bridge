import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fail } from './errors.mjs';
export async function loadSdk(store) {
  process.umask(0o077);
  store.init();
  // Override even if the calling shell has a global SDK state setting.
  process.env.AGENT_MESSENGER_CONFIG_DIR=path.join(store.root,'sdk');
  const require=createRequire(import.meta.url);
  const pkg=JSON.parse(fs.readFileSync(require.resolve('agent-messenger/package.json'),'utf8'));
  if(pkg.version!=='2.38.1')fail('unsupported_sdk_version');
  const sdk=await import('agent-messenger/kakaotalk');
  const {Long}=await import('bson');
  return {...sdk,Long};
}
