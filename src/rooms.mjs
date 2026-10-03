import path from 'node:path';
import fs from 'node:fs';
import { checkPrivateFile } from './store.mjs';
import { validateSession } from './auth.mjs';
import { validId } from './config.mjs';
import { fail, deadline } from './errors.mjs';
function syncId(value){
  // SDK toLongLike writes signed BSON pairs OR unsigned halves for numeric IDs.
  const half=n=>Number.isInteger(n)&&n>=-2147483648&&n<=4294967295;
  if(!value || !half(value.low)||!half(value.high))fail('invalid_sdk_sync_state');
  const id=((BigInt(value.high>>>0)<<32n)|BigInt(value.low>>>0)).toString();
  if(!validId(id))fail('invalid_sdk_sync_state');return id;
}
function publicRoom(room){
  if(!validId(room?.chat_id))fail('invalid_room_list');
  return {chat_id:room.chat_id,type:room.type,name:room.title||room.display_name||null};
}
// SDK 2.38.1 can return an empty incremental login snapshot after saving sync state.
// Only recover this enrolled device's isolated metadata; never reset or read global state.
export async function listRooms(client,store){
  const direct=await client.getChats({all:true,resolveTitles:false});
  if(!Array.isArray(direct))fail('invalid_room_list');
  if(direct.length)return {source:'sdk',incomplete:false,failedCount:0,rooms:direct.map(publicRoom)};
  const session=validateSession(store.read('session.json'));
  const file=path.join(store.root,'sdk',`kakaotalk-sync-state-${session.deviceUuid}.json`);
  try{checkPrivateFile(file);}catch(error){if(error.code==='ENOENT')return {source:'empty_sdk_snapshot',incomplete:true,failedCount:0,rooms:[]};throw error;}
  let state;try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('invalid_sdk_sync_state');}
  if(state?.version!==2 || !Array.isArray(state.chatIds) || !Array.isArray(state.maxIds) || state.chatIds.length!==state.maxIds.length || state.chatIds.length>500)fail('invalid_sdk_sync_state');
  const ids=[...new Set(state.chatIds.map(syncId))];const rooms=[];let failedCount=0;
  for(const id of ids){
    try{const room=await deadline(client.getChat(id),5000);if(room?.chat_id!==id)fail('room_boundary');rooms.push(publicRoom(room));}
    catch{failedCount++;}
  }
  return {source:'private_sync_state',incomplete:failedCount>0||!ids.length,failedCount,rooms};
}
