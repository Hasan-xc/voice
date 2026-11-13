// ---- input tabs ----
function setInputTab(mode){
  $('tabUpload').classList.toggle('act',mode==='upload');
  $('tabPaste').classList.toggle('act',mode==='paste');
  $('uploadPane').style.display=mode==='upload'?'block':'none';
  $('pastePane').style.display=mode==='paste'?'block':'none';
}
$('tabUpload').onclick=()=>setInputTab('upload');
$('tabPaste').onclick=()=>setInputTab('paste');

// show save/clear actions only when there is text
function syncFileBox(){$('textActions').classList.toggle('show',$('text').value.trim().length>0)}

$('clearsave').onclick=()=>{
  if(dirty&&!confirm('سيتم مسح كل شيء، بما فيه التغييرات غير المحفوظة. متابعة؟'))return;
  cancelAll(false);
  // The director undo snapshot holds blob: URLs that are revoked below; clear
  // it first so the undo button cannot restore dead players.
  if(typeof clearDirectorUndo==='function')clearDirectorUndo();
  releaseUrls();
  if(typeof clearDraft==='function')clearDraft();
  $('text').value='';
  $('file').value='';
  $('filename').textContent='';$('filename').style.display='none';
  $('dzTitle').textContent='اسحب الملف هنا أو اضغط لرفعه';
  chunks=[];currentWorkId=null;currentWorkName='';dirty=false;
  $('mergeName').value='merged';mergeNameAuto='merged';
  setInputTab('upload');
  render();showStats();syncFileBox();
  $('savemsg').textContent='تم مسح كل شيء، رجع الموقع لوضعه الأول';
};

// ---- stats ----
function showStats(){
  const t=$('text').value,b=bytes(t);
  const rows=[['الأحرف',t.length],['بدون مسافات',t.replace(/\s/g,'').length],['الكلمات',words(t)],['بايت UTF-8 (دقيق)',b],['توكنز (تقريبي)',tokens(t)]];
  const cost=costForText(t);
  rows.push(['التكلفة التقديرية',cost.label]);
  rows.push(['مدة الصوت ≈',Math.max(1,Math.round(t.length/15))+' ث']);
  $('stats').innerHTML=rows.map(([l,v])=>`<div class="stat"><b>${typeof v=='number'?fmt(v):v}</b><span>${l}</span></div>`).join('');
  if(typeof updateDirectorState==='function')updateDirectorState();
}
let statsTimer=null;
function scheduleStats(){clearTimeout(statsTimer);statsTimer=setTimeout(showStats,180)}
$('text').oninput=()=>{scheduleStats();markDirty();syncFileBox()};

// ---- file upload & drag-and-drop ----
async function handleFile(f){
  if(!f)return;
  $('filename').style.display='block';
  $('filename').textContent='⏳ جارٍ القراءة: '+f.name;
  try{
    let t='';
    if(/\.docx$/i.test(f.name)){
      // Hosted locally (vendor/) so there is no CDN supply-chain risk and DOCX
      // upload works offline.
      if(!window.mammoth)await new Promise((ok,no)=>{const s=document.createElement('script');s.src='vendor/mammoth.browser.min.js?v=20261112a';s.onload=ok;s.onerror=()=>no(new Error('تعذّر تحميل قارئ docx'));document.head.appendChild(s)});
      t=(await mammoth.extractRawText({arrayBuffer:await f.arrayBuffer()})).value;
    }else{
      // Read bytes, not f.text(): SRT/TXT files from old Windows tools are
      // usually Windows-1256, and f.text() always assumes UTF-8.
      t=decodeTextBuffer(await f.arrayBuffer());
      if(/\.html?$/i.test(f.name))t=new DOMParser().parseFromString(t,'text/html').body.textContent;
      if(/\.srt$/i.test(f.name))t=t.replace(/^\d+\s*$/gm,'').replace(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/g,'').replace(/\n{2,}/g,'\n').trim();
    }
    cancelAll(false);
    $('text').value=t;
    $('filename').textContent='✓ تم رفع: '+f.name;
    $('dzTitle').textContent='✓ تم رفع الملف — اضغط للاستبدال';
    setInputTab('paste');
    showStats();markDirty();syncFileBox();
    if(typeof autoMergeName==='function')autoMergeName(true);
  }catch(err){$('filename').textContent='تعذّرت القراءة';alert(err.message)}
  finally{$('file').value=''}
}
$('file').onchange=e=>handleFile(e.target.files[0]);
const dz=$('dropzone');
['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag')}));
['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag')}));
dz.addEventListener('drop',e=>{const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(f)handleFile(f)});

// ---- paste & fullscreen text editor ----
function flashCopyIcon(btn){if(!btn)return;btn.classList.add('copied');setTimeout(()=>btn.classList.remove('copied'),1400)}
function copyText(txt){
  if(!txt||!txt.trim())return alert('لا يوجد نص');
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(txt).catch(()=>{})}
  else{const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.top='-9999px';document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand('copy')}catch(e){}document.body.removeChild(ta)}
}
async function pasteFromClipboard(btn){
  try{
    if(navigator.clipboard&&navigator.clipboard.readText){
      const clip=await navigator.clipboard.readText();
      if(!clip)return alert('الحافظة فارغة');
      if($('fsEditor').classList.contains('open')){$('fsText').value=clip;syncFsTextChange()}
      else{cancelAll(false);$('text').value=clip;showStats();markDirty();syncFileBox();if(typeof autoMergeName==='function')autoMergeName(true)}
      flashCopyIcon(btn);return;
    }
    throw new Error('no-api');
  }catch(e){
    if(!$('fsEditor').classList.contains('open'))openFsEditor();
    alert('اضغط مطوّلاً داخل المحرر واختر «لصق»');
  }
}
function updateFsCount(){const v=$('fsText').value;$('fsCount').textContent=`(${fmt(v.length)} حرف · ${fmt(words(v))} كلمة)`}
function syncFsTextChange(){
  updateFsCount();
  if($('text').value!==$('fsText').value){cancelAll(false);$('text').value=$('fsText').value;showStats();markDirty();syncFileBox()}
}
function openFsEditor(){
  $('fsText').value=$('text').value;updateFsCount();
  $('fsEditor').classList.add('open');document.body.style.overflow='hidden';
  setTimeout(()=>$('fsText').focus(),60);
}
function closeFsEditor(){
  syncFsTextChange();
  $('fsEditor').classList.remove('open');document.body.style.overflow='';$('fsText').blur();
}
$('pasteIconBtn').onclick=e=>{e.stopPropagation();pasteFromClipboard($('pasteIconBtn'))};
$('fsPasteIconBtn').onclick=e=>{e.stopPropagation();pasteFromClipboard($('fsPasteIconBtn'))};
$('fsPasteBtn').onclick=()=>pasteFromClipboard($('fsPasteIconBtn'));
$('fsCopyBtn').onclick=()=>{copyText($('fsText').value);flashCopyIcon($('fsCopyBtn'))};
$('fsCloseBtn').onclick=closeFsEditor;
$('fsText').oninput=syncFsTextChange;
let lastTap=0;
$('text').addEventListener('dblclick',()=>openFsEditor());
$('text').addEventListener('touchend',e=>{const now=Date.now();if(now-lastTap<340){e.preventDefault();openFsEditor();lastTap=0}else lastTap=now});
