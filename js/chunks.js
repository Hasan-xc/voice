// ---- smart split ----
function smartSplit(text,m,max){
  const sents=text.replace(/\r/g,'').split(/(?<=[.!?؟؛…。！？])\s+|\n+/).map(s=>s.trim()).filter(Boolean),pieces=[];
  for(const s of sents){
    if(m(s)<=max){pieces.push(s);continue}
    for(const p of s.split(/(?<=[,،:;])\s+/)){
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
  chunks=smartSplit(t,meas[$('mode').value],Math.max(20,+$('max').value||1500)).map((text,i)=>({text,voice:'',name:defName(i)}));
  render();markDirty();$('ctrl').scrollIntoView({behavior:'smooth'});
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
const audioHtml=(i,c)=>`<audio controls src="${c.url}"></audio><a href="${c.url}" download="${esc(fname(i,c))}">تحميل</a>`;
function render(){
  if(mergeUrl){URL.revokeObjectURL(mergeUrl);mergeUrl=null}
  $('chunks').innerHTML='';
  chunks.forEach((c,i)=>{
    const d=document.createElement('div');d.className='card chunk';d.id='c'+i;
    d.innerHTML=`<div class="top"><span class="num" dir="ltr">${i+1} / ${chunks.length}</span>
      <span class="row"><select data-v="${i}" dir="ltr" style="width:150px"></select>
      <button data-g="${i}">🔊 توليد صوت</button>
      <button class="ghost mini" data-c="${i}" style="display:none">✕ إلغاء</button></span></div>
      <textarea data-t="${i}">${esc(c.text)}</textarea>
      <div class="row" style="margin-top:4px"><span class="lbl" style="margin:0">اسم الملف</span><input class="fname" data-n="${i}" dir="ltr" value="${esc(c.name||defName(i))}" aria-label="اسم ملف المقطع ${i+1}"></div>
      <div class="tag" id="s${i}"></div><div class="tag" id="m${i}"></div><div class="tag" id="u${i}"></div><div id="a${i}"></div>`;
    $('chunks').appendChild(d);cs(i);
    if(c.blob){$('c'+i).classList.add('done');$('m'+i).className='tag ok';$('m'+i).textContent='تم ✓';renderUsed(i,c);
      $('a'+i).innerHTML=audioHtml(i,c);}
  });
  renderVoiceSelects();
  chunks.forEach((c,i)=>{const sel=document.querySelector(`select[data-v="${i}"]`);if(sel)sel.value=c.voice||''});
  $('ctrl').style.display=chunks.length?'block':'none';$('mergeout').innerHTML='';prog();
}
function cs(i){
  const t=chunks[i].text,tk=tokens(t);
  const el=$('s'+i);
  el.textContent=`${fmt(t.length)} حرف · ${fmt(words(t))} كلمة · ≈${fmt(tk)} توكن · ${fmt(bytes(t))} بايت`;
  if(tk>TOKEN_WARN[P()])el.innerHTML+=' · <span class="warn">⚠ قريب من حد السياق، يُفضّل تقسيمه أصغر</span>';
}
function prog(){
  const n=chunks.length,d=chunks.filter(c=>c.blob).length;
  $('fill').style.width=(n?d/n*100:0)+'%';
  $('prog').textContent=`تم توليد ${d} من ${n}`+(n&&d==n?' ✓':'');
  const totalBytes=chunks.reduce((a,c)=>a+bytes(c.text),0);
  $('costest').textContent=P()!=='or'?'':`تقدير التكلفة لو مدفوع: $${(totalBytes/1e6*15).toFixed(3)}`;
}
$('chunks').addEventListener('input',e=>{
  if(e.target.dataset.t!==undefined){
    cancelAll(false);
    const i=+e.target.dataset.t,c=chunks[i];c.text=e.target.value;c.blob=null;c.usedAccount='';c.usedModel='';
    if(c.url){URL.revokeObjectURL(c.url);c.url=null}
    const u=$('u'+i);if(u)u.textContent='';
    $('a'+i).innerHTML='';$('c'+i).classList.remove('done','err');$('m'+i).textContent='';cs(i);prog();markDirty();
  }
});
$('chunks').addEventListener('change',e=>{
  if(e.target.dataset.v!==undefined){chunks[+e.target.dataset.v].voice=e.target.value;markDirty()}
  if(e.target.dataset.n!==undefined){
    const i=+e.target.dataset.n,c=chunks[i];
    c.name=cleanName(e.target.value)||defName(i);e.target.value=c.name;
    if(c.url)$('a'+i).innerHTML=audioHtml(i,c);
    markDirty();
  }
});
$('chunks').addEventListener('click',e=>{
  if(e.target.dataset.g!==undefined){stopReq=false;gen(+e.target.dataset.g)}
  if(e.target.dataset.c!==undefined){const i=+e.target.dataset.c;const ctl=ctls.get(i);if(ctl)ctl.abort()}
});
