import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fail } from './errors.mjs';
export function requireTty() {
  if(!process.stdin.isTTY || !process.stderr.isTTY)fail('interactive_terminal_required');
}
export async function hiddenPrompt(label) {
  requireTty();
  const output=new Writable({write(_chunk,_enc,done){done();}});
  const rl=createInterface({input:process.stdin,output,terminal:true});
  process.stderr.write(label);
  const abort=new AbortController();
  rl.on('SIGINT',()=>abort.abort());
  try {return await rl.question('',{signal:abort.signal});}
  catch{fail('login_cancelled');}
  finally{rl.close();output.destroy();process.stderr.write('\n');}
}
export function displayPasscode(code) {
  requireTty();
  // This deliberate local display is needed by Kakao registration. Never logged.
  process.stderr.write('휴대폰 카카오톡 인증 화면에만 이 코드를 입력하세요: '+code+'\n승인 대기 중…\n');
}
