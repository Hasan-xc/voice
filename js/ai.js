// ---- AI helpers (pure functions are Node-testable) -------------------------
// In the browser js/util.js loads first and provides these globals. Under Node
// (tests) pull them from the module so the pure helpers stay testable.
if(typeof module!=='undefined'&&module.exports&&typeof splitAfterPunct==='undefined'){
  Object.assign(globalThis,require('./util.js'));
}
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
// Speaker-plan windows are smaller: the model must copy every word verbatim.
const AI_PLAN_WINDOW=2600;
const AI_PLAN_UNITS=40;

function aiNormalize(s){return String(s==null?'':s).replace(/\r/g,'').replace(/\s+/g,' ').trim()}

// Sentence atoms with a paragraph-end flag; the original text is preserved
// (whitespace is normalized exactly like the normal splitter).
function aiSplitSentences(text){
  const out=[];
  const paras=String(text==null?'':text).replace(/\r/g,'').split(/\n+/);
  for(const para of paras){
    const p=para.trim();if(!p)continue;
    // splitAfterPunct has no regex lookbehind (Safari < 16.4).
    const sents=splitAfterPunct(p,SENT_PUNCT);
    if(!sents.length)continue;
    sents.forEach((s,i)=>out.push({t:s,p:i===sents.length-1}));
  }
  return out;
}

// Fallback splitter for one over-limit sentence (same order as smartSplit:
// sentence -> comma/colon -> words, never cutting a word).
function aiSplitLong(text,measure,max){
  const m=measure||(s=>s.length),pieces=[];
  for(const p of splitAfterPunct(String(text),CLAUSE_PUNCT)){
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
function aiCleanSpeaker(s){
  return typeof s==='string'?s.replace(/\s+/g,' ').trim().slice(0,60):'';
}
// A speaker split is valid only if the parts concatenate back to the original
// text (after removing allowed tags and normalizing whitespace).
function aiPartsValid(original,parts,mode){
  if(!Array.isArray(parts)||parts.length<2)return false;
  const texts=[];
  for(const p of parts){
    const t=aiNormalize(p&&p.text);
    if(!t||!aiStripTags(t,mode))return false;
    texts.push(t);
  }
  return aiTextMatches(original,texts.join(' '),mode);
}

// ---- AI director: speaker plan (preview before applying) -----------------
// The director returns a plan (characters + lines) that is shown to the user
// for review. Only after «موافق» the lines become chunks in the work area.
function aiShort(s,n){return typeof s==='string'?s.replace(/\s+/g,' ').trim().slice(0,n||80):''}
function aiCharName(s){return aiShort(s,40).replace(/^[\s:：]+|[\s:：]+$/g,'')}
// Names are compared without diacritics so «رنا» and «رنـا» stay one character.
function aiCharKey(s){
  return aiCharName(s)
    .replace(/[\u064B-\u0652\u0670\u0640]/g,'')
    .replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .replace(/\s+/g,'')
    .toLowerCase();
}
function aiGender(s){
  const g=String(s==null?'':s).toLowerCase();
  if(/female|woman|girl|أنثى|انثى|امرأة|امراه|بنت|فتاة|فتاه/.test(g))return 'female';
  if(/male|man|boy|ذكر|رجل|ولد|شاب|فتى/.test(g))return 'male';
  if(/neutral|محايد/.test(g))return 'neutral';
  return '';
}
// The model may keep the «الاسم:» label inside text. The chunk must not.
function aiStripSpeakerPrefix(text,speaker){
  const t=String(text==null?'':text).trim();
  const name=aiCharName(speaker);
  if(!name)return t;
  const escName=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return t.replace(new RegExp('^\\s*'+escName+'\\s*[:：\\-–—]\\s*'),'').trim();
}
// Parse {"characters":[...],"lines":[...]}. Each line keeps `source` (verbatim
// original) for validation and `text` (spoken words only) for the chunk.
function aiParseSpeakerPlan(raw){
  const j=aiExtractJson(raw);
  if(!j||typeof j!=='object')return null;
  const rawChars=Array.isArray(j.characters)?j.characters:[];
  const rawLines=Array.isArray(j.lines)?j.lines:[];
  const characters=[],seen=new Set();
  for(const c of rawChars){
    if(!c||typeof c!=='object')continue;
    const name=aiCharName(c.name),key=aiCharKey(name);
    if(!key||seen.has(key))continue;
    seen.add(key);
    characters.push({
      name,
      gender:aiGender(c.gender),
      age:aiShort(c.age,30),
      desc:aiShort(c.desc,90),
      voice:aiShort(c.voice,120)
    });
  }
  const lines=[];
  for(const l of rawLines){
    if(!l||typeof l!=='object')continue;
    const speaker=aiCharName(l.speaker);
    const source=aiNormalize(l.source||l.text);
    let text=aiNormalize(l.text||l.source);
    text=aiStripSpeakerPrefix(text,speaker);
    if(!text)text=aiStripSpeakerPrefix(source,speaker);
    if(!text)continue;
    lines.push({
      speaker,
      source:source||text,
      text,
      emotion:aiShort(l.emotion,24),
      style:aiCleanStyle(l.style)
    });
  }
  if(!lines.length)return null;
  return {characters,lines};
}
function aiPlanSourceText(lines){
  return (Array.isArray(lines)?lines:[]).map(l=>aiNormalize(l&&(l.source||l.text))).join(' ');
}
// Compare spoken content only: ignore tags, punctuation, spacing and case so a
// model's punctuation edit cannot drop a whole window of dialogue.
function aiSpeechKey(text,mode){
  return aiStripTags(text,mode).replace(/[\s.,!?؟؛،:;…«»"'“”()\[\]{}<>ـ\-]+/g,'').toLowerCase();
}
function aiSpeechSame(a,b,mode){
  const ka=aiSpeechKey(a,mode),kb=aiSpeechKey(b,mode);
  return !!ka&&ka===kb;
}
function aiFallbackLines(text){
  const sents=splitSentences(String(text==null?'':text));
  const src=sents.length?sents:[aiNormalize(text)].filter(Boolean);
  return src.map(t=>({speaker:'',source:aiNormalize(t),text:aiNormalize(t),emotion:'',style:''}));
}
function aiPickVoice(gender,catalog,used){
  const list=(Array.isArray(catalog)?catalog:[]).filter(v=>v&&v.id);
  if(!list.length)return '';
  const free=list.filter(v=>!used||!used.has(v.id));
  const pool=free.length?free:list;
  const want=gender&&pool.find(v=>aiGender(v.gender)===gender);
  return (want||pool[0]).id;
}
// Ensure every line speaker exists in characters and every character has one
// valid, distinct-when-possible voice from the current provider catalog.
function aiFinalizePlan(plan,catalog){
  const chars=plan&&Array.isArray(plan.characters)?plan.characters.map(c=>({...c})):[];
  const lines=plan&&Array.isArray(plan.lines)?plan.lines.slice():[];
  const byKey=new Map();
  chars.forEach(c=>{const k=aiCharKey(c.name);if(k)byKey.set(k,c)});
  for(const l of lines){
    const name=l.speaker||'الراوي',key=aiCharKey(name);
    if(!key)continue;
    if(!byKey.has(key)){
      const c={name,gender:'',age:'',desc:'',voice:''};
      chars.push(c);byKey.set(key,c);
    }
  }
  const ids=new Set((Array.isArray(catalog)?catalog:[]).map(v=>v&&v.id).filter(Boolean));
  const used=new Set();
  for(const c of chars){
    if(c.voice&&!ids.has(c.voice))c.voice='';
    if(c.voice&&used.has(c.voice))c.voice='';
    if(!c.voice)c.voice=aiPickVoice(c.gender,catalog,used);
    if(c.voice)used.add(c.voice);
  }
  return {characters:chars,lines};
}
// Build the actual chunks: text is the spoken line only (no «name:»), voice is
// the user-approved character voice, style/speaker stay internal metadata.
function aiBuildSpeakerChunks(plan,opts){
  const map=(opts&&opts.voices)||{};
  const lines=plan&&Array.isArray(plan.lines)?plan.lines:[];
  return lines.map((l,i)=>{
    const key=aiCharKey(l.speaker);
    return {
      text:aiNormalize(l.text),
      voice:(key&&map[key])||'',
      speaker:l.speaker||'',
      style:l.style||'',
      name:String(i+1),
      ext:'mp3'
    };
  }).filter(c=>c.text);
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
async function googleTextReply(j){
  if(typeof j.output_text==='string')return j.output_text;
  const steps=Array.isArray(j.steps)?j.steps:[];
  return steps.flatMap(s=>Array.isArray(s&&s.content)?s.content:[]).filter(x=>x&&x.type==='text').map(x=>x.text||'').join('');
}
async function aiChatGoogle(info,model,sys,user,ctl){
  // The TTS endpoint uses the structured Interactions body; older text
  // revisions accept a plain string. Try structured first, then fall back on
  // an input-shape 400 so the two call sites can never disagree.
  const structured={model,input:[{type:'user_input',content:[{type:'text',text:user}]}],system_instruction:sys,generation_config:{temperature:0}};
  const plain={model,input:user,system_instruction:sys,generation_config:{temperature:0}};
  for(const body of [structured,plain]){
    const r=await fetchT(AI_G_URL,{method:'POST',signal:ctl.signal,headers:{'x-goog-api-key':info.key,'Content-Type':'application/json'},body:JSON.stringify(body)},AI_TIMEOUT);
    const raw=await r.text();let j={};try{j=JSON.parse(raw)}catch(e){}
    if(r.ok)return googleTextReply(j);
    const msg=(j.error&&j.error.message)||raw;
    if(r.status===400&&/input|content|request/i.test(msg))continue;
    throw {status:r.status,body:msg.slice(0,300)};
  }
  throw {status:400,body:'تعذّر إرسال الطلب إلى Google (صيغة input غير مدعومة)'};
}
async function aiChat(info,model,sys,user,ctl){
  if(info.p==='g')return aiChatGoogle(info,model,sys,user,ctl);
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
  chunks=segs.map((text,i)=>({text,voice:'',name:defName(i),style:'',speaker:''}));
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
function directorVoiceCatalog(){
  if(P()==='google'||(typeof isOrGemini==='function'&&isOrGemini())){
    return getGoogleVoiceCatalog().map(v=>{
      const m=(typeof voiceMeta==='function')?voiceMeta(v):{};
      return {id:v.id,name:v.name||v.id,gender:m.gender||'',age:m.age||'',accent:m.accent||'',desc:v.desc||''};
    });
  }
  return (typeof voices!=='undefined'?voices:[]).map(v=>({id:v.id,name:v.name||v.id,gender:v.gender||'',age:v.age||'',desc:v.desc||''})).filter(v=>v.id);
}
function directorVoiceList(){return directorVoiceCatalog().map(v=>v.id)}
function updateDirectorState(){
  const btn=$('directorBtn');if(!btn)return;
  const info=directorInfo(),opts=directorOptions();
  const anyOpt=opts.style||opts.tags||opts.voices;
  const hasChunks=!!(typeof chunks!=='undefined'&&chunks.length);
  const hasText=!!(($('text')&&$('text').value||'').trim()||hasChunks);
  // The speaker-preview flow works on the source text, so chunks are not
  // required when voice distribution is enabled.
  const ready=opts.voices?hasText:hasChunks;
  btn.disabled=!!directorCtl||!info||!ready||!anyOpt;
  const hint=$('directorHint');
  let msg='';
  if(P()==='kie')msg='المخرج الصوتي غير مدعوم مع kie.';
  else if(!info)msg='أضف مفتاح المزود الحالي في الإعدادات لاستخدام المخرج الصوتي.';
  else if(!ready)msg=opts.voices?'اكتب النص أو الصقه أولاً.':'قسّم النص أولاً لاستخدام المخرج الصوتي.';
  else if(!anyOpt)msg='اختر خياراً واحداً على الأقل للمخرج الصوتي.';
  if(hint){hint.hidden=!msg;hint.textContent=msg}
  btn.title=msg||(opts.voices?'تحليل الشخصيات وعرض نبذة قبل إدخال المقاطع':'تحسين الأداء والوسوم وتوزيع الأصوات بمساعدة الذكاء الاصطناعي');
}
function clearDirectorUndo(){
  if(directorUndo){
    // Release only URLs that are no longer used by the live chunks.
    const live=new Set((typeof chunks!=='undefined'?chunks:[]).map(c=>c.url).filter(Boolean));
    directorUndo.forEach(s=>{
      if(s&&s.url&&!live.has(s.url)){try{URL.revokeObjectURL(s.url)}catch(e){}}
    });
  }
  directorUndo=null;
  const b=$('directorUndo');if(b)b.hidden=true;
}
function undoDirector(){
  if(!directorUndo)return;
  const snap=directorUndo;
  const keep=new Set(snap.map(s=>s.url).filter(Boolean));
  chunks.forEach(c=>{if(c.url&&!keep.has(c.url)){try{URL.revokeObjectURL(c.url)}catch(e){}}});
  chunks=snap.map(s=>({...s}));
  directorUndo=null;
  const b=$('directorUndo');if(b)b.hidden=true;
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
// Explicit instructions for the speaker-splitting stage. This is the stage the
// user sees as a preview (نبذة) before anything is placed in the work area.
function aiSpeakerSystem(tagMode,opts){
  const tags=aiTagList(tagMode);
  const tagList=tagMode==='fish'
    ?tags.map(t=>'['+t+']').join(' ')
    :tags.map(t=>'<'+t+'>').join(' ');
  const tagRule=opts.tags
    ?`أضف وسم أداء واحداً على الأكثر في بداية الجملة أو نهايتها، من هذه القائمة فقط: ${tagList}. اختر الوسم حسب انفعال الشخصية في هذا الموضع من القصة (مثل <gasp> للدهشة، <sigh> للحسرة، <laugh> للضحك). لا تترجم الوسم ولا تكتب وصفاً عربياً مكانه.`
    :'لا تضف أي وسوم إطلاقاً.';
  return `أنت مخرج صوتي ومحلل حوارات محترف. مهمتك الأولى والأهم: تقسيم النص إلى أدوار متحدثين قبل توليد أي صوت.
ستتلقى نصاً عربياً (سرد وحوار). أعد JSON فقط بهذا الشكل:
{"characters":[{"name":"عمار","gender":"male","age":"شاب","desc":"شاب متحمس في العشرين","voice":"Puck"}],"lines":[{"speaker":"عمار","source":"عمار: مابكم يا شباب هيا..","text":"مابكم يا شباب هيا..","emotion":"حماس","style":"متحمس"}]}

القواعد الإلزامية:
1) قسّم النص بالترتيب إلى lines. كل line هو جملة أو جملتان متتاليتان لشخصية واحدة فقط. اقطع عند كل تغيّر متحدث.
2) source: انسخ الجزء الأصلي من النص حرفياً كما هو، بما فيه «الاسم:» إن وُجد. مجموع كل source بالترتيب يجب أن يعيد النص الأصلي كاملاً بلا زيادة أو نقصان.
3) text: الكلام المنطوق فقط، بدون «الاسم:» وبدون علامات الاقتباس وبدون كلمات السرد المحيطة. لا تحذف أي كلمة من الكلام ولا تعيد صياغته ولا تلخّصه.
4) استخرج كل الشخصيات التي تتحدث أو تُذكر. استخدم الاسم نفسه لكل ظهور، ولا تخلط بين شخصيتين.
5) استنتج الجنس والعمر من الاسم والسياق والقصة (مثال: عمار = شاب، رنا = بنت متوسطة العمر، الجدة = مسنة). اكتب age بالعربية.
6) اختر voice من availableVoices فقط بما يناسب الجنس والعمر والشخصية. لا تخترع معرّفاً. اجعل لكل شخصية صوتاً مختلفاً إن أمكن.
7) السرد غير الحواري يُسند إلى الراوي (speaker:"الراوي") بصوت راوٍ مناسب، ويبقى في lines حتى لا يضيع النص.
8) ${tagRule}
9) ${opts.style?'style: وصف قصير للأداء (نبرة/سرعة/انفعال) لكل سطر.':'اترك style فارغاً.'}
10) لا تخرج أي نص خارج JSON.`;
}
function aiSpeakerUser(text,characters,catalog,desc,prevTail){
  return JSON.stringify({
    work:desc||'',
    previousContext:prevTail||'',
    knownCharacters:Array.isArray(characters)?characters:[],
    availableVoices:Array.isArray(catalog)?catalog:[],
    text:String(text||'')
  });
}

function aiDirectorSystem(tagMode,opts){
  const tags=aiTagList(tagMode);
  const tagLine=opts.tags
    ?(tagMode==='fish'
      ?`يمكنك إضافة وسوم بين قوسين مربعين فقط من هذه القائمة: ${tags.map(t=>'['+t+']').join(' ')}. ضعها في موضعها الطبيعي، ولا تضف أي كلمة أخرى.`
      :`يمكنك إضافة وسوم بين زاويتين فقط من هذه القائمة: ${tags.map(t=>'<'+t+'>').join(' ')}. ضعها في موضعها الطبيعي، ولا تضف أي كلمة أخرى.`)
    :'لا تضف أي وسوم ولا تغيّر النص إطلاقاً.';
  const splitLine=opts.voices
    ?`- إذا كان المقطع يحتوي أكثر من متحدث (سرد + حوار، أو حوار بين شخصين)، قسّمه إلى parts عند حدود المتحدثين فقط. كل part: {"text":"...","speaker":"...","voice":"..."}. مجموع نصوص parts (بعد إزالة الوسوم المسموحة وتوحيد المسافات) يجب أن يطابق نص المقطع الأصلي حرفياً. لا تقسّم داخل جملة واحدة أو داخل اقتباس.`
    :'- لا تقسّم المقطع ولا ترسل parts.';
  const voiceLine=opts.voices
    ?`- وزّع الأصوات: اختر voice من قائمة availableVoices فقط، واكتب speaker تسمية عربية قصيرة للمتحدث (مثل: الراوي، الأم، الطفل). حافظ على نفس speaker ونفس voice لنفس الشخصية عبر كل المقاطع والدفعات. اختر الصوت المناسب لجنس/عمر الشخصية: الراوي الشاب صوت رجالي عادي، الأم صوت أنثوي ناضج، الطفل صوت طفولي/رجالي. لا تخترع معرّف صوت غير موجود.`
    :'- لا توزّع أصواتاً ولا تكتب speaker/voice ولا parts.';
  return `أنت مخرج صوتي محترف. ستتلقى مقاطع نصية مرقّمة ووصفاً عاماً للعمل.
أعد JSON فقط بالشكل: {"items":[{"i":1,"style":"...","text":"...","speaker":"...","voice":"...","parts":[...]}]}
القواعد:
- لا تعيد كتابة النص ولا تلخّصه ولا تصحّحه. النص مقدّس.
- ${tagLine}
${opts.style?'- style: وصف موجز للأداء (نبرة، سرعة، انفعال، وقفات) بما يناسب الوصف العام، ويحافظ على الاتساق مع أسلوب المقطع السابق.':'- لا تكتب style؛ اتركه فارغاً.'}
${splitLine}
${voiceLine}
- إذا لم يُفعّل خيار، اترك حقلَه فارغاً أو احذفه.
- لا تخرج أي نص خارج JSON.`;
}
function aiDirectorUser(items,opts,prevStyle,speakerMap,knownSpeakers,voiceCatalog,desc){
  return JSON.stringify({
    work:desc||'',
    options:opts,
    previousStyle:opts.style?(prevStyle||''):'',
    speakerVoices:opts.voices?speakerMap:{},
    knownSpeakers:opts.voices?[...knownSpeakers]:[],
    availableVoices:opts.voices?voiceCatalog:[],
    items:items.map(it=>({i:it.i,text:it.text,style:it.style||'',speaker:it.speaker||''}))
  });
}
async function aiDirectorChunks(){
  if(directorCtl)return;
  const info=directorInfo();
  if(!info){updateDirectorState();return toast(P()==='kie'?'المخرج الصوتي غير مدعوم مع kie':'أضف مفتاح المزود الحالي لاستخدام المخرج الصوتي')}
  if(!chunks.length)return toast('قسّم النص أولاً');
  const opts=directorOptions();
  if(!opts.style&&!opts.tags&&!opts.voices)return toast('اختر خياراً واحداً على الأقل للمخرج الصوتي');
  try{
    if(localStorage.getItem('directornotice')!=='1'){
      const ok=confirm('سيُرسل نص المقاطع إلى مزود الذكاء الاصطناعي المختار ('+(info.p==='g'?'Google':'OpenRouter')+') لإخراج الأداء. قد يقسّم المخرج المقطع حسب المتحدثين دون تغيير النص. متابعة؟');
      if(!ok)return;
      localStorage.setItem('directornotice','1');
    }
  }catch(e){}
  const tagMode=directorTagMode();
  const voiceCatalog=opts.voices?directorVoiceCatalog():[];
  const voiceList=voiceCatalog.map(v=>v.id);
  const desc=(($('directorDesc')&&$('directorDesc').value)||'').trim();
  const model=($('smartModel').value||'').trim()||aiModelFor(info.p);
  const BATCH=10,total=Math.ceil(chunks.length/BATCH);
  const results=new Map(),speakerMap={},knownSpeakers=new Set();
  let prevStyle='';
  // A new run replaces any previous undo and releases its unused audio URLs.
  clearDirectorUndo();
  directorCtl=new AbortController();
  const ctl=directorCtl;
  setDirectorBusy(true,'جارٍ التحضير...');
  try{
    for(let start=0,b=1;start<chunks.length;start+=BATCH,b++){
      if(ctl.signal.aborted)throw abortError();
      const items=chunks.slice(start,start+BATCH).map((c,k)=>({i:start+k+1,text:c.text,style:c.style||'',speaker:c.speaker||''}));
      const sys=aiDirectorSystem(tagMode,opts);
      const user=aiDirectorUser(items,opts,prevStyle,speakerMap,knownSpeakers,voiceCatalog,desc);
      const raw=await aiChat(info,model,sys,user,ctl);
      if(ctl.signal.aborted)throw abortError();
      const arr=aiParseDirectorItems(raw);
      if(!arr)throw new Error('bad JSON');
      for(let k=0;k<arr.length;k++){
        const it=arr[k];
        if(!it||typeof it!=='object')continue;
        const i=Number.isFinite(Number(it.i))?Math.round(Number(it.i)):start+k+1;
        if(i<start+1||i>start+items.length)continue;
        const c=chunks[i-1],r={baseText:c.text};
        if(opts.style){
          const st=aiCleanStyle(it.style);
          if(st)r.style=st;
        }
        if(opts.tags&&typeof it.text==='string'&&aiTextMatches(c.text,it.text,tagMode)){
          const txt=aiNormalize(it.text);
          if(txt)r.text=txt;
        }
        if(opts.voices){
          const sp=aiCleanSpeaker(it.speaker);
          if(sp){r.speaker=sp;knownSpeakers.add(sp)}
          let v=typeof it.voice==='string'?it.voice.trim():'';
          if(sp&&speakerMap[sp])v=speakerMap[sp];
          else if(v&&voiceList.includes(v)){if(sp)speakerMap[sp]=v}
          else v='';
          if(v)r.voice=v;
          if(Array.isArray(it.parts)&&it.parts.length>1){
            const parts=[];
            for(const p of it.parts){
              if(!p||typeof p.text!=='string'){parts.length=0;break}
              let txt=aiNormalize(p.text);
              if(!opts.tags)txt=aiStripTags(txt,tagMode);
              if(!txt){parts.length=0;break}
              const psp=aiCleanSpeaker(p.speaker);
              if(psp)knownSpeakers.add(psp);
              let pv=typeof p.voice==='string'?p.voice.trim():'';
              if(psp&&speakerMap[psp])pv=speakerMap[psp];
              else if(pv&&voiceList.includes(pv)){if(psp)speakerMap[psp]=pv}
              else pv='';
              if(!pv&&psp&&psp===sp&&v)pv=v;
              parts.push({text:txt,speaker:psp,voice:pv,style:aiCleanStyle(p.style)});
            }
            if(parts.length>1&&new Set(parts.map(p=>p.speaker).filter(Boolean)).size>1&&aiPartsValid(c.text,parts,tagMode))r.parts=parts;
          }
        }
        if(Object.keys(r).length>1)results.set(i-1,r);
      }
      const lastIdx=Math.min(chunks.length,start+BATCH)-1,lastRes=results.get(lastIdx);
      if(opts.style){
        let ls=(lastRes&&lastRes.style)||'';
        if(lastRes&&lastRes.parts&&lastRes.parts.length)ls=lastRes.parts[lastRes.parts.length-1].style||ls;
        prevStyle=ls||chunks[lastIdx].style||prevStyle;
      }
      const pr=$('directorProgress');if(pr)pr.textContent=`دفعة ${b} من ${total}`;
    }
    // Snapshot full chunks so undo can restore the exact chunk count, speaker
    // labels, and any audio that was detached by a text change or a split.
    const snapshot=chunks.map(c=>({...c}));
    let changed=false;
    const out=[];
    for(let idx=0;idx<chunks.length;idx++){
      const c=chunks[idx],r=results.get(idx);
      if(!r){out.push(c);continue}
      if(r.baseText!=null&&c.text!==r.baseText){out.push(c);continue}
      if(r.parts&&r.parts.length>1){
        // Split by speaker. The old audio belongs to the whole chunk; it stays
        // in the undo snapshot and is released if the undo is discarded.
        if(c.url){try{URL.revokeObjectURL(c.url)}catch(e){}}
        c.blob=null;c.url=null;c.usedAccount='';c.usedModel='';c.stale=false;
        const base=cleanName(c.name)||defName(idx);
        r.parts.forEach((p,k)=>{
          out.push({
            text:p.text,
            voice:p.voice||'',
            speaker:p.speaker||'',
            style:p.style||r.style||c.style||'',
            name:k===0?base:`${base}-${k+1}`,
            ext:c.ext||'mp3'
          });
          changed=true;
        });
        continue;
      }
      if(r.style!=null&&r.style!==(c.style||'')){c.style=r.style;markChunkStale(c);changed=true}
      if(r.speaker!=null&&r.speaker!==(c.speaker||'')){c.speaker=r.speaker;markChunkStale(c);changed=true}
      if(r.text!=null&&r.text!==c.text){
        c.text=r.text;changed=true;
        if(c.url){try{URL.revokeObjectURL(c.url)}catch(e){}}
        c.blob=null;c.url=null;c.usedAccount='';c.usedModel='';c.stale=false;
      }
      if(r.voice!=null&&r.voice!==(c.voice||'')){c.voice=r.voice;markChunkStale(c);changed=true}
      out.push(c);
    }
    if(!changed){toast('لم يقترح المخرج تغييرات');return}
    chunks=out;
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

// ---- UI: speaker preview before applying ---------------------------------
let directorPlan=null;
function directorSourceText(){
  const t=($('text')&&$('text').value||'').trim();
  if(t)return t;
  return (typeof chunks!=='undefined'?chunks:[]).map(c=>c.text).filter(Boolean).join('\n').trim();
}
function dirCharMeta(c){
  const g=c.gender==='female'?'أنثى':c.gender==='male'?'ذكر':c.gender==='neutral'?'محايد':'';
  return [g,c.age,c.desc].filter(Boolean).join(' · ');
}
function directorVoiceOptions(selected){
  const cat=(directorPlan&&directorPlan.catalog)||[];
  return cat.map(v=>{
    const extra=[v.gender==='female'?'أنثى':v.gender==='male'?'ذكر':'',v.age].filter(Boolean).join(' ');
    return `<option value="${esc(v.id)}"${v.id===selected?' selected':''}>${esc(v.name||v.id)}${extra?' — '+esc(extra):''}</option>`;
  }).join('');
}
function renderDirectorPreview(){
  if(!directorPlan)return;
  const chars=$('directorChars'),lines=$('directorLines'),cnt=$('directorLinesCount');
  if(chars){
    chars.innerHTML=directorPlan.characters.map((c,i)=>`<div class="dir-char">
      <div class="dir-char-id"><span class="dir-char-name">${esc(c.name)}</span>
      <span class="dir-char-meta">${esc(dirCharMeta(c)||'شخصية')}</span></div>
      <select data-dcv="${i}" dir="ltr" aria-label="صوت ${esc(c.name)}">${directorVoiceOptions(c.voice)}</select>
    </div>`).join('')||'<div class="dir-empty">لم تُكتشف شخصيات — سيُستخدم الراوي.</div>';
  }
  if(lines){
    lines.innerHTML=directorPlan.lines.map(l=>`<div class="dir-line">
      <span class="dir-spk">${esc(l.speaker||'الراوي')}</span><span class="dir-colon">:</span>
      <span class="dir-txt">${esc(l.text)}</span>
      ${l.emotion?`<span class="dir-emo">${esc(l.emotion)}</span>`:''}
    </div>`).join('');
  }
  if(cnt)cnt.textContent=`(${fmt(directorPlan.lines.length)})`;
}
function openDirectorPreview(){
  renderDirectorPreview();
  const ov=$('directorOverlay');
  if(ov)ov.classList.add('show');
}
function closeDirectorPreview(){
  const ov=$('directorOverlay');
  if(ov)ov.classList.remove('show');
}
function applyDirectorPreview(){
  if(!directorPlan)return;
  const voiceMap={};
  directorPlan.characters.forEach(c=>{const k=aiCharKey(c.name);if(k&&c.voice)voiceMap[k]=c.voice});
  const next=aiBuildSpeakerChunks(directorPlan,{voices:voiceMap});
  if(!next.length)return toast('لا توجد مقاطع لإدخالها');
  const snapshot=(typeof chunks!=='undefined'?chunks:[]).map(c=>({...c}));
  // Release the previous undo snapshot (its audio is no longer reachable).
  clearDirectorUndo();
  // Old audio stays in the undo snapshot; it is released only if the undo is
  // discarded, exactly like the previous director behaviour.
  chunks=next;
  directorUndo=snapshot;
  const ub=$('directorUndo');if(ub)ub.hidden=false;
  directorPlan=null;
  closeDirectorPreview();
  render();markDirty();
  if(typeof autoMergeName==='function')autoMergeName(false);
  toast(`تم إدخال ${fmt(next.length)} مقطعاً حسب المتحدثين ✓`);
}
async function aiDirectorPreview(){
  if(directorCtl)return;
  const info=directorInfo();
  if(!info){updateDirectorState();return toast(P()==='kie'?'المخرج الصوتي غير مدعوم مع kie':'أضف مفتاح المزود الحالي لاستخدام المخرج الصوتي')}
  const text=directorSourceText();
  if(!text)return toast('اكتب النص أو الصقه أولاً');
  const opts=directorOptions();
  if(!opts.style&&!opts.tags&&!opts.voices)return toast('اختر خياراً واحداً على الأقل للمخرج الصوتي');
  const catalog=directorVoiceCatalog();
  if(!catalog.length)return toast('لا توجد أصوات متاحة لهذا المزود — أضف صوتاً من الإعدادات');
  try{
    if(localStorage.getItem('directornotice')!=='1'){
      const ok=confirm('سيُرسل نص العمل إلى مزود الذكاء الاصطناعي المختار ('+(info.p==='g'?'Google':'OpenRouter')+') لتحليل الشخصيات وتقسيم الحوار. ستظهر لك نبذة للمراجعة قبل إدخال أي مقطع إلى مساحة العمل. متابعة؟');
      if(!ok)return;
      localStorage.setItem('directornotice','1');
    }
  }catch(e){}
  const tagMode=directorTagMode();
  const desc=(($('directorDesc')&&$('directorDesc').value)||'').trim();
  const model=($('smartModel').value||'').trim()||aiModelFor(info.p);
  const units=aiUnitsFromText(text,s=>s.length,AI_PLAN_WINDOW);
  const wins=aiWindows(units,AI_PLAN_WINDOW,AI_PLAN_UNITS);
  directorCtl=new AbortController();
  const ctl=directorCtl;
  setDirectorBusy(true,'جارٍ تحليل الشخصيات...');
  try{
    const charMap=new Map();
    const lines=[];
    let prevTail='';
    for(let w=0;w<wins.length;w++){
      if(ctl.signal.aborted)throw abortError();
      const [a,b]=wins[w];
      const winText=units.slice(a,b).map(u=>u.t).join(' ');
      const sys=aiSpeakerSystem(tagMode,opts);
      const user=aiSpeakerUser(winText,[...charMap.values()],catalog,desc,prevTail);
      const raw=await aiChat(info,model,sys,user,ctl);
      if(ctl.signal.aborted)throw abortError();
      const parsed=aiParseSpeakerPlan(raw);
      let winLines=[];
      if(parsed&&parsed.lines.length&&aiSpeechSame(winText,aiPlanSourceText(parsed.lines),tagMode)){
        winLines=parsed.lines;
        for(const c of parsed.characters){
          const k=aiCharKey(c.name);if(!k)continue;
          const old=charMap.get(k);
          if(!old)charMap.set(k,{...c});
          else{
            if(!old.gender&&c.gender)old.gender=c.gender;
            if(!old.age&&c.age)old.age=c.age;
            if(!old.desc&&c.desc)old.desc=c.desc;
            if(!old.voice&&c.voice)old.voice=c.voice;
          }
        }
      }else{
        // Never lose text: fall back to the original sentences of this window.
        winLines=aiFallbackLines(winText);
      }
      lines.push(...winLines);
      const last=winLines[winLines.length-1];
      prevTail=last?last.text.slice(-160):'';
      const pr=$('directorProgress');if(pr)pr.textContent=`تحليل ${w+1} من ${wins.length}`;
    }
    if(!lines.length)throw new Error('empty');
    for(const l of lines){
      const name=l.speaker||'الراوي',k=aiCharKey(name);
      if(k&&!charMap.has(k))charMap.set(k,{name,gender:'',age:'',desc:'',voice:''});
    }
    const fin=aiFinalizePlan({characters:[...charMap.values()],lines},catalog);
    directorPlan={characters:fin.characters,lines:fin.lines,catalog,tagMode};
    setDirectorBusy(false);
    openDirectorPreview();
  }catch(e){
    if(ctl.signal.aborted)toast('أُلغي المخرج الصوتي');
    else toast('تعذّر تحليل الشخصيات — لم يتغيّر شيء');
  }finally{
    directorCtl=null;
    setDirectorBusy(false);
    updateDirectorState();
  }
}
function aiRunDirector(){
  if(directorCtl)return;
  const opts=directorOptions();
  // With voice distribution on, the director re-splits the source text by
  // speaker and shows a preview. Without it, it keeps the old per-chunk flow.
  if(opts.voices)return aiDirectorPreview();
  return aiDirectorChunks();
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
  if($('directorApply'))$('directorApply').onclick=applyDirectorPreview;
  if($('directorPreviewCancel'))$('directorPreviewCancel').onclick=()=>{directorPlan=null;closeDirectorPreview()};
  if($('directorOverlay')){
    $('directorOverlay').onclick=e=>{if(e.target.id==='directorOverlay'){directorPlan=null;closeDirectorPreview()}};
    $('directorOverlay').addEventListener('change',e=>{
      const i=e.target.dataset&&e.target.dataset.dcv;
      if(i==null||!directorPlan)return;
      const c=directorPlan.characters[+i];
      if(c)c.voice=e.target.value;
    });
  }
  ['dirStyle','dirTags','dirVoices'].forEach(id=>{const el=$(id);if(el)el.onchange=updateDirectorState});
  syncSmartModelField(true);
  updateSmartSplitState();
  updateDirectorState();
}
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    aiNormalize,aiSplitSentences,aiSplitLong,aiUnitsFromText,aiExtractJson,aiParseBreaks,
    aiSanitizeBreaks,aiSegmentsFromUnits,aiWindows,aiBuildPrompt,aiContentText,
    aiTagList,aiTagRegex,aiStripTags,aiTextMatches,aiParseDirectorItems,aiCleanStyle,
    aiCleanSpeaker,aiPartsValid,aiParseSpeakerPlan,aiPlanSourceText,aiSpeechKey,
    aiSpeechSame,aiFallbackLines,aiFinalizePlan,aiBuildSpeakerChunks,aiCharKey,
    aiStripSpeakerPrefix,aiGender,aiPickVoice,aiSpeakerSystem
  };
}
