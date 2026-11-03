// ---- generation ----
function errMsg(status,body){
  body=String(body||'');
  const who={kie:'kie.ai',google:'Google AI Studio'}[P()]||'OpenRouter';
  if(status===401||(P()==='google'&&(status===403||/API key/i.test(body||''))))return `مفتاح ${who} غير صالح أو غير مسموح. تحقّق منه من زر 🔑`;
  if(P()==='google'&&status===429)return 'تجاوزت حصة Google (المجانية محدودة بالدقيقة/اليوم). '+(body||'').slice(0,160);
  if(status===402)return `الرصيد غير كافٍ (أو سالب) في حساب ${who}`;
  if(status===429)return 'تجاوزت حد الطلبات المسموح';
  if(status===422)return 'kie رفض المعاملات (422): '+(body||'').slice(0,250);
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
  if(geminiTts){ // raw PCM (16-bit, usually 24kHz mono) -> wrap into a WAV file
    const bytes=new Uint8Array(await r.arrayBuffer());
    const mt=(r.headers&&r.headers.get&&r.headers.get('content-type'))||'';
    const m=mt.match(/rate=(\d+)/),rate=m?+m[1]:24000;
    c.ext='wav';
    return new Blob([wavFromPcm(bytes,rate)],{type:'audio/wav'});
  }
  c.ext='mp3';
  return r.blob();
}

// kie.ai: createTask -> poll recordInfo -> download resultUrls[0]
async function kieBlob(c,ctl,m){
  const H={Authorization:'Bearer '+curKey(),'Content-Type':'application/json'};
  const body={
    model:$('kmodel').value.trim(),
    input:{
      speakers:[{speaker_id:'Speaker 1',voice_name:$('kvoice').value.trim()||'Kore'}],
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
    if(m)m.textContent=`جارٍ التوليد في kie... (${n+1})`;
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
  const body={
    model:slot.model,
    input:[{type:'user_input',content:[text]}],
    response_format:{type:'audio'},
    generation_config:{speech_config:[{voice:getGoogleVoice()}]}
  };
  googleSendAt=Date.now();
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
  c.ext=/l16|pcm/i.test(mt)?'pcm':'wav';
  let bytes=b64ToBytes(a.data);
  if(c.ext==='pcm'){
    const m=String(mt).match(/rate=(\d+)/);
    bytes=wavFromPcm(bytes,m?+m[1]:24000);
    c.ext='wav';
  }
  c.usedAccount=slot.account.name;
  c.usedModel=gLabel(slot.model);
  return new Blob([bytes],{type:'audio/wav'});
}

// ---- WAV helpers (merge WAVs properly: strip headers, join PCM, write one header) ----
function sniffAudioExt(u){
  if(!u||u.length<4)return '';
  if(u[0]===0x52&&u[1]===0x49&&u[2]===0x46&&u[3]===0x46)return 'wav';
  if(u[0]===0x49&&u[1]===0x44&&u[2]===0x33)return 'mp3';
  if(u[0]===0xFF&&(u[1]&0xE0)===0xE0)return 'mp3';
  if(u[0]===0x4F&&u[1]===0x67&&u[2]===0x67&&u[3]===0x53)return 'ogg';
  if(u[0]===0x66&&u[1]===0x4C&&u[2]===0x61&&u[3]===0x43)return 'flac';
  return '';
}
function wavHeader(dataLen,rate,ch,bits){
  const b=new DataView(new ArrayBuffer(44)),w=(o,s)=>[...s].forEach((x,i)=>b.setUint8(o+i,x.charCodeAt(0)));
  w(0,'RIFF');b.setUint32(4,36+dataLen,true);w(8,'WAVEfmt ');b.setUint32(16,16,true);b.setUint16(20,1,true);b.setUint16(22,ch,true);
  b.setUint32(24,rate,true);b.setUint32(28,rate*ch*bits/8,true);b.setUint16(32,ch*bits/8,true);b.setUint16(34,bits,true);w(36,'data');b.setUint32(40,dataLen,true);
  return new Uint8Array(b.buffer);
}
function wavFromPcm(pcm,rate=24000){const h=wavHeader(pcm.length,rate,1,16),o=new Uint8Array(44+pcm.length);o.set(h);o.set(pcm,44);return o}
function parseWav(u){
  const dv=new DataView(u.buffer,u.byteOffset,u.byteLength);let rate=24000,ch=1,bits=16,o=12;
  while(o+8<=u.length){
    const id=String.fromCharCode(u[o],u[o+1],u[o+2],u[o+3]);let sz=dv.getUint32(o+4,true);
    if(id==='fmt '){ch=dv.getUint16(o+10,true);rate=dv.getUint32(o+12,true);bits=dv.getUint16(o+22,true)}
    if(id==='data'){if(o+8+sz>u.length)sz=u.length-o-8;return {rate,ch,bits,pcm:u.subarray(o+8,o+8+sz)}}
    o+=8+sz+(sz&1);
  }
  return {rate,ch,bits,pcm:u.subarray(44)};
}
async function mergeWavs(blobs){
  if(!blobs.length)throw new Error('لا توجد ملفات للدمج');
  const parts=[];for(const b of blobs)parts.push(parseWav(new Uint8Array(await b.arrayBuffer())));
  const f=parts[0];
  const bad=parts.find(p=>p.rate!==f.rate||p.ch!==f.ch||p.bits!==f.bits);
  if(bad){
    throw new Error(`لا يمكن دمج ملفات WAV بإعدادات مختلفة: الأول ${f.rate}Hz/${f.ch}ch/${f.bits}bit، وملف آخر ${bad.rate}Hz/${bad.ch}ch/${bad.bits}bit. وحّد الإعدادات أولاً.`);
  }
  const len=parts.reduce((a,p)=>a+p.pcm.length,0),out=new Uint8Array(44+len);
  out.set(wavHeader(len,f.rate,f.ch,f.bits));let o=44;for(const p of parts){out.set(p.pcm,o);o+=p.pcm.length}
  return new Blob([out],{type:'audio/wav'});
}
