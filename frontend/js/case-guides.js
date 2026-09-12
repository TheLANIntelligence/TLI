/* Reusable, reviewable troubleshooting instructions. Never executable skills. */
(() => {
  'use strict';
  const FORMAT='tli-troubleshooting-guide',LIMIT=32768;
  function validate(value){
    if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!=='format,steps,symptom,title,version' || value.format!==FORMAT || value.version!==1 ||
      typeof value.title!=='string' || !value.title.trim() || value.title.length>120 || typeof value.symptom!=='string' || !value.symptom.trim() || value.symptom.length>4000 ||
      !Array.isArray(value.steps) || value.steps.length>12 || value.steps.some(s=>typeof s!=='string' || !s.trim() || s.length>1000) || new TextEncoder().encode(JSON.stringify(value)).length>LIMIT)
      throw new Error('Choose a supported guide: a title, symptom and up to 12 plain-text steps within 32 KiB. Executable fields, targets, outcomes and evidence fields are not accepted.');
    return {format:FORMAT,version:1,title:value.title,symptom:value.symptom,steps:[...value.steps]};
  }
  function fromCase(row){
    if(!row || !Array.isArray(row.steps))throw new Error('Open a saved problem before preparing a guide.');
    if(row.steps.length>12)throw new Error('This problem has more than 12 steps. A reusable guide supports up to 12 whole steps; the saved problem was not changed.');
    return validate({format:FORMAT,version:1,title:row.title,symptom:row.symptom,steps:row.steps.map(s=>s.text)});
  }
  function parse(text){
    if(typeof text!=='string' || new TextEncoder().encode(text).length>LIMIT)throw new Error('Choose a guide no larger than 32 KiB.');
    const value=JSON.parse(text),keys=new Set();let depth=0,previous=null;
    // JSON.parse has already checked syntax. Reject ambiguous duplicate root keys,
    // including escaped spellings, before accepting this small fixed-schema object.
    for(const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:]/g)){
      const token=match[0];
      if(token===':' && depth===1 && previous?.startsWith('"')){const key=JSON.parse(previous);if(keys.has(key))throw new Error('A guide cannot repeat a field. Review an unambiguous JSON file.');keys.add(key);}
      if(token==='{' || token==='[')depth++;else if(token==='}' || token===']')depth--;previous=token;
    }
    return validate(value);
  }
  const catalogue=[
    {title:'An app feels slow',symptom:'Describe the application, the task you were doing and when the slowdown occurs.',steps:[
      'Choose the computer affected. The available system and process observations run on the TLI host, not automatically on another computer.',
      'Open Performance & apps. Review a specific process and explicitly start a 30-second observation while reproducing the problem.',
      'Review sample coverage, missing fields and CPU/RAM measurements. One process may not represent the whole application; these readings do not identify a cause by themselves.',
      'Save the report if useful and link it to this problem. Record what you changed and what happened; run a comparable observation only when you choose.']},
    {title:'An unreliable connection',symptom:'Describe what cannot connect, which computer is affected and whether other devices are affected.',steps:[
      'Choose the affected computer and review where a network check would execute. Current network diagnostics measure from the TLI host.',
      'Review and explicitly run an available local network check. Include internet-contacting checks only when their reviewed scope is useful.',
      'Read the saved report, including timeouts and unavailable fields. A successful reachability check does not prove every app or service works.',
      'Record a single change and its outcome. Review the same scope before repeating a check or comparing reports.']},
    {title:'A drive is running out of space',symptom:'Name the computer and drive, and describe the space warning or task that failed.',steps:[
      'Open Free Space and choose the exact drive or folder on the TLI host. Start a scan explicitly.',
      'Review its observation time and coverage. Large files, system files and incomplete folders are not automatically cleanup candidates.',
      'Review selected cleanup items and their exact paths before any operation. Keep useful files and follow the existing protected-path and Trash workflow.',
      'Record what actually completed and any failures. Compare a later scan only after choosing to run it.']},
    {title:'A printer will not finish a job',symptom:'Name the printer and describe whether the job is missing, queued, partly printed or visibly failed.',steps:[
      'Choose the printer in Printers & USB. Distinguish the operating-system queue from network discovery.',
      'Open Print & Scan for that selected printer. Review any test-print action before submitting it.',
      'Check the reported submission result and the physical printer separately. Job submission does not establish that a page printed.',
      'Record the observed outcome and any useful queue or connection changes. Save a confirmed historical fix only after reviewing what helped.']},
    {title:'Revisit a previous fix',symptom:'Describe the current symptoms and the earlier problem or note you want to compare.',steps:[
      'Open the earlier problem and saved notes. Review their dates and whether linked evidence changed or is unavailable.',
      'Choose the current affected computer. A historical fix is not a current health observation.',
      'Review an available check with the right host and scope. Run it only when ready and link its saved result explicitly.',
      'Record what you tried and what happened. Marking this problem resolved records your conclusion, not measured proof of recovery.']},
  ].map(value=>validate({format:FORMAT,version:1,...value}));
  const exported={validate,parse,fromCase,catalogue:()=>catalogue.map(validate)};
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  if(typeof window==='undefined')return;
  const $=id=>document.getElementById(id),state={open:false,locked:false,epoch:0,reading:false,mode:'use',guide:null,returnFocus:null,download:null};
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn)=>{const b=node('button',text,'btn-outline');b.type='button';b.addEventListener('click',fn);return b;};
  const notice=text=>{if($('case-guide-status'))$('case-guide-status').textContent=text;};
  const allowed=()=>!state.locked && !document.hidden && $('tli-lock-screen')?.getAttribute('aria-hidden')!=='false' && (!$('panel-troubleshooting') || !$('panel-troubleshooting').hidden);
  const current=epoch=>state.open && state.epoch===epoch && allowed();
  function reading(value){state.reading=value;$('case-guide-options')?.querySelectorAll('input,button').forEach(el=>{el.disabled=value;});}
  function close(){if(!state.open)return;state.open=false;state.epoch++;reading(false);state.guide=null;if(state.download)URL.revokeObjectURL(state.download);state.download=null;$('case-guide-preview')?.replaceChildren();$('case-guide-options')?.replaceChildren();if($('case-guide-file'))$('case-guide-file').value='';notice('');if($('case-guide-dialog')?.open)$('case-guide-dialog').close();if(allowed() && state.returnFocus?.checkVisibility?.()!==false)state.returnFocus?.focus?.();state.returnFocus=null;}
  function show(guide){
    state.guide=validate(guide);const box=$('case-guide-preview');box.replaceChildren();
    const reviewed=state.guide,epoch=state.epoch;let consumed=false;
    box.append(node('h3',state.guide.title),node('p',state.guide.symptom));
    const steps=node('ol');state.guide.steps.forEach(text=>steps.append(node('li',text)));box.append(steps);
    const ack=node('input');ack.id='case-guide-ack';ack.type='checkbox';
    const label=node('label',null,'case-guide-choice');label.append(ack,node('span',state.mode==='download'?'I reviewed this plain-text guide for private information before downloading it.':'Use these instructions as an unsaved problem draft. I will choose the computer and review every check separately.'));
    const action=button(state.mode==='download'?'Download reviewed guide':'Prepare problem draft',()=>{
      if(!current(epoch) || state.guide!==reviewed || !ack.checked || state.reading || consumed)return;
      try{const chosen=validate(reviewed);
      if(state.mode==='download'){
        const content=JSON.stringify(chosen,null,2)+'\n';if(new TextEncoder().encode(content).length>LIMIT){notice('The formatted guide exceeds 32 KiB. Shorten its steps before exporting.');return;}
        consumed=true;action.disabled=true;
        if(state.download)URL.revokeObjectURL(state.download);
        state.download=URL.createObjectURL(new Blob([content],{type:'application/json'}));
        const link=node('a');link.href=state.download;link.download='TLI-troubleshooting-guide.json';document.body.append(link);try{link.click();}finally{link.remove();}ack.checked=false;notice('Guide download requested. It contains the reviewed text and may include private details. This is not a backup of the problem. Close and review again to request another copy.');
      }else{
        const prepared=window.TLITroubleshooting?.prepareGuide(chosen);
        if(prepared===true){close();$('troubleshooting-title')?.focus();}else notice('Your current problem draft is retained. Save or discard it before preparing another problem.');
      }
      }catch(error){consumed=false;action.disabled=!ack.checked;notice((error.message || 'The guide could not be prepared.')+' Your review remains available. Nothing was saved.');}
    });action.disabled=true;ack.addEventListener('change',()=>{action.disabled=consumed || !ack.checked;});box.append(label,action);
    notice('Review the instructions. No check, action, Chat request or save has run.');
  }
  async function read(file){
    if(!current(state.epoch) || state.reading || !file)return;
    if(file.size>LIMIT){notice('Choose a guide no larger than 32 KiB. '+(state.guide?'The previous review is retained.':'No guide was prepared.'));return;}
    const epoch=state.epoch;reading(true);notice('Reading the selected file in this browser. Wait for its preview before choosing another guide.');
    try{const text=await file.text();if(!current(epoch))return;show(parse(text));}
    catch(error){if(current(epoch))notice((error.message || 'The guide could not be read.')+' '+(state.guide?'Previous review is retained.':'No guide was prepared.')+' Nothing was uploaded.');}
    finally{if(current(epoch))reading(false);}
  }
  function init(){
    if($('case-guide-dialog'))return;const dialog=node('dialog',null,'case-guide-dialog');dialog.id='case-guide-dialog';dialog.setAttribute('aria-labelledby','case-guide-heading');
    const header=node('header'),heading=node('h2','Troubleshooting guides');heading.id='case-guide-heading';heading.tabIndex=-1;header.append(heading,button('Close guides',close));
    const help=node('p','Reusable plain-text instructions for a new problem. Only title, symptom and step text are included; structured targets, evidence and outcomes are omitted. Text may still contain private details or historical claims: review it before use or download. Guides never execute tools or run by themselves.');
    const status=node('p');status.id='case-guide-status';status.setAttribute('role','status');
    const options=node('div',null,'case-guide-options');options.id='case-guide-options';const preview=node('section');preview.id='case-guide-preview';
    dialog.append(header,help,status,options,preview);document.body.append(dialog);
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',()=>{if(!dialog.open)close();});
  }
  function open(row=null){
    if(state.open || !allowed())return;init();state.open=true;state.epoch++;state.mode=row?'download':'use';state.returnFocus=document.activeElement;
    const options=$('case-guide-options');options.replaceChildren();$('case-guide-preview').replaceChildren();$('case-guide-dialog').showModal();$('case-guide-heading').focus();
    if(row){try{show(fromCase(row));}catch(error){notice(error.message);}return;}
    const epoch=state.epoch;
    catalogue.forEach(guide=>options.append(button(guide.title,()=>{if(!current(epoch))return;if(state.reading){notice('Finish reading the selected file before choosing another guide.');return;}show(guide);} )));
    const file=node('input');file.type='file';file.accept='.json,application/json';file.id='case-guide-file';file.addEventListener('change',()=>{if(!current(epoch))return;if(state.reading){file.value='';notice('A guide is already being read. Wait for its preview before choosing another file.');return;}return read(file.files?.[0]);});
    const label=node('label');label.append(node('span','Or review a saved guide (JSON, up to 32 KiB)'),file);options.append(label);
    notice('Choose a starting point or open a guide file. Reading a file stays in this browser until you explicitly save the resulting problem.');
  }
  window.TLICaseGuides={...exported,open,close};
  window.addEventListener('tli-session-locked',()=>{state.locked=true;close();});window.addEventListener('tli-session-unlocked',()=>{state.locked=false;});window.addEventListener('pagehide',close);document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});
})();
