// ---- boot ----------------------------------------------------------------
try{
  const om=localStorage.getItem('ormodel');
  if(om&&[...$('model').options].some(o=>o.value===om))$('model').value=om;
}catch(e){}
loadGoogleState();
setOrModel();

// the page always starts empty (no autosave); only the provider choice is remembered
(()=>{
  syncFileBox();
  let p='or';try{p=localStorage.getItem('prov')||'or'}catch(e){}
  setProvider(['kie','google'].includes(p)?p:'or',false);
})();
