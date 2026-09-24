/**
 * Minimal client console served at GET /console: reconnect to a task, watch
 * its events, answer approvals and take/release control. Vanilla JS, no
 * external assets. The capability token lives in sessionStorage only.
 */
export function renderConsolePage(): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser Task Console</title>
<style>
:root{--bg:#fff;--fg:#1b1b1f;--muted:#666;--line:#ddd;--accent:#2b59c3;--warn:#b25b00}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e8e8ea;--muted:#9a9aa2;--line:#33343a;--accent:#7aa2ff;--warn:#f0a050}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:880px}
input{width:100%;box-sizing:border-box;padding:6px;margin:2px 0 8px;background:var(--bg);color:var(--fg);border:1px solid var(--line)}
button{margin:2px 4px 2px 0;padding:6px 10px;border:1px solid var(--line);background:var(--bg);color:var(--accent);cursor:pointer}
section{border:1px solid var(--line);padding:10px;margin:10px 0}pre{white-space:pre-wrap;word-break:break-word;margin:0}
.muted{color:var(--muted)}.warn{color:var(--warn)}#events{max-height:320px;overflow:auto}
</style></head><body>
<h1>Browser task console</h1>
<section><label>Interactive capability token<input id="token" type="password" autocomplete="off"></label>
<label>Task id<input id="taskId" autocomplete="off"></label>
<label>Tab id (for take over / release)<input id="tabId" autocomplete="off"></label>
<button id="connect">Connect</button><span id="conn" class="muted"></span></section>
<section><h2>Task</h2><pre id="task" class="muted">not connected</pre></section>
<section id="approvalBox" hidden><h2 class="warn">Approval required</h2><pre id="approval"></pre>
<button id="approve">Approve</button><button id="reject">Reject</button></section>
<section><h2>Control</h2><button id="takeOver">Take over</button><button id="release">Release</button>
<button id="resume">Resume</button><button id="stop">Stop</button><pre id="actionResult" class="muted"></pre></section>
<section><h2>Events</h2><pre id="events"></pre></section>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var S={cursor:0,seen:{},task:null,leaseEpoch:0,running:false,gen:0};
function store(k,v){try{if(v===undefined)return sessionStorage.getItem(k)||'';sessionStorage.setItem(k,v)}catch(e){return ''}}
$('token').value=store('abp.token');$('taskId').value=store('abp.taskId');$('tabId').value=store('abp.tabId');
function rid(){return (crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random())}
function op(name,body){return fetch('/v1/ops/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+$('token').value.trim()},body:JSON.stringify(body)})
 .then(function(r){return r.json()}).then(function(j){if(!j.ok){var e=new Error(j.error.code+': '+j.error.message);e.body=j.error;throw e}return j.result})}
function showTask(t){S.task=t;$('task').textContent=JSON.stringify({status:t.status,pauseReason:t.pauseReason,waitReason:t.waitReason,stateVersion:t.stateVersion,tabs:t.tabs,cancelRequested:t.cancelRequested,uncertainActions:t.uncertainActions},null,2);
 if(!$('tabId').value&&t.tabs&&t.tabs[0])$('tabId').value=t.tabs[0];
 var a=t.pendingApproval;$('approvalBox').hidden=!a;if(a)$('approval').textContent='origin: '+a.origin+'\\n'+a.description+'\\nexpires: '+new Date(a.expiresAtMs).toLocaleString()}
function addEvent(e){if(S.seen[e.seq])return;S.seen[e.seq]=1;if(e.seq>S.cursor)S.cursor=e.seq;if(typeof e.leaseEpoch==='number')S.leaseEpoch=Math.max(S.leaseEpoch,e.leaseEpoch);
 var line=document.createElement('div');line.textContent='#'+e.seq+' '+e.type+' '+JSON.stringify(e.data);$('events').prepend(line)}
function refresh(){return op('getTask',{taskId:$('taskId').value.trim()}).then(showTask)}
function loop(gen){if(gen!==S.gen)return;
 op('subscribe',{taskId:$('taskId').value.trim(),afterSeq:S.cursor,waitMs:25000}).then(function(r){
  if(gen!==S.gen)return;$('conn').textContent=' connected';
  if(r.kind==='snapshot-required'){S.cursor=r.highWatermarkSeq;S.seen={};showTask(r.snapshot)}
  else if(r.events.length){r.events.forEach(addEvent);return refresh()}
 }).then(function(){loop(gen)},function(e){$('conn').textContent=' '+e.message+' (retrying)';setTimeout(function(){loop(gen)},2000)})}
$('connect').onclick=function(){store('abp.token',$('token').value.trim());store('abp.taskId',$('taskId').value.trim());store('abp.tabId',$('tabId').value.trim());
 S.cursor=0;S.seen={};$('events').textContent='';var gen=++S.gen;refresh().then(function(){loop(gen)},function(e){$('conn').textContent=' '+e.message})};
function act(p){$('actionResult').textContent='...';p.then(function(r){$('actionResult').textContent=JSON.stringify(r.status||r.outcome||r.owner||r,null,0);if(r.task)showTask(r.task);if(typeof r.leaseEpoch==='number')S.leaseEpoch=r.leaseEpoch;return refresh()})
 .catch(function(e){$('actionResult').textContent=e.message})}
function decide(d){var a=S.task&&S.task.pendingApproval;if(!a)return;act(op('approve',{taskId:S.task.taskId,approvalId:a.approvalId,bindingHash:a.bindingHash,requestId:rid(),decision:d}))}
$('approve').onclick=function(){decide('approve')};$('reject').onclick=function(){decide('reject')};
$('takeOver').onclick=function(){act(op('takeOver',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:S.leaseEpoch,requestId:rid()}))};
$('release').onclick=function(){act(op('releaseControl',{taskId:$('taskId').value.trim(),tabId:$('tabId').value.trim(),expectedEpoch:S.leaseEpoch,requestId:rid()}))};
$('resume').onclick=function(){if(S.task)act(op('resume',{taskId:S.task.taskId,expectedVersion:S.task.stateVersion,requestId:rid()}))};
$('stop').onclick=function(){act(op('cancel',{taskId:$('taskId').value.trim(),requestId:rid()}))};
})();
</script></body></html>`
}
