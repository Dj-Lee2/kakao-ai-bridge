#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireRunnable } from '../src/config.mjs';
import { StateStore, checkPrivateFile } from '../src/store.mjs';
import { loadSdk, assertSdkPackage } from '../src/sdk.mjs';
import { login, connectClient, validateSession } from '../src/auth.mjs';
import { hiddenPrompt, displayPasscode, requireTty } from '../src/prompt.mjs';
import { Bridge } from '../src/bridge.mjs';
import { listRooms } from '../src/rooms.mjs';
import { deadline, fail, safeCode } from '../src/errors.mjs';
process.umask(0o077);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const command=process.argv[2] || 'help';
const HELP='사용법: npm run setup | login | rooms | doctor | start\nsetup/doctor는 카카오/AI에 접속하지 않습니다. login/rooms/start는 본인 계정에만 사용하세요.\n';
async function main(){
  if(process.argv.length>3)fail('unexpected_arguments');
  if(['help','--help','-h'].includes(command)){process.stdout.write(HELP);return 0;}
  if(!['setup','login','rooms','doctor','start'].includes(command))fail('unknown_command');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22 || major>24 || (major===22&&minor<13))fail('node_22_13_through_24_required');
  if(process.platform==='win32')fail('native_windows_unsupported_use_wsl');
  if(command==='setup'){
    const target=path.join(process.cwd(),'.env');
    try {
      const fd=fs.openSync(target,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(fd,fs.readFileSync(path.join(root,'.env.example')));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      process.stdout.write('.env 생성 완료 (0600). AI 설정을 입력한 뒤 login, rooms, 허용 방 설정, doctor, start 순서로 진행하세요.\n');
    }catch(e){if(e.code!=='EEXIST')throw e;checkPrivateFile(target);process.stdout.write('.env가 있어 그대로 보존했습니다.\n');}
    return 0;
  }
  const cfg=loadConfig();const store=new StateStore(cfg.stateDir);
  if(command==='doctor'){
    const checks=[];
    function check(name,fn){try{fn();checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,code:safeCode(e)});}}
    check('configuration',()=>requireRunnable(cfg));
    check('session',()=>validateSession(store.read('session.json')));
    check('private_state',()=>{if(fs.existsSync(store.root))store.init();else fail('state_not_initialized');});
    check('pinned_sdk',assertSdkPackage);
    check('not_locked',()=>{if(fs.existsSync(path.join(store.root,'lock.json')))fail('state_locked');});
    process.stdout.write(JSON.stringify({offline:true,networkChecked:false,roomsConfigured:cfg.rooms.length,checks},null,2)+'\n');
    return checks.every(x=>x.ok)?0:1;
  }
  // Preflight must fail before SDK import, credentials or network when all rooms blocked.
  if(command==='start')requireRunnable(cfg);
  if(command==='login'||command==='rooms')requireTty();
  store.init();store.lock();let client,bridge;
  const stop=()=>{bridge?.stop('stopped');client?.close();};
  const signalStop=()=>{stop();if(!bridge){store.unlock();process.exit(130);}};
  process.once('SIGINT',signalStop);process.once('SIGTERM',signalStop);
  try{
    const sdk=await loadSdk(store);
    if(command==='login'){
      process.stderr.write('비공식 SDK입니다. 본인 전용 계정만 사용하고 다른 기기 세션 충돌 가능성을 확인하세요. 강제 로그인은 지원하지 않습니다.\n');
      await login({sdk,store,prompt:hiddenPrompt,displayPasscode});
      process.stdout.write('로그인 세션을 전용 비공개 디렉터리에 저장했습니다. 비밀번호는 저장하지 않았습니다.\n');return 0;
    }
    if(command==='rooms'){
      const consent=await hiddenPrompt('본인 계정에 연결하여 방 ID/이름 목록을 조회합니다. 계속하려면 yes: ');
      if(consent!=='yes')fail('cancelled');
    }
    const connected=await connectClient(sdk,store);client=connected.client;
    if(command==='rooms'){
      const result=await deadline(listRooms(client,store),60000);
      process.stdout.write(JSON.stringify(result,null,2)+'\n');
      if(result.incomplete)process.stderr.write('방 목록이 비어 있거나 일부 조회에 실패했습니다. 방이 없다고 단정할 수 없습니다. README를 확인하세요.\n');
      return result.incomplete?1:0;
    }
    const listener=new sdk.KakaoTalkListener(client);
    bridge=new Bridge({cfg,store,client,listener,Long:sdk.Long,selfId:connected.selfId,
      onEvent:code=>process.stdout.write(JSON.stringify({event:code})+'\n')});
    await bridge.start();const reason=await bridge.stopped;return reason==='stopped'?0:1;
  }finally{
    stop();process.removeListener('SIGINT',signalStop);process.removeListener('SIGTERM',signalStop);store.unlock();
  }
}
main().then(code=>process.exit(code)).catch(error=>{
  process.stderr.write('실패: '+safeCode(error)+'. README의 문제 해결 항목을 확인하세요.\n');process.exit(1);
});
