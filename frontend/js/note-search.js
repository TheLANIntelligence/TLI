/* Optional, reviewed similarity search. No automatic Chat recall or model launch. */
(() => {
  'use strict';
  const protocol = 'tli-related-notes-v1', base = '/api/intelligence/note-search';
  const $ = id => document.getElementById(id);
  const state = {epoch:0, open:false, busy:false, supported:false, notes:[], devices:[], selected:new Set(), review:null, index:null, timer:null, returnFocus:null};
  let locked=false, pending=null;
  const node = (tag,text,cls) => { const n=document.createElement(tag); if(text!=null)n.textContent=text; if(cls)n.className=cls; return n; };
  const button = (text,fn) => { const b=node('button',text,'btn-outline'); b.type='button'; b.addEventListener('click',()=>{if(state.open&&!locked&&!b.disabled)return fn();}); return b; };
  const field = (label,input) => { const n=node('label',null,'note-search-field'); n.append(node('span',label),input); return n; };
  const bounded = (s,max) => typeof s==='string' && s.length>0 && s.length<=max;
  const ref = n => bounded(n?.id,256) && /^[a-f0-9]{64}$/.test(n?.revision || '');
  const opaque = s => typeof s==='string' && /^[A-Za-z0-9_-]{20,64}$/.test(s);
  const status = text => { if($('note-search-status'))$('note-search-status').textContent=text; };
  const fresh = epoch => state.open && !locked && epoch===state.epoch;
  const blocked = () => state.busy || !!pending || !state.open || locked || !state.supported;
  const title = n => n.title || 'Untitled note';
  function dispose(ident) {
    if(!opaque(ident))return;
    fetch(base+'/'+encodeURIComponent(ident),{method:'DELETE',cache:'no-store',redirect:'error'}).catch(()=>{});
  }
  async function api(path,body) {
    const requestEpoch=state.epoch;
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response.status===401){if(fresh(requestEpoch))window.dispatchEvent(new CustomEvent('tli-session-locked'));throw new Error('Unlock TLI before searching saved notes.');}
    const data=await response.json();
    if(!response.ok || data?.ok!==true || data.protocol!==protocol)throw Object.assign(new Error(typeof data?.detail==='string'?data.detail:'This host did not return a supported related-note result.'),{status:response.status});
    return data;
  }
  function update() {
    const busy=state.busy || !!pending || !state.supported;
    for(const input of $('note-search-setup')?.querySelectorAll('input') || [])input.disabled=busy;
    if($('note-search-review-button'))$('note-search-review-button').disabled=busy || !state.selected.size;
    if($('note-search-build'))$('note-search-build').disabled=busy || !state.review || !$('note-search-ack')?.checked;
    if($('note-search-submit'))$('note-search-submit').disabled=busy || !state.index || !$('note-search-query')?.value.trim();
    if($('note-search-search'))$('note-search-search').hidden=!state.index;
    if($('note-search-query'))$('note-search-query').disabled=busy;
    if($('note-search-target'))$('note-search-target').disabled=busy;
    if($('note-search-support'))$('note-search-support').disabled=state.busy || !!pending;
    if($('note-search-ack'))$('note-search-ack').disabled=busy;
  }
  function invalidateReview() {
    if(blocked())return;
    dispose(state.review?.review_id); state.review=null;
    $('note-search-review')?.replaceChildren(); update();
  }
  function close() {
    if(!state.open)return;
    state.open=false; state.epoch++; state.busy=false; clearTimeout(state.timer);state.timer=null;
    dispose(state.review?.review_id);dispose(state.index?.index_id);
    state.review=null;state.index=null;state.notes=[];state.devices=[];state.selected.clear();state.supported=false;
    $('note-search-body')?.replaceChildren();status('');
    if($('note-search-dialog')?.open)$('note-search-dialog').close();
    state.returnFocus?.focus?.();state.returnFocus=null;
  }
  function choice(note) {
    const check=node('input');check.type='checkbox';check.value=note.id;
    check.addEventListener('change',()=>{
      if(blocked()){check.checked=state.selected.has(note.id);return;}
      if(check.checked && state.selected.size>=64){check.checked=false;status('Choose up to 64 whole notes.');return;}
      check.checked?state.selected.add(note.id):state.selected.delete(note.id);invalidateReview();
    });
    const label=node('label',null,'note-search-choice');
    label.append(check,node('span',`${title(note)}${note.device_id?' · associated with '+(state.devices.find(d=>d.id===note.device_id)?.name || note.device_id):' · general note'}`));
    return label;
  }
  function setup() {
    const body=$('note-search-body');body.replaceChildren();
    const intro=node('div',null,'note-search-intro');
    intro.append(node('p','Find notes by meaning using an embedding server you already run on this TLI computer. This optional search is separate from “Use saved notes” in Chat.'),
      node('p','Choose notes → Review their text → Build a temporary index → Search. TLI does not install or switch a model. The chosen server may load its configured model when you build or search.'));
    const form=node('section');form.id='note-search-setup';
    const recheck=button('Check search support',loadCapabilities);recheck.id='note-search-support';
    const back=button('Return to Notes & fixes',()=>{close();window.TLINotebook?.open();});
    const grid=node('div',null,'note-search-fields');
    const port=node('input');port.id='note-search-port';port.type='number';port.min='1024';port.max='65535';port.value='1234';
    const model=node('input');model.id='note-search-model';model.type='text';model.maxLength=256;model.placeholder='Exact embedding model identifier';model.autocomplete='off';
    const key=node('input');key.id='note-search-key';key.type='password';key.maxLength=2048;key.autocomplete='off';
    const advanced=node('details');advanced.append(node('summary','Optional server API token'),field('API token (kept only for this temporary index)',key),node('p','Submitting a token requires HTTPS or opening TLI on the host computer.'));
    grid.append(field('Loopback server port',port),field('Embedding model',model));
    const notes=node('fieldset',null,'note-search-notes');notes.append(node('legend','Choose saved notes (up to 64; whole text must fit 64 KiB)'));
    state.notes.forEach(n=>notes.append(choice(n)));
    if(!state.notes.length)notes.append(node('p','No current saved notes are available. Save a note first; earlier device memory must be converted to a current note.'));
    const review=button('Review selected notes',reviewNotes);review.id='note-search-review-button';
    form.append(grid,advanced,notes,review);
    for(const input of [port,model,key])input.addEventListener('input',invalidateReview);
    const reviewed=node('section');reviewed.id='note-search-review';
    const search=node('section',null,'note-search-search');search.id='note-search-search';search.hidden=true;
    const info=node('p');info.id='note-search-index-status';
    const target=node('select');target.id='note-search-target';const all=node('option','General notes only');all.value='';target.append(all);
    const ids=new Set(state.notes.map(n=>n.device_id).filter(Boolean));
    state.devices.filter(d=>ids.has(d.id)).forEach(d=>{const o=node('option',`${d.name} · ${d.id}`);o.value=d.id;target.append(o);});
    const query=node('input');query.id='note-search-query';query.type='search';query.maxLength=1000;query.placeholder='For example: the fix for missing printer jobs';query.addEventListener('input',update);
    const submit=button('Find related notes',searchNotes);submit.id='note-search-submit';
    query.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchNotes();}});
    search.append(node('h3','Search the reviewed notes'),info,field('Include device-associated notes for',target),field('What do you want to find?',query),submit,
      node('p','Results are suggestions based on similarity. Opening a note does not attach it to Chat or establish that its contents are true.'));
    const results=node('section');results.id='note-search-results';results.setAttribute('aria-label','Related note results');
    const navigation=node('div',null,'note-search-navigation');navigation.append(recheck,back);
    body.append(intro,navigation,form,reviewed,search,results);update();
  }
  async function reviewNotes() {
    if(blocked() || !state.selected.size)return;
    const port=Number($('note-search-port').value),model=$('note-search-model').value.trim();
    if(!Number.isInteger(port) || port<1024 || port>65535 || !model){status('Enter a loopback server port (1024–65535) and its exact embedding model identifier.');return;}
    const epoch=state.epoch;state.busy=true;dispose(state.review?.review_id);state.review=null;$('note-search-review').replaceChildren();update();status('Checking selected note revisions…');
    const expected=state.notes.filter(n=>state.selected.has(n.id)).map(n=>({id:n.id,revision:n.revision}));
    try {
      const value=await api('/review',{notes:expected,port,model,api_key:$('note-search-key').value});
      if(!fresh(epoch)){dispose(value.review_id);return;}
      if(!opaque(value.review_id) || value.expires_in_seconds!==300 || value.inference_called!==false || value.actions_performed!==false || value.endpoint!==`http://127.0.0.1:${port}/v1/embeddings` || value.model!==model || !bounded(value.scope,4000) ||
        !Number.isInteger(value.text_bytes) || value.text_bytes<0 || value.text_bytes>65536 || !Array.isArray(value.notes) || value.notes.length!==expected.length ||
        value.notes.some((n,i)=>!ref(n) || n.id!==expected[i].id || n.revision!==expected[i].revision || (n.device_id||null)!==(state.notes.find(row=>row.id===n.id)?.device_id||null) || typeof n.text!=='string' || n.text.length>65536 || typeof n.title!=='string' || n.title.length>240)) {
        dispose(value.review_id);throw new Error('The reviewed selection did not match your notes and server. Nothing was sent to the embedding server.');
      }
      dispose(state.review?.review_id);state.review=value;
      const box=$('note-search-review');box.replaceChildren();
      box.append(node('h3','Review before building'),node('p',`${value.notes.length} notes · ${value.text_bytes.toLocaleString()} bytes · ${value.endpoint} · ${value.model}`),node('p',value.scope));
      value.notes.forEach(n=>{const article=node('details',null,'note-search-source');article.append(node('summary',title(n)),node('p',n.text,'note-search-text'));box.append(article);});
      const ack=node('input');ack.id='note-search-ack';ack.type='checkbox';ack.addEventListener('change',update);
      const label=node('label',null,'note-search-choice');label.append(ack,node('span','Send these reviewed notes to this embedding server to build a temporary index.'));
      const build=button('Build temporary index',buildIndex);build.id='note-search-build';box.append(label,build);
      status('Review the whole selected text. No embedding request has run.');
    } catch(error){if(fresh(epoch))status((error.message || 'Note review failed.')+' Previous search results, if any, are retained.');}
    finally{if(fresh(epoch)){state.busy=false;update();}}
  }
  async function buildIndex() {
    if(blocked() || !state.review || !$('note-search-ack')?.checked)return;
    const epoch=state.epoch,review=state.review,reservation={};pending=reservation;state.busy=true;update();status('Building the reviewed index… The embedding server may load its model. Closing this view does not cancel that server request.');
    try {
      const value=await api('/build',{review_id:review.review_id,reviewed:true});
      if(!fresh(epoch)){dispose(value.index_id);return;}
      if(!opaque(value.index_id) || value.model!==review.model || value.note_count!==review.notes.length || !Number.isInteger(value.dimensions) || value.dimensions<1 || value.dimensions>4096 || value.expires_in_seconds!==1800 || value.source_retained!==false || !bounded(value.scope,4000)){if(value.index_id!==state.index?.index_id)dispose(value.index_id);throw new Error('The host did not confirm the reviewed index. Review the notes again before searching.');}
      state.index={...value,refs:review.notes.map(n=>({id:n.id,revision:n.revision,device_id:n.device_id||null}))};state.review=null;clearTimeout(state.timer);$('note-search-review').replaceChildren();$('note-search-key').value='';
      $('note-search-results').replaceChildren();
      $('note-search-index-status').textContent=`${value.note_count} reviewed notes · ${value.model} · expires in 30 minutes. Note edits, lock and restart invalidate it. Model quality has not been validated.`;
      state.timer=setTimeout(()=>{if(fresh(epoch)){dispose(state.index?.index_id);state.index=null;$('note-search-results').replaceChildren();status('The temporary index expired. Review your notes again to rebuild it.');update();}},1800000);
      status('Temporary index ready. Describe a note and choose Find related notes.');
    } catch(error){if(fresh(epoch)){dispose(review.review_id);state.review=null;$('note-search-review').replaceChildren();status((error.message || 'The index could not be built.')+' Existing search results have not been replaced. A new explicit note review is required before another build.');}}
    finally{if(pending===reservation)pending=null;if(fresh(epoch))state.busy=false;if(state.open)update();}
  }
  async function searchNotes() {
    const query=$('note-search-query')?.value.trim();
    if(blocked() || !state.index || !query)return;
    const epoch=state.epoch,index=state.index,target=$('note-search-target').value || null,reservation={};
    if(target&&!state.devices.some(d=>d.id===target)){status('Choose a registered device or general notes. No search was sent.');return;}
    pending=reservation;state.busy=true;update();status('Finding related notes… Closing this view does not cancel the embedding request.');
    try {
      const value=await api('/search',{index_id:index.index_id,query,target_id:target});
      if(!fresh(epoch))return;
      const eligible=index.refs.filter(n=>!n.device_id||n.device_id===target);
      if(value.actions_performed!==false || value.chat_context_changed!==false || value.target_id!==target || !bounded(value.scope,4000) || !Array.isArray(value.results) || value.results.length!==Math.min(8,eligible.length) || value.candidate_count!==eligible.length ||
         new Set(value.results.map(n=>n?.id)).size!==value.results.length || value.results.some(n=>!ref(n) || !eligible.some(e=>e.id===n.id&&e.revision===n.revision&&e.device_id===(n.device_id||null)) || typeof n.title!=='string' || n.title.length>240 || typeof n.similarity!=='number' || !Number.isFinite(n.similarity) || n.similarity<-1 || n.similarity>1 || n.device_id!=null && n.device_id!==target))throw new Error('The returned note candidates did not match the reviewed note revisions and selected device.');
      const results=$('note-search-results');results.replaceChildren();
      results.append(node('h3',value.results.length?'Review these candidates':'No eligible notes in this index'),node('p',`Search: ${query} · ${target?'Device '+target:'General notes only'} · Checked ${new Date().toLocaleTimeString()}`),node('p',value.scope));
      value.results.forEach((n,i)=>{const row=node('article',null,'note-search-result');
        const details=node('details');details.append(node('summary','Similarity details'),node('p',`${n.similarity.toFixed(4)} · rank ${i+1}. This is not a confidence or accuracy score.`));
        row.append(node('h4',title(n)),node('p',`${n.device_id?'Device-associated note':'General note'} · saved information`),details,button('Open current note',()=>{close();window.TLINotebook?.open({id:n.id,revision:n.revision},{source:'search'});}));results.append(row);});
      status('Search completed. No notes were attached to Chat.');
    } catch(error){if(fresh(epoch)){if(error.status===409){dispose(state.index?.index_id);state.index=null;clearTimeout(state.timer);state.timer=null;}status((error.message || 'Related-note search failed.')+' Previous results remain visible; they may now be out of date.'+(error.status===409?' Return to Notes & fixes to refresh changed notes, then review a new index.':''));}}
    finally{if(pending===reservation)pending=null;if(fresh(epoch))state.busy=false;if(state.open)update();}
  }
  async function open({notes=[],devices=[]}={}) {
    if(state.open || document.hidden || locked)return;
    init();state.epoch++;state.open=true;state.busy=false;state.supported=false;state.returnFocus=document.activeElement;
    const seen=new Set();state.notes=(Array.isArray(notes)?notes:[]).filter(n=>ref(n) && !n.id.startsWith('device-') && !seen.has(n.id) && (seen.add(n.id),true)).slice(0,1000).map(n=>({id:n.id,revision:n.revision,title:typeof n.title==='string'?n.title.slice(0,240):'',device_id:n.device_id || null}));
    state.devices=(Array.isArray(devices)?devices:[]).filter(d=>bounded(d?.id,256) && bounded(d?.name,240)).map(d=>({id:d.id,name:d.name}));
    state.selected.clear();$('note-search-dialog').showModal();$('note-search-heading').focus();setup();status('Checking optional search support…');
    await loadCapabilities();
  }
  async function loadCapabilities() {
    if(!state.open || locked || state.busy)return;
    const epoch=state.epoch;state.busy=true;state.supported=false;update();
    try{const value=await api('/capabilities');if(!fresh(epoch))return;
      if(value.automatic_chat_retrieval!==false || value.embedding_server!=='existing-loopback-only' || value.max_notes!==64 || value.max_text_bytes!==65536 || value.expires_in_seconds!==1800 || value.quality!=='not_validated')throw new Error('This host does not support the reviewed related-note workflow.');
      state.supported=true;status(pending?'An earlier embedding request is still settling. No new build or search can start yet.':'Optional setup. Nothing has been sent to an embedding server.');
    }catch(error){if(fresh(epoch))status(error.message || 'Related-note search is unavailable.');}
    finally{if(fresh(epoch)){state.busy=false;update();}}
  }
  function init() {
    if($('note-search-dialog'))return;
    const dialog=node('dialog',null,'note-search-dialog');dialog.id='note-search-dialog';dialog.setAttribute('aria-labelledby','note-search-heading');
    const header=node('header'),heading=node('h2','Related notes');heading.id='note-search-heading';heading.tabIndex=-1;header.append(heading,button('Close related notes',close));
    const feedback=node('p');feedback.id='note-search-status';feedback.setAttribute('role','status');
    const body=node('div');body.id='note-search-body';dialog.append(header,feedback,body);document.body.append(dialog);
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',()=>{if(!dialog.open)close();});
  }
  window.TLIRelatedNotes={open,close};
  window.addEventListener('tli-session-locked',()=>{locked=true;close();});window.addEventListener('tli-session-unlocked',()=>{locked=false;});window.addEventListener('pagehide',close);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});
})();
