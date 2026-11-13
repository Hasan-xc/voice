// ---- generation ----
function errMsg(status,body){
  body=String(body||'');
  const who={kie:'kie.ai',google:'Google AI Studio'}[P()]||'OpenRouter';
  if(status===401||(P()==='google'&&(status===403||/API key/i.test(body||''))))return `مفتاح ${who} غير صالح أو غير مسموح. تحقّق منه من زر 🔑`;
  if(P()==='google'&&status===429)return 'تجاوزت حصة Google (المجانية محدودة بالدقيقة/اليوم). '+(body||'').slice(0,160);
  if(status===402)return `الرصيد غير كافٍ (أو سالب) في حساب ${who}`;
  if(status===429)return 'تجاوزت حد الطلبات المسموح';
  if(status===422)return 'kie رفض المعاملات (422): '+(body||'').slice(0,250);
  if(!status&&/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(body))
    return 'تعذّر الاتصال بالخادم. تحقّق من الإنترنت أو من حجب الشبكة/CORS ثم أعد المحاولة.';
  if(status===500||status===502||status===503||status===504)return `الخادم غير متاح الآن (${status}). أعد المحاولة بعد قليل.`;
  return (status?status+' ':'')+(body||'').slice(0,250);
}

// OpenRouter: returns audio Blob. Gemini TTS models only accept response_format "pcm".
async function orBlob(c,ctl){
  const model=$('model').value.trim();
  const geminiTts=/gemini/i.test(model)&&/tts/i.test(model);
  const body={model,input:c.text,response_format:geminiTts?'pcm':'mp3'};
  const style=String(c.style||'').trim();
  if(style)body.instructions=style;
  if(geminiTts){
    // Per-box choice wins, then the global picker. Never send a Fish voice id
    // to a Gemini TTS model (or vice versa).
    if(c.voice&&googleVoiceNames().includes(c.voice))body.voice=c.voice;
    else{const g=$('orGvoice').value;body.voice=googleVoiceNames().includes(g)?g:'Kore'}
  }else{
    const boxVoice=String(c.voice||'').trim(),globalV=String($('voiceSelect').value||'').trim();
    if(boxVoice&&voices.some(v=>v.id===boxVoice))body.voice=boxVoice;
    else if(globalV&&voices.some(v=>v.id===globalV))body.voice=globalV;
  }
  const r=await fetchT('https://openrouter.ai/api/v1/audio/speech',{method:'POST',signal:ctl.signal,headers:{Authorization:'Bearer '+curKey(),'Content-Type':'application/json'},body:JSON.stringify(body)},GOOGLE_TIMEOUT);
  if(!r.ok)throw {status:r.status,body:await r.text()};
  if(geminiTts){
    // Gemini TTS returns raw PCM. Read the real rate/channels/bit depth from
    // the content-type instead of assuming 24kHz/16-bit/mono.
    const bytes=new Uint8Array(await r.arrayBuffer());
    const mt=(r.headers&&r.headers.get&&r.headers.get('content-type'))||'';
    c.ext='wav';
    if(sniffAudioExt(bytes)==='wav')return new Blob([bytes],{type:'audio/wav'});
    return new Blob([pcmToWav(bytes,mt).bytes],{type:'audio/wav'});
  }
  c.ext='mp3';
  return r.blob();
}

// kie.ai: createTask -> poll recordInfo -> download resultUrls[0]
async function kieBlob(c,ctl,m){
  const H={Authorization:'Bearer '+curKey(),'Content-Type':'application/json'};
  const chunkVoice=String(c.voice||'').trim();
  const voiceName=(chunkVoice&&googleVoiceNames().includes(chunkVoice))?chunkVoice:($('kvoice').value.trim()||'Kore');
  const body={
    model:$('kmodel').value.trim(),
    input:{
      speakers:[{speaker_id:'Speaker 1',voice_name:voiceName}],
      dialogue_turns:[{speaker_id:'Speaker 1',text:c.text}],
      filler_words:$('kfill').checked,
      temperature:Math.min(2,Math.max(0,+$('ktemp').value||1))
    }
  };
  const r=await fetchT('https://api.kie.ai/api/v1/jobs/createTask',{method:'POST',signal:ctl.signal,headers:H,body:JSON.stringify(body)},KIE_CREATE_TIMEOUT);
  const j=await r.json().catch(()=>({}));
  if(!r.ok||Number(j.code)!==200){
    if(Number(j.code)===429||r.status===429)throw {code:'KIE_429',status:429,body:j.msg||'تجاوز حد Kie'};
    throw {status:j.code||r.status,body:j.msg||''};
  }
  const id=j.data&&j.data.taskId;if(!id)throw {status:0,body:'لم يُرجع kie معرّف مهمة'};
  for(let n=0;n<KIE_POLL_MAX;n++){
    await sleepAbort(KIE_POLL_MS+Math.round((Math.random()*2-1)*KIE_POLL_JITTER),ctl);
    if(ctl.signal.aborted)throw abortError();
    const q=await fetchT('https://api.kie.ai/api/v1/jobs/recordInfo?taskId='+encodeURIComponent(id),{signal:ctl.signal,headers:{Authorization:H.Authorization}},KIE_POLL_TIMEOUT);
    const qj=await q.json().catch(()=>({}));
    if(!q.ok||Number(qj.code)!==200){
      if(Number(qj.code)===429||q.status===429)throw {code:'KIE_429',status:429,body:qj.msg||'تجاوز حد Kie'};
      throw {status:qj.code||q.status,body:qj.msg||''};
    }
    const d=qj.data||{};
    if(d.state==='fail')throw {status:0,body:(d.failMsg||'فشلت المهمة')+(d.failCode?` [${d.failCode}]`:'')};
    if(d.state==='success'){
      let url='';
      try{
        const rj=typeof d.resultJson==='string'?JSON.parse(d.resultJson||'{}'):(d.resultJson||{});
        url=(rj.resultUrls&&rj.resultUrls[0])||rj.url||rj.audio_url||'';
      }catch(e){}
      if(!url)throw {status:0,body:'نجحت المهمة لكن لا يوجد رابط صوت: '+(d.resultJson||'')};
      const mx=url.split('?')[0].match(/\.(mp3|wav|ogg|m4a|aac|flac)$/i);
      const extFromUrl=mx?mx[1].toLowerCase():'';
      if(m)m.textContent='جارٍ تنزيل الصوت...';
      let ar;try{ar=await fetchT(url,{signal:ctl.signal},KIE_DOWNLOAD_TIMEOUT)}catch(e){if(e&&e.name==='AbortError')throw e;throw {status:0,body:'تعذّر تنزيل الصوت (قد يمنعه المتصفح). الرابط: '+url}}
      if(!ar.ok)throw {status:ar.status,body:'تعذّر تنزيل الصوت: '+url};
      const b=await ar.blob();
      let sniffed='';
      try{sniffed=sniffAudioExt(new Uint8Array(await b.slice(0,16).arrayBuffer()))}catch(e){}
      c.ext=sniffed||extFromUrl||'mp3';
      return b;
    }
  }
  throw {status:0,body:'انتهت مهلة الانتظار (المهمة '+id+' لم تكتمل)'};
}

// Google AI Studio (Gemini API, Interactions endpoint): returns WAV Blob
// one request per box, no automatic retries — if Google returns an error it is shown as-is
function b64ToBytes(b64){const bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u}
function googleQuotaKind(text){
  const s=String(text||'');
  if(/PerDay|per[\s_-]*day|daily/i.test(s))return 'day';
  if(/PerMinute|per[\s_-]*minute|per[\s_-]*min/i.test(s))return 'minute';
  return '';
}
async function googleBlob(c,ctl,slot){
  const text={type:'text',text:c.text},style=String(c.style||'').trim()||$('gstyle').value.trim();
  if(style)text.annotations=[{type:'speech_metadata',style}];
  const voice=(c.voice&&googleVoiceNames().includes(c.voice))?c.voice:getGoogleVoice();
  const body={
    model:slot.model,
    input:[{type:'user_input',content:[text]}],
    response_format:{type:'audio'},
    generation_config:{speech_config:[{voice}]}
  };
  // Per-account spacing: a global timestamp used to serialize every account.
  const gap=Math.max(0,parseInt($('gdelay').value,10)||0)*1000;
  if(gap){
    const last=gSendAt[slot.account.id]||0,wait=last+gap-Date.now();
    if(wait>0)await sleepAbort(wait,ctl);
  }
  gSendAt[slot.account.id]=Date.now();
  const r=await fetchT('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',signal:ctl.signal,headers:{'x-goog-api-key':slot.account.key,'Content-Type':'application/json'},body:JSON.stringify(body)},GOOGLE_TIMEOUT);
  const raw=await r.text();let j={};try{j=JSON.parse(raw)}catch(e){}
  if(!r.ok){
    const detail=raw+' '+(j.error?JSON.stringify(j.error.details||''):'')+' '+(j.error&&j.error.message?j.error.message:'');
    const retryAfter=Math.max(0,Number(r.headers&&r.headers.get&&r.headers.get('retry-after'))||0)*1000;
    if(r.status===429){
      const kind=googleQuotaKind(detail);
      throw {status:429,body:(j.error&&j.error.message)||raw,googleQuota:kind||'unknown',retryAfter,accountId:slot.account.id,model:slot.model};
    }
    if((r.status===400||r.status===403)&&/API key|API_KEY|UNAUTHENTICATED|PERMISSION_DENIED|permission|denied|forbidden|unauthorized|not authorized|invalid.{0,20}key|not valid.{0,20}key/i.test(detail)){
      throw {status:r.status,body:(j.error&&j.error.message)||raw,invalidKey:true,accountId:slot.account.id};
    }
    throw {status:r.status,body:(j.error&&j.error.message)||raw};
  }
  const steps=Array.isArray(j.steps)?j.steps:[];
  const auds=steps.flatMap(s=>Array.isArray(s&&s.content)?s.content:[]).filter(x=>x&&x.type==='audio'&&x.data);
  if(!auds.length)throw {status:0,body:'لم يرجع Google أي صوت: '+raw.slice(0,200)};
  const a=auds[auds.length-1],mt=a.mime_type||a.mimeType||'audio/wav';
  let bytes=b64ToBytes(a.data);
  // The API normally returns audio/L16 PCM, but stereo/24-bit has been seen.
  // Parse rate/channels/bits from the mime type and wrap correctly.
  if(/l16|pcm|s16|s24/i.test(mt)&&sniffAudioExt(bytes)!=='wav'){
    bytes=pcmToWav(bytes,mt).bytes;
  }
  c.ext='wav';
  c.usedAccount=slot.account.name;
  c.usedModel=gLabel(slot.model);
  return new Blob([bytes],{type:'audio/wav'});
}

// WAV/PCM helpers live in js/util.js (loaded first) so they are testable in
// Node and shared with the merger.

