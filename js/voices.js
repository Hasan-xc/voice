// ---- voices & Google accounts/quota --------------------------------------
const DEFAULT_VOICES=[{name:'ناشينال',id:'4b06a9b39328408f95420f1ff675cd6d'}];
// GOOGLE_TTS_VOICES lives in js/util.js ([id, Arabic character, gender]).
const GOOGLE_STATIC_CATALOG=GOOGLE_TTS_VOICES.map(([id,desc,gender])=>({id,name:id,desc,lang:'',gender:gender||'',type:'prebuilt'}));
const G_VOICES_VERSION=2;
let gVoiceCache={ts:0,voices:[]};

function saveGoogleVoiceCache(){
  try{
    const voices=(gVoiceCache.voices&&gVoiceCache.voices.length?gVoiceCache.voices:GOOGLE_STATIC_CATALOG)
      .map(v=>{const {_meta,_hay,...rest}=normalizeGoogleVoice(v)||{};return rest});
    localStorage.setItem(G_VOICES_KEY,JSON.stringify({version:G_VOICES_VERSION,ts:Date.now(),voices}));
  }catch(e){}
}
function loadGoogleVoiceCache(){
  let valid=false;
  try{
    const c=JSON.parse(localStorage.getItem(G_VOICES_KEY)||'null');
    if(c&&c.version===G_VOICES_VERSION&&Array.isArray(c.voices)&&c.voices.length){
      gVoiceCache={ts:Number(c.ts)||0,voices:c.voices.map(normalizeGoogleVoice).filter(Boolean)};
      valid=gVoiceCache.voices.length>0;
    }
  }catch(e){}
  if(!valid){
    // The cache used to be read but never written. Persist the verified static
    // catalog (with gender) so the picker has real metadata immediately.
    gVoiceCache={ts:Date.now(),voices:GOOGLE_STATIC_CATALOG.map(v=>({...v}))};
    saveGoogleVoiceCache();
  }
  gCatalogCache=null;
}
const G_CUSTOM_KEY='gcustomvoices';
let gCustomVoices=[];
// Memoized catalog: rebuilt only when gVoiceCache or gCustomVoices change.
let gCatalogCache=null;
let gOptionsCatalog=null;
const G_VOICE_PAGE=40;
let gVoiceFiltered=[],gVoiceShown=0;
const TONE_DEFS=[
  {id:'soft',label:'ناعم',re:/\b(soft|smooth|gentle|calm|relaxed)\b|ناعم|هادئ|لطيف|سلس/i},
  {id:'rough',label:'خشن/غليظ',re:/\b(gravelly|rough|hard|deep)\b|\blow pitch\b|أجش|خشن|غليظ/i},
  {id:'warm',label:'دافئ',re:/\b(warm|friendly|approachable)\b|دافئ|ودود|عفوي/i},
  {id:'energetic',label:'حيوي',re:/\b(energetic|upbeat|lively)\b|متحمس|حيوي|مرح|شبابي/i},
  {id:'firm',label:'حازم',re:/\b(firm|authoritative|commanding)\b|حازم|جريء/i},
  {id:'formal',label:'رسمي/معلوماتي',re:/\b(professional|formal|corporate)\b|معلوماتي|خبير|رسمي|متّزن|ناضج/i},
  {id:'clear',label:'واضح',re:/\b(bright|sharp)\b|\bhigh pitch\b|واضح|مشرق/i},
  {id:'calm',label:'هادئ',re:/\bcalm\b|هادئ/i}
];
const ACCENT_DEFS=[
  [/\bfrom the arab world\b/i,'عربي'],
  [/\b(saudi|saudi arabian)\b/i,'سعودي'],
  [/\b(emirati|uae)\b/i,'إماراتي'],
  [/\b(qatari|qatar)\b/i,'قطري'],
  [/\b(kuwaiti|kuwait)\b/i,'كويتي'],
  [/\b(bahraini|bahrain)\b/i,'بحريني'],
  [/\b(omani|oman)\b/i,'عماني'],
  [/\b(egyptian|egypt)\b/i,'مصري'],
  [/\b(lebanese|lebanon)\b/i,'لبناني'],
  [/\b(moroccan|morocco)\b/i,'مغربي'],
  [/\b(algerian|algeria)\b/i,'جزائري'],
  [/\b(tunisian|tunisia)\b/i,'تونسي'],
  [/\b(iraqi|iraq)\b/i,'عراقي'],
  [/\b(syrian|syria)\b/i,'سوري'],
  [/\b(jordanian|jordan)\b/i,'أردني'],
  [/\b(palestinian|palestine)\b/i,'فلسطيني'],
  [/\b(yemeni|yemen)\b/i,'يمني'],
  [/\b(sudanese|sudan)\b/i,'سوداني'],
  [/\b(gulf)\b/i,'خليجي'],
  [/\b(levantine|levant)\b/i,'شامي'],
  [/\b(maghrebi|maghreb)\b/i,'مغاربي'],
  [/\b(arab)\b/i,'عربي'],
  [/\b(german|germany)\b/i,'ألماني'],
  [/\b(austrian|austria)\b/i,'نمساوي'],
  [/\b(swiss|switzerland)\b/i,'سويسري'],
  [/\b(american|usa|united states)\b/i,'أمريكي'],
  [/\b(british|britain|english|uk)\b/i,'بريطاني'],
  [/\b(australian|australia)\b/i,'أسترالي'],
  [/\b(canadian|canada)\b/i,'كندي'],
  [/\b(irish|ireland)\b/i,'أيرلندي'],
  [/\b(scottish|scotland)\b/i,'اسكتلندي'],
  [/\b(welsh|wales)\b/i,'ويلزي'],
  [/\b(new zealand|kiwi)\b/i,'نيوزيلندي'],
  [/\b(south african)\b/i,'جنوب أفريقي'],
  [/\b(nigerian|nigeria)\b/i,'نيجيري'],
  [/\b(kenyan|kenya)\b/i,'كيني'],
  [/\b(ghanaian|ghana)\b/i,'غاني'],
  [/\b(ethiopian|ethiopia)\b/i,'إثيوبي'],
  [/\b(indian|india)\b/i,'هندي'],
  [/\b(pakistani|pakistan)\b/i,'باكستاني'],
  [/\b(bangladeshi|bangladesh)\b/i,'بنغلاديشي'],
  [/\b(sri lankan)\b/i,'سريلانكي'],
  [/\b(french|france)\b/i,'فرنسي'],
  [/\b(spanish|spain)\b/i,'إسباني'],
  [/\b(portuguese|portugal)\b/i,'برتغالي'],
  [/\b(italian|italy)\b/i,'إيطالي'],
  [/\b(greek|greece)\b/i,'يوناني'],
  [/\b(turkish|turkey)\b/i,'تركي'],
  [/\b(russian|russia)\b/i,'روسي'],
  [/\b(ukrainian|ukraine)\b/i,'أوكراني'],
  [/\b(polish|poland)\b/i,'بولندي'],
  [/\b(czech)\b/i,'تشيكي'],
  [/\b(hungarian|hungary)\b/i,'هنغاري'],
  [/\b(romanian|romania)\b/i,'روماني'],
  [/\b(dutch|netherlands|holland)\b/i,'هولندي'],
  [/\b(swedish|sweden)\b/i,'سويدي'],
  [/\b(norwegian|norway)\b/i,'نرويجي'],
  [/\b(danish|denmark)\b/i,'دنماركي'],
  [/\b(finnish|finland)\b/i,'فنلندي'],
  [/\b(japanese|japan)\b/i,'ياباني'],
  [/\b(korean|korea)\b/i,'كوري'],
  [/\b(chinese|china|mandarin|cantonese)\b/i,'صيني'],
  [/\b(thai|thailand)\b/i,'تايلاندي'],
  [/\b(vietnamese|vietnam)\b/i,'فيتنامي'],
  [/\b(indonesian|indonesia)\b/i,'إندونيسي'],
  [/\b(malaysian|malaysia)\b/i,'ماليزي'],
  [/\b(filipino|philippines)\b/i,'فلبيني'],
  [/\b(persian|iranian|iran)\b/i,'إيراني'],
  [/\b(hebrew|israeli|israel)\b/i,'عبري'],
  [/\b(brazilian|brazil)\b/i,'برازيلي'],
  [/\b(mexican|mexico)\b/i,'مكسيكي'],
  [/\b(argentinian|argentina)\b/i,'أرجنتيني'],
  [/\b(chilean|chile)\b/i,'تشيلي'],
  [/\b(colombian|colombia)\b/i,'كولومبي'],
  [/\b(peruvian|peru)\b/i,'بيروفي']
];
const LANG_ACCENT={ar:'عربي',en:'إنجليزي',de:'ألماني',fr:'فرنسي',es:'إسباني',it:'إيطالي',pt:'برتغالي',tr:'تركي',ru:'روسي',hi:'هندي',ur:'أردي',fa:'فارسي',he:'عبري',ja:'ياباني',ko:'كوري',zh:'صيني',nl:'هولندي',pl:'بولندي',sv:'سويدي',no:'نرويجي',da:'دنماركي',fi:'فنلندي',el:'يوناني',cs:'تشيكي',hu:'هنغاري',ro:'روماني',uk:'أوكراني',id:'إندونيسي',ms:'ماليزي',th:'تايلاندي',vi:'فيتنامي',fil:'فلبيني',bn:'بنغلاديشي',ta:'تاميلي',te:'تيلوغو',mr:'مراثي',gu:'غوجاراتي',kn:'كانادي',ml:'مالايالامي',pa:'بنجابي',sw:'سواحيلي'};

function normalizeGoogleVoice(v){
  if(!v)return null;
  if(typeof v==='string')return {id:v,name:v,desc:'',lang:'',gender:'',type:'',age:'',accent:'',tone:'',custom:false};
  const id=v.id||v.voice_id||v.voiceId||v.name||v.display_name||v.displayName||'';
  if(!id)return null;
  const name=v.display_name||v.displayName||v.name||id;
  const lr=v.language_code||v.languageCode||v.language_codes||v.languageCodes||v.lang||v.language||'';
  return {
    id:String(id),name:String(name),desc:String(v.description||v.desc||''),
    lang:Array.isArray(lr)?lr.join(', '):String(lr||''),gender:String(v.gender||''),
    type:String(v.type||''),age:String(v.age||''),accent:String(v.accent||''),
    tone:String(v.tone||''),custom:!!(v.custom||v.type==='custom')
  };
}
function genderLabel(g){
  const s=String(g||'').toLowerCase();
  if(s==='female')return 'أنثى';
  if(s==='male')return 'ذكر';
  if(s==='neutral')return 'محايد';
  if(s==='unknown'||s==='unspecified')return 'غير محدد';
  return g||'';
}
function loadCustomGoogleVoices(){
  gCustomVoices=[];
  try{
    const a=JSON.parse(lsGet(G_CUSTOM_KEY)||'[]');
    if(!Array.isArray(a))return;
    const seen=new Set();
    for(const raw of a){
      const v=normalizeGoogleVoice(raw);
      if(!v||!v.id||seen.has(v.id))continue;
      seen.add(v.id);v.type='custom';v.custom=true;gCustomVoices.push(v);
    }
  }catch(e){}
  gCatalogCache=null;
}
function saveCustomGoogleVoices(){
  try{
    const clean=gCustomVoices.map(v=>{const {_meta,_hay,...rest}=v;return rest});
    localStorage.setItem(G_CUSTOM_KEY,JSON.stringify(clean));
  }catch(e){}
}
function getGoogleVoiceCatalog(){
  if(gCatalogCache)return gCatalogCache;
  const base=GOOGLE_STATIC_CATALOG.map(v=>({...v}));
  const byId=new Map(base.map(v=>[v.id,v]));
  (gVoiceCache.voices||[]).forEach(raw=>{
    const v=normalizeGoogleVoice(raw);if(!v)return;
    if(byId.has(v.id)){const old=byId.get(v.id);Object.assign(old,v,{desc:v.desc||old.desc});}
    else{base.push(v);byId.set(v.id,v)}
  });
  (gCustomVoices||[]).forEach(raw=>{
    const v=normalizeGoogleVoice(raw);if(!v)return;
    v.type='custom';v.custom=true;
    if(!byId.has(v.id)){base.push(v);byId.set(v.id,v)}
  });
  // Precompute metadata and the lowercase search string once per catalog build.
  for(const v of base){
    const m=voiceMeta(v);
    v._hay=[v.id,v.name,v.desc,v.lang,m.gender,genderLabel(m.gender),m.age,m.accent,v.custom?'مخصص':'',...m.tones.map(toneLabel)].join(' ').toLowerCase();
  }
  gCatalogCache=base;
  return base;
}
function googleVoiceNames(){return getGoogleVoiceCatalog().map(v=>v.id)}
function inferGender(v){
  if(v.gender){const g=String(v.gender).toLowerCase();if(g==='male'||g==='female'||g==='neutral')return g;return g}
  const s=(v.desc||'')+' '+(v.name||'');
  if(/\b(female|woman|girl|lady|she)\b|أنثى|امرأة|فتاة|بنت/i.test(s))return 'female';
  if(/\b(male|man|boy|gentleman|he)\b|ذكر|رجل|ولد|شاب/i.test(s))return 'male';
  if(/\bneutral\b|محايد/i.test(s))return 'neutral';
  return '';
}
function inferAge(v){
  if(v.age)return String(v.age);
  const s=v.desc||'';
  let m=s.match(/(\d{1,2})\s*[- ]?\s*(?:year|yr)s?\s*[- ]?\s*old/i);
  if(!m)m=s.match(/عمر(?:ه|ها)?\s*(\d{1,2})/);
  if(!m)m=s.match(/(\d{1,2})\s*(?:سنة|عام)/);
  return m?m[1]:'';
}
function inferAccent(v){
  if(v.accent)return v.accent;
  const s=(v.desc||'')+' '+(v.name||'');
  for(const [re,label] of ACCENT_DEFS)if(re.test(s))return label;
  const lang=String(v.lang||'').split(',')[0].trim();
  if(!lang)return '';
  const parts=lang.split('-'),base=parts[0].toLowerCase(),region=(parts[1]||'').toUpperCase();
  if(base==='en')return region==='GB'?'بريطاني':region==='AU'?'أسترالي':region==='CA'?'كندي':region==='IN'?'هندي':region?'أمريكي':'إنجليزي';
  return LANG_ACCENT[base]||'';
}
function toneTags(v){
  const s=(v.desc||'')+' '+(v.name||'');
  return TONE_DEFS.filter(t=>t.re.test(s)).map(t=>t.id);
}
function toneLabel(id){
  const t=TONE_DEFS.find(x=>x.id===id);
  return t?t.label:id;
}
function voiceMeta(v){
  if(v._meta)return v._meta;
  v._meta={gender:inferGender(v),age:inferAge(v),accent:inferAccent(v),tones:toneTags(v)};
  return v._meta;
}
function voiceMetaLine(v){
  const m=voiceMeta(v),parts=[];
  if(v.custom)parts.push('مخصص');
  if(m.gender)parts.push(genderLabel(m.gender));
  if(m.age)parts.push(m.age+' سنة');
  if(m.accent)parts.push(m.accent);
  if(m.tones.length)parts.push(m.tones.map(toneLabel).join('، '));
  return parts.join(' · ')||v.desc||'Google';
}
function voiceShortLabel(v){
  const m=voiceMeta(v),parts=[v.name||v.id];
  if(v.custom)parts.push('مخصص');
  else{
    if(m.gender)parts.push(genderLabel(m.gender));
    if(m.age)parts.push(m.age+' سنة');
    if(m.accent)parts.push(m.accent);
    if(v.desc&&v.desc.length<=25)parts.push(v.desc);
  }
  return parts.join(' · ');
}
function getGoogleVoice(){return ($('gvoice').value||'Kore')}
function updateGoogleVoiceTrigger(){
  const v=getGoogleVoiceCatalog().find(x=>x.id===$('gvoice').value);
  const el=$('gVoiceTriggerText');
  if(el)el.textContent=v?voiceShortLabel(v):'اختر صوتاً';
}
function setGoogleVoiceSelection(id,save){
  const sel=$('gvoice');
  if(!id||![...sel.options].some(o=>o.value===id))return false;
  sel.value=id;updateGoogleVoiceTrigger();
  if(save)keyState();
  return true;
}
function googleVoiceRowHtml(v,selectedId){
  const selRow=v.id===selectedId;
  return `<div class="g-voice-row${selRow?' sel':''}" data-voice="${esc(v.id)}" role="option" tabindex="0" aria-selected="${selRow}">
        <span class="g-voice-main"><b>${esc(v.name)}</b><small>${esc(voiceMetaLine(v))}</small></span>
        <button class="g-voice-info" type="button" data-info="${esc(v.id)}" title="عرض معلومات الصوت" aria-label="عرض معلومات ${esc(v.name)}">ℹ</button>
      </div>`;
}
function appendGoogleVoiceRows(){
  const box=$('gVoiceList');if(!box)return;
  const end=Math.min(gVoiceFiltered.length,gVoiceShown+G_VOICE_PAGE);
  if(end<=gVoiceShown)return;
  const selectedId=$('gvoice').value;
  let html='';
  for(let k=gVoiceShown;k<end;k++)html+=googleVoiceRowHtml(gVoiceFiltered[k],selectedId);
  box.insertAdjacentHTML('beforeend',html);
  gVoiceShown=end;
}
function resetGoogleVoiceList(list){
  gVoiceFiltered=list;gVoiceShown=0;
  const box=$('gVoiceList');
  if(box){box.innerHTML='';box.scrollTop=0;appendGoogleVoiceRows()}
  const empty=$('gVoiceEmpty');if(empty)empty.hidden=!!list.length;
}
// Infinite scroll: append the next batch when the user nears the end of the list.
$('gVoiceList').addEventListener('scroll',()=>{
  if(gVoiceShown>=gVoiceFiltered.length)return;
  const box=$('gVoiceList');
  if(box.scrollTop+box.clientHeight>=box.scrollHeight-80)appendGoogleVoiceRows();
});
function renderGoogleVoicePicker(preferred){
  const catalog=getGoogleVoiceCatalog(),sel=$('gvoice');
  if(preferred&&catalog.some(v=>v.id===preferred))sel.value=preferred;
  if(!catalog.some(v=>v.id===sel.value))sel.value=catalog.some(v=>v.id==='Kore')?'Kore':(catalog[0]?.id||'');
  updateGoogleVoiceTrigger();
  const q=($('gvoiceSearch')?.value||'').trim().toLowerCase();
  const gender=$('gvoiceGender')?.value||'';
  const tone=$('gvoiceTone')?.value||'';
  const fb=$('gVoiceFilterBtn');
  if(fb){const active=!!(gender||tone);fb.textContent=active?'تصفية •':'تصفية';fb.classList.toggle('on',active)}
  // Filtering uses the precomputed metadata and lowercase haystack (no regex work here).
  const list=[];
  for(const v of catalog){
    const m=v._meta;
    if(q&&!(v._hay||'').includes(q))continue;
    if(gender&&m.gender!==gender)continue;
    if(tone&&!m.tones.includes(tone))continue;
    list.push(v);
  }
  resetGoogleVoiceList(list);
}
function renderGoogleVoiceOptions(preferred){
  const catalog=getGoogleVoiceCatalog(),hidden=$('gvoice');
  const current=hidden.value,ocur=$('orGvoice').value;
  if(catalog!==gOptionsCatalog){
    const opts=catalog.map(v=>`<option value="${esc(v.id)}">${esc(voiceShortLabel(v))}</option>`).join('');
    hidden.innerHTML=opts;
    $('orGvoice').innerHTML=opts;
    gOptionsCatalog=catalog;
  }
  if(preferred&&catalog.some(v=>v.id===preferred))hidden.value=preferred;
  else if(catalog.some(v=>v.id===current))hidden.value=current;
  if(catalog.some(v=>v.id===ocur))$('orGvoice').value=ocur;
  else $('orGvoice').value=catalog.some(v=>v.id==='Kore')?'Kore':(catalog[0]?.id||'');
  renderGoogleVoicePicker(preferred);
}
function fillOrGvoice(){renderGoogleVoiceOptions()}
function addCustomGoogleVoice(name){
  name=String(name||'').trim();
  if(!name)return null;
  const existing=getGoogleVoiceCatalog().find(v=>String(v.id).toLowerCase()===name.toLowerCase()||String(v.name).toLowerCase()===name.toLowerCase());
  if(existing){setGoogleVoiceSelection(existing.id,true);return {voice:existing,created:false}}
  const v={id:name,name,desc:'',lang:'',gender:'',type:'custom',age:'',accent:'',tone:'',custom:true};
  gCustomVoices.push(v);saveCustomGoogleVoices();
  gCatalogCache=null;
  renderGoogleVoiceOptions(name);renderVoiceSelects();
  setGoogleVoiceSelection(name,true);
  return {voice:v,created:true};
}
function deleteCustomGoogleVoice(id){
  const v=gCustomVoices.find(x=>x.id===id);
  if(!v)return false;
  gCustomVoices=gCustomVoices.filter(x=>x.id!==id);saveCustomGoogleVoices();
  gCatalogCache=null;
  const cur=$('gvoice').value;
  renderGoogleVoiceOptions(cur===id?'Kore':cur);renderVoiceSelects();
  keyState();
  toast('حُذف الاسم المخصص');
  return true;
}
function openVoiceInfo(id){
  const v=getGoogleVoiceCatalog().find(x=>x.id===id);
  if(!v)return;
  const m=voiceMeta(v);
  const rows=[
    ['الاسم',v.name],
    ['الجنس',m.gender?genderLabel(m.gender):'غير محدد'],
    ['العمر',m.age?m.age+' سنة':'غير محدد'],
    ['اللهجة/الجنسية',m.accent||'غير محدد'],
    ['اللغة',v.lang||'غير محدد'],
    ['النبرة',m.tones.length?m.tones.map(toneLabel).join('، '):'غير محدد'],
    ['المصدر',v.custom?'مخصص':'Google'],
    ['المعرّف',v.id]
  ];
  $('gInfoTitle').textContent=v.name;
  $('gInfoBody').innerHTML=`<div class="g-info-grid">${rows.map(([k,val])=>`<b>${esc(k)}</b><span dir="auto">${esc(val)}</span>`).join('')}</div>`+
    `<div class="g-info-desc">${esc(v.desc||'لا يوجد وصف إضافي.')}</div>`;
  $('gInfoUse').dataset.voice=v.id;
  $('gInfoDelete').dataset.voice=v.id;
  $('gInfoDelete').style.display=v.custom?'':'none';
  $('gInfoDelete').disabled=!v.custom;
  $('gInfoOverlay').classList.add('show');
  $('gInfoClose').focus();
}
function closeVoiceInfo(){$('gInfoOverlay').classList.remove('show')}
function openVoicePanel(){
  const p=$('gVoicePanel');if(!p)return;
  p.hidden=false;
  renderGoogleVoicePicker();
  $('gVoiceTrigger').setAttribute('aria-expanded','true');
  const f=$('gVoiceFilterPanel');if(f)f.hidden=true;
  $('gVoiceFilterBtn').setAttribute('aria-expanded','false');
  const cf=$('gCustomForm');if(cf)cf.hidden=true;
}
function closeVoicePanel(){
  const p=$('gVoicePanel');if(!p)return;
  p.hidden=true;
  $('gVoiceTrigger').setAttribute('aria-expanded','false');
  const f=$('gVoiceFilterPanel');if(f)f.hidden=true;
  $('gVoiceFilterBtn').setAttribute('aria-expanded','false');
  const cf=$('gCustomForm');if(cf)cf.hidden=true;
}


function loadVoices(){try{const v=JSON.parse(localStorage.getItem('voices')||'null');return (v&&v.length)?v:DEFAULT_VOICES}catch(e){return DEFAULT_VOICES}}
function saveVoices(v){try{localStorage.setItem('voices',JSON.stringify(v))}catch(e){}}
let voices=loadVoices();
let lastOrFamily=null;
function isOrGemini(){const m=$('model').value;return /gemini/i.test(m)&&/tts/i.test(m)}
function orFamily(){return isOrGemini()?'gemini':'fish'}
function setOrModel(){
  const fam=orFamily();
  if(lastOrFamily&&lastOrFamily!==fam){
    const allowed=fam==='gemini'?googleVoiceNames():voices.map(v=>v.id);
    let cleared=0;
    chunks.forEach(c=>{if(c.voice&&!allowed.includes(c.voice)){c.voice='';cleared++}});
    if(cleared){
      renderVoiceSelects();
      toast(`أُزيل الصوت غير المتوافق من ${cleared} مقطعاً`);
    }
    const stale=markAllChunksStale();
    if(stale)toast(`${stale} مقطعاً بحاجة إلى إعادة توليد بعد تغيير الموديل`);
  }
  lastOrFamily=fam;
  const g=fam==='gemini';
  $('orVoiceFree').style.display=g?'none':'flex';
  $('orVoiceG').style.display=g?'flex':'none';
  $('orHint').textContent=g
    ?'صوت Gemini عبر OpenRouter يُطلب بصيغة PCM ويُحوَّل تلقائياً إلى WAV. المفتاح يبقى في متصفحك ويُرسل إلى openrouter.ai فقط.'
    :'المفتاح يبقى في متصفحك ويُرسل إلى openrouter.ai فقط. الصوت المختار هنا افتراضي لكل الصناديق، ويمكن لكل صندوق اختيار صوت مختلف.';
  try{localStorage.setItem('ormodel',$('model').value);localStorage.setItem('orgvoice',$('orGvoice').value)}catch(e){}
  renderVoiceSelects();
  chunks.forEach((c,i)=>{const sel=document.querySelector(`select[data-v="${i}"]`);if(sel)sel.value=c.voice||''});
}
function renderVoiceSelects(){
  const orGoogle=isOrGemini();
  const globalList=orGoogle?getGoogleVoiceCatalog().map(v=>[v.name,v.id]):voices.map(v=>[v.name,v.id]);
  const globalOpts=globalList.map(([name,id])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
  const cur=$('voiceSelect').value;
  $('voiceSelect').innerHTML=globalOpts;
  if([...$('voiceSelect').options].some(o=>o.value===cur))$('voiceSelect').value=cur;
  // Per-chunk lists follow the active TTS provider: Google direct and Gemini use
  // the Google catalog; Fish uses the Fish voice list.
  const chunkList=(P()==='google'||orGoogle)?getGoogleVoiceCatalog().map(v=>[v.name,v.id]):voices.map(v=>[v.name,v.id]);
  const chunkOpts=chunkList.map(([name,id])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
  document.querySelectorAll('select[data-v]').forEach(sel=>{
    const kept=sel.value;
    sel.innerHTML=`<option value="">افتراضي (من الأعلى)</option>`+chunkOpts;
    if([...sel.options].some(o=>o.value===kept))sel.value=kept;
  });
}
