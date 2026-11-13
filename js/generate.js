async function googleBlobWithSlots(c,ctl,m){
  const ambiguous=new Set();
  let retrySlot=null;
  for(let guard=0;guard<100;guard++){
    if(stopReq||ctl.signal.aborted){
      if(retrySlot)releaseSlot(retrySlot);
      throw abortError();
    }
    const slot=retrySlot||acquireGoogleSlot();
    retrySlot=null;
    if(!slot){const e=new Error('no slot');e.noSlot=true;throw e}
    try{
      const b=await googleBlob(c,ctl,slot);
      updateGoogleQuotaUI();
      return b;
    }catch(err){
      if(err&&(err.name==='AbortError'||err.timeout)){releaseSlot(slot);throw err}
      if(err&&err.googleQuota==='day'){
        releaseSlot(slot);
        markGoogleExhausted(slot);
        continue;
      }
      if(err&&err.googleQuota==='minute'){
        const delay=Math.min(90000,Math.max(15000,err.retryAfter||60000));
        if(m){m.className='tag';m.textContent=`حد Google بالدقيقة… إعادة خلال ${Math.ceil(delay/1000)} ث`}
        try{await sleepAbort(delay,ctl)}catch(e){releaseSlot(slot);throw e}
        retrySlot=slot;
        continue;
      }
      if(err&&err.googleQuota==='unknown'){
        const key=slot.account.id+'|'+slot.model;
        if(ambiguous.has(key)){
          releaseSlot(slot);
          markGoogleExhausted(slot);
          continue;
        }
        ambiguous.add(key);
        const delay=Math.min(60000,Math.max(5000,err.retryAfter||15000));
        if(m){m.className='tag';m.textContent='حد Google غير واضح… محاولة واحدة أخرى'}
        try{await sleepAbort(delay,ctl)}catch(e){releaseSlot(slot);throw e}
        retrySlot=slot;
        continue;
      }
      if(err&&err.invalidKey){
        releaseSlot(slot);
        slot.account.enabled=false;
        saveGoogleAccounts();renderGoogleAccounts();
        toast(`تم تعطيل ${slot.account.name}: مفتاح غير صالح`);
        continue;
      }
      releaseSlot(slot);
      throw err;
    }
  }
  if(retrySlot)releaseSlot(retrySlot);
  const e=new Error('no slot');e.noSlot=true;throw e;
}
async function gen(i,opts){
  opts=opts||{};
  const myEpoch=epoch,c=chunks[i];
  if(!c)return false;
  if(P()==='google'){
    if(!googleAnyKey()){$('keybox').style.display='block';alert('أضف مفتاح حساب Google أو فعّل حساباً أولاً');return false}
  }else if(!curKey()){
    $('keybox').style.display='block';
    alert('أدخل مفتاح '+({kie:'kie.ai',google:'Google AI Studio'}[P()]||'OpenRouter')+' أولاً');
    return false;
  }
  const m=$('m'+i),card=$('c'+i);
  if(m){m.className='tag chunk-msg';m.textContent=''}
  if(card){card.classList.add('work','busy');card.classList.remove('err')}
  const ctl=new AbortController();ctls.set(i,ctl);
  let tries=0,timeoutTries=0,kieAttempt=opts.kieAttempt||0;
  try{
    while(true){
      if(!isAlive(i,c,myEpoch)||stopReq||ctl.signal.aborted)return false;
      try{
        const blob=P()==='kie'?await kieBlob(c,ctl,m):P()==='google'?await googleBlobWithSlots(c,ctl,m):await orBlob(c,ctl);
        if(!isAlive(i,c,myEpoch)||stopReq||ctl.signal.aborted)return false;
        c.blob=blob;c.stale=false;
        if(c.url)URL.revokeObjectURL(c.url);
        c.url=URL.createObjectURL(c.blob);
        if(P()!=='google'){c.usedAccount='';c.usedModel=''}
        const a=$('a'+i);if(a)a.innerHTML=audioHtml(i,c);
        if(m){m.className='tag ok';m.textContent='تم ✓'}
        if(card){card.classList.add('done');card.classList.remove('err','work')}
        prog();markDirty();return true;
      }catch(err){
        if(!isAlive(i,c,myEpoch))return false;
        if(err&&err.code==='KIE_429'){
          if(opts.kieQueue){if(m){m.className='tag';m.textContent='حد Kie: بانتظار الإعادة…'}return {retry:true,attempt:kieAttempt}}
          if(kieAttempt<KIE_MAX_ATTEMPTS-1){
            const delay=KIE_RETRY_DELAYS[Math.min(kieAttempt,KIE_RETRY_DELAYS.length-1)];
            if(m){m.className='tag';m.textContent=`حد Kie… إعادة خلال ${Math.ceil(delay/1000)} ث`}
            await sleepAbort(delay,ctl);kieAttempt++;continue;
          }
        }
        if(err&&err.status===429&&P()!=='google'&&!opts.kieQueue&&tries<3&&!stopReq){
          tries++;
          if(m){m.className='tag';m.textContent='حد الطلبات… إعادة المحاولة خلال 20 ثانية'}
          await sleepAbort(RETRY_DELAY,ctl);continue;
        }
        // One transparent retry for transient timeouts (network hiccups).
        if(err&&err.timeout&&!opts.kieQueue&&timeoutTries<1&&!stopReq){
          timeoutTries++;
          if(m){m.className='tag';m.textContent='انتهت المهلة… محاولة أخيرة'}
          await sleepAbort(2500,ctl);continue;
        }
        throw err;
      }
    }
  }catch(err){
    if(!isAlive(i,c,myEpoch))return false;
    if(err&&err.noSlot){
      // Quota exhaustion must not abort the whole batch: mark this chunk as
      // pending and let the remaining chunks try other accounts.
      if(m){m.className='tag';m.textContent='معلّق — لا حصة Google الآن'}
      if(card)card.classList.remove('work','err');
      showNoSlots();return false;
    }
    if(stopReq&&!ctl.signal.aborted)return false;
    if(err&&err.name==='AbortError'){
      if(m){m.className='tag';m.textContent='أُلغي'}
      if(card)card.classList.remove('err','work');
      return false;
    }
    if(err&&err.timeout){
      if(m){m.className='tag bad';m.textContent='انتهت المهلة. اضغط توليد لإعادة المحاولة.'}
      if(card){card.classList.add('err');card.classList.remove('work')}
      return false;
    }
    if(m){
      m.className='tag bad';
      m.textContent=err&&err.code==='KIE_429'
        ?'خطأ: تجاوز حد Kie بعد 4 محاولات'
        :'خطأ: '+errMsg(err&&err.status,(err&&(err.body||err.message))||'');
    }
    if(card){card.classList.add('err');card.classList.remove('work')}
    return false;
  }finally{
    const owns=ctls.get(i)===ctl;
    if(owns)ctls.delete(i);
    if(epoch===myEpoch&&chunks[i]===c&&(owns||!ctls.has(i))){
      if(card)card.classList.remove('busy');
    }
  }
}
// Wait until the gap (measured from the previous send) has elapsed.
function delayUntil(i,target,myEpoch){
  return new Promise(res=>{
    if(stopReq||epoch!==myEpoch)return res();
    const m=$('m'+i),f2=n=>String(n).padStart(2,'0');
    let timer=null;
    const tick=()=>{
      if(stopReq||epoch!==myEpoch){if(timer)clearTimeout(timer);return res()}
      const left=target-Date.now();
      if(left<=0){if(m)m.textContent='';return res()}
      const s=Math.ceil(left/1000);
      if(m)m.textContent=`بانتظار ${f2(Math.floor(s/60))}:${f2(s%60)} ثم الإرسال...`;
      timer=setTimeout(tick,Math.min(1000,left));
    };
    tick();
  });
}
function showKieRetryCountdown(i,readyAt,myEpoch){
  const m=$('m'+i);if(!m)return;
  const tick=()=>{
    if(stopReq||epoch!==myEpoch||!document.body.contains(m))return;
    const left=readyAt-Date.now();
    if(left<=0){m.className='tag';m.textContent='بانتظار إعادة المحاولة…';return}
    m.className='tag';m.textContent=`حد Kie: إعادة خلال ${Math.ceil(left/1000)} ث`;
    setTimeout(tick,1000);
  };
  tick();
}
function runKieQueue(pending,myEpoch){
  return new Promise(resolve=>{
    const queue=pending.slice(),retries=[],launchTimes=[],attempts=new Map();
    let active=0,finished=false,timer=null;
    function finish(){
      if(finished)return;
      finished=true;
      if(timer){clearTimeout(timer);timer=null}
      resolve();
    }
    function schedule(){
      if(finished)return;
      if(timer){clearTimeout(timer);timer=null}
      if(stopReq||epoch!==myEpoch){finish();return}
      const now=Date.now();
      while(launchTimes.length&&now-launchTimes[0]>=KIE_WINDOW_MS)launchTimes.shift();
      for(let k=retries.length-1;k>=0;k--){
        if(retries[k].readyAt<=now){queue.push(retries[k].i);retries.splice(k,1)}
      }
      while(!stopReq&&epoch===myEpoch&&active<KIE_MAX_CONCURRENT&&queue.length&&launchTimes.length<KIE_LAUNCH_PER_WINDOW){
        const i=queue.shift();
        launchTimes.push(Date.now());
        active++;
        const attempt=attempts.get(i)||0;
        gen(i,{kieQueue:true,kieAttempt:attempt}).then(res=>{
          active--;
          if(epoch!==myEpoch){finish();return}
          if(res&&res.retry){
            const next=attempt+1;
            if(next>=KIE_MAX_ATTEMPTS){
              const m=$('m'+i),card=$('c'+i);
              if(m){m.className='tag bad';m.textContent='خطأ: تجاوز حد Kie بعد 4 محاولات'}
              if(card){card.classList.add('err');card.classList.remove('work')}
            }else{
              attempts.set(i,next);
              const delay=KIE_RETRY_DELAYS[Math.min(attempt,KIE_RETRY_DELAYS.length-1)];
              const readyAt=Date.now()+delay;
              retries.push({i,readyAt});
              showKieRetryCountdown(i,readyAt,myEpoch);
            }
          }
          schedule();
        }).catch(err=>{
          active--;
          if(epoch!==myEpoch){finish();return}
          const m=$('m'+i),card=$('c'+i);
          if(m){m.className='tag bad';m.textContent='خطأ: '+((err&&err.message)||'غير معروف')}
          if(card){card.classList.add('err');card.classList.remove('work')}
          schedule();
        });
      }
      if(!stopReq&&epoch===myEpoch&&active===0&&queue.length===0&&retries.length===0){finish();return}
      let wait=250;
      if(!queue.length&&retries.length){
        const next=Math.min(...retries.map(r=>r.readyAt))-Date.now();
        wait=Math.max(50,Math.min(1000,next));
      }
      timer=setTimeout(schedule,wait);
    }
    schedule();
  });
}
$('allbtn').onclick=async()=>{
  cancelAll(false);
  stopReq=false;
  const myRun=++runSeq,myEpoch=epoch;
  const key=curKey();
  if(!key){
    $('keybox').style.display='block';
    alert(P()==='google'?'أضف مفتاح حساب Google أو فعّل حساباً أولاً':'أدخل مفتاح '+({kie:'kie.ai',google:'Google AI Studio'}[P()]||'OpenRouter')+' أولاً');
    return;
  }
  $('allbtn').style.display='none';$('stopbtn').style.display='';
  // Stale chunks (audio generated with an old voice/style/model) count as pending.
  const pending=chunks.map((c,i)=>i).filter(i=>chunkPending(chunks[i]));
  // Refuse to start when the user set a cap and the known estimate exceeds it.
  const cap=Math.max(0,Number($('costCap')&&$('costCap').value)||0);
  if(cap>0&&pending.length){
    const est=costForChunks(pending.map(i=>chunks[i]));
    if(est.known&&!est.free&&est.usd>cap){
      $('stopbtn').style.display='none';$('allbtn').style.display='';
      alert(`التقدير ${est.label} يتجاوز سقف التكلفة $${cap.toFixed(2)}. ارفع السقف أو قلّل النص.`);
      return;
    }
  }
  try{
    if(P()==='kie'){
      await runKieQueue(pending,myEpoch);
    }else if(P()==='google'){
      // Parallel workers, one per usable account (capped). The per-account
      // delay is enforced inside googleBlob, so different accounts can send
      // at the same time while each account keeps its own spacing.
      const usable=Math.max(1,gAccounts.filter(a=>a.enabled&&a.key).length);
      const workers=Math.max(1,Math.min(4,usable,pending.length||1));
      let idx=0;
      const worker=async()=>{
        while(idx<pending.length&&!stopReq&&epoch===myEpoch){
          const i=pending[idx++];
          await gen(i);
        }
      };
      await Promise.all(Array.from({length:workers},worker));
    }else{
      let idx=0;
      async function worker(){
        while(idx<pending.length&&!stopReq&&epoch===myEpoch){
          const i=pending[idx++];
          await gen(i);
          if(!stopReq&&epoch===myEpoch)await sleep(STAGGER);
        }
      }
      await Promise.all(Array.from({length:Math.min(CONCURRENCY,pending.length)||1},worker));
    }
  }finally{
    if(myRun===runSeq){
      $('stopbtn').style.display='none';$('allbtn').style.display='';
      $('allbtn').textContent=chunks.some(c=>chunkPending(c))?'▶ استئناف':'▶ توليد الكل';
      const bc=$('batchCount');if(bc)bc.textContent='';
    }
  }
};
$('stopbtn').onclick=()=>{cancelAll(true)};
