// ---- unsaved-changes tracking ----
let dirty=false,currentWorkId=null,currentWorkName='',mergeUrl=null,persistAsked=false,saveBusy=false;
function markDirty(){dirty=true;$('savemsg').textContent='تغييرات غير محفوظة (اضغط 💾 حفظ في المتصفح)'}

// ---- IndexedDB (saved works) ----
const DB_NAME='voicegen-db',STORE='works';
let dbPromise=null;
function openDB(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((ok,no)=>{
    if(!('indexedDB' in window)){const e=new Error('no indexedDB');e.name='NoIDB';return no(e)}
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE,{keyPath:'id'})};
    req.onsuccess=()=>ok(req.result);
    req.onerror=()=>{dbPromise=null;no(req.error)};
    req.onblocked=()=>{dbPromise=null;no(new Error('قاعدة البيانات مقفلة في نافذة أخرى'))};
  });
  return dbPromise;
}
async function tx(mode,fn){
  const db=await openDB();
  return new Promise((ok,no)=>{
    const t=db.transaction(STORE,mode);let req;
    t.oncomplete=()=>ok(req?req.result:undefined);
    t.onerror=()=>no(t.error);t.onabort=()=>no(t.error||new Error('aborted'));
    try{req=fn(t.objectStore(STORE))}catch(e){try{t.abort()}catch(_){}no(e)}
  });
}
const dbPut=w=>tx('readwrite',s=>s.put(w));
const dbGet=id=>tx('readonly',s=>s.get(id));
const dbGetAll=()=>tx('readonly',s=>s.getAll());
const dbDelete=id=>tx('readwrite',s=>s.delete(id));
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
      text:$('text').value,mode:$('mode').value,max:$('max').value,
      mergedName:$('mergeName').value,globalVoice:$('voiceSelect').value,
      chunks:chunks.map(c=>({text:c.text,voice:c.voice||'',name:c.name||'',ext:c.ext||'mp3',blob:c.blob||null,usedAccount:c.usedAccount||'',usedModel:c.usedModel||''}))
    };
    askPersist();
    await dbPut(work);
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
  $('text').value=w.text||'';
  $('mode').value=w.mode||'chars';
  $('max').value=w.max||1500;
  $('mergeName').value=w.mergedName||'merged';
  if([...$('voiceSelect').options].some(o=>o.value===w.globalVoice))$('voiceSelect').value=w.globalVoice;
  chunks=(w.chunks||[]).map(c=>{
    const o={text:c.text||'',voice:c.voice||'',name:c.name||'',ext:c.ext||'mp3',blob:c.blob||null,
      usedAccount:c.usedAccount||'',usedModel:c.usedModel||''};
    if(o.blob)o.url=URL.createObjectURL(o.blob);
    return o;
  });
  currentWorkId=w.id;currentWorkName=w.name;dirty=false;
  $('file').value='';
  if($('text').value.trim())setInputTab('paste');
  render();showStats();syncFileBox();
  $('savemsg').textContent='تم استرجاع «'+w.name+'»';
  closeDrawer();
  (chunks.length?$('chunks'):$('text')).scrollIntoView({behavior:'smooth'});
}
async function renderLibrary(){
  const box=$('libList');
  let list;
  try{list=await dbGetAll()}catch(e){box.innerHTML=`<small>${esc(dbMsg(e))}</small>`;return}
  list.sort((a,b)=>b.createdAt-a.createdAt);
  if(!list.length){box.innerHTML='<small>لا توجد أعمال محفوظة</small>';return}
  box.innerHTML=list.map(w=>{
    const cs_=w.chunks||[],gen=cs_.filter(c=>c.blob).length;
    const when=new Date(w.createdAt).toLocaleString('ar',{dateStyle:'medium',timeStyle:'short'});
    return `<div class="lib-item"><div class="lib-top"><b>${esc(w.name)}</b><small>${esc(when)}</small></div>`+
      `<div class="lib-bot"><div class="lib-stats"><small>${fmt(words(w.text||''))} كلمة</small>`+
      `<small>${fmt(gen)} صوت مولد من ${fmt(cs_.length)} مقطع</small></div>`+
      `<div class="row lib-btns"><button class="mini" data-restore="${esc(w.id)}" aria-label="استرجاع ${esc(w.name)}">↩ استرجاع</button>`+
      `<button class="ghost mini" data-del="${esc(w.id)}" aria-label="حذف ${esc(w.name)}">🗑 حذف</button></div></div></div>`;
  }).join('');
}
$('libList').addEventListener('click',async e=>{
  const r=e.target.closest('[data-restore]'),d=e.target.closest('[data-del]');
  if(r)return restoreWork(r.dataset.restore);
  if(d){
    const id=d.dataset.del;
    let w;try{w=await dbGet(id)}catch(err){return alert(dbMsg(err))}
    if(!w)return renderLibrary();
    if(!confirm(`سيُحذف للأبد: «${w.name}». هل أنت متأكد؟`))return;
    try{await dbDelete(id)}catch(err){return alert(dbMsg(err))}
    if(currentWorkId===id){currentWorkId=null;currentWorkName=''}
    renderLibrary();
  }
});
$('voiceSelect').addEventListener('change',markDirty);
$('mergeName').addEventListener('input',()=>{
  markDirty();
  const a=document.querySelector('#mergeout a[data-ext]');
  if(a)a.download=(cleanName($('mergeName').value)||'merged')+'.'+a.dataset.ext;
});
