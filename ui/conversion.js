export function conversionUI({api,esc,fmt,toast,onStarted}) {
  const reviewed=new Set();
  let dialogActive=false;
  const key=p=>JSON.stringify([p.local,p.size,p.mtimeMs]);
  async function offer(local,{force=false,allowNative=true}={}) {
    if(dialogActive)return 'cancel';dialogActive=true;
    try{return await showOffer(local,{force,allowNative});}finally{dialogActive=false;}
  }
  async function showOffer(local,{force,allowNative}) {
    const pkg=await api('pkg_inspect',{local});
    if(!pkg.shadowConvertible)return 'native';
    if(!force&&reviewed.has(key(pkg)))return 'native';
    const plan=await api('conversion_plan',{local});
    const dialog=document.createElement('dialog');dialog.className='conversion-dialog';
    dialog.innerHTML=`<div class="eyebrow">PS5 fPKG detected</div><h2>Convert for ShadowMount?</h2><p>${esc(plan.note)}</p><p><b>${esc(pkg.name)}</b><br>${esc(pkg.titleId)} · ${fmt(pkg.size)} · Target ${esc(plan.host)}</p><label>PC output folder<input class="conversion-folder" value="${esc(plan.outputFolder)}"></label><div class="row"><button class="conversion-browse ghost">Choose folder</button><button class="conversion-space ghost">Check space</button></div><p class="conversion-capacity note"></p><label>After verification<select class="conversion-destination"><option value="">Keep image on this PC</option></select></label><div class="row"><button class="conversion-refresh ghost">Refresh destinations</button><button class="conversion-prepare ghost" hidden>Prepare internal storage</button></div><p class="conversion-storage note" role="status">Checking console storage…</p><p class="note">Extraction, compression and complete verification can take time. Temporary files are cleaned up; the verified image remains on your PC. Existing console installations must be managed separately.</p><p class="conversion-error callout warn" hidden></p><div class="form-actions row"><button class="conversion-go primary">Convert</button>${allowNative?'<button class="conversion-native ghost">Use PKG installer</button>':''}<button class="conversion-close ghost">Cancel</button></div>`;
    document.body.append(dialog);dialog.showModal();
    const $=s=>dialog.querySelector(s);let current=plan,processing=false,storageBusy=false;
    function error(e){$('.conversion-error').hidden=false;$('.conversion-error').textContent=e.message;}
    function capacity(){const enough=current.available>=current.estimatedSpace;$('.conversion-capacity').textContent=`${fmt(current.available)} free · ${fmt(current.estimatedSpace)} conservative working-space estimate. Actual expanded size is checked during extraction.`;$('.conversion-go').disabled=!enough||!current.helperReady||processing||storageBusy;$('.conversion-error').hidden=true;if(!current.helperReady)error(Error('Converter missing from this build. Use the complete Windows package.'));else if(!enough)error(Error('Choose a drive with at least '+fmt(current.estimatedSpace)+' free for this conversion.'));}
    async function check(){current=await api('conversion_plan',{local,outputFolder:$('.conversion-folder').value});$('.conversion-folder').value=current.outputFolder;capacity();}
    $('.conversion-folder').oninput=()=>{$('.conversion-go').disabled=true;};
    $('.conversion-space').onclick=()=>check().catch(error);
    $('.conversion-browse').onclick=async()=>{try{const folder=await window.desktop?.chooseFolder();if(folder){$('.conversion-folder').value=folder;await check();}}catch(e){error(e);}};
    async function destinations(prepare=false){
      if(storageBusy||processing)return;
      storageBusy=true;$('.conversion-refresh').disabled=true;$('.conversion-prepare').disabled=true;$('.conversion-destination').disabled=true;capacity();
      const note=$('.conversion-storage');note.textContent=prepare?'Preparing internal game folder…':'Checking console storage…';
      try{
        const s=await api(prepare?'shadow_prepare':'shadow_refresh');
        if(!dialog.isConnected)return;
        const select=$('.conversion-destination'),previous=select.value;
        select.innerHTML='<option value="">Keep image on this PC</option>'+s.destinations.map(d=>`<option value="${esc(d.path)}">Convert and transfer → ${esc(d.path)} (${fmt(d.available_bytes)} free)</option>`).join('');
        select.value=s.destinations.some(d=>d.path===previous)?previous:'';
        $('.conversion-prepare').hidden=!s.internalStorage?.canPrepare||s.destinations.some(d=>d.path==='/user/data/homebrew'||d.path==='/data/homebrew');
        if(prepare&&s.destinations.some(d=>d.path==='/user/data/homebrew'))select.value='/user/data/homebrew';
        note.textContent=s.destinations.length?'Console storage found. Choose a transfer destination above, or keep the image on this PC.':s.internalStorage?.error|| (s.internalStorage?.canPrepare?'Click Prepare internal storage to create the game folder, then convert and transfer directly.':'No writable scan folder is available. Check ShadowMount storage settings, or keep the image on this PC.');
      }catch(e){if(dialog.isConnected){$('.conversion-destination').innerHTML='<option value="">Keep image on this PC</option>';$('.conversion-prepare').hidden=true;note.textContent=e.message+' You can still convert and keep the image on this PC.';}}
      finally{storageBusy=false;if(dialog.isConnected){$('.conversion-refresh').disabled=false;$('.conversion-prepare').disabled=false;$('.conversion-destination').disabled=false;capacity();}}
    }
    $('.conversion-refresh').onclick=()=>destinations();
    $('.conversion-prepare').onclick=()=>destinations(true);
    capacity();void destinations();
    return await new Promise(resolve=>{
      function finish(result){dialog.close();dialog.remove();resolve(result);}
      dialog.addEventListener('cancel',e=>{e.preventDefault();if(!processing)finish('cancel');});
      $('.conversion-close').onclick=()=>finish('cancel');
      if(allowNative)$('.conversion-native').onclick=()=>{reviewed.add(key(pkg));finish('native');};
      $('.conversion-go').onclick=async()=>{processing=true;for(const b of dialog.querySelectorAll('button,input,select'))b.disabled=true;try{await api('conversion_start',{local,outputFolder:current.outputFolder,destination:$('.conversion-destination').value||undefined});finish('started');onStarted();toast('Conversion started. The original PKG will be preserved.');}catch(e){processing=false;for(const b of dialog.querySelectorAll('button,input,select'))b.disabled=false;capacity();error(e);}};
    });
  }
  async function paint(){
    const el=document.querySelector('#conversion-progress');if(!el)return;
    const s=await api('conversion_status'),j=s.job;
    if(!j){el.innerHTML='<p class="note">Select a PS5 debug game PKG in either page to convert it into a verified ShadowMount image.</p>';return;}
    const t=s.transfer,done=j.state==='transferring'?t?.processed:j.done,total=j.state==='transferring'?t?.total:j.total;
    el.innerHTML=`<b>${esc(j.pkg.name)}</b><p>${esc(j.state)} · ${esc(j.stage)}</p>${s.busy?`<progress max="100" ${total?`value="${Math.min(100,(done||0)/total*100)}"`:''}></progress>${total?`<p class="note">${fmt(done||0)} / ${fmt(total)}</p>`:''}`:''}${j.error?`<p class="callout warn">${esc(j.error)}</p>`:''}${j.report?`<p class="note">Verified image: <span class="mono">${esc(j.report.output)}</span><br>Original PKG preserved. Conversion does not modify etaHEN or add native package support.</p>`:''}<div class="row">${s.busy?'<button class="conversion-stop ghost">Cancel</button>':j.report?'<button class="conversion-send primary">Transfer verified image</button>':''}</div>`;
    el.querySelector('.conversion-stop')?.addEventListener('click',()=>api('conversion_cancel').then(paint).catch(e=>toast(e.message,true)));
    el.querySelector('.conversion-send')?.addEventListener('click',async()=>{
      try{
        const status=await api('shadow_refresh');if(!status.destinations.length)throw Error('Prepare internal storage in ShadowMount, then transfer again.');
        const dialog=document.createElement('dialog');dialog.className='conversion-dialog';dialog.innerHTML=`<h2>Transfer verified image</h2><p>${esc(j.pkg.titleId)} → ${esc(j.host)}</p><label>Console destination<select>${status.destinations.map(d=>`<option value="${esc(d.path)}">${esc(d.path)} · ${fmt(d.available_bytes)} free</option>`).join('')}</select></label><p class="note">Only this game will transfer. Other queued games remain untouched.</p><div class="row"><button class="primary">Transfer</button><button class="ghost">Cancel</button></div>`;document.body.append(dialog);dialog.showModal();
        dialog.querySelector('.ghost').onclick=()=>dialog.remove();dialog.addEventListener('cancel',()=>dialog.remove());
        dialog.querySelector('.primary').onclick=async()=>{try{await api('conversion_transfer',{destination:dialog.querySelector('select').value});dialog.remove();await paint();}catch(e){toast(e.message,true);}};
      }catch(e){toast(e.message,true);}
    });
  }
  return {offer,paint};
}
