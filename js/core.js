const $=id=>document.getElementById(id),enc=new TextEncoder();
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const words=s=>(s.trim().match(/\S+/g)||[]).length,bytes=s=>enc.encode(s).length;
const tokens=s=>{const a=(s.match(/[\u0600-\u06FF]/g)||[]).length;return Math.ceil(a/2.1+(s.length-a)/4)};
const meas={chars:s=>s.length,words,bytes,tokens},fmt=n=>n.toLocaleString('en'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
// token guidance per provider: OpenRouter/kie keep the 4000 advice, Google allows up to 10000
const TOKEN_WARN={or:4000,kie:4000,google:8000};
const TOK_HINT={
  or:'يُنصح ألا يتجاوز الصندوق ≈4000 توكن تقريبي حتى لا يقترب من حد سياق النموذج (8K).',
  kie:'يُنصح ألا يتجاوز الصندوق ≈4000 توكن تقريبي حتى لا يقترب من حد سياق النموذج (8K). في kie يُفضّل ألا يزيد الصندوق عن 5000 حرف (وأقل من دقيقة صوت للجودة الأفضل).',
  google:'يُنصح ألا يتجاوز الصندوق ≈8000 توكن تقريبي (حد الإدخال الرسمي 8,192).'
};
const CONCURRENCY=3, RETRY_DELAY=20000, STAGGER=650;
// Kie rate limits (official docs: 20 createTask per 10s per account, >100 concurrent tasks).
// We deliberately use half the official launch limit as a safety margin.
const KIE_LAUNCH_PER_WINDOW=10;
const KIE_WINDOW_MS=10000;
const KIE_MAX_CONCURRENT=40;
const KIE_POLL_MS=4000;
const KIE_POLL_JITTER=500;
// Long scripts routinely take more than 8 minutes on kie. Keep polling for
// up to 20 minutes before giving up.
const KIE_POLL_MAX=Math.ceil(20*60*1000/KIE_POLL_MS); // ~20 minutes
const KIE_RETRY_DELAYS=[10000,20000,40000]; // 10s, 20s, 40s (4 attempts total)
const KIE_MAX_ATTEMPTS=4;
const GOOGLE_TIMEOUT=120000, KIE_CREATE_TIMEOUT=30000, KIE_POLL_TIMEOUT=20000, KIE_DOWNLOAD_TIMEOUT=120000;
const GOOGLE_MODELS=['gemini-3.8-flash-lite-tts','gemini-3.8-flash-tts'];
const GOOGLE_MODEL_LABELS={'gemini-3.8-flash-lite-tts':'Lite','gemini-3.8-flash-tts':'Flash'};
const GOOGLE_TZ='America/Los_Angeles', TR_TZ='Europe/Istanbul';
const G_ACCOUNTS_KEY='gaccounts', G_LIMITS_KEY='glimits', G_ORDER_KEY='gmodelorder';
const G_MODE_KEY='gmode', G_MANUAL_KEY='gmanual', G_VOICES_KEY='gvoicescache';

let chunks=[],stopReq=false,ctls=new Map();
let epoch=0, runSeq=0, gQuotaNoticeAt=0;
// Per-account "last send" timestamp. A single global timestamp serialized all
// Google accounts; each account has its own rate limit.
let gSendAt={};
let quotaResetCache={at:0,day:''};
const P=()=>document.body.dataset.p;
function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}

// ---- timeout-aware fetch -------------------------------------------------
function abortError(){
  try{return new DOMException('Aborted','AbortError')}catch(e){const x=new Error('Aborted');x.name='AbortError';return x}
}
function sleepAbort(ms,ctl){
  return new Promise((res,rej)=>{
    if(ctl.signal.aborted)return rej(abortError());
    const t=setTimeout(()=>{cleanup();res()},ms);
    const onAbort=()=>{clearTimeout(t);cleanup();rej(abortError())};
    function cleanup(){try{ctl.signal.removeEventListener('abort',onAbort)}catch(e){}}
    ctl.signal.addEventListener('abort',onAbort,{once:true});
  });
}
function mergedSignal(signals){
  const list=signals.filter(Boolean);
  if(!list.length)return undefined;
  if(AbortSignal.any)return AbortSignal.any(list);
  const c=new AbortController();
  const onAbort=()=>{try{c.abort()}catch(e){}};
  list.forEach(s=>{if(s.aborted)onAbort();else s.addEventListener('abort',onAbort,{once:true})});
  return c.signal;
}
async function fetchT(url,opts={},ms=GOOGLE_TIMEOUT){
  const ctl=new AbortController();
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;try{ctl.abort()}catch(e){}},ms);
  const userSignal=opts.signal;
  const signal=mergedSignal([userSignal,ctl.signal]);
  try{
    return await fetch(url,{...opts,signal});
  }catch(e){
    if(timedOut){
      const x=new Error('انتهت المهلة');
      x.name='TimeoutError';x.timeout=true;x.status=0;x.body='انتهت مهلة الانتظار';
      throw x;
    }
    if(e&&e.name==='AbortError')throw e;
    throw e;
  }finally{clearTimeout(timer)}
}

// Google keys are resolved later (multi-account model); this function is
// intentionally a thin wrapper so callers do not need to know the mode.
const curKey=()=>P()==='kie'?$('kkey').value.trim():P()==='google'?googleAnyKey():$('key').value.trim();

// ---- generation lifecycle ------------------------------------------------
function cancelAll(showCancelled){
  const active=[...ctls.keys()];
  epoch++;
  stopReq=true;
  ctls.forEach(ctl=>{try{ctl.abort()}catch(e){}});
  ctls.clear();
  chunks.forEach((_,i)=>{
    const btn=document.querySelector(`[data-g="${i}"]`);
    if(btn)btn.disabled=false;
    const cancel=document.querySelector(`[data-c="${i}"]`);
    if(cancel)cancel.style.display='none';
  });
  chunks.forEach((c,i)=>{
    const card=$('c'+i);
    const wasWorking=(card&&card.classList.contains('work'))||active.includes(i);
    if(wasWorking){
      const m=$('m'+i);
      if(c.blob){
        if(m){m.className='tag ok';m.textContent='تم ✓'}
        if(card)card.classList.add('done');
      }else{
        if(m){m.className='tag';m.textContent='أُلغي'}
        if(card)card.classList.remove('done');
      }
      if(card)card.classList.remove('work','err');
    }
  });
}
// ---- stale-audio bookkeeping ---------------------------------------------
// Changing voice/style/speaker/model must not silently keep audio generated
// with the old settings. We keep the audio (it may still be useful) but flag
// it as stale, and "generate all" regenerates stale chunks.
function markChunkStale(c){
  if(!c||!c.blob)return false;
  c.stale=true;return true;
}
function markChunkStaleByIndex(i){return markChunkStale(chunks[i])}
function markAllChunksStale(){
  let n=0;
  chunks.forEach((c,i)=>{if(markChunkStale(c)){n++;refreshChunkCard(i)}});
  if(n){prog();markDirty()}
  return n;
}
// Chunks with an empty per-box voice inherit the global picker, so changing the
// global default only invalidates those.
function markDefaultVoiceChunksStale(){
  let n=0;
  chunks.forEach((c,i)=>{if(!String(c.voice||'').trim()&&markChunkStale(c)){n++;refreshChunkCard(i)}});
  if(n){prog();markDirty()}
  return n;
}
function refreshChunkCard(i){
  const c=chunks[i];if(!c)return;
  const m=$('m'+i),card=$('c'+i);
  if(!c.blob)return;
  if(card){card.classList.add('done');card.classList.remove('err','work')}
  if(m){
    if(c.stale){m.className='tag warn';m.textContent='صوت قديم — أعد التوليد'}
    else{m.className='tag ok';m.textContent='تم ✓'}
  }
}
function chunkPending(c){return !c.blob||!!c.stale}
function isAlive(i,c,myEpoch){
  return epoch===myEpoch && chunks[i]===c;
}
// Cost of one chunk / all chunks for the active provider+model.
function costForText(text){
  if(P()==='google')return {known:true,free:true,usd:0,label:'مجاني ضمن الحصة'};
  if(P()==='kie')return {known:false,free:false,usd:0,label:'حسب حساب kie'};
  return estimateTtsCost($('model').value,text);
}
function costForChunks(list){
  const arr=list||chunks;
  let usd=0,known=true,free=true;
  for(const c of arr){
    const r=costForText(c.text||'');
    if(!r.known){known=false;free=false;continue}
    if(!r.free)free=false;
    usd+=r.usd;
  }
  if(!known)return {known:false,free:false,usd:0,label:'غير معروف'};
  if(free)return {known:true,free:true,usd:0,label:P()==='google'?'مجاني ضمن الحصة':'مجاني'};
  return {known:true,free:false,usd,label:'$'+usd.toFixed(4)};
}

// ---- theme ----
function setTheme(t){document.documentElement.dataset.theme=t;try{localStorage.setItem('theme',t)}catch(e){}}
$('lt').onclick=()=>setTheme('light');$('dk').onclick=()=>setTheme('dark');
(()=>{let t=null;try{t=localStorage.getItem('theme')}catch(e){}setTheme(t||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'))})();

// ---- drawer (hamburger menu) ----
const drawer=$('drawer'),drawerBack=$('drawerBack'),menuBtn=$('menuBtn');
function openDrawer(){
  drawer.classList.add('show');drawerBack.classList.add('show');menuBtn.setAttribute('aria-expanded','true');
  renderLibrary();$('drawerClose').focus();
}
function closeDrawer(){
  if(!drawer.classList.contains('show'))return;
  drawer.classList.remove('show');drawerBack.classList.remove('show');menuBtn.setAttribute('aria-expanded','false');menuBtn.focus();
}
menuBtn.onclick=()=>drawer.classList.contains('show')?closeDrawer():openDrawer();
$('drawerClose').onclick=closeDrawer;
drawerBack.onclick=closeDrawer;
function trapFocus(e,container){
  const f=[...container.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
  if(!f.length)return;
  const first=f[0],last=f[f.length-1];
  if(e.shiftKey&&(document.activeElement===first||!container.contains(document.activeElement))){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&(document.activeElement===last||!container.contains(document.activeElement))){e.preventDefault();first.focus()}
}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if($('fsEditor').classList.contains('open')){closeFsEditor();return}
    if($('mergeOverlay').classList.contains('show')){closeMerge();return}
    if($('saveOverlay').classList.contains('show')){closeSaveModal();return}
    if($('gInfoOverlay').classList.contains('show')){closeVoiceInfo();return}
    if(!$('gVoicePanel').hidden){closeVoicePanel();return}
    if($('voiceOverlay').classList.contains('show')){
      $('voiceOverlay').classList.remove('show');
      $('addVoiceBtn').focus();
      return;
    }
    closeDrawer();return;
  }
  if(e.key==='Tab'){
    const layer=$('gInfoOverlay').classList.contains('show')?$('gInfoOverlay')
      :$('voiceOverlay').classList.contains('show')?$('voiceOverlay')
      :$('saveOverlay').classList.contains('show')?$('saveOverlay')
      :$('mergeOverlay').classList.contains('show')?$('mergeOverlay')
      :$('fsEditor').classList.contains('open')?$('fsEditor')
      :drawer.classList.contains('show')?drawer:null;
    if(layer)trapFocus(e,layer);
    return;
  }
});

// ---- keys & provider ----
function keyState(){
  const ok=curKey().length>10;$('keyst').textContent=ok?'✓':'✗';$('keyst').className=ok?'on':'';
  try{
    // Honour "do not remember" immediately: unchecking must erase the key,
    // not leave the previously stored copy behind.
    if($('rem').checked)localStorage.setItem('orkey',$('key').value.trim());
    else localStorage.removeItem('orkey');
    if($('krem').checked)localStorage.setItem('kiekey',$('kkey').value.trim());
    else localStorage.removeItem('kiekey');
    localStorage.setItem('kvoice',$('kvoice').value);localStorage.setItem('kmodel',$('kmodel').value);
    localStorage.setItem('ktemp',$('ktemp').value);localStorage.setItem('kfill',$('kfill').checked?'1':'0');
    localStorage.setItem('orGvoice',$('orGvoice').value);
    localStorage.setItem('gvoice',$('gvoice').value);
    localStorage.setItem('gmodel',$('gmodel').value);localStorage.setItem('gstyle',$('gstyle').value);localStorage.setItem('gdelay',$('gdelay').value);
    if(typeof saveGoogleAccounts==='function')saveGoogleAccounts();
  }catch(e){}
  if(typeof updateSmartSplitState==='function')updateSmartSplitState();
  if(typeof updateDirectorState==='function')updateDirectorState();
}
function setProvider(p,openBox){
  const changed=document.body.dataset.p!==p;
  if(changed)cancelAll(false);
  document.body.dataset.p=p;
  $('pOR').classList.toggle('act',p==='or');$('pKie').classList.toggle('act',p==='kie');$('pG').classList.toggle('act',p==='google');
  try{localStorage.setItem('prov',p)}catch(e){}
  if(openBox)$('keybox').style.display='block';
  keyState();showStats();prog();
  if(typeof renderVoiceSelects==='function')renderVoiceSelects();
  $('tokHint').textContent=TOK_HINT[p]||TOK_HINT.or;chunks.forEach((_,i)=>cs(i));
  if(changed&&chunks.some(c=>c.blob)){
    const n=markAllChunksStale();
    if(n&&typeof toast==='function')toast(`غيّرت المزود: ${n} مقطعاً بحاجة إلى إعادة توليد`);
  }
}
$('pOR').onclick=()=>setProvider('or',true);
$('pKie').onclick=()=>setProvider('kie',true);
$('pG').onclick=()=>setProvider('google',true);
$('keybtn').onclick=()=>{const b=$('keybox');b.style.display=b.style.display==='block'?'none':'block'};
['key','kkey','kvoice','kmodel','gvoice','gmodel','gstyle','gdelay'].forEach(id=>{$(id).oninput=keyState;$(id).onchange=keyState});
$('rem').onchange=()=>{if($('rem').checked)keyState();else try{localStorage.removeItem('orkey')}catch(e){}};
$('krem').onchange=()=>{if($('krem').checked)keyState();else try{localStorage.removeItem('kiekey')}catch(e){}};
$('grem').onchange=()=>{if(!$('grem').checked){try{localStorage.removeItem('gkey')}catch(e){}}saveGoogleAccounts()};
$('ktemp').oninput=keyState;$('ktemp').onchange=keyState;
$('kfill').onchange=keyState;
try{
  const k=localStorage.getItem('orkey');if(k){$('key').value=k;$('rem').checked=true}
  const kk=localStorage.getItem('kiekey');if(kk){$('kkey').value=kk;$('krem').checked=true}
  const kv=localStorage.getItem('kvoice');if(kv)$('kvoice').value=kv;
  const km=localStorage.getItem('kmodel');if(km)$('kmodel').value=km;
  const gm=localStorage.getItem('gmodel');if(gm&&[...$('gmodel').options].some(o=>o.value===gm))$('gmodel').value=gm;
  const gs=localStorage.getItem('gstyle');if(gs)$('gstyle').value=gs;
  const gd=localStorage.getItem('gdelay');
  if(gd){
    // migrate the old minutes-based values (1/2/3/5 min) to the new 60s maximum
    const mig={'1':'60','2':'60','3':'60','5':'60'};
    const v=mig[gd]||gd;
    if([...$('gdelay').options].some(o=>o.value===v))$('gdelay').value=v;
  }
  const kt=localStorage.getItem('ktemp');if(kt!==null&&kt!==''&&Number.isFinite(Number(kt)))$('ktemp').value=kt;
  const kf=localStorage.getItem('kfill');if(kf==='1')$('kfill').checked=true;
}catch(e){}

// Wipe every stored key from this browser (names/quota stay).
function forgetAllKeys(){
  if(!confirm('سيتم حذف كل مفاتيح API المحفوظة من هذا المتصفح. ستحتاج لإدخالها مرة أخرى. متابعة؟'))return;
  try{
    ['orkey','kiekey','gkey'].forEach(k=>localStorage.removeItem(k));
  }catch(e){}
  $('key').value='';$('kkey').value='';$('rem').checked=false;$('krem').checked=false;$('grem').checked=false;
  if(typeof gAccounts!=='undefined'){
    gAccounts.forEach(a=>{a.key=''});
    if(typeof saveGoogleAccounts==='function')saveGoogleAccounts();
    if(typeof renderGoogleAccounts==='function')renderGoogleAccounts();
  }
  keyState();
  if(typeof toast==='function')toast('حُذفت المفاتيح المحفوظة من هذا المتصفح');
}
if($('forgetKeys'))$('forgetKeys').onclick=forgetAllKeys;

// ---- optional pre-run cost cap -------------------------------------------
if($('costCap')){
  try{
    const cc=localStorage.getItem('costcap');
    if(cc!==null&&cc!=='')$('costCap').value=cc;
  }catch(e){}
  $('costCap').oninput=()=>{try{localStorage.setItem('costcap',$('costCap').value)}catch(e){}};
}
