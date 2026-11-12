// ---- unsaved-changes tracking ----
let dirty=false,currentWorkId=null,currentWorkName='',mergeUrl=null,persistAsked=false,saveBusy=false;
function markDirty(){
  dirty=true;$('savemsg').textContent='تغييرات غير محفوظة (اضغط 💾 حفظ في المتصفح)';
  if(typeof scheduleDraft==='function')scheduleDraft();
}

// ---- IndexedDB (saved works + metadata + autosaved draft) ----
const DB_NAME='voicegen-db',STORE='works',META_STORE='meta',DRAFT_STORE='draft',DRAFT_KEY='current';
let dbPromise=null;
function openDB(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((ok,no)=>{
    if(!('indexedDB' in window)){const e=new Error('no indexedDB');e.name='NoIDB';return no(e)}
    const req=indexedDB.open(DB_NAME,2);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});
      // The library only needs names/counts; keeping a metadata-only store
      // avoids loading every saved audio Blob just to draw the list.
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE,{keyPath:'id'});
      if(!db.objectStoreNames.contains(DRAFT_STORE))db.createObjectStore(DRAFT_STORE);
    };
    req.onsuccess=()=>ok(req.result);
    req.onerror=()=>{dbPromise=null;no(req.error)};
    req.onblocked=()=>{dbPromise=null;no(new Error('قاعدة البيانات مقفلة في نافذة أخرى'))};
  });
  return dbPromise;
}
async function tx(mode,fn,store){
  const db=await openDB();
  store=store||STORE;
  return new Promise((ok,no)=>{
    const t=db.transaction(store,mode);let req;
    t.oncomplete=()=>ok(req?req.result:undefined);
    t.onerror=()=>no(t.error);t.onabort=()=>no(t.error||new Error('aborted'));
    try{req=fn(t.objectStore(store))}catch(e){try{t.abort()}catch(_){}no(e)}
  });
}
const dbPut=w=>tx('readwrite',s=>s.put(w));
const dbGet=id=>tx('readonly',s=>s.get(id));
const dbGetAll=()=>tx('readonly',s=>s.getAll());
const dbDelete=id=>tx('readwrite',s=>s.delete(id));
const dbPutMeta=m=>tx('readwrite',s=>s.put(m),META_STORE);
const dbGetAllMeta=()=>tx('readonly',s=>s.getAll(),META_STORE);
const dbGetMetaOne=id=>tx('readonly',s=>s.get(id),META_STORE);
const dbDeleteMeta=id=>tx('readwrite',s=>s.delete(id),META_STORE);
const dbPutDraft=d=>tx('readwrite',s=>s.put(d,DRAFT_KEY),DRAFT_STORE);
const dbGetDraft=()=>tx('readonly',s=>s.get(DRAFT_KEY),DRAFT_STORE);
const dbDeleteDraft=()=>tx('readwrite',s=>s.delete(DRAFT_KEY),DRAFT_STORE);
function dbMsg(e){
  if(!e)return 'خطأ غير معروف';
  if(e.name==='NoIDB')return 'هذا المتصفح لا يدعم حفظ الأعمال (IndexedDB)';
  if(e.name==='QuotaExceededError')return 'مساحة التخزين في المتصفح ممتلئة. احذف بعض الأعمال المحفوظة ثم أعد المحاولة';
  if(e.name==='InvalidStateError'||e.name==='SecurityError')return 'التخزين في المتصفح معطّل أو محجوب (وضع خاص أو إعدادات الخصوصية)';
  return 'تعذّر الوصول إلى التخزين في المتصفح: '+(e.message||e.name);
}
function askPersist(){
  if(persistAsked)return;persistAsked=true;
  try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist().catch(()=>{})}catch(e){}
}

// ---- workspace snapshot (shared by save + autosave) ----------------------
function workspaceSnapshot(){
  return {
    text:$('text').value,mode:$('mode').value,max:$('max').value,
    mergedName:$('mergeName').value,globalVoice:$('voiceSelect').value,
    chunks:chunks.map(c=>({text:c.text,voice:c.voice||'',name:c.name||'',style:c.style||'',speaker:c.speaker||'',ext:c.ext||'mp3',blob:c.blob||null,usedAccount:c.usedAccount||'',usedModel:c.usedModel||'',stale:!!c.stale}))
  };
}
function applySnapshot(w){
  $('text').value=w.text||'';
  $('mode').value=w.mode||'chars';
  $('max').value=w.max||1500;
  $('mergeName').value=w.mergedName||w.mergeName||'merged';
  if([...$('voiceSelect').options].some(o=>o.value===w.globalVoice))$('voiceSelect').value=w.globalVoice;
  chunks=(w.chunks||[]).map(c=>{
    const o={text:c.text||'',voice:c.voice||'',name:c.name||'',style:c.style||'',speaker:c.speaker||'',ext:c.ext||'mp3',blob:c.blob||null,
      usedAccount:c.usedAccount||'',usedModel:c.usedModel||'',stale:!!c.stale};
    if(o.blob)o.url=URL.createObjectURL(o.blob);
    return o;
  });
  if(typeof clearDirectorUndo==='function')clearDirectorUndo();
  $('file').value='';
  if($('text').value.trim())setInputTab('paste');
  render();showStats();syncFileBox();
}

// ---- autosave: debounced draft in IndexedDB, restored on next visit ------
let draftTimer=null,draftBusy=false,draftWarned=false;
function scheduleDraft(){
  clearTimeout(draftTimer);
  draftTimer=setTimeout(()=>{saveDraft()},1500);
}
async function saveDraft(){
  if(draftBusy)return false;
  const has=!!$('text').value.trim()||chunks.length>0;
  if(!has){try{await dbDeleteDraft()}catch(e){}return true}
  draftBusy=true;
  const snap=workspaceSnapshot();
  const d={id:DRAFT_KEY,updatedAt:Date.now(),...snap};
  // Blob URLs are only valid in this session; never persist them.
  d.chunks=d.chunks.map(c=>({...c,url:undefined}));
  try{
    await dbPutDraft(d);
    return true;
  }catch(e){
    // If audio made the draft too large, keep the text so nothing is lost.
    try{
      await dbPutDraft({...d,chunks:d.chunks.map(c=>({...c,blob:null}))});
      if(!draftWarned){draftWarned=true;if(typeof toast==='function')toast('مساحة المتصفح ممتلئة: حُفظت المسودة بدون الصوت')}
      return true;
    }catch(_){return false}
  }finally{draftBusy=false}
}
async function clearDraft(){
  clearTimeout(draftTimer);
  try{await dbDeleteDraft()}catch(e){}
}
async function restoreDraft(){
  let d;try{d=await dbGetDraft()}catch(e){return false}
  if(!d)return false;
  if(!(String(d.text||'').trim()||(d.chunks||[]).length))return false;
  // Never clobber text the user already started typing before the async read.
  if($('text').value.trim()||chunks.length)return false;
  cancelAll(false);
  releaseUrls();
  applySnapshot(d);
  dirty=false;
  const t=d.updatedAt?new Date(d.updatedAt).toLocaleString('ar',{dateStyle:'short',timeStyle:'short'}):'';
  $('savemsg').textContent='تم استرجاع المسودة تلقائياً'+(t?' ('+t+')':'');
  return true;
}
window.addEventListener('pagehide',()=>{saveDraft()});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')saveDraft()});

// ---- work metadata for the library ---------------------------------------
function workMeta(w){
  const list=w.chunks||[];
  return {
    id:w.id,name:w.name,createdAt:w.createdAt,updatedAt:w.updatedAt,
    words:words(w.text||''),chunkCount:list.length,gen:list.filter(c=>c.blob).length
  };
}

// ---- blob URL cleanup ----
function releaseUrls(){
  chunks.forEach(c=>{if(c.url){URL.revokeObjectURL(c.url);c.url=null}});
  if(mergeUrl){URL.revokeObjectURL(mergeUrl);mergeUrl=null}
}

// ---- save / update / restore / delete ----
function defaultWorkName(){
  const w=$('text').value.trim().split(/\s+/).slice(0,6).join(' ').slice(0,60)||'عمل بدون نص';
  return `${w} · ${new Date().toLocaleString('ar',{dateStyle:'short',timeStyle:'short'})}`;
}
function openSaveModal(){
  if(!$('text').value.trim()&&!chunks.length)return alert('لا يوجد نص أو مقاطع لحفظها');
  $('wName').value=currentWorkId?currentWorkName:defaultWorkName();
  $('wSave').textContent=currentWorkId?'تحديث نفس العمل':'حفظ';
  $('wNew').style.display=currentWorkId?'':'none';
  $('saveOverlay').classList.add('show');$('wName').focus();$('wName').select();
}
function closeSaveModal(){$('saveOverlay').classList.remove('show')}
$('savebtn').onclick=openSaveModal;
$('wCancel').onclick=closeSaveModal;
$('saveOverlay').onclick=e=>{if(e.target.id==='saveOverlay')closeSaveModal()};
$('wSave').onclick=()=>saveWork(currentWorkId?'update':'create');
$('wNew').onclick=()=>saveWork('new');
async function saveWork(kind){
  if(saveBusy)return;saveBusy=true;
  const name=$('wName').value.trim()||defaultWorkName();
  try{
    const now=Date.now();
    const prev=(kind==='update'&&currentWorkId)?await dbGet(currentWorkId):null;
    const id=prev?prev.id:((self.crypto&&crypto.randomUUID)?crypto.randomUUID():'w'+now+'-'+Math.random().toString(36).slice(2,8));
    const work={
      id,name,createdAt:prev?prev.createdAt:now,updatedAt:now,
      ...workspaceSnapshot()
    };
    askPersist();
    await dbPut(work);
    try{await dbPutMeta(workMeta(work))}catch(e){}
    currentWorkId=id;currentWorkName=name;dirty=false;
    closeSaveModal();
    const n=chunks.filter(c=>c.blob).length;
    $('savemsg').textContent='تم الحفظ في المتصفح ✓ '+(n?'(النص + الصوت)':'(النص)');
  }catch(e){alert(dbMsg(e))}
  finally{saveBusy=false}
}
async function restoreWork(id){
  let w;try{w=await dbGet(id)}catch(e){return alert(dbMsg(e))}
  if(!w)return alert('هذا العمل لم يعد موجوداً');
  if(dirty&&!confirm('توجد تغييرات غير محفوظة في مساحة العمل الحالية. الاسترجاع سيستبدلها. متابعة؟'))return;
  cancelAll(false);
  releaseUrls();
  applySnapshot(w);
  currentWorkId=w.id;currentWorkName=w.name;dirty=false;
  $('savemsg').textContent='تم استرجاع «'+w.name+'»';
  closeDrawer();
  (chunks.length?$('chunks'):$('text')).scrollIntoView({behavior:'smooth'});
}
async function renderLibrary(){
  const box=$('libList');
  let list;
  try{list=await dbGetAllMeta()}catch(e){box.innerHTML=`<small>${esc(dbMsg(e))}</small>`;return}
  // One-time migration for libraries saved before the metadata store existed.
  if(!list.length){
    try{
      const all=await dbGetAll();
      list=all.map(workMeta);
      if(list.length)await Promise.all(list.map(m=>dbPutMeta(m).catch(()=>{})));
    }catch(e){box.innerHTML=`<small>${esc(dbMsg(e))}</small>`;return}
  }
  list.sort((a,b)=>b.createdAt-a.createdAt);
  if(!list.length){box.innerHTML='<small>لا توجد أعمال محفوظة</small>';return}
  box.innerHTML=list.map(w=>{
    const gen=w.gen||0,total=w.chunkCount||0;
    const when=new Date(w.createdAt).toLocaleString('ar',{dateStyle:'medium',timeStyle:'short'});
    return `<div class="lib-item"><div class="lib-top"><b>${esc(w.name)}</b><small>${esc(when)}</small></div>`+
      `<div class="lib-bot"><div class="lib-stats"><small>${fmt(w.words||0)} كلمة</small>`+
      `<small>${fmt(gen)} صوت مولد من ${fmt(total)} مقطع</small></div>`+
      `<div class="row lib-btns"><button class="mini" data-restore="${esc(w.id)}" aria-label="استرجاع ${esc(w.name)}">↩ استرجاع</button>`+
      `<button class="ghost mini" data-del="${esc(w.id)}" aria-label="حذف ${esc(w.name)}">🗑 حذف</button></div></div></div>`;
  }).join('');
}
$('libList').addEventListener('click',async e=>{
  const r=e.target.closest('[data-restore]'),d=e.target.closest('[data-del]');
  if(r)return restoreWork(r.dataset.restore);
  if(d){
    const id=d.dataset.del;
    let w;try{w=await dbGetMetaOne(id)}catch(err){return alert(dbMsg(err))}
    if(!w)return renderLibrary();
    if(!confirm(`سيُحذف للأبد: «${w.name}». هل أنت متأكد؟`))return;
    try{await Promise.all([dbDelete(id),dbDeleteMeta(id)])}catch(err){return alert(dbMsg(err))}
    if(currentWorkId===id){currentWorkId=null;currentWorkName=''}
    renderLibrary();
  }
});
$('voiceSelect').addEventListener('change',()=>{markDirty();markDefaultVoiceChunksStale()});
$('mergeName').addEventListener('input',()=>{
  markDirty();
  const a=document.querySelector('#mergeout a[data-ext]');
  if(a)a.download=(cleanName($('mergeName').value)||'merged')+'.'+a.dataset.ext;
});
