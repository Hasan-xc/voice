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
// ---- merge audio (decode when needed, never concatenate MP3 bytes) -------
async function decodeAudioToChannels(blob, ctx){
  const buf=await ctx.decodeAudioData(await blob.arrayBuffer());
  const channels=[];
  for(let c=0;c<buf.numberOfChannels;c++)channels.push(buf.getChannelData(c));
  return {rate:buf.sampleRate,channels};
}
async function mergeAnyAudio(blobs){
  if(!blobs.length)throw new Error('لا توجد ملفات للدمج');
  const total=blobs.reduce((a,b)=>a+(b.size||0),0);
  if(total>250*1024*1024)throw new Error('الحجم الكلي أكبر من 250MB. ادمج على دفعات أصغر.');
  // Fast path: WAV files are merged directly, with resampling when needed.
  const kinds=[];
  for(const b of blobs){
    let head;
    try{head=await blobBytes(b.slice(0,12))}catch(e){head=new Uint8Array(0)}
    kinds.push(sniffAudioExt(head));
  }
  if(kinds.every(k=>k==='wav'))return mergeWavs(blobs);
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw new Error('متصفحك لا يدعم فك ترميز الصوت لدمج الصيغ المختلفة');
  const ctx=new AC();
  try{
    const parts=[];
    for(const b of blobs)parts.push(await decodeAudioToChannels(b,ctx));
    const rate=Math.max(...parts.map(p=>p.rate));
    const ch=Math.min(2,Math.max(...parts.map(p=>p.channels.length)));
    const chunks=[];
    for(const p of parts){
      const channels=mapChannels(p.channels,ch).map(c=>resampleChannel(c,p.rate,rate));
      chunks.push(floatToInt16(channels));
    }
    const len=chunks.reduce((a,c)=>a+c.length,0);
    return new Blob([wavHeader(len,rate,ch,16),...chunks],{type:'audio/wav'});
  }finally{
    try{ctx.close()}catch(e){}
  }
}
$('mergeDoBtn').onclick=async()=>{
  if(!mergeItems.length)return alert('لا توجد أصوات للدمج');
  let blob;
  try{blob=await mergeAnyAudio(mergeItems.map(it=>it.blob))}
  catch(err){return alert('تعذّر الدمج: '+err.message)}
  const url=URL.createObjectURL(blob);
  if(mergeUrl)URL.revokeObjectURL(mergeUrl);mergeUrl=url;
  const base=cleanName($('mergeName').value)||cleanName(currentWorkName)||'merged';
  const note='<p class="tag">دُمج الصوت بعد فك ترميزه إلى WAV (المدة والترتيب دقيقان).</p>';
  const html=`<p class="tag">دُمج ${mergeItems.length} صوتاً بالترتيب</p>${note}<audio controls src="${url}"></audio><a href="${url}" data-ext="wav" download="${esc(base)}.wav">تحميل الملف المدمج</a>`;
  $('mergeResult').innerHTML=html;
  $('mergeout').innerHTML=html;
};

// ---- ZIP (store, no compression) ----
const crcT=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc32=u=>{let c=~0;for(let i=0;i<u.length;i++)c=crcT[(c^u[i])&255]^(c>>>8);return ~c>>>0};
const pack=(...f)=>{const b=new DataView(new ArrayBuffer(f.reduce((a,x)=>a+x[1],0)));let o=0;f.forEach(([v,s])=>{s==2?b.setUint16(o,v,true):b.setUint32(o,v,true);o+=s});return new Uint8Array(b.buffer)};
async function blobBytes(blob){
  if(blob.arrayBuffer)return new Uint8Array(await blob.arrayBuffer());
  return new Promise((ok,no)=>{
    const r=new FileReader();
    r.onload=()=>ok(new Uint8Array(r.result));
    r.onerror=()=>no(r.error||new Error('read failed'));
    r.readAsArrayBuffer(blob);
  });
}
// CRC over a Blob without copying it all into RAM. Files are then referenced
// directly as Blob parts, so a 200MB export does not need a 200MB Uint8Array.
async function crc32Blob(blob){
  let c=~0;
  if(blob.stream){
    const r=blob.stream().getReader();
    while(true){
      const {done,value}=await r.read();
      if(done)break;
      for(let i=0;i<value.length;i++)c=crcT[(c^value[i])&255]^(c>>>8);
    }
  }else{
    const u=await blobBytes(blob);
    for(let i=0;i<u.length;i++)c=crcT[(c^u[i])&255]^(c>>>8);
  }
  return {crc:(~c)>>>0,size:blob.size};
}
async function zipParts(files){
  const parts=[],cen=[];let off=0;
  for(const f of files){
    const n=enc.encode(f.name),{crc,size}=await crc32Blob(f.blob);
    const lh=pack([0x04034b50,4],[20,2],[0x800,2],[0,2],[0,2],[33,2],[crc,4],[size,4],[size,4],[n.length,2],[0,2]);
    parts.push(lh,n,f.blob);
    cen.push(pack([0x02014b50,4],[20,2],[20,2],[0x800,2],[0,2],[0,2],[33,2],[crc,4],[size,4],[size,4],[n.length,2],[0,2],[0,2],[0,2],[0,2],[0,4],[off,4]),n);
    off+=lh.length+n.length+size;
  }
  const cs=cen.reduce((a,x)=>a+x.length,0);
  parts.push(...cen,pack([0x06054b50,4],[0,2],[0,2],[files.length,2],[files.length,2],[cs,4],[off,4],[0,2]));
  return parts;
}
async function saveZipParts(parts,filename){
  // File System Access API writes parts to disk without building one big Blob.
  if(window.showSaveFilePicker){
    try{
      const h=await window.showSaveFilePicker({suggestedName:filename,types:[{description:'ZIP',accept:{'application/zip':['.zip']}}]});
      const w=await h.createWritable();
      for(const p of parts)await w.write(p);
      await w.close();
      return;
    }catch(e){
      if(e&&e.name==='AbortError')return;
      // Fall through to a normal download when the picker is unavailable.
    }
  }
  const u=URL.createObjectURL(new Blob(parts,{type:'application/zip'}));
  const a=document.createElement('a');a.href=u;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(u),60000);
}
$('zipbtn').onclick=async()=>{
  const files=[],used=new Set();
  for(let i=0;i<chunks.length;i++)if(chunks[i].blob)files.push({name:uniqueName(fname(i,chunks[i]),used),blob:chunks[i].blob});
  if(!files.length)return alert('لا توجد أصوات مولّدة للتصدير');
  const merged=cleanName($('mergeName').value);
  const base=((merged&&merged!=='merged')?merged:(cleanName(currentWorkName)||merged||'audio-parts')).replace(/\.zip$/i,'');
  const zipName=(base||'audio-parts')+'.zip';
  try{
    const parts=await zipParts(files);
    await saveZipParts(parts,zipName);
  }catch(e){alert('تعذّر إنشاء ZIP: '+(e.message||e))}
};

// ---- warn before leaving while generating or with unsaved changes ----
window.addEventListener('beforeunload',e=>{if(ctls.size||dirty){e.preventDefault();e.returnValue=''}});
