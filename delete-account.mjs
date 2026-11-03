import {createApi,makeFlow,takeFlow,readReceipt,prepareReceipt,FLOW_KEY,RECEIPT_KEY} from './deletion-core.mjs';
import {config} from './config.mjs';
const $ = id => document.getElementById(id);
let session = null, busy = false, canSubmit = false;
const api = createApi(config);
let storage;
try { storage=window.sessionStorage; }
catch { storage={getItem:()=>null,removeItem:()=>{},setItem:()=>{throw new Error('LOGIN_STORAGE_UNAVAILABLE');}}; }
const roomRequests = new Map();
function message(text, kind='info') { $('status').textContent=text; $('status').className=`notice ${kind}`; }
const texts = {
  LOGIN_EXPIRED:'본인 확인 시간이 지났습니다. 같은 Google 계정으로 다시 확인해 주세요.',
  LOGIN_STORAGE_UNAVAILABLE:'이 브라우저에서 임시 확인 정보를 보관할 수 없습니다. 일반 브라우저에서 열거나 지원 이메일로 삭제를 요청해 주세요.',
  AUTH_REQUIRED:'로그인이 필요합니다. 같이룸에서 사용한 Google 계정으로 확인해 주세요.',
  REAUTH_REQUIRED:'최근 본인 확인이 필요합니다. 같은 Google 계정으로 다시 확인해 주세요.',
  ACCOUNT_CHANGED:'앞서 요청한 계정과 다릅니다. 원래 요청한 Google 계정으로 확인해 주세요.',
  HOST_ACTION_REQUIRED:'먼저 아래 방의 운영을 마무리해 주세요. 방을 유지하려면 지원 이메일로 방장 위임을 문의할 수 있습니다.',
  ACCOUNT_DELETION_PENDING:'이미 삭제를 접수했습니다. 요청한 기기 또는 이 페이지의 처리 상태 확인을 이용해 주세요.',
  ACCOUNT_UNAVAILABLE:'이 계정은 현재 이용할 수 없습니다. 삭제를 요청했다면 처리 상태를 확인해 주세요.',
  NETWORK_UNCERTAIN:'연결이 끊겨 결과를 확인하지 못했습니다. 다시 제출하기 전에 처리 상태를 확인해 주세요.',
  REQUEST_FAILED:'지금 확인하지 못했습니다. 잠시 뒤 다시 시도하거나 지원 이메일로 문의해 주세요.'
};
function showError(e) { message(texts[e?.message]||texts.REQUEST_FAILED,'error'); }
function updateButtons() { document.querySelectorAll('button').forEach(b=>b.disabled=busy); $('submit').disabled=busy||!session||!canSubmit||!$('agree').checked||$('confirmation').value.trim()!=='탈퇴'; }
async function run(action) { if(busy)return; busy=true; updateButtons(); try{await action();}catch(e){showError(e);}finally{busy=false;updateButtons();} }
function showStatus(status) {
  $('receipt-panel').hidden=false;
  if(status==='COMPLETED') { message('같이룸 계정 삭제가 완료됐습니다. Google 계정과 친구의 기록은 유지됩니다.','success'); $('account-panel').hidden=true; session=null; }
  else if(status==='PENDING') { message('삭제 요청을 접수했습니다. 사진 파일과 계정 정리가 끝나면 완료로 바뀝니다.','success'); $('account-panel').hidden=true; session=null; }
  else message('아직 접수 내역을 확인하지 못했습니다. 이 표시는 삭제 완료를 뜻하지 않습니다. 같은 계정으로 확인해 다시 요청하거나 문의해 주세요.');
}
async function refreshPreview() {
  canSubmit=false; $('confirmation-form').hidden=true; $('host-panel').hidden=true;
  const preview=await api.preview(session);
  $('account-label').textContent=session.user.email||'본인 확인된 Google 계정';
  $('account-panel').hidden=false; $('host-rooms').replaceChildren();
  const rooms=Array.isArray(preview?.host_rooms)?preview.host_rooms:[];
  $('host-panel').hidden=rooms.length===0;
  $('confirmation-form').hidden=rooms.length>0||preview.requested===true;
  for(const room of rooms) {
    const card=document.createElement('section'); card.className='host-room';
    const title=document.createElement('h3'); title.textContent=room.title||'내가 방장인 방';
    const note=document.createElement('p'); note.textContent='방을 종료하면 모든 참가자의 도전이 끝나고, 내 기록은 삭제됩니다. 친구는 본인의 기록 보관 방법을 선택할 수 있습니다.';
    const label=document.createElement('label'); label.className='check';
    const check=document.createElement('input');check.type='checkbox';
    label.append(check,document.createTextNode('이 방의 도전을 종료하는 데 동의합니다.'));
    const button=document.createElement('button');button.className='danger secondary';button.textContent='방 종료 후 내 참여 종료';
    button.onclick=()=>run(async()=>{
      if(!check.checked) {message('해당 방의 종료 내용을 확인하고 체크해 주세요.');return;}
      if(!roomRequests.has(room.room_id))roomRequests.set(room.room_id,crypto.randomUUID());
      await api.endHostedRoom(session,room.room_id,roomRequests.get(room.room_id));
      const fresh=await refreshPreview();
      if(fresh.host_rooms.some(item=>item.room_id===room.room_id))throw new Error('REQUEST_FAILED');
      message('방 종료를 처리했습니다. 남은 안내를 확인해 주세요.');
    });
    card.append(title,note,label,button);$('host-rooms').append(card);
  }
  if(preview.requested)message(texts.ACCOUNT_DELETION_PENDING);
  else if(rooms.length)message(texts.HOST_ACTION_REQUIRED);
  else if(preview.can_delete!==true)throw new Error('REQUEST_FAILED');
  else {canSubmit=true;message('본인 확인이 끝났습니다. 아래 삭제 범위를 확인해 주세요.');}
  return preview;
}
$('login').onclick=()=>run(async()=>{
  if(window.top!==window.self || location.href.split(/[?#]/)[0]!==config.redirect)throw new Error('REQUEST_FAILED');
  await api.signOut(session);session=null;
  location.assign(await makeFlow(config,storage));
});
$('cancel').onclick=()=>run(async()=>{
  await api.signOut(session);session=null;storage.removeItem(FLOW_KEY);
  $('account-panel').hidden=true;message('이 페이지에서 로그아웃했습니다. 기존 삭제 요청은 취소되지 않습니다.');
});
$('agree').onchange=updateButtons;$('confirmation').oninput=updateButtons;
$('confirmation-form').onsubmit=e=>{e.preventDefault();run(async()=>{
  if(!session||!canSubmit||!$('agree').checked||$('confirmation').value.trim()!=='탈퇴')return;
  const receipt=prepareReceipt(storage,session.user.id);
  $('receipt-panel').hidden=false;
  const result=await api.submit(session,receipt);
  showStatus(result);
});};
$('check-status').onclick=()=>run(async()=>{
  const receipt=readReceipt(storage);
  if(!receipt) {message('이 브라우저 탭에 확인 정보가 없습니다. 요청한 기기에서 확인하거나 지원 이메일로 문의해 주세요.');return;}
  showStatus(await api.status(receipt));
});
$('clear-status').onclick=()=>run(async()=>{
  if(!$('clear-agree').checked){message('확인 정보를 지우면 이 탭에서 상태를 다시 조회할 수 없습니다. 안내에 체크해 주세요.');return;}
  storage.removeItem(RECEIPT_KEY);$('receipt-panel').hidden=true;
  message('이 탭의 확인 정보만 지웠습니다. 서버에 접수한 삭제 요청은 취소되지 않습니다.');
});
async function initialize() {
  const url=new URL(location.href); const code=url.searchParams.get('code'); const authError=url.searchParams.has('error');
  // Remove callback artifacts before any API operation or UI error.
  if(url.search||url.hash)history.replaceState(null,'',url.pathname);
  if(window.top!==window.self){document.querySelector('main').replaceChildren(document.createTextNode('같이룸 지원 페이지를 새 창에서 직접 열어 주세요.'));return;}
  if(readReceipt(storage))$('receipt-panel').hidden=false;
  if(authError){storage.removeItem(FLOW_KEY);message('Google 본인 확인을 완료하지 않았습니다. 다시 확인할 수 있습니다.');return;}
  if(code) {
    const flow=takeFlow(storage,config.redirect);
    session=await api.exchange(code,flow.verifier);
    const receipt=readReceipt(storage);
    if(receipt&&receipt.userId!==session.user.id){await api.signOut(session);session=null;throw new Error('ACCOUNT_CHANGED');}
    await refreshPreview();
  }
}
function clearAccountView() {
  session=null;canSubmit=false;$('account-panel').hidden=true;
  $('account-label').textContent='';$('host-rooms').replaceChildren();
  $('agree').checked=false;$('confirmation').value='';updateButtons();
}
window.addEventListener('pagehide',clearAccountView);
window.addEventListener('pageshow',event=>{
  if(event.persisted){clearAccountView();message('계정 확인 화면을 다시 열었습니다. 계속하려면 Google로 본인을 확인해 주세요.');}
});
run(initialize);
