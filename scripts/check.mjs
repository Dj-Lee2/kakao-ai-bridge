import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const dir of ['src', 'bin', 'test', 'scripts']) {
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
    const r = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
  }
}
console.log('Syntax checks passed.');
