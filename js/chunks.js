// ---- smart split ----
function smartSplit(text,m,max){
  // splitSentences/splitAfterPunct avoid regex lookbehind (Safari < 16.4).
  const sents=splitSentences(text),pieces=[];
  for(const s of sents){
    if(m(s)<=max){pieces.push(s);continue}
    for(const p of splitAfterPunct(s,CLAUSE_PUNCT)){
      if(m(p)<=max){pieces.push(p);continue}
      let cur='';
      for(const w of p.split(/\s+/)){const n=cur?cur+' '+w:w;if(m(n)>max&&cur){pieces.push(cur);cur=w}else cur=n}
      if(cur)pieces.push(cur);
    }
  }
  const out=[];let cur='';
  for(const p of pieces){const n=cur?cur+' '+p:p;if(cur&&m(n)>max){out.push(cur);cur=p}else cur=n}
  if(cur)out.push(cur);
  return out;
}
$('splitbtn').onclick=()=>{
  const t=$('text').value.trim();if(!t)return alert('لا يوجد نص');
  if(chunks.some(c=>c.blob)&&!confirm('توجد مقاطع مولّد صوتها. إعادة التقسيم ستحذف الصوت المولّد لها. متابعة؟'))return;
  cancelAll(false);
  releaseUrls();
  if(typeof clearDirectorUndo==='function')clearDirectorUndo();
  chunks=smartSplit(t,meas[$('mode').value],Math.max(20,+$('max').value||1500)).map((text,i)=>({text,voice:'',name:defName(i),style:'',speaker:''}));
  render();autoMergeName(false);markDirty();$('ctrl').scrollIntoView({behavior:'smooth'});
};

// ---- render ----
const ext=c=>c.ext||'mp3';
const defName=i=>String(i+1);
// strip forbidden filename chars and a typed extension; the real extension is added separately
const cleanName=s=>(s||'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'').replace(/\.(mp3|wav|pcm|ogg|m4a|aac|flac)$/i,'').replace(/[. ]+$/,'').trim();
const fname=(i,c)=>`${cleanName(c.name)||defName(i)}.${ext(c)}`;
// makes "a.mp3" -> "a-2.mp3" when the same name already exists in the ZIP
function uniqueName(name,used){
  if(!used.has(name)){used.add(name);return name}
  const d=name.lastIndexOf('.'),base=d>0?name.slice(0,d):name,e=d>0?name.slice(d):'';
  let k=2;while(used.has(`${base}-${k}${e}`))k++;
  const n=`${base}-${k}${e}`;used.add(n);return n;
}
const dlIcon='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>';
const genIcon='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 7v10"/><path d="M20 10v4"/></svg>';
// audio player + icon-only download (the word «تحميل» was removed on purpose)
const audioHtml=(i,c)=>`<div class="audio-row"><audio controls preload="none" src="${c.url}"></audio><a class="dl-btn" href="${c.url}" download="${esc(fname(i,c))}" title="تنزيل: ${esc(fname(i,c))}" aria-label="تنزيل الصوت ${esc(fname(i,c))}">${dlIcon}</a></div>`;

// The merged file is always named after the opening words of the story, so the
// user does not have to rename "merged" by hand every time.
let mergeNameAuto='merged';
function autoMergeName(force){
  const box=$('mergeName');if(!box)return '';
  const cur=String(box.value||'').trim();
  if(!force&&cur&&cur!=='merged'&&cur!==mergeNameAuto)return cur;
  const t=storyTitle($('text').value);
  if(!t)return cur;
  mergeNameAuto=t;box.value=t;
  if(typeof markDirty==='function')markDirty();
  return t;
}

function render(){
  if(mergeUrl){URL.revokeObjectURL(mergeUrl);mergeUrl=null}
  $('chunks').innerHTML='';
  chunks.forEach((c,i)=>{
    const d=document.createElement('div');d.className='card chunk';d.id='c'+i;
    d.innerHTML=`<div class="top">
      <span class="num" dir="ltr">${i+1} / ${chunks.length}</span>
      <span class="chunk-stats" id="s${i}"></span>
      <label class="voice-pick" title="صوت هذا المقطع — يتجاوز الصوت الأساسي المختار فوق">
        <span class="vp-ico" aria-hidden="true">🎚️</span>
        <select data-v="${i}" dir="ltr" aria-label="صوت المقطع ${i+1}"></select>
      </label>
    </div>
    <div class="ta-wrap chunk-ta">
      <textarea data-t="${i}" aria-label="نص المقطع ${i+1}">${esc(c.text)}</textarea>
      <div class="ta-acts">
        <button type="button" class="gen-ico" data-g="${i}" title="توليد صوت هذا المقطع" aria-label="توليد صوت المقطع ${i+1}">${genIcon}</button>
        <span class="gen-spin" aria-hidden="true"></span>
        <button type="button" class="cancel-ico" data-c="${i}" title="إلغاء التوليد" aria-label="إلغاء توليد المقطع ${i+1}">✕</button>
      </div>
    </div>
    <div id="a${i}"></div>
    <div class="tag chunk-msg" id="m${i}"></div>
    <div class="meta-grid">
      <label class="meta-f"><span>اسم الملف</span><input class="fname" data-n="${i}" dir="ltr" value="${esc(c.name||defName(i))}" aria-label="اسم ملف المقطع ${i+1}"></label>
      <label class="meta-f"><span>اسم المتحدث</span><input class="speaker-inp" data-sp="${i}" dir="auto" value="${esc(c.speaker||'')}" placeholder="مثلاً: الراوي" aria-label="اسم متحدث المقطع ${i+1}"></label>
      <label class="meta-f wide"><span>أسلوب الإلقاء</span><input class="style-inp" data-s="${i}" dir="auto" value="${esc(c.style||'')}" placeholder="اختياري — مثلاً: هادئ ودافئ" aria-label="أسلوب إلقاء المقطع ${i+1}"></label>
    </div>`;
    $('chunks').appendChild(d);cs(i);
    if(c.blob){$('c'+i).classList.add('done');refreshChunkCard(i);
      $('a'+i).innerHTML=audioHtml(i,c);}
  });
  renderVoiceSelects();
  chunks.forEach((c,i)=>{const sel=document.querySelector(`select[data-v="${i}"]`);if(sel)sel.value=c.voice||''});
  $('ctrl').style.display=chunks.length?'block':'none';$('mergeout').innerHTML='';prog();
  if(typeof updateDirectorState==='function')updateDirectorState();
}
function cs(i){
  const t=chunks[i].text,tk=tokens(t);
  const el=$('s'+i);if(!el)return;
  el.textContent=`${fmt(t.length)} حرف · ${fmt(words(t))} كلمة · ≈${fmt(tk)} توكن · ${fmt(bytes(t))} بايت`;
  if(tk>TOKEN_WARN[P()])el.innerHTML+=' · <span class="warn" title="قريب من حد السياق، يُفضّل تقسيمه أصغر">⚠</span>';
}
function prog(){
  const n=chunks.length,ready=chunks.filter(c=>c.blob&&!c.stale).length;
  const stale=chunks.filter(c=>c.blob&&c.stale).length;
  $('fill').style.width=(n?ready/n*100:0)+'%';
  $('prog').textContent=`تم توليد ${ready} من ${n}`+(stale?` · ${stale} قديم`:'')+(n&&ready===n?' ✓':'');
  const cost=costForChunks(chunks);
  $('costest').textContent=cost.known
    ?(cost.free?`التكلفة: ${cost.label}`:`تقدير التكلفة: ${cost.label}`)
    :'التكلفة: غير معروفة لهذا الموديل';
  const bc=$('batchCount');if(bc)bc.textContent=stale?`${stale} مقطع يحتاج إعادة توليد`:'';
}
$('chunks').addEventListener('input',e=>{
  if(e.target.dataset.sp!==undefined){
    const i=+e.target.dataset.sp,c=chunks[i];if(!c)return;
    c.speaker=e.target.value;
    if(markChunkStale(c)){refreshChunkCard(i);prog()}
    markDirty();return;
  }
  if(e.target.dataset.s!==undefined){
    const i=+e.target.dataset.s,c=chunks[i];if(!c)return;
    c.style=e.target.value;
    if(markChunkStale(c)){refreshChunkCard(i);prog()}
    markDirty();return;
  }
  if(e.target.dataset.t!==undefined){
    // Only abort the chunk being edited; a text edit used to cancel every
    // running generation on each keystroke.
    const i=+e.target.dataset.t,c=chunks[i];if(!c)return;
    const ctl=ctls.get(i);if(ctl)ctl.abort();
    c.text=e.target.value;c.stale=false;
    if(c.url){try{URL.revokeObjectURL(c.url)}catch(_){}}
    c.blob=null;c.url=null;c.usedAccount='';c.usedModel='';
    $('a'+i).innerHTML='';$('c'+i).classList.remove('done','err');$('m'+i).textContent='';cs(i);prog();markDirty();
  }
});
$('chunks').addEventListener('change',e=>{
  if(e.target.dataset.v!==undefined){
    const i=+e.target.dataset.v,c=chunks[i];if(!c)return;
    c.voice=e.target.value;
    if(markChunkStale(c)){refreshChunkCard(i);prog()}
    markDirty();
  }
  if(e.target.dataset.n!==undefined){
    const i=+e.target.dataset.n,c=chunks[i];
    c.name=cleanName(e.target.value)||defName(i);e.target.value=c.name;
    if(c.url)$('a'+i).innerHTML=audioHtml(i,c);
    markDirty();
  }
});
$('chunks').addEventListener('click',e=>{
  const g=e.target.closest('[data-g]'),c=e.target.closest('[data-c]');
  if(g){stopReq=false;gen(+g.dataset.g)}
  else if(c){const i=+c.dataset.c;const ctl=ctls.get(i);if(ctl)ctl.abort()}
});
