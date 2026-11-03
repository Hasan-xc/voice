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
const KIE_POLL_MAX=Math.ceil(8*60*1000/KIE_POLL_MS); // ~8 minutes
const KIE_RETRY_DELAYS=[10000,20000,40000]; // 10s, 20s, 40s (4 attempts total)
const KIE_MAX_ATTEMPTS=4;
const GOOGLE_TIMEOUT=120000, KIE_CREATE_TIMEOUT=30000, KIE_POLL_TIMEOUT=20000, KIE_DOWNLOAD_TIMEOUT=120000;
const GOOGLE_MODELS=['gemini-3.8-flash-lite-tts','gemini-3.8-flash-tts'];
const GOOGLE_MODEL_LABELS={'gemini-3.8-flash-lite-tts':'Lite','gemini-3.8-flash-tts':'Flash'};
const GOOGLE_TZ='America/Los_Angeles', TR_TZ='Europe/Istanbul';
const G_ACCOUNTS_KEY='gaccounts', G_LIMITS_KEY='glimits', G_ORDER_KEY='gmodelorder';
const G_MODE_KEY='gmode', G_MANUAL_KEY='gmanual', G_VOICES_KEY='gvoicescache';

let chunks=[],stopReq=false,ctls=new Map();
let epoch=0, runSeq=0, gQuotaNoticeAt=0, googleSendAt=0;
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
function safeEl(id){return document.getElementById(id)}
function isAlive(i,c,myEpoch){
  return epoch===myEpoch && chunks[i]===c;
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
    if($('rem').checked)localStorage.setItem('orkey',$('key').value.trim());
    if($('krem').checked)localStorage.setItem('kiekey',$('kkey').value.trim());
    localStorage.setItem('kvoice',$('kvoice').value);localStorage.setItem('kmodel',$('kmodel').value);
    localStorage.setItem('ktemp',$('ktemp').value);localStorage.setItem('kfill',$('kfill').checked?'1':'0');
    localStorage.setItem('orGvoice',$('orGvoice').value);
    localStorage.setItem('gvoice',$('gvoice').value);
    localStorage.setItem('gmodel',$('gmodel').value);localStorage.setItem('gstyle',$('gstyle').value);localStorage.setItem('gdelay',$('gdelay').value);
    if(typeof saveGoogleAccounts==='function')saveGoogleAccounts();
  }catch(e){}
  if(typeof updateSmartSplitState==='function')updateSmartSplitState();
}
function setProvider(p,openBox){
  if(document.body.dataset.p!==p)cancelAll(false);
  document.body.dataset.p=p;
  $('pOR').classList.toggle('act',p==='or');$('pKie').classList.toggle('act',p==='kie');$('pG').classList.toggle('act',p==='google');
  try{localStorage.setItem('prov',p)}catch(e){}
  if(openBox)$('keybox').style.display='block';
  keyState();showStats();prog();
  $('tokHint').textContent=TOK_HINT[p]||TOK_HINT.or;chunks.forEach((_,i)=>cs(i));
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
  const gd=localStorage.getItem('gdelay');if(gd&&[...$('gdelay').options].some(o=>o.value===gd))$('gdelay').value=gd;
  const kt=localStorage.getItem('ktemp');if(kt!==null&&kt!==''&&Number.isFinite(Number(kt)))$('ktemp').value=kt;
  const kf=localStorage.getItem('kfill');if(kf==='1')$('kfill').checked=true;
}catch(e){}
