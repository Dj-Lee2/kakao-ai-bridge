import { validId } from './config.mjs';
import { fail, deadline } from './errors.mjs';
export function validateSession(s) {
  if (s?.version !== 1 || !validId(s.userId) || BigInt(s.userId)>BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof s.oauthToken!=='string' || !s.oauthToken || s.oauthToken.length>8192 ||
      typeof s.refreshToken!=='string' || s.refreshToken.length>8192 ||
      typeof s.deviceUuid!=='string' || s.deviceUuid.length!==64 || /[^a-f0-9]/.test(s.deviceUuid) || s.deviceType!=='tablet') fail('invalid_session');
  return s;
}
// Reuses the inspected SDK flow: attempt -> display passcode -> register -> attempt.
// No SDK CLI, desktop extraction, debug logger, raw provider result or force fallback.
export async function login({sdk,store,prompt,displayPasscode}) {
  const email=(await prompt('카카오 계정 이메일 (화면에 표시하지 않음): ')).trim();
  let password=await prompt('카카오 비밀번호 (화면에 표시하지 않음): ');
  if(!email || !password) fail('login_cancelled');
  let result;
  try {result=await deadline(sdk.loginFlow({email,password,deviceType:'tablet',force:false,
    savedDeviceUuid:store.read('session.json') ? validateSession(store.read('session.json')).deviceUuid : undefined,
    onPasscodeDisplay:code=>{if(!/^[0-9]{4,12}$/.test(String(code)) || /[^0-9]/.test(String(code)))fail('invalid_passcode');displayPasscode(String(code));}
  }),180000);}finally{password=undefined;}
  if(result?.next_action==='choose_device') fail('tablet_slot_occupied_no_force');
  if(!result?.authenticated || !result.credentials) fail('kakao_login_failed');
  const c=result.credentials;
  const session=validateSession({version:1,oauthToken:c.access_token,refreshToken:c.refresh_token||'',
    userId:c.user_id,deviceUuid:c.device_uuid,deviceType:c.device_type,createdAt:new Date().toISOString()});
  store.write('session.json',session); return true;
}
export async function connectClient(sdk, store) {
  const s=validateSession(store.read('session.json'));
  const client=new sdk.KakaoTalkClient();
  try {
    await client.login({oauthToken:s.oauthToken,userId:s.userId,deviceUuid:s.deviceUuid,deviceType:s.deviceType});
    const profile=await deadline(client.getProfile());
    if(profile?.user_id!==s.userId)fail('account_mismatch');
    return {client,selfId:s.userId};
  } catch(e){client.close();throw e;}
}
