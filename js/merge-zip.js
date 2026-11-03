// ---- merge preview (reorder / add / delete, then merge in order) ----
let mergeItems=[],mergeDrag=null;
function renderMergeList(){
  const box=$('mergeList');
  if(!mergeItems.length){box.innerHTML='<div class="merge-empty">لا توجد أصوات بعد.</div>';return}
  box.innerHTML=mergeItems.map((it,idx)=>`<div class="merge-item" draggable="true" data-mi="${idx}">
      <span class="mi-handle" aria-hidden="true">⋮⋮</span>
      <span class="mi-name" dir="ltr" title="${esc(it.name)}">${esc(it.name)}</span>
      <audio controls preload="none" src="${it.url}"></audio>
      <span class="mi-btns">
        <button type="button" class="ghost mini" data-up="${idx}" title="أعلى" aria-label="أعلى">▲</button>
        <button type="button" class="ghost mini" data-down="${idx}" title="أسفل" aria-label="أسفل">▼</button>
        <button type="button" class="ghost mini" data-del="${idx}" title="حذف" aria-label="حذف">✕</button>
      </span>
    </div>`).join('');
}
function openMerge(){
  const list=chunks.map((c,i)=>({c,i})).filter(x=>x.c.blob);
  if(!list.length)return alert('ولّد صوتاً لصندوق واحد على الأقل');
  mergeItems.forEach(it=>URL.revokeObjectURL(it.url));
  mergeItems=list.map(({c,i})=>({name:cleanName(c.name)||defName(i),ext:ext(c),blob:c.blob,url:URL.createObjectURL(c.blob)}));
  renderMergeList();
  $('mergeResult').innerHTML='';
  $('mergeOverlay').classList.add('show');
  setTimeout(()=>$('mergeDoBtn').focus(),60);
}
function closeMerge(){
  mergeItems.forEach(it=>URL.revokeObjectURL(it.url));
  mergeItems=[];
  $('mergeOverlay').classList.remove('show');
}
$('mergebtn').onclick=openMerge;
$('mergeCancel').onclick=closeMerge;
$('mergeOverlay').onclick=e=>{if(e.target.id==='mergeOverlay')closeMerge()};
$('mergeList').addEventListener('click',e=>{
  const up=e.target.dataset.up,down=e.target.dataset.down,del=e.target.dataset.del;
  if(up!==undefined){const i=+up;if(i>0){[mergeItems[i-1],mergeItems[i]]=[mergeItems[i],mergeItems[i-1]];renderMergeList()}}
  else if(down!==undefined){const i=+down;if(i<mergeItems.length-1){[mergeItems[i],mergeItems[i+1]]=[mergeItems[i+1],mergeItems[i]];renderMergeList()}}
  else if(del!==undefined){const i=+del;URL.revokeObjectURL(mergeItems[i].url);mergeItems.splice(i,1);renderMergeList()}
});
$('mergeList').addEventListener('dragstart',e=>{const el=e.target.closest('[data-mi]');if(!el)return;mergeDrag=+el.dataset.mi;el.classList.add('dragging');try{e.dataTransfer.effectAllowed='move'}catch(_){}});
$('mergeList').addEventListener('dragend',e=>{const el=e.target.closest('[data-mi]');if(el)el.classList.remove('dragging');mergeDrag=null;document.querySelectorAll('.merge-item.over').forEach(x=>x.classList.remove('over'))});
$('mergeList').addEventListener('dragover',e=>{e.preventDefault();const el=e.target.closest('[data-mi]');if(!el)return;document.querySelectorAll('.merge-item.over').forEach(x=>x.classList.remove('over'));el.classList.add('over')});
$('mergeList').addEventListener('drop',e=>{
  e.preventDefault();const el=e.target.closest('[data-mi]');
  if(!el||mergeDrag===null)return;
  const to=+el.dataset.mi,from=mergeDrag;
  document.querySelectorAll('.merge-item.over').forEach(x=>x.classList.remove('over'));
  if(from!==to){const [m]=mergeItems.splice(from,1);mergeItems.splice(to,0,m)}
  mergeDrag=null;renderMergeList();
});
$('mergeAddFile').onchange=e=>{
  const allowed=['mp3','wav','ogg','m4a','aac','flac'];
  const maxBytes=100*1024*1024;
  const bad=[];
  for(const f of e.target.files){
    const ex=((f.name.match(/\.([a-z0-9]+)$/i)||[])[1]||'').toLowerCase();
    const okType=f.type?f.type.startsWith('audio/'):true;
    if(!allowed.includes(ex)||!okType||f.size>maxBytes){
      bad.push(f.name+(f.size>maxBytes?' (أكبر من 100MB)':''));
      continue;
    }
    const nm=cleanName(f.name.replace(/\.[^.]+$/,''))||f.name;
    mergeItems.push({name:nm,ext:ex,blob:f,url:URL.createObjectURL(f)});
  }
  e.target.value='';renderMergeList();
  if(bad.length)alert('تم تجاهل ملفات غير مدعومة أو كبيرة جداً:\n'+bad.join('\n'));
};
$('mergeDoBtn').onclick=async()=>{
  if(!mergeItems.length)return alert('لا توجد أصوات للدمج');
  const exts=[...new Set(mergeItems.map(it=>it.ext))];
  if(exts.length>1)return alert('الملفات بصيغ مختلطة ('+exts.join(', ')+'). استخدم ملفات من نفس الصيغة.');
  const e=exts[0];
  if(e!=='wav'&&e!=='mp3')return alert('الدمج مدعوم فقط لملفات WAV وMP3.');
  let blob;
  try{blob=e==='wav'?await mergeWavs(mergeItems.map(it=>it.blob)):new Blob(mergeItems.map(it=>it.blob),{type:mergeItems[0].blob.type||'audio/mpeg'})}
  catch(err){return alert('تعذّر الدمج: '+err.message)}
  const url=URL.createObjectURL(blob);
  if(mergeUrl)URL.revokeObjectURL(mergeUrl);mergeUrl=url;
  const base=cleanName($('mergeName').value)||cleanName(currentWorkName)||'merged';
  const note=e==='mp3'?'<p class="tag warn">دمج MP3 خام: قد تظهر مدة الملف غير دقيقة في بعض المشغّلات.</p>':'';
  const html=`<p class="tag">دُمج ${mergeItems.length} صوتاً بالترتيب</p>${note}<audio controls src="${url}"></audio><a href="${url}" data-ext="${e}" download="${esc(base)}.${e}">تحميل الملف المدمج</a>`;
  $('mergeResult').innerHTML=html;
  $('mergeout').innerHTML=html;
};

// ---- ZIP (store, no compression) ----
const crcT=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc32=u=>{let c=~0;for(let i=0;i<u.length;i++)c=crcT[(c^u[i])&255]^(c>>>8);return ~c>>>0};
const pack=(...f)=>{const b=new DataView(new ArrayBuffer(f.reduce((a,x)=>a+x[1],0)));let o=0;f.forEach(([v,s])=>{s==2?b.setUint16(o,v,true):b.setUint32(o,v,true);o+=s});return new Uint8Array(b.buffer)};
function zip(files){
  const parts=[],cen=[];let off=0;
  for(const f of files){
    const n=enc.encode(f.name),c=crc32(f.data),s=f.data.length;
    const lh=pack([0x04034b50,4],[20,2],[0x800,2],[0,2],[0,2],[33,2],[c,4],[s,4],[s,4],[n.length,2],[0,2]);
    parts.push(lh,n,f.data);
    cen.push(pack([0x02014b50,4],[20,2],[20,2],[0x800,2],[0,2],[0,2],[33,2],[c,4],[s,4],[s,4],[n.length,2],[0,2],[0,2],[0,2],[0,2],[0,4],[off,4]),n);
    off+=lh.length+n.length+s;
  }
  const cs=cen.reduce((a,x)=>a+x.length,0);
  return new Blob([...parts,...cen,pack([0x06054b50,4],[0,2],[0,2],[files.length,2],[files.length,2],[cs,4],[off,4],[0,2])],{type:'application/zip'});
}
$('zipbtn').onclick=async()=>{
  const files=[],used=new Set();
  for(let i=0;i<chunks.length;i++)if(chunks[i].blob)files.push({name:uniqueName(fname(i,chunks[i]),used),data:new Uint8Array(await chunks[i].blob.arrayBuffer())});
  if(!files.length)return alert('لا توجد أصوات مولّدة للتصدير');
  const u=URL.createObjectURL(zip(files));
  const merged=cleanName($('mergeName').value);
  const base=((merged&&merged!=='merged')?merged:(cleanName(currentWorkName)||merged||'audio-parts')).replace(/\.zip$/i,'');
  const zipName=(base||'audio-parts')+'.zip';
  const a=document.createElement('a');a.href=u;a.download=zipName;a.click();
  setTimeout(()=>URL.revokeObjectURL(u),60000);
};

// ---- warn before leaving while generating or with unsaved changes ----
window.addEventListener('beforeunload',e=>{if(ctls.size||dirty){e.preventDefault();e.returnValue=''}});
