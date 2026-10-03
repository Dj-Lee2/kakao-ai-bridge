import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
function owner(stat) { if (process.getuid && stat.uid !== process.getuid()) fail('state_owner_mismatch'); }
export function checkPrivateFile(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o077)) fail('unsafe_private_file');
  owner(s); if (s.size > 1048576) fail('state_file_too_large'); return s;
}
function noSymlinkAncestors(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('state_symlink'); }
    catch(e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export function privateDir(dir) {
  if (process.platform === 'win32') fail('native_windows_unsupported_use_wsl');
  noSymlinkAncestors(dir); fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || (s.mode & 0o077)) fail('unsafe_state_directory'); owner(s);
}
export function atomicJson(file, data) {
  if (fs.existsSync(file) || (()=>{try{return fs.lstatSync(file).isSymbolicLink();}catch{return false;}})()) checkPrivateFile(file);
  const tmp = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
    fs.renameSync(tmp,file);
    const d=fs.openSync(path.dirname(file),'r'); try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  } finally { if(fd !== undefined)fs.closeSync(fd); if(fs.existsSync(tmp))fs.unlinkSync(tmp); }
}
export class StateStore {
  constructor(root) { this.root=path.resolve(root); this.locked=false; }
  init() {
    const global=path.resolve(os.homedir(),'.config','agent-messenger');
    if(this.root===global || this.root.startsWith(global+path.sep)) fail('global_sdk_state_forbidden');
    privateDir(this.root); privateDir(path.join(this.root,'sdk'));
    const walk=dir=>{for(const item of fs.readdirSync(dir)){const p=path.join(dir,item); const s=fs.lstatSync(p);
      if(s.isDirectory()){privateDir(p);walk(p);}else checkPrivateFile(p);
    }}; walk(this.root); return this;
  }
  file(name) { if(!/^[a-z][a-z0-9-]*\.json$/.test(name))fail('invalid_state_name'); return path.join(this.root,name); }
  read(name, fallback) {
    const p=this.file(name); try{checkPrivateFile(p);}catch(e){if(e.code==='ENOENT')return fallback;throw e;}
    try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{fail('invalid_state_json');}
  }
  write(name, value) { atomicJson(this.file(name),value); }
  lock() {
    privateDir(this.root); const p=path.join(this.root,'lock.json');
    try {const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      this.locked=true;
    } catch(e) {if(e.code==='EEXIST')fail('state_locked');throw e;}
  }
  unlock() { if(this.locked){this.locked=false;fs.unlinkSync(path.join(this.root,'lock.json'));} }
}
