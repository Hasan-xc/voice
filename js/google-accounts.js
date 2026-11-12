// ---- Google multi-account model -----------------------------------------
let gAccounts=[],gLimits={},gModelOrder=[],gMode='auto',gManual={accountId:'',model:''};
let gAccOpen=new Set();
let toastTimer=null;
function toast(msg){
  const t=$('toast');if(!t)return;
  t.textContent=msg;t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),3800);
}
function gUid(){
  try{if(crypto&&crypto.randomUUID)return 'ga_'+crypto.randomUUID()}
  catch(e){}
  return 'ga_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
}
function newGAccount(name,key){
  return {id:gUid(),name:name||('حساب '+(gAccounts.length+1)),key:key||'',enabled:true,usage:{},exhausted:{},overrides:{}};
}
function normalizeGAccount(a,i){
  return {
    id:String((a&&a.id)||gUid()),name:String((a&&a.name)||('حساب '+(i+1))),key:String((a&&a.key)||''),
    enabled:!(a&&a.enabled===false),
    usage:(a&&a.usage&&typeof a.usage==='object')?a.usage:{},
    exhausted:(a&&a.exhausted&&typeof a.exhausted==='object')?a.exhausted:{},
    overrides:(a&&a.overrides&&typeof a.overrides==='object')?a.overrides:{}
  };
}
function gLabel(m){return GOOGLE_MODEL_LABELS[m]||m}
function ptDay(date){
  date=date||new Date();
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:GOOGLE_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const o={};parts.forEach(p=>{if(p.type!=='literal')o[p.type]=p.value});
  return o.year+'-'+o.month+'-'+o.day;
}
function nextQuotaReset(now){
  now=now||new Date();
  const start=now.getTime(),today=ptDay(now);
  let hi=start+36*3600*1000,t=start;
  while(t<hi&&ptDay(new Date(t))===today)t+=15*60*1000;
  hi=Math.min(hi,t);
  let lo=Math.max(start,hi-15*60*1000);
  while(hi-lo>1000){
    const mid=Math.floor((lo+hi)/2);
    if(ptDay(new Date(mid))===today)lo=mid;else hi=mid;
  }
  return new Date(hi);
}
function getQuotaReset(now){
  now=now||new Date();
  const day=ptDay(now),t=now.getTime();
  if(quotaResetCache.at>t&&quotaResetCache.day===day)return new Date(quotaResetCache.at);
  const r=nextQuotaReset(now);
  quotaResetCache={at:r.getTime(),day};
  return r;
}
function fmtDur(ms){
  let s=Math.max(0,Math.floor(ms/1000));
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  return [h,m,ss].map(x=>String(x).padStart(2,'0')).join(':');
}
function fmtTurkeyTime(d){
  return new Intl.DateTimeFormat('en-GB',{timeZone:TR_TZ,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d);
}
function ensureQuotaDay(){
  const day=ptDay();let changed=false;
  gAccounts.forEach(a=>{
    if(!a.usage||typeof a.usage!=='object')a.usage={};
    if(!a.exhausted||typeof a.exhausted!=='object')a.exhausted={};
    GOOGLE_MODELS.forEach(m=>{
      const u=a.usage[m];
      if(u&&u.day!==day){u.day=day;u.used=0;changed=true}
      if(a.exhausted[m]&&a.exhausted[m]!==day){delete a.exhausted[m];changed=true}
    });
  });
  return changed;
}
function accountLimit(a,m){
  const o=a&&a.overrides?a.overrides[m]:undefined;
  if(typeof o==='number'&&Number.isFinite(o)&&o>=0)return o;
  return typeof gLimits[m]==='number'&&Number.isFinite(gLimits[m])&&gLimits[m]>=0?gLimits[m]:10;
}
function accountUsed(a,m){
  const u=a&&a.usage?a.usage[m]:null;
  return u&&u.day===ptDay()?Math.max(0,Number(u.used)||0):0;
}
function accountExhausted(a,m){return !!(a&&a.exhausted&&a.exhausted[m]===ptDay())}
function accountRemaining(a,m){return accountExhausted(a,m)?0:Math.max(0,accountLimit(a,m)-accountUsed(a,m))}
function saveGoogleAccounts(){
  try{
    const remember=!!($('grem')&&$('grem').checked);
    const data=gAccounts.map(a=>({...a,key:remember?a.key:''}));
    localStorage.setItem(G_ACCOUNTS_KEY,JSON.stringify(data));
    if(remember&&gAccounts[0]&&gAccounts[0].key)localStorage.setItem('gkey',gAccounts[0].key);
    else localStorage.removeItem('gkey');
    localStorage.setItem(G_LIMITS_KEY,JSON.stringify(gLimits));
    localStorage.setItem(G_ORDER_KEY,JSON.stringify(gModelOrder));
    localStorage.setItem(G_MODE_KEY,gMode);
    localStorage.setItem(G_MANUAL_KEY,JSON.stringify(gManual));
  }catch(e){}
}
function googleAnyKey(){
  if(gMode==='manual'){
    let a=gAccounts.find(x=>x.id===gManual.accountId);
    if(a&&!a.enabled)a=null;
    a=a||gAccounts.find(x=>x.enabled);
    return a?a.key:'';
  }
  const a=gAccounts.find(x=>x.enabled&&x.key);
  return a?a.key:'';
}
function pickSlot(){
  ensureQuotaDay();
  if(gMode==='manual'){
    let a=gAccounts.find(x=>x.id===gManual.accountId);
    if(a&&!a.enabled)a=null;
    a=a||gAccounts.find(x=>x.enabled);
    const m=gManual.model||$('gmodel').value||GOOGLE_MODELS[0];
    if(!a||!a.key)return null;
    return {account:a,model:m,overLimit:accountExhausted(a,m)||accountUsed(a,m)>=accountLimit(a,m)};
  }
  for(const a of gAccounts){
    if(!a.enabled||!a.key)continue;
    for(const m of gModelOrder){
      if(accountExhausted(a,m))continue;
      if(accountUsed(a,m)<accountLimit(a,m))return {account:a,model:m};
    }
  }
  return null;
}
function reserveSlot(slot){
  ensureQuotaDay();
  const day=ptDay();
  if(!slot.account.usage)slot.account.usage={};
  const u=slot.account.usage[slot.model]||(slot.account.usage[slot.model]={day,used:0});
  if(u.day!==day){u.day=day;u.used=0}
  u.used=(Number(u.used)||0)+1;
  saveGoogleAccounts();updateGoogleQuotaUI();
}
function releaseSlot(slot){
  const u=slot&&slot.account&&slot.account.usage?slot.account.usage[slot.model]:null;
  if(u&&u.day===ptDay()&&u.used>0){u.used--;saveGoogleAccounts();updateGoogleQuotaUI()}
}
function acquireGoogleSlot(){
  ensureQuotaDay();
  const slot=pickSlot();
  if(!slot)return null;
  if(slot.overLimit&&Date.now()-gQuotaNoticeAt>8000){
    gQuotaNoticeAt=Date.now();
    toast(`تنبيه: ${slot.account.name} · ${gLabel(slot.model)} استُنفد، لكن الوضع اليدوي يسمح بالمتابعة.`);
  }
  reserveSlot(slot);
  return slot;
}
function markGoogleExhausted(slot){
  slot.account.exhausted=slot.account.exhausted||{};
  slot.account.exhausted[slot.model]=ptDay();
  saveGoogleAccounts();updateGoogleQuotaUI();
}
function showNoSlots(){
  const reset=getQuotaReset();
  const msg=`لا توجد حصة Google متاحة الآن. تتصفّر الحصة بعد ${fmtDur(reset-new Date())} (الساعة ${fmtTurkeyTime(reset)} بتوقيت تركيا). المقاطع المتبقية معلّقة ويمكنك متابعة «توليد الكل» لاحقاً.`;
  $('savemsg').textContent=msg;
  toast(msg);
}
function updateResetCountdown(){
  const el=$('gResetCountdown');if(!el)return;
  const now=new Date(),reset=getQuotaReset(now);
  el.textContent=`تتصفّر الحصة بعد ${fmtDur(reset-now)} (الساعة ${fmtTurkeyTime(reset)} بتوقيت تركيا)`;
}
function quotaAccountHTML(a){
  const day=ptDay();
  return GOOGLE_MODELS.map(m=>{
    const lim=accountLimit(a,m),rem=accountRemaining(a,m);
    const ex=a.exhausted&&a.exhausted[m]===day;
    const st=!a.enabled?'<span class="tag">معطّل</span>'
      :(!a.key?'<span class="g-acc-bad">بلا مفتاح</span>'
      :(ex?'<span class="g-acc-bad">استُنفد</span>':(rem<=0?'<span class="g-acc-bad">انتهت الحصة</span>':'<span class="g-acc-ok">نشط</span>')));
    return `<div class="g-acc-line"><b>${gLabel(m)}</b> باقي ${rem} من ${lim} · ${st}
      <button class="actbtn" type="button" data-edit="${m}">تعديل العدّاد</button>
      <button class="actbtn" type="button" data-reset="${m}">تصفير</button></div>`;
  }).join('');
}
function renderGoogleManual(){
  const sel=$('gManualAccount');if(!sel)return;
  const cur=gManual.accountId;
  const list=gAccounts.filter(a=>a.enabled);
  sel.innerHTML=list.length
    ?list.map(a=>`<option value="${esc(a.id)}"${a.id===cur?' selected':''}>${esc(a.name)}</option>`).join('')
    :'<option value="">لا حسابات مفعّلة</option>';
  if(!list.some(a=>a.id===cur)){
    gManual.accountId=list[0]?list[0].id:'';
    if(gManual.accountId)sel.value=gManual.accountId;
  }
  $('gManualRow').style.display=gMode==='manual'?'flex':'none';
  if(gManual.model&&[...$('gmodel').options].some(o=>o.value===gManual.model))$('gmodel').value=gManual.model;
}
function updateGoogleQuotaUI(){
  if(!$('gQuotaSummary'))return;
  const usable=gAccounts.filter(a=>a.enabled&&a.key);
  const totals=GOOGLE_MODELS.map(m=>{
    const rem=usable.reduce((s,a)=>s+accountRemaining(a,m),0);
    return `${gLabel(m)}: ${rem}`;
  });
  $('gQuotaSummary').innerHTML=`<b>إجمالي المتبقي:</b> ${totals.join(' · ')}`;
  document.querySelectorAll('#gAccounts [data-acc]').forEach(card=>{
    const a=gAccounts.find(x=>x.id===card.dataset.acc);if(!a)return;
    const q=card.querySelector('[data-quota]');
    if(q)q.innerHTML=quotaAccountHTML(a);
  });
  const n=gAccounts.filter(a=>a.enabled&&a.key).length;
  const ks=$('gkeyState');
  if(ks){ks.textContent=n?`${n} حساب نشط`:'لا مفاتيح';ks.className=n?'tag on':'tag bad'}
  const mi=$('gManualInfo');
  if(mi){
    const a=gAccounts.find(x=>x.id===gManual.accountId)||gAccounts.find(x=>x.enabled);
    const mm=gManual.model||$('gmodel').value||GOOGLE_MODELS[0];
    if(a){const rem=accountRemaining(a,mm),lim=accountLimit(a,mm);mi.textContent=`المتبقي: ${rem} من ${lim}`+(accountExhausted(a,mm)?' · استُنفد':'')+(a.key?'':' · بلا مفتاح')}
    else mi.textContent='';
  }
}
function renderGoogleAccounts(){
  const host=$('gAccounts');if(!host)return;
  host.innerHTML=gAccounts.map((a,i)=>{
    const open=gAccOpen.has(a.id);
    return `<div class="g-account${a.enabled?'':' off'}${open?' open':''}" data-acc="${esc(a.id)}">
    <div class="g-acc-row">
      <span class="g-acc-idx" title="${a.enabled?'مفعّل':'معطّل'}">${i+1}</span>
      <input class="g-acc-name" value="${esc(a.name)}" aria-label="اسم الحساب ${i+1}" placeholder="اسم الحساب">
      <input class="g-acc-key" type="password" value="${esc(a.key)}" placeholder="مفتاح API (AIza...)" dir="ltr" autocomplete="off" aria-label="مفتاح API للحساب ${i+1}">
      <button class="g-acc-gear" type="button" data-toggle="1" aria-expanded="${open}" title="خيارات الحساب" aria-label="خيارات ${esc(a.name)}">⚙</button>
      <button class="g-acc-del" type="button" title="حذف الحساب" aria-label="حذف ${esc(a.name)}">✕</button>
    </div>
    <div class="g-acc-details"${open?'':' hidden'}>
      <div class="g-acc-quota" data-quota>${quotaAccountHTML(a)}</div>
      <div class="g-acc-ov">حد خاص:
        ${GOOGLE_MODELS.map(m=>`<span>${gLabel(m)} <input type="number" min="0" step="1" data-ov="${esc(m)}" value="${esc(a.overrides&&a.overrides[m]!==undefined?String(a.overrides[m]):'')}" placeholder="تلقائي"></span>`).join(' ')}
      </div>
      <label class="g-acc-en"><input type="checkbox" class="g-acc-enabled" ${a.enabled?'checked':''}> مفعّل (يُستخدم في التوليد)</label>
    </div>
  </div>`}).join('');
  renderGoogleManual();
  updateGoogleQuotaUI();
}
function loadGoogleState(){
  loadGoogleVoiceCache();
  loadCustomGoogleVoices();
  let raw=null;try{raw=JSON.parse(lsGet(G_ACCOUNTS_KEY)||'null')}catch(e){}
  if(Array.isArray(raw)&&raw.length)gAccounts=raw.map(normalizeGAccount);
  else gAccounts=[newGAccount('حساب 1',lsGet('gkey')||'')];
  // Migrate a legacy single key even if an empty accounts list was stored.
  const legacy=lsGet('gkey')||'';
  if(legacy&&!gAccounts.some(a=>a.key))gAccounts[0].key=legacy;
  try{
    const l=JSON.parse(lsGet(G_LIMITS_KEY)||'null');
    if(l&&typeof l==='object')gLimits=l;
  }catch(e){}
  GOOGLE_MODELS.forEach(m=>{if(typeof gLimits[m]!=='number'||!Number.isFinite(gLimits[m])||gLimits[m]<0)gLimits[m]=10});
  try{
    const o=JSON.parse(lsGet(G_ORDER_KEY)||'null');
    if(Array.isArray(o))gModelOrder=[...new Set(o.filter(m=>GOOGLE_MODELS.includes(m)))];
  }catch(e){}
  if(!Array.isArray(gModelOrder)||!gModelOrder.length)gModelOrder=[...GOOGLE_MODELS];
  GOOGLE_MODELS.forEach(m=>{if(!gModelOrder.includes(m))gModelOrder.push(m)});
  gMode=lsGet(G_MODE_KEY)==='manual'?'manual':'auto';
  try{
    const m=JSON.parse(lsGet(G_MANUAL_KEY)||'null');
    if(m&&typeof m==='object')gManual=m;
  }catch(e){}
  if(!gAccounts.some(a=>a.id===gManual.accountId))gManual.accountId=gAccounts[0]?gAccounts[0].id:'';
  if(!GOOGLE_MODELS.includes(gManual.model))gManual.model=$('gmodel').value||GOOGLE_MODELS[0];
  $('grem').checked=gAccounts.some(a=>a.key);
  $('gmode').value=gMode;
  ensureQuotaDay();
  saveGoogleAccounts();
  renderGoogleAccounts();
  const gv=lsGet('gvoice')||'Kore';
  renderGoogleVoiceOptions(gv);
  const og=lsGet('orgvoice');
  if(og&&[...$('orGvoice').options].some(o=>o.value===og))$('orGvoice').value=og;
  $('gmodel').value=gManual.model;
  renderGoogleManual();
  updateGoogleQuotaUI();
  updateResetCountdown();
  setInterval(updateResetCountdown,1000);
  setInterval(()=>{if(ensureQuotaDay()){saveGoogleAccounts();updateGoogleQuotaUI();}},60000);
}

// ---- Google UI bindings --------------------------------------------------
$('gAddAccount').onclick=()=>{
  const a=newGAccount('حساب '+(gAccounts.length+1),'');
  gAccounts.push(a);
  if(!gManual.accountId)gManual.accountId=a.id;
  saveGoogleAccounts();renderGoogleAccounts();
  const last=document.querySelector(`#gAccounts [data-acc="${a.id}"] .g-acc-key`);
  if(last)last.focus();
};
$('gmode').onchange=()=>{
  gMode=$('gmode').value==='manual'?'manual':'auto';
  if(gMode==='manual'&&!gAccounts.some(a=>a.id===gManual.accountId))gManual.accountId=gAccounts[0]?gAccounts[0].id:'';
  saveGoogleAccounts();renderGoogleManual();updateGoogleQuotaUI();
};
$('gManualAccount').onchange=()=>{
  gManual.accountId=$('gManualAccount').value;
  saveGoogleAccounts();updateGoogleQuotaUI();
};
$('gmodel').addEventListener('change',()=>{
  gManual.model=$('gmodel').value;
  saveGoogleAccounts();updateGoogleQuotaUI();
});
$('gAccounts').addEventListener('input',e=>{
  const card=e.target.closest('[data-acc]');if(!card)return;
  const a=gAccounts.find(x=>x.id===card.dataset.acc);if(!a)return;
  if(e.target.classList.contains('g-acc-name')){a.name=e.target.value;saveGoogleAccounts()}
  else if(e.target.classList.contains('g-acc-key')){a.key=e.target.value;saveGoogleAccounts();keyState();updateGoogleQuotaUI()}
});
$('gAccounts').addEventListener('change',e=>{
  const card=e.target.closest('[data-acc]');if(!card)return;
  const a=gAccounts.find(x=>x.id===card.dataset.acc);if(!a)return;
  if(e.target.classList.contains('g-acc-enabled')){
    a.enabled=e.target.checked;saveGoogleAccounts();renderGoogleAccounts();
  }else if(e.target.classList.contains('g-acc-name')){
    a.name=e.target.value.trim()||a.name;saveGoogleAccounts();renderGoogleManual();
  }else if(e.target.matches('[data-ov]')){
    if(!a.overrides)a.overrides={};
    const v=e.target.value.trim();
    if(v==='')delete a.overrides[e.target.dataset.ov];
    else a.overrides[e.target.dataset.ov]=Math.max(0,Number(v)||0);
    saveGoogleAccounts();updateGoogleQuotaUI();
  }
});
$('gAccounts').addEventListener('click',e=>{
  const card=e.target.closest('[data-acc]');if(!card)return;
  const a=gAccounts.find(x=>x.id===card.dataset.acc);if(!a)return;
  const tg=e.target.closest('[data-toggle]');
  if(tg){
    const open=card.classList.toggle('open');
    const d=card.querySelector('.g-acc-details');
    if(d)d.hidden=!open;
    tg.setAttribute('aria-expanded',String(open));
    if(open)gAccOpen.add(a.id);else gAccOpen.delete(a.id);
    return;
  }
  if(e.target.classList.contains('g-acc-del')){
    if(gAccounts.length<=1){toast('احتفظ بحساب واحد على الأقل');return}
    if(!confirm(`حذف الحساب «${a.name}»؟\nلا يمكن التراجع عن هذا الإجراء.`))return;
    gAccounts=gAccounts.filter(x=>x.id!==a.id);
    gAccOpen.delete(a.id);
    if(gManual.accountId===a.id)gManual.accountId=gAccounts[0]?gAccounts[0].id:'';
    saveGoogleAccounts();renderGoogleAccounts();
    toast(`حُذف الحساب «${a.name}»`);
    return;
  }
  const edit=e.target.closest('[data-edit]');
  if(edit){
    const m=edit.dataset.edit;
    const v=prompt(`عدد الطلبات المستخدمة اليوم لـ${gLabel(m)} في «${a.name}» (0–999):`,String(accountUsed(a,m)));
    if(v===null)return;
    const n=Math.max(0,Math.min(999,Math.round(Number(v)||0)));
    if(!a.usage)a.usage={};
    a.usage[m]={day:ptDay(),used:n};
    if(a.exhausted)delete a.exhausted[m];
    saveGoogleAccounts();updateGoogleQuotaUI();
    return;
  }
  const reset=e.target.closest('[data-reset]');
  if(reset){
    const m=reset.dataset.reset;
    if(!a.usage)a.usage={};
    a.usage[m]={day:ptDay(),used:0};
    if(a.exhausted)delete a.exhausted[m];
    saveGoogleAccounts();updateGoogleQuotaUI();
  }
});
$('gvoiceSearch').oninput=()=>renderGoogleVoicePicker();
$('gVoiceSearchIcon').onclick=()=>$('gvoiceSearch').focus();
$('gvoiceGender').onchange=()=>renderGoogleVoicePicker();
$('gvoiceTone').onchange=()=>renderGoogleVoicePicker();
$('gVoiceTrigger').onclick=()=>{const p=$('gVoicePanel');p.hidden?openVoicePanel():closeVoicePanel()};
$('gVoiceFilterBtn').onclick=()=>{
  const f=$('gVoiceFilterPanel');f.hidden=!f.hidden;
  $('gVoiceFilterBtn').setAttribute('aria-expanded',String(!f.hidden));
};
$('gVoiceAddCustom').onclick=()=>{const f=$('gCustomForm');f.hidden=false;$('gCustomName').focus()};
$('gCustomSave').onclick=()=>{
  const r=addCustomGoogleVoice($('gCustomName').value);
  if(!r)return alert('أدخل اسم الصوت الجديد');
  $('gCustomName').value='';$('gCustomForm').hidden=true;closeVoicePanel();
  toast(r.created?'تمت إضافة الاسم المخصص':'الصوت موجود وتم اختياره');
};
$('gCustomName').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();$('gCustomSave').click()}
  else if(e.key==='Escape'){e.preventDefault();$('gCustomForm').hidden=true}
});
$('gVoiceList').addEventListener('click',e=>{
  const info=e.target.closest('[data-info]');
  if(info){openVoiceInfo(info.dataset.info);closeVoicePanel();return}
  const row=e.target.closest('[data-voice]');
  if(row){setGoogleVoiceSelection(row.dataset.voice,true);closeVoicePanel()}
});
$('gVoiceList').addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  const row=e.target.closest('[data-voice]');if(!row)return;
  e.preventDefault();setGoogleVoiceSelection(row.dataset.voice,true);closeVoicePanel();
});
document.addEventListener('click',e=>{
  const p=$('gVoicePanel');
  if(p&&!p.hidden&&!$('gVoicePicker').contains(e.target))closeVoicePanel();
});
$('gInfoClose').onclick=closeVoiceInfo;
$('gInfoOverlay').onclick=e=>{if(e.target.id==='gInfoOverlay')closeVoiceInfo()};
$('gInfoUse').onclick=()=>{
  const id=$('gInfoUse').dataset.voice;
  setGoogleVoiceSelection(id,true);closeVoiceInfo();closeVoicePanel();
};
$('gInfoDelete').onclick=()=>{
  const id=$('gInfoDelete').dataset.voice;
  deleteCustomGoogleVoice(id);closeVoiceInfo();
};
$('gvoice').addEventListener('change',()=>{updateGoogleVoiceTrigger();keyState();markDefaultVoiceChunksStale()});
$('orGvoice').addEventListener('change',()=>{keyState();markDirty();markDefaultVoiceChunksStale()});
$('vCancel').onclick=()=>$('voiceOverlay').classList.remove('show');
$('voiceOverlay').onclick=e=>{if(e.target.id==='voiceOverlay')$('voiceOverlay').classList.remove('show')};

$('model').onchange=()=>{setOrModel();markDirty()};
$('addVoiceBtn').onclick=()=>{$('vName').value='';$('vId').value='';$('voiceOverlay').classList.add('show');$('vName').focus()};
$('vSave').onclick=()=>{
  const name=$('vName').value.trim(),id=$('vId').value.trim();
  if(!name||!id)return alert('أدخل اسماً ومعرّف الصوت (ID)');
  voices.push({name,id});saveVoices(voices);renderVoiceSelects();
  $('voiceSelect').value=id;
  $('voiceOverlay').classList.remove('show');
};
