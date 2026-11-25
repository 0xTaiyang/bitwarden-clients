/** No request details or credentials are interpolated into the page. */
export function sshRemoteApprovalPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SSH approval</title><style nonce="${nonce}">
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;padding:28px 20px;background:#101827;color:#f3f4f6}
main{max-width:440px;margin:8vh auto;padding:26px;border:1px solid #374151;border-radius:20px;background:#1f2937}
h1{font-size:26px;margin:0 0 20px}p{line-height:1.6;overflow-wrap:anywhere}#warning{color:#fbbf24}
.buttons{display:flex;gap:12px;margin:24px 0}.buttons[hidden]{display:none}button{flex:1;border:0;border-radius:12px;padding:15px;font:600 17px system-ui;background:#374151;color:white}
#approve{background:#2563eb}button:disabled{opacity:.45}#status{color:#cbd5e1;font-size:14px}
#success{display:none;margin:28px auto 18px;width:112px;height:112px;border-radius:50%;background:#14532d;color:#4ade80;align-items:center;justify-content:center}
#success svg{width:66px;height:66px;stroke:currentColor;stroke-width:7;fill:none;stroke-linecap:round;stroke-linejoin:round}
main.approved #success{display:flex}main.approved .buttons{display:none}main.approved #message{font-size:22px;font-weight:700;color:#86efac}main.approved #host,main.approved #warning{display:none}
@media(prefers-reduced-motion:no-preference){#success{animation:success-pop .28s ease-out}}
@keyframes success-pop{from{transform:scale(.65);opacity:.4}to{transform:scale(1);opacity:1}}
</style></head><body><main><h1>SSH approval</h1><p id="message">Connecting to your Mac…</p><p id="host"></p><p id="warning" hidden></p>
<div id="success" role="img" aria-label="Request approved"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="m14 33 12 12 25-27"/></svg></div><div class="buttons" hidden><button id="deny" disabled>Deny</button><button id="approve" disabled>Approve</button></div><p id="status" aria-live="polite"></p></main>
<script nonce="${nonce}">
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const message=document.getElementById('message'),host=document.getElementById('host'),warning=document.getElementById('warning'),status=document.getElementById('status');
const approve=document.getElementById('approve'),deny=document.getElementById('deny'),buttons=document.querySelector('.buttons');
let expiresAt=0,done=false,busy=false,poll;
function stop(text){done=true;clearInterval(poll);approve.disabled=deny.disabled=true;status.textContent=text}
function showApproved(){document.querySelector('main').classList.add('approved');message.textContent='Request approved';status.textContent='The SSH request is approved. You can close this page.'}
async function load(){
 if(done||busy)return;
 try{
  const r=await fetch('/api/ssh-approval',{headers:{Authorization:'Bearer '+token},cache:'no-store'});
  if(!r.ok){message.textContent='This request is no longer available.';stop('Expired, cancelled, or already answered. Retry SSH for a new request.');return}
  const data=await r.json();expiresAt=data.expiresAt;message.textContent=data.message;
  host.textContent=data.hostFingerprint?'Host fingerprint: '+data.hostFingerprint:'Host fingerprint is not available for this request.';
  warning.hidden=!data.warningMessage;warning.textContent=data.warningMessage||'';
  buttons.hidden=false;approve.disabled=deny.disabled=false;
  status.textContent='Expires in '+Math.max(0,Math.ceil((expiresAt-Date.now())/1000))+' seconds.';
 }catch{approve.disabled=deny.disabled=true;status.textContent='Cannot reach the Mac. Check that Surge Ponte is connected; retrying…'}
}
async function answer(approved){
 if(done||busy)return;
 if(Date.now()>=expiresAt){stop('Request expired. Retry SSH.');return}
 busy=true;approve.disabled=deny.disabled=true;
 try{
  const r=await fetch('/api/ssh-approval',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({approved})});
  if(r.ok&&approved){stop('');showApproved();return}
  stop(r.ok?'Denied. You can close this page.':'Request expired or already answered. Retry SSH.');
 }catch{stop('Could not confirm the result. Check the SSH client; retry SSH for a new request.')}
}
approve.addEventListener('click',()=>void answer(true));deny.addEventListener('click',()=>void answer(false));
if(!/^[a-f0-9]{64}$/.test(token)){message.textContent='Your Mac is reachable through Surge Ponte.';status.textContent='Open a Bark SSH notification to review a pending request.'}
else{void load();poll=setInterval(()=>void load(),1000)}
</script></body></html>`;
}
