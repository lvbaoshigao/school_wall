function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
const CSRF=document.querySelector("meta[name=dashboard-csrf]").content;
const CAN_DB=document.body.dataset.canDb==='true';
// ===== 票据引导 =====
// 先用 HttpOnly Cookie（Path=/dashboard）换一枚 10 分钟的短期 API token，
// 存在页面内存里给下面的管理操作用 —— 修复了 TOKEN 固定为空导致所有按钮 401 的问题。
let TOKEN='';
let tokenReady=null;
let tokenExpiresAt=0;
function ensureToken(){
  if(!tokenReady || (tokenExpiresAt>0 && Date.now()>=tokenExpiresAt)){
    tokenExpiresAt=0;
    tokenReady=fetch('/dashboard/api/token',{method:'POST',headers:{'X-Dashboard-CSRF':CSRF}})
      .then(r=>{if(!r.ok)throw new Error('token 获取失败');return r.json()})
      .then(d=>{TOKEN=d.token;tokenExpiresAt=Date.now()+9*60*1000})
      .catch(e=>{tokenReady=null;throw e});
  }
  return tokenReady;
}
ensureToken().catch(()=>{});

async function api(url,method,body){
  await ensureToken();
  const r=await fetch(url,{method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
  return d;
}

// ===== 轻量 toast =====
function showToast(msg,type){
  const box=document.getElementById('toasts');
  const el=document.createElement('div');
  el.className='toast'+(type==='err'?' err':type==='ok'?' ok':'');
  el.textContent=msg;
  box.appendChild(el);
  setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300)},3600);
}

// ===== 公告 =====
async function publishAnn(){
  const title=document.getElementById('ann-title').value;
  const content=document.getElementById('ann-content').value;
  const is_pinned=document.getElementById('ann-pinned').value==='1';
  const delete_at=document.getElementById('ann-delete-at').value;
  if(!title||!content)return showToast('请填写标题和内容','err');
  try{await api('/api/admin/announcements','POST',{title,content,is_pinned,delete_at});showToast('公告已发布','ok');setTimeout(()=>location.reload(),600)}
  catch(e){showToast(e.message,'err')}
}
async function deleteAnn(id){if(!confirm('确定删除该公告?'))return;try{await api('/api/admin/announcements/'+id,'DELETE');location.reload()}catch(e){showToast(e.message,'err')}}

// ===== 帖子 =====
async function deletePost(id){if(!confirm('确定删除该帖子?'))return;try{await api('/api/admin/posts/'+id,'DELETE');location.reload()}catch(e){showToast(e.message,'err')}}

// ===== 用户设置弹窗 =====
let modalReturnFocus=null;
function showSettings(id,username,role,status){
  modalReturnFocus=document.activeElement;
  document.getElementById('modal-user-id').value=id;
  document.getElementById('modal-username').textContent=username;
  document.getElementById('modal-role').value=role;
  document.getElementById('modal-ban-duration').value=0;
  const modal=document.getElementById('settingsModal');
  modal.classList.add('active');
  modal.focus();
}
function closeModal(){document.getElementById('settingsModal').classList.remove('active');modalReturnFocus?.focus();}

async function saveSettings(){
  const id=document.getElementById('modal-user-id').value;
  const role=document.getElementById('modal-role').value;
  try{await api('/api/admin/users/'+id+'/role','PUT',{role});showToast('角色已更新','ok');setTimeout(()=>location.reload(),600)}
  catch(e){showToast(e.message,'err')}
}
async function banFromModal(){
  const id=document.getElementById('modal-user-id').value;
  const duration=parseInt(document.getElementById('modal-ban-duration').value)||0;
  try{await api('/api/admin/users/'+id+'/ban','PUT',{banned:true,duration});showToast('已封禁','ok');setTimeout(()=>location.reload(),600)}
  catch(e){showToast(e.message,'err')}
}
document.getElementById('settingsModal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal()});

// ===== 数据库管理 =====
function fmtSize(n){
  if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB';
  if(n>=1048576)return (n/1048576).toFixed(2)+' MB';
  if(n>=1024)return (n/1024).toFixed(1)+' KB';
  return n+' B';
}
async function dbApi(path,method,body){
  const r=await fetch('/dashboard/api/db'+path,{method,headers:{'Content-Type':'application/json','X-Dashboard-CSRF':CSRF},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
  return d;
}
async function loadDbStatus(){
  try{
    const s=await dbApi('/status');
    document.getElementById('db-meta').innerHTML=
      '<div class="item"><div class="v">'+fmtSize(s.db_size)+'</div><div class="k">数据库大小</div></div>'+
      '<div class="item"><div class="v">'+s.total_rows+'</div><div class="k">总行数 / '+s.tables.length+' 张表</div></div>'+
      '<div class="item"><div class="v">'+s.backups+'</div><div class="k">备份份数</div></div>'+
      '<div class="item"><div class="v">'+fmtSize(s.upload_size||0)+'</div><div class="k">上传文件体积</div></div>';
  }catch(e){document.getElementById('db-meta').innerHTML='<div class="item"><div class="k">加载失败: '+escapeHtml(e.message)+'</div></div>'}
}
async function makeBackup(){
  try{const r=await dbApi('/backup','POST',{});showToast(r.message,'ok');loadBackups();loadDbStatus()}
  catch(e){showToast(e.message,'err')}
}
async function loadBackups(){
  const tb=document.getElementById('backup-rows');
  try{
    const r=await dbApi('/backups');
    if(!r.backups.length){tb.innerHTML='<tr><td colspan="4" style="color:var(--faint)">还没有备份</td></tr>';return}
    tb.innerHTML=r.backups.map(b=>
      '<tr><td style="font-family:monospace">'+escapeHtml(b.name)+'</td><td>'+fmtSize(b.size)+'</td>'+
      '<td>'+new Date(b.created_at).toLocaleString('zh-CN')+'</td>'+
      '<td><a class="btn btn-ghost btn-sm" href="/dashboard/api/db/backups/'+encodeURIComponent(b.name)+'/download">下载</a> '+
      '<button class="btn btn-danger btn-sm" data-action="delBackup" data-name="'+escapeHtml(b.name)+'">删除</button></td></tr>').join('');
  }catch(e){tb.innerHTML='<tr><td colspan="4" style="color:var(--danger)">加载失败: '+escapeHtml(e.message)+'</td></tr>'}
}
async function delBackup(name){
  if(!confirm('确定删除备份 '+name+' ?'))return;
  try{await dbApi('/backups/'+encodeURIComponent(name),'DELETE');showToast('已删除','ok');loadBackups();loadDbStatus()}
  catch(e){showToast(e.message,'err')}
}

// ===== IP 白名单 =====
let wlEntries=[];
async function loadWhitelist(){
  try{
    const r=await dbApi('/whitelist');
    wlEntries=r.entries||[];
    document.getElementById('wl-mode').value=r.mode;
    document.getElementById('wl-myip').textContent=r.current_ip||'未知';
    document.getElementById('wl-env').textContent=r.env_entries&&r.env_entries.length?('环境变量条目: '+r.env_entries.join(', ')):'（环境变量 ADMIN_IP_WHITELIST 未配置）';
    renderWlTags();
  }catch(e){showToast('白名单加载失败: '+e.message,'err')}
}
function renderWlTags(){
  document.getElementById('wl-tags').innerHTML=wlEntries.map((e,i)=>
    '<span class="wl-tag">'+escapeHtml(e)+'<button aria-label="移除 '+escapeHtml(e)+'" data-action="removeWlEntry" data-index="'+i+'">×</button></span>').join('')||'';
}
function addWlEntry(){
  const inp=document.getElementById('wl-input');
  const v=inp.value.trim();
  if(!v)return;
  if(!/^[0-9a-fA-F.:*]{1,45}$/.test(v))return showToast('条目只能包含 IP 字符与 *','err');
  if(wlEntries.includes(v))return showToast('条目已存在','err');
  wlEntries.push(v);inp.value='';renderWlTags();
}
function removeWlEntry(i){wlEntries.splice(i,1);renderWlTags()}
async function saveWhitelist(){
  try{
    const mode=document.getElementById('wl-mode').value;
    const r=await dbApi('/whitelist','PUT',{mode,entries:wlEntries});
    showToast(r.message,'ok');
  }catch(e){showToast(e.message,'err')}
}

// ===== 一键删库 =====
let wipeCode='',wipeTimer=null;
async function wipePrepare(){
  try{
    const r=await dbApi('/wipe/prepare','POST',{});
    wipeCode=r.code;
    document.getElementById('wipe-step2').style.display='flex';
    document.getElementById('wipe-code').textContent=r.code;
    document.getElementById('wipe-input').value='';
    startWipeCountdown(r.wait_seconds);
    showToast('验证码已生成，10 秒冷却后可执行','ok');
  }catch(e){showToast(e.message,'err')}
}
function startWipeCountdown(wait){
  const btn=document.getElementById('wipe-exec-btn');
  let remain=wait;
  btn.disabled=true;
  clearInterval(wipeTimer);
  wipeTimer=setInterval(()=>{
    remain--;
    if(remain<=0){clearInterval(wipeTimer);btn.disabled=false;btn.textContent='确认删库';}
    else{btn.textContent='请等待 '+remain+' 秒…';}
  },1000);
}
async function wipeExecute(){
  const code=document.getElementById('wipe-input').value.trim().toUpperCase();
  if(code!==wipeCode)return showToast('验证码不正确','err');
  if(!confirm('最后确认：将清空全部数据并自动备份，继续吗?'))return;
  const btn=document.getElementById('wipe-exec-btn');
  btn.disabled=true;
  try{
    const r=await dbApi('/wipe/execute','POST',{code});
    document.body.innerHTML='<div style="font-family:sans-serif;background:#0b0d1a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center"><div style="text-align:center"><h1 style="color:#3ddc84">已清空</h1><p style="color:rgba(255,255,255,.6)">'+escapeHtml(r.message)+'</p><p style="color:rgba(255,255,255,.4);font-size:13px">自动备份: '+escapeHtml(r.backup.file)+' ('+fmtSize(r.backup.size)+')</p><a href="/" style="color:#7c8cf8">返回首页</a></div></div>';
  }catch(e){
    btn.disabled=false;
    showToast(e.message,'err');
    if(e.message.indexOf('秒')>=0)startWipeCountdown(3);
  }
}

const actions={publishAnn,deleteAnn:el=>deleteAnn(Number(el.dataset.id)),deletePost:el=>deletePost(Number(el.dataset.id)),
  showSettings:el=>showSettings(Number(el.dataset.id),el.dataset.username,el.dataset.role,el.dataset.status),
  makeBackup,loadBackups,addWlEntry,saveWhitelist,wipePrepare,wipeExecute,saveSettings,banFromModal,closeModal,
  delBackup:el=>delBackup(el.dataset.name),removeWlEntry:el=>removeWlEntry(Number(el.dataset.index))};
document.addEventListener('click',event=>{
  const control=event.target.closest('[data-action]');
  if(control && Object.prototype.hasOwnProperty.call(actions,control.dataset.action)) actions[control.dataset.action](control);
});
document.addEventListener('keydown',event=>{
  if(event.key==='Enter' && event.target.dataset.enterAction==='addWlEntry'){event.preventDefault();addWlEntry();}
  const modal=document.getElementById('settingsModal');
  if(!modal.classList.contains('active'))return;
  if(event.key==='Escape'){event.preventDefault();closeModal();return;}
  if(event.key==='Tab'){
    const controls=Array.from(modal.querySelectorAll('button:not([disabled]):not([hidden]),input:not([type=hidden]):not([disabled]),select:not([disabled])'));
    const first=controls[0],last=controls[controls.length-1];
    if(event.shiftKey && (document.activeElement===first || document.activeElement===modal)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey && (document.activeElement===last || document.activeElement===modal)){event.preventDefault();first?.focus();}
  }
});
if(CAN_DB){loadDbStatus();loadBackups();loadWhitelist();}


// ===== Overview dashboard data (cookie-authenticated, no private content) =====
const overviewStatus=document.getElementById('overview-status');
const overviewDays=document.getElementById('overview-days');
function formatCount(value){return value===null||value===undefined?'—':Number(value).toLocaleString('zh-CN')}
function addText(parent,tag,className,text){const el=document.createElement(tag);if(className)el.className=className;el.textContent=text;parent.appendChild(el);return el}
function renderOverviewTotals(data){
  const root=document.getElementById('overview-totals');root.replaceChildren();
  const fields=[['用户','users'],['正常状态用户','active_users'],['封禁用户','banned_users'],['墙','walls'],['启用墙','active_walls'],['成员关系','members'],['帖子','posts'],['匿名帖子','anonymous_posts'],['评论','comments'],['投票','votes'],['点赞','likes'],['公告','announcements'],['待处理','pending']];
  for(const [label,key] of fields){const card=document.createElement('div');card.className='overview-kpi';addText(card,'strong','',formatCount(data.totals?.[key]));addText(card,'span','',label);root.appendChild(card)}
}
function renderTrend(data){
  const root=document.getElementById('overview-trend');root.replaceChildren();
  const rows=Array.isArray(data.daily)?data.daily:[];
  if(!rows.length){addText(root,'p','overview-empty','所选时间段暂无趋势数据。');return}
  const keys=[['帖子','posts','posts'],['新用户','users','users'],['评论','comments','comments'],['投票','votes','votes']];
  const max={};for(const [,key] of keys)max[key]=Math.max(1,...rows.map(row=>Number(row[key])||0));
  for(const row of rows){
    const line=document.createElement('div');line.className='trend-row';addText(line,'time','',String(row.date||''));const bars=document.createElement('div');bars.className='trend-bars';
    for(const [label,key,cls] of keys){const item=document.createElement('div');item.className='trend-item';addText(item,'label','',label+' '+formatCount(row[key]));const track=document.createElement('div');track.className='bar-track';const fill=document.createElement('span');fill.className=cls;fill.style.width=Math.max(0,Math.min(100,(Number(row[key])||0)*100/max[key]))+'%';track.appendChild(fill);item.appendChild(track);bars.appendChild(item)}
    line.appendChild(bars);root.appendChild(line)
  }
}
function renderWalls(data){
  const root=document.getElementById('overview-walls');root.replaceChildren();
  const rows=Array.isArray(data.walls)?data.walls:[];const meta=data.walls_meta||{};
  if(meta.truncated)addText(root,'p','overview-muted','已显示 '+formatCount(rows.length)+' / '+formatCount(meta.total)+' 面墙（列表上限 '+formatCount(meta.limit)+'）');
  if(!rows.length){addText(root,'p','overview-empty','暂无可展示的墙数据。');return}
  for(const wall of rows){const item=document.createElement('div');item.className='wall-item';const left=document.createElement('div');addText(left,'strong','',wall.name||'未命名的墙');addText(left,'span','overview-muted',(wall.status==='active'?'已启用':'未启用')+' · '+formatCount(wall.posts_in_range)+' 篇近期帖子');const right=document.createElement('span');right.className='wall-count';right.textContent=formatCount(wall.members)+' 成员 · '+formatCount(wall.posts)+' 帖';item.append(left,right);root.appendChild(item)}
}
function renderTodos(data){
  const root=document.getElementById('overview-todos');root.replaceChildren();
  const rows=Array.isArray(data.todos)?data.todos:[];const meta=data.todos_meta||{};
  if(meta.truncated)addText(root,'p','overview-muted','已显示 '+formatCount(rows.length)+' / '+formatCount(meta.total)+' 项待办（列表上限 '+formatCount(meta.limit)+'）');
  if(!rows.length){addText(root,'p','overview-empty','当前没有可展示的待处理事项。');return}
  for(const todo of rows){const item=document.createElement('div');item.className='todo-item';const label=addText(item,'strong','',todo.title||todo.key||'待处理事项');addText(item,'span','wall-count',formatCount(todo.count));if(todo.wall_id!==null&&todo.wall_id!==undefined)label.title='墙 '+todo.wall_id+' · '+(todo.permission||'');root.appendChild(item)}
}
function renderSystem(data){
  const root=document.getElementById('overview-system');root.replaceChildren();const system=data.system;
  if(!system){addText(root,'p','overview-empty','运行信息不可用。');return}
  const mem=system.memory||{},db=system.database||{},visits=system.visits||{};
  const uptime=Math.max(0,Number(system.uptime_seconds)||0);const hours=Math.floor(uptime/3600),minutes=Math.floor((uptime%3600)/60);
  const traffic=formatCount(visits.visitors)+' 个访问标识 · '+formatCount(visits.requests)+' 次 API 请求（近 '+formatCount(visits.window_minutes)+' 分钟）';
  const pairs=[['运行时长',hours+' 小时 '+minutes+' 分'],['RSS',formatBytes(mem.rss_bytes)],['堆内存',formatBytes(mem.heap_used_bytes)+' / '+formatBytes(mem.heap_total_bytes)],['数据库',db.engine+(db.dirty?' · 有未落盘变更':' · 已同步')+(db.temporary?' · 临时会话':'')],['访问概览',traffic]];
  for(const [key,value] of pairs){const row=document.createElement('div');row.className='system-item';addText(row,'span','overview-muted',key);addText(row,'strong','',value);root.appendChild(row)}
  const note=['访问标识按登录用户或访客 IP 估算，不代表真实访客人数','统计 API 请求，不代表页面浏览量',visits.bounded?'采样有界（上限 '+formatCount(visits.identity_limit)+' 个标识）':'',visits.reset_on_restart?'服务重启后清零':''].filter(Boolean).join(' · ');
  if(note)addText(root,'p','overview-muted',note);
}
function formatBytes(value){const n=Number(value)||0;if(n>=1073741824)return(n/1073741824).toFixed(1)+' GB';if(n>=1048576)return(n/1048576).toFixed(1)+' MB';if(n>=1024)return(n/1024).toFixed(0)+' KB';return n+' B'}
let overviewRequestId=0;let overviewController=null;let hasOverviewData=false;let lastOverviewAt='';
const overviewSection=document.querySelector('[aria-labelledby=overview-title]');
const overviewRefresh=document.getElementById('overview-refresh');
function clearOverview(message){for(const id of ['overview-totals','overview-trend','overview-walls','overview-todos','overview-system'])document.getElementById(id)?.replaceChildren();overviewStatus.textContent=message;hasOverviewData=false;lastOverviewAt=''}
async function loadOverview(){
  overviewController?.abort();const requestId=++overviewRequestId;const controller=new AbortController();overviewController=controller;
  if(overviewSection)overviewSection.setAttribute('aria-busy','true');if(overviewRefresh)overviewRefresh.disabled=true;if(overviewDays)overviewDays.disabled=true;
  overviewStatus.textContent='正在读取概览…';
  const days=overviewDays.value;
  try{const response=await fetch('/dashboard/api/overview?days='+encodeURIComponent(days),{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',signal:controller.signal});const data=await response.json().catch(()=>({}));if(requestId!==overviewRequestId)return;
    if(response.status===401||response.status===403){clearOverview(response.status===401?'看板登录已失效，请重新进入。':'当前账号已无权查看此概览。');return}
    if(!response.ok)throw new Error(data.error||('HTTP '+response.status));
    renderOverviewTotals(data);renderTrend(data);renderWalls(data);renderTodos(data);renderSystem(data);hasOverviewData=true;lastOverviewAt=new Date().toLocaleTimeString('zh-CN');
    const range=data.range||{};const stamp=data.generated_at?new Date(data.generated_at).toLocaleString('zh-CN'):'';
    overviewStatus.textContent=(data.scope?.kind==='wall'?'墙范围':'全局范围')+' · '+(range.start_date||'')+' 至 '+(range.end_date||'')+' · '+(range.timezone||'本地时区')+' · 更新于 '+stamp;
  }catch(error){if(requestId!==overviewRequestId||error.name==='AbortError')return;overviewStatus.textContent=hasOverviewData?'刷新失败，仍显示 '+lastOverviewAt+' 成功加载的数据：'+error.message:'概览加载失败：'+error.message}
  finally{if(requestId===overviewRequestId){if(overviewSection)overviewSection.setAttribute('aria-busy','false');if(overviewRefresh)overviewRefresh.disabled=false;if(overviewDays)overviewDays.disabled=false}}
}
overviewDays?.addEventListener('change',loadOverview);
overviewRefresh?.addEventListener('click',loadOverview);
loadOverview();
