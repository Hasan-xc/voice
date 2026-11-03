// ---- AI helpers (pure functions are Node-testable) -------------------------
// Text models (current official docs, fast + cheap):
//   OpenRouter: google/gemini-3.5-flash-lite
//   Google:     gemini-3.5-flash-lite (Interactions API)
const AI_OR_URL='https://openrouter.ai/api/v1/chat/completions';
const AI_G_URL='https://generativelanguage.googleapis.com/v1beta/interactions';
const AI_DEFAULT_OR='google/gemini-3.5-flash-lite';
const AI_DEFAULT_G='gemini-3.5-flash-lite';
const AI_MODEL_KEYS={or:'smartmodelor',g:'smartmodelg'};
const AI_MODELS={or:AI_DEFAULT_OR,g:AI_DEFAULT_G};
const AI_TIMEOUT=90000;
const AI_WINDOW_CHARS=6000;
const AI_WINDOW_UNITS=90;
const AI_MIN_RATIO=0.3;

function aiNormalize(s){return String(s==null?'':s).replace(/\r/g,'').replace(/\s+/g,' ').trim()}

// Sentence atoms with a paragraph-end flag; the original text is preserved
// (whitespace is normalized exactly like the normal splitter).
function aiSplitSentences(text){
  const out=[];
  const paras=String(text==null?'':text).replace(/\r/g,'').split(/\n+/);
  for(const para of paras){
    const p=para.trim();if(!p)continue;
    const sents=p.split(/(?<=[.!?؟؛…。！？])\s+/).map(s=>s.trim()).filter(Boolean);
    if(!sents.length)continue;
    sents.forEach((s,i)=>out.push({t:s,p:i===sents.length-1}));
  }
  return out;
}

// Fallback splitter for one over-limit sentence (same order as smartSplit:
// sentence -> comma/colon -> words, never cutting a word).
function aiSplitLong(text,measure,max){
  const m=measure||(s=>s.length),pieces=[];
  for(const p of String(text).split(/(?<=[,،:;])\s+/)){
    if(m(p)<=max){pieces.push(p);continue}
    let cur='';
    for(const w of p.split(/\s+/)){
      const n=cur?cur+' '+w:w;
      if(m(n)>max&&cur){pieces.push(cur);cur=w}else cur=n;
    }
    if(cur)pieces.push(cur);
  }
  const out=[];let cur='';
  for(const p of pieces){const n=cur?cur+' '+p:p;if(cur&&m(n)>max){out.push(cur);cur=p}else cur=n}
  if(cur)out.push(cur);
  return out.length?out:[String(text)];
}

// Numbered local units: sentences (paragraph ends flagged), each <= max.
function aiUnitsFromText(text,measure,max,splitLong){
  const m=measure||(s=>s.length);
  const split=splitLong||((s,fn,mx)=>aiSplitLong(s,fn,mx));
  const units=[];
  for(const a of aiSplitSentences(text)){
    if(m(a.t)<=max){units.push({t:a.t,p:a.p});continue}
    const parts=split(a.t,m,max);
    parts.forEach((t,i)=>units.push({t,p:a.p&&i===parts.length-1}));
  }
  return units;
}

// Extract the first JSON object from a model reply (plain, fenced, or noisy).
function aiExtractJson(raw){
  const s=String(raw==null?'':raw).trim();
  const fence=s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence){try{return JSON.parse(fence[1].trim())}catch(e){}}
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a>=0&&b>a){try{return JSON.parse(s.slice(a,b+1))}catch(e){}}
  return null;
}
function aiParseBreaks(raw){
  const j=aiExtractJson(raw);
  if(!j)return null;
  if(Array.isArray(j.breaks))return j.breaks;
  if(Array.isArray(j))return j;
  return null;
}

// Breaks must be increasing integers in 1..n; the last unit always closes a segment.
// Out-of-order model output is sorted instead of silently dropping valid breaks.
function aiSanitizeBreaks(breaks,n){
  const seen=new Set();
  for(const b of (Array.isArray(breaks)?breaks:[])){
    const k=Math.round(Number(b));
    if(Number.isFinite(k)&&k>=1&&k<=n)seen.add(k);
  }
  const out=[...seen].sort((a,b)=>a-b);
  if(n>0&&out[out.length-1]!==n)out.push(n);
  return out;
}

// Build final segments from local units + model breaks, enforcing the max and
// merging tiny neighbours (never changing the text, only whitespace-normalized).
function aiSegmentsFromUnits(units,breaks,measure,max,splitLong,minRatio){
  const m=measure||(s=>s.length),n=units.length;
  if(!n)return [];
  const bs=aiSanitizeBreaks(breaks,n);
  const segs=[];let start=0;
  for(const b of bs){
    if(b>start)segs.push(units.slice(start,b).map(u=>u.t).join(' '));
    start=b;
  }
  if(start<n)segs.push(units.slice(start).map(u=>u.t).join(' '));
  const split=splitLong||((s,fn,mx)=>aiSplitLong(s,fn,mx));
  const limited=[];
  for(const s of segs){
    if(m(s)<=max)limited.push(s);
    else limited.push(...split(s,m,max));
  }
  const min=Math.max(1,Math.floor(max*(minRatio==null?AI_MIN_RATIO:minRatio)));
  const out=limited.slice();
  for(let i=0;i<out.length;){
    if(out.length>1&&m(out[i])<min){
      const j=i>0?i-1:i+1;
      const a=Math.min(i,j),b=Math.max(i,j);
      const merged=out[a]+' '+out[b];
      if(m(merged)<=max){out.splice(a,2,merged);i=Math.max(0,a-1);continue}
    }
    i++;
  }
  return out;
}

// ---- AI director: tag whitelists / text validation (pure) ----------------
// Gemini 3.8 TTS inline vocal tags (official prompting guide).
const AI_TAGS_GEMINI=['argh','breath','heavy breath','exhales','cackle','cheer','chuckle','chuckles','cough','cry','gasp','giggle','groan','growl','grunt','grr','hiss','laugh','laughter','moan','pant','pff','phew','scream','shout','shriek','sigh','sighs','sneeze','snicker','snort','sob','throat-clearing','tsk','whimper','whispers','whispering','yawn','short pause','long pause'];
// Fish Audio S2 core + well-tested inline tags (official docs/blog).
const AI_TAGS_FISH=['whisper','whispers','whispering','laugh','laughs','laughing','chuckle','chuckling','giggle','sigh','sighs','gasp','pause','long pause','emphasis','angry','excited','sad','surprised','inhale','exhale','sobbing','crying','groan','soft voice','loud voice','shouting','low voice'];
function aiTagList(mode){return mode==='fish'?AI_TAGS_FISH:mode==='gemini'?AI_TAGS_GEMINI:[]}
function aiTagRegex(mode){
  const list=aiTagList(mode);
  if(!list.length)return null;
  const body=list.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+')).join('|');
  return mode==='fish'?new RegExp('\\[\\s*(?:'+body+')\\s*\\]','gi'):new RegExp('<\\s*(?:'+body+')\\s*>','gi');
}
// Remove only whitelisted tags, then normalize whitespace.
function aiStripTags(text,mode){
  let s=String(text==null?'':text);
  const re=aiTagRegex(mode);
  if(re)s=s.replace(re,' ');
  return aiNormalize(s);
}
// The model may only add/remove whitelisted tags; the spoken text must be identical.
function aiTextMatches(original,suggested,mode){
  return aiStripTags(original,mode)===aiStripTags(suggested,mode);
}
function aiParseDirectorItems(raw){
  const j=aiExtractJson(raw);
  if(!j)return null;
  if(Array.isArray(j.items))return j.items;
  if(Array.isArray(j))return j;
  return null;
}
function aiCleanStyle(s){
  return typeof s==='string'?s.replace(/\s+/g,' ').trim().slice(0,400):'';
}

// ---- providers / models (browser only) ------------------------------------
function aiContentText(c){
  if(typeof c==='string')return c;
  if(Array.isArray(c))return c.map(x=>typeof x==='string'?x:(x&&(x.text||x.content))||'').join('');
  return '';
}
function aiProviderInfo(){
  const orKey=($('key').value||'').trim();
  if(P()==='google'){
    const gKey=(typeof googleAnyKey==='function')?googleAnyKey():'';
    return gKey?{p:'g',key:gKey}:null;
  }
  return orKey?{p:'or',key:orKey}:null;
}
function aiModelFor(p){
  try{return (localStorage.getItem(AI_MODEL_KEYS[p])||AI_MODELS[p])}catch(e){return AI_MODELS[p]}
}
function aiFieldProvider(){
  const info=aiProviderInfo();
  return info?info.p:(P()==='google'?'g':'or');
}
let aiFieldProv=null;
function syncSmartModelField(force){
  const f=$('smartModel');if(!f)return;
  const p=aiFieldProvider();
  if(force||p!==aiFieldProv){f.value=aiModelFor(p);aiFieldProv=p}
}
function updateSmartSplitState(){
  const btn=$('smartsplitbtn');if(!btn)return;
  syncSmartModelField(false);
  const info=aiProviderInfo(),hint=$('smartSplitHint');
  btn.disabled=!!aiCtl||!info;
  if(hint){
    if(info){hint.hidden=true;hint.textContent=''}
    else{
      hint.hidden=false;
      hint.textContent=P()==='kie'
        ?'التقسيم الذكي مع kie يحتاج مفتاح OpenRouter في الإعدادات.'
        :'أضف مفتاح المزود الحالي في الإعدادات لاستخدام التقسيم الذكي.';
    }
  }
  btn.title=info?'تقسيم النص إلى مقاطع بمساعدة الذكاء الاصطناعي':(hint?hint.textContent:'');
}

// ---- request helpers ------------------------------------------------------
function aiWindows(units,maxChars,maxUnits){
  const wins=[];let i=0;
  while(i<units.length){
    let j=i,chars=0;
    while(j<units.length&&j-i<maxUnits){
      const len=units[j].t.length;
      if(j>i&&chars+len>maxChars)break;
      chars+=len+1;j++;
    }
    if(j===i)j=i+1;
    wins.push([i,j]);i=j;
  }
  return wins;
}
const AI_SPLIT_SYS=`أنت محرّر تقسيم صوتي. مهمتك تحديد مواضع القطع فقط، دون إعادة كتابة النص أو تلخيصه أو تصحيحه.
ستتلقى وحدات نصية مرقّمة. أعد كائن JSON فقط بالشكل {"breaks":[أرقام]}، حيث كل رقم هو رقم آخر وحدة في المقطع.
القواعد:
- اقطع عند تغيّر المشهد أو الموضوع أو الزمن، أو تغيّر المتحدث في الحوار، أو نهاية فقرة.
- لا تقطع داخل جملة واحدة أو داخل اقتباس.
- اجعل أحجام المقاطع متقاربة وقدّر الحد الأقصى للمقطع.
- الأرقام تصاعدية وضمن الوحدات المطلوبة فقط. لا تُجبِر القطع عند نهاية النافذة إن لم يكن مناسباً.
- لا تخرج أي نص خارج JSON.`;
function aiBuildPrompt(units,a,b,ctxA,measure,max,mode){
  const labels={chars:'حرف',words:'كلمة',bytes:'بايت',tokens:'توكن تقريبي'};
  const unit=labels[mode]||'';
  const ctx=ctxA<a?units.slice(ctxA,a).map((u,k)=>`${ctxA+k+1}. ${u.t}`).join('\n'):'';
  const list=units.slice(a,b).map((u,k)=>`${a+k+1}. (${measure(u.t)} ${unit}${u.p?'، نهاية فقرة':''}) ${u.t}`).join('\n');
  return `الحد الأقصى للمقطع: ${max} ${unit}.\n`+
    (ctx?`سياق من النافذة السابقة (لا تُرجع أرقامه):\n${ctx}\n\n`:'')+
    `الوحدات المطلوبة (${a+1}–${b}):\n${list}\n\n`+
    `أعد JSON فقط: {"breaks":[...]}`;
}
async function aiChat(info,model,sys,user,ctl){
  if(info.p==='g'){
    const body={model,input:user,system_instruction:sys,generation_config:{temperature:0}};
    const r=await fetchT(AI_G_URL,{method:'POST',signal:ctl.signal,headers:{'x-goog-api-key':info.key,'Content-Type':'application/json'},body:JSON.stringify(body)},AI_TIMEOUT);
    const raw=await r.text();let j={};try{j=JSON.parse(raw)}catch(e){}
    if(!r.ok)throw {status:r.status,body:(j.error&&j.error.message)||raw.slice(0,300)};
    if(typeof j.output_text==='string')return j.output_text;
    const steps=Array.isArray(j.steps)?j.steps:[];
    return steps.flatMap(s=>Array.isArray(s&&s.content)?s.content:[]).filter(x=>x&&x.type==='text').map(x=>x.text||'').join('');
  }
  const r=await fetchT(AI_OR_URL,{method:'POST',signal:ctl.signal,headers:{'Content-Type':'application/json','Authorization':'Bearer '+info.key},body:JSON.stringify({model,messages:[{role:'system',content:sys},{role:'user',content:user}],temperature:0})},AI_TIMEOUT);
  const raw=await r.text();let j={};try{j=JSON.parse(raw)}catch(e){}
  if(!r.ok)throw {status:r.status,body:(j.error&&j.error.message)||raw.slice(0,300)};
  return aiContentText(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content);
}
async function aiRequestBreaks(o){
  const wins=aiWindows(o.units,AI_WINDOW_CHARS,AI_WINDOW_UNITS),all=[];
  for(let k=0;k<wins.length;k++){
    const [a,b]=wins[k],ctxA=Math.max(0,a-2);
    const user=aiBuildPrompt(o.units,a,b,ctxA,o.measure,o.max,o.mode);
    const raw=await aiChat(o.info,o.model,AI_SPLIT_SYS,user,o.ctl);
    if(o.ctl.signal.aborted)throw abortError();
    const br=aiParseBreaks(raw);
    if(!br)throw new Error('bad JSON');
    for(const x of br){
      const v=Math.round(Number(x));
      if(Number.isFinite(v)&&v>a&&v<=b)all.push(v);
    }
    if(o.onProgress)o.onProgress(k+1,wins.length);
  }
  return all;
}

// ---- UI: smart split ------------------------------------------------------
let aiCtl=null;
function aiSetBusy(busy,label){
  const btn=$('smartsplitbtn'),cancel=$('smartSplitCancel'),pr=$('smartSplitProg'),f=$('smartModel'),sp=$('splitbtn');
  if(cancel)cancel.hidden=!busy;
  if(pr)pr.textContent=busy?(label||''):'';
  if(btn)btn.disabled=busy||!aiProviderInfo();
  if(sp)sp.disabled=busy;
  if(f)f.disabled=busy;
}
function applyAiSplit(segs){
  cancelAll(false);
  releaseUrls();
  if(typeof clearDirectorUndo==='function')clearDirectorUndo();
  chunks=segs.map((text,i)=>({text,voice:'',name:defName(i),style:''}));
  render();markDirty();$('ctrl').scrollIntoView({behavior:'smooth'});
}
async function smartSplitAI(){
  if(aiCtl)return;
  const t=$('text').value.trim();if(!t)return alert('لا يوجد نص');
  if(chunks.some(c=>c.blob)&&!confirm('توجد مقاطع مولّد صوتها. إعادة التقسيم ستحذف الصوت المولّد لها. متابعة؟'))return;
  const info=aiProviderInfo();
  if(!info){updateSmartSplitState();return toast('التقسيم الذكي يحتاج مفتاح المزود الحالي');}
  try{
    if(localStorage.getItem('smartnotice')!=='1'){
      const ok=confirm('سيُرسل النص إلى مزود الذكاء الاصطناعي المختار ('+(info.p==='g'?'Google':'OpenRouter')+') لتحديد مواضع القطع. لن يعيد النموذج كتابة النص. متابعة؟');
      if(!ok)return;
      localStorage.setItem('smartnotice','1');
    }
  }catch(e){}
  const mode=$('mode').value,max=Math.max(20,+$('max').value||1500),m=meas[mode];
  const units=aiUnitsFromText(t,m,max,smartSplit);
  if(units.length<2){applyAiSplit(smartSplit(t,m,max));return}
  const model=($('smartModel').value||'').trim()||aiModelFor(info.p);
  aiCtl=new AbortController();
  const ctl=aiCtl;
  aiSetBusy(true,'جارٍ التحضير...');
  try{
    const breaks=await aiRequestBreaks({
      units,measure:m,max,mode,info,model,ctl,
      onProgress:(i,n)=>{const pr=$('smartSplitProg');if(pr)pr.textContent=`نافذة ${i} من ${n}`}
    });
    if(ctl.signal.aborted)throw abortError();
    const segs=aiSegmentsFromUnits(units,breaks,m,max,smartSplit);
    if(!segs.length)throw new Error('empty');
    applyAiSplit(segs);
    toast('تم التقسيم الذكي ✓');
  }catch(e){
    if(ctl.signal.aborted){toast('أُلغي التقسيم الذكي')}
    else{
      toast('تعذّر التقسيم الذكي — استُخدم التقسيم العادي');
      applyAiSplit(smartSplit(t,m,max));
    }
  }finally{
    aiCtl=null;
    aiSetBusy(false);
    updateSmartSplitState();
  }
}

// ---- UI: AI voice director ------------------------------------------------
let directorCtl=null,directorUndo=null;
function directorInfo(){
  if(P()==='kie')return null;
  return aiProviderInfo();
}
function directorOptions(){
  return {
    style:!!($('dirStyle')&&$('dirStyle').checked),
    tags:!!($('dirTags')&&$('dirTags').checked),
    voices:!!($('dirVoices')&&$('dirVoices').checked)
  };
}
function directorTagMode(){
  if(P()==='google')return 'gemini';
  if(P()==='or')return (typeof isOrGemini==='function'&&isOrGemini())?'gemini':'fish';
  return '';
}
function directorVoiceList(){
  if(P()==='google'||(typeof isOrGemini==='function'&&isOrGemini()))return googleVoiceNames();
  return (typeof voices!=='undefined'?voices:[]).map(v=>v.id).filter(Boolean);
}
function updateDirectorState(){
  const btn=$('directorBtn');if(!btn)return;
  const info=directorInfo(),opts=directorOptions();
  const anyOpt=opts.style||opts.tags||opts.voices;
  const hasChunks=!!(typeof chunks!=='undefined'&&chunks.length);
  btn.disabled=!!directorCtl||!info||!hasChunks||!anyOpt;
  const hint=$('directorHint');
  let msg='';
  if(P()==='kie')msg='المخرج الصوتي غير مدعوم مع kie.';
  else if(!info)msg='أضف مفتاح المزود الحالي في الإعدادات لاستخدام المخرج الصوتي.';
  else if(!hasChunks)msg='قسّم النص أولاً لاستخدام المخرج الصوتي.';
  else if(!anyOpt)msg='اختر خياراً واحداً على الأقل للمخرج الصوتي.';
  if(hint){hint.hidden=!msg;hint.textContent=msg}
  btn.title=msg||'تحسين الأداء والوسوم وتوزيع الأصوات بمساعدة الذكاء الاصطناعي';
}
function clearDirectorUndo(){
  directorUndo=null;
  const b=$('directorUndo');if(b)b.hidden=true;
}
function undoDirector(){
  if(!directorUndo||directorUndo.length!==chunks.length)return;
  chunks.forEach((c,i)=>{
    const s=directorUndo[i];
    c.text=s.text;c.style=s.style;c.voice=s.voice;
  });
  clearDirectorUndo();
  render();markDirty();
  toast('تم التراجع عن المخرج');
}
function setDirectorBusy(busy,label){
  const btn=$('directorBtn'),cancel=$('directorCancel'),pr=$('directorProgress'),desc=$('directorDesc');
  if(cancel)cancel.hidden=!busy;
  if(pr)pr.textContent=busy?(label||''):'';
  if(btn)btn.disabled=busy;
  if(desc)desc.disabled=busy;
  ['dirStyle','dirTags','dirVoices'].forEach(id=>{const el=$(id);if(el)el.disabled=busy});
}
function aiDirectorSystem(tagMode,opts){
  const tags=aiTagList(tagMode);
  const tagLine=opts.tags
    ?(tagMode==='fish'
      ?`يمكنك إضافة وسوم بين قوسين مربعين فقط من هذه القائمة: ${tags.map(t=>'['+t+']').join(' ')}. ضعها في موضعها الطبيعي، ولا تضف أي كلمة أخرى.`
      :`يمكنك إضافة وسوم بين زاويتين فقط من هذه القائمة: ${tags.map(t=>'<'+t+'>').join(' ')}. ضعها في موضعها الطبيعي، ولا تضف أي كلمة أخرى.`)
    :'لا تضف أي وسوم ولا تغيّر النص إطلاقاً.';
  return `أنت مخرج صوتي محترف. ستتلقى مقاطع نصية مرقّمة ووصفاً عاماً للعمل.
أعد JSON فقط بالشكل: {"items":[{"i":1,"style":"...","text":"...","speaker":"...","voice":"..."}]}
القواعد:
- لا تعيد كتابة النص ولا تلخّصه ولا تصحّحه. النص مقدّس.
- ${tagLine}
${opts.style?'- style: وصف موجز للأداء (نبرة، سرعة، انفعال، وقفات) بما يناسب الوصف العام، ويحافظ على الاتساق مع أسلوب المقطع السابق.':'- لا تكتب style؛ اتركه فارغاً.'}
${opts.voices?'- وزّع الأصوات: اختر voice من الأصوات المتاحة فقط، واكتب speaker (اسم أو رقم المتحدث). حافظ على نفس الصوت لنفس المتحدث عبر كل المقاطع.':'- لا توزّع أصواتاً ولا تكتب speaker/voice.'}
- إذا لم يُفعّل خيار، اترك حقلَه فارغاً أو احذفه.
- لا تخرج أي نص خارج JSON.`;
}
function aiDirectorUser(items,opts,prevStyle,speakerMap,voiceList,desc){
  return JSON.stringify({
    work:desc||'',
    options:opts,
    previousStyle:opts.style?(prevStyle||''):'',
    speakerVoices:opts.voices?speakerMap:{},
    availableVoices:opts.voices?voiceList:[],
    items:items.map(it=>({i:it.i,text:it.text,style:it.style||''}))
  });
}
async function aiRunDirector(){
  if(directorCtl)return;
  const info=directorInfo();
  if(!info){updateDirectorState();return toast(P()==='kie'?'المخرج الصوتي غير مدعوم مع kie':'أضف مفتاح المزود الحالي لاستخدام المخرج الصوتي')}
  if(!chunks.length)return toast('قسّم النص أولاً');
  const opts=directorOptions();
  if(!opts.style&&!opts.tags&&!opts.voices)return toast('اختر خياراً واحداً على الأقل للمخرج الصوتي');
  try{
    if(localStorage.getItem('directornotice')!=='1'){
      const ok=confirm('سيُرسل نص المقاطع إلى مزود الذكاء الاصطناعي المختار ('+(info.p==='g'?'Google':'OpenRouter')+') لإخراج الأداء. لن يعيد النموذج كتابة النص. متابعة؟');
      if(!ok)return;
      localStorage.setItem('directornotice','1');
    }
  }catch(e){}
  const tagMode=directorTagMode();
  const voiceList=opts.voices?directorVoiceList():[];
  const desc=(($('directorDesc')&&$('directorDesc').value)||'').trim();
  const model=($('smartModel').value||'').trim()||aiModelFor(info.p);
  const BATCH=10,total=Math.ceil(chunks.length/BATCH);
  const results=new Map(),speakerMap={};
  let prevStyle='';
  directorCtl=new AbortController();
  const ctl=directorCtl;
  setDirectorBusy(true,'جارٍ التحضير...');
  try{
    for(let start=0,b=1;start<chunks.length;start+=BATCH,b++){
      if(ctl.signal.aborted)throw abortError();
      const items=chunks.slice(start,start+BATCH).map((c,k)=>({i:start+k+1,text:c.text,style:c.style||''}));
      const sys=aiDirectorSystem(tagMode,opts);
      const user=aiDirectorUser(items,opts,prevStyle,speakerMap,voiceList,desc);
      const raw=await aiChat(info,model,sys,user,ctl);
      if(ctl.signal.aborted)throw abortError();
      const arr=aiParseDirectorItems(raw);
      if(!arr)throw new Error('bad JSON');
      for(let k=0;k<arr.length;k++){
        const it=arr[k];
        if(!it||typeof it!=='object')continue;
        const i=Number.isFinite(Number(it.i))?Math.round(Number(it.i)):start+k+1;
        if(i<start+1||i>start+items.length)continue;
        const c=chunks[i-1],r={};
        if(opts.style){
          const st=aiCleanStyle(it.style);
          if(st)r.style=st;
        }
        if(opts.tags&&typeof it.text==='string'&&aiTextMatches(c.text,it.text,tagMode)){
          const txt=aiNormalize(it.text);
          if(txt)r.text=txt;
        }
        if(opts.voices){
          const speaker=typeof it.speaker==='string'?it.speaker.trim().slice(0,60):'';
          let v=typeof it.voice==='string'?it.voice.trim():'';
          if(speaker&&speakerMap[speaker])v=speakerMap[speaker];
          else if(v&&voiceList.includes(v)){if(speaker)speakerMap[speaker]=v}
          else v='';
          if(v)r.voice=v;
        }
        if(Object.keys(r).length)results.set(i-1,r);
      }
      const lastIdx=Math.min(chunks.length,start+BATCH)-1,lastRes=results.get(lastIdx);
      if(opts.style)prevStyle=(lastRes&&lastRes.style)||chunks[lastIdx].style||prevStyle;
      const pr=$('directorProgress');if(pr)pr.textContent=`دفعة ${b} من ${total}`;
    }
    let changed=false;
    const snapshot=chunks.map(c=>({text:c.text,style:c.style||'',voice:c.voice||''}));
    for(const [idx,r] of results){
      const c=chunks[idx];if(!c)continue;
      if(r.style!=null&&r.style!==(c.style||'')){c.style=r.style;changed=true}
      if(r.text!=null&&r.text!==c.text){
        c.text=r.text;changed=true;
        if(c.blob){
          if(c.url){try{URL.revokeObjectURL(c.url)}catch(e){}c.url=null}
          c.blob=null;c.usedAccount='';c.usedModel='';
        }
      }
      if(r.voice!=null&&r.voice!==(c.voice||'')){c.voice=r.voice;changed=true}
    }
    if(!changed){toast('لم يقترح المخرج تغييرات');return}
    directorUndo=snapshot;
    const ub=$('directorUndo');if(ub)ub.hidden=false;
    render();markDirty();
    toast('تم تطبيق المخرج الصوتي ✓');
  }catch(e){
    if(ctl.signal.aborted)toast('أُلغي المخرج الصوتي');
    else toast('تعذّر إكمال المخرج الصوتي — لم تُطبَّق تغييرات');
  }finally{
    directorCtl=null;
    setDirectorBusy(false);
    updateDirectorState();
  }
}

if(typeof document!=='undefined'&&document.getElementById){
  $('smartsplitbtn').onclick=smartSplitAI;
  $('smartSplitCancel').onclick=()=>{if(aiCtl)aiCtl.abort()};
  $('smartModel').oninput=()=>{
    const v=($('smartModel').value||'').trim();
    try{localStorage.setItem(AI_MODEL_KEYS[aiFieldProvider()],v)}catch(e){}
  };
  if($('directorBtn'))$('directorBtn').onclick=aiRunDirector;
  if($('directorCancel'))$('directorCancel').onclick=()=>{if(directorCtl)directorCtl.abort()};
  if($('directorUndo'))$('directorUndo').onclick=undoDirector;
  ['dirStyle','dirTags','dirVoices'].forEach(id=>{const el=$(id);if(el)el.onchange=updateDirectorState});
  syncSmartModelField(true);
  updateSmartSplitState();
  updateDirectorState();
}
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    aiNormalize,aiSplitSentences,aiSplitLong,aiUnitsFromText,aiExtractJson,aiParseBreaks,
    aiSanitizeBreaks,aiSegmentsFromUnits,aiWindows,aiBuildPrompt,aiContentText,
    aiTagList,aiTagRegex,aiStripTags,aiTextMatches,aiParseDirectorItems,aiCleanStyle
  };
}
