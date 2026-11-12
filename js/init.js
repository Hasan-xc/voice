// ---- boot ----------------------------------------------------------------
try{
  const om=localStorage.getItem('ormodel');
  if(om&&[...$('model').options].some(o=>o.value===om))$('model').value=om;
}catch(e){}
loadGoogleState();
setOrModel();

// the page restores the last autosaved draft from IndexedDB (or starts empty)
(()=>{
  syncFileBox();
  let p='or';try{p=localStorage.getItem('prov')||'or'}catch(e){}
  setProvider(['kie','google'].includes(p)?p:'or',false);
  if(typeof restoreDraft==='function')restoreDraft().catch(()=>{});
})();
