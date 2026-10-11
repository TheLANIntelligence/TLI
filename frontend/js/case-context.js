/* Reviewed, ephemeral case selections. Opening/reviewing never sends chat. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), protocol = 'tli-case-context-v1';
  const reportProtocol='tli-case-report-context-v1';
  const state = { epoch: 0, read: 0, loading: false, checked: false, locked: false, review: null, selected: null, ownerCurrent: null, reportSupported:false, purpose:'chat', onReview:null };
  const requests = new WeakMap(), decorated = new WeakSet();
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, action) => { const b = node('button', text, 'btn-outline'); b.type = 'button'; b.addEventListener('click', action); return b; };
  const bounded = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n;
  const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const id = v => /^case-[a-f0-9]{32}$/.test(v || '');
  const date = v => Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : 'Time unavailable';
  const pointer = p => ({kind:p.kind,id:p.id,revision:p.revision,...(p.kind === 'chat' ? {message_index:p.message_index} : {})});
  const key = p => JSON.stringify(pointer(p));
  const validLink = p => p && ['note','report','chat'].includes(p.kind) && bounded(p.id,256) && hash(p.revision) && (p.kind === 'chat' ? Number.isInteger(p.message_index) && p.message_index >= 0 && p.message_index <= 1000000 : p.message_index == null) && bounded(p.label,240) && ['current','changed','unavailable'].includes(p.availability);
  const validRow = r => r && id(r.id) && hash(r.revision) && bounded(r.title,120) && bounded(r.symptom,4000) && ['open','resolved'].includes(r.status) && typeof r.archived === 'boolean' && Number.isFinite(Date.parse(r.updated_at)) &&
    (r.computer === null || r.computer && bounded(r.computer.id,256) && bounded(r.computer.name,240)) && typeof r.resolution === 'string' && r.resolution.length <= 2000 &&
    Array.isArray(r.steps) && r.steps.length <= 30 && new Set(r.steps.map(s=>s?.id)).size === r.steps.length && r.steps.every(s=>bounded(s.id,80) && bounded(s.text,1000) && ['planned','tried','skipped'].includes(s.status) && typeof s.outcome === 'string' && s.outcome.length <= 2000) &&
    Array.isArray(r.evidence) && r.evidence.length <= 32 && r.evidence.every(validLink) && new Set(r.evidence.map(key)).size === r.evidence.length;
  function validReceipt(r) {
    return r?.schema_version === 1 && id(r.id) && hash(r.revision) && bounded(r.title,120) && Number.isFinite(Date.parse(r.updated_at)) && (r.computer_id === null || bounded(r.computer_id,256)) && ['open','resolved'].includes(r.status) && typeof r.archived === 'boolean' && typeof r.resolution_included === 'boolean' && r.linked_bodies_included === false && r.actions_performed === false &&
      Array.isArray(r.steps) && r.steps.length <= 8 && r.steps.every(s=>bounded(s.id,80) && ['planned','tried','skipped'].includes(s.status)) && new Set(r.steps.map(s=>s.id)).size === r.steps.length && Number.isInteger(r.omitted_step_count) && r.omitted_step_count >= 0 && r.omitted_step_count + r.steps.length <= 30 &&
      Array.isArray(r.evidence_links) && r.evidence_links.length <= 8 && r.evidence_links.every(validLink) && new Set(r.evidence_links.map(key)).size === r.evidence_links.length && Number.isInteger(r.omitted_link_count) && r.omitted_link_count >= 0 && r.omitted_link_count + r.evidence_links.length <= 32 &&
      (r.included_reports===undefined || Array.isArray(r.included_reports) && r.included_reports.length===1 && r.included_reports.every(p=>p && p.handle==='R1' && bounded(p.id,256) && hash(p.revision) && bounded(p.host_id,256) && (p.target_id===null || bounded(p.target_id,256)) && (p.recorded_at===null || Number.isFinite(Date.parse(p.recorded_at))) && (!r.computer_id || r.computer_id===(p.target_id || 'node-'+p.host_id)) && r.evidence_links.some(l=>l.kind==='report' && l.id===p.id && l.revision===p.revision && l.availability==='current')));
  }
  const changed = () => window.dispatchEvent(new CustomEvent('tli-chat-context-changed'));
  const status = text => { if ($('case-context-status')) $('case-context-status').textContent = text; };
  function choice(label, checked, callback) { const input=node('input'); input.type='checkbox'; input.checked=checked; const wrap=node('label',null,'case-context-choice'); wrap.append(input,node('span',label)); input.addEventListener('change',()=>callback(input)); return wrap; }
  function renderSelected() {
    const box=$('case-context-selected'); if (!box) return; box.replaceChildren(); box.hidden=!state.selected;
    if (state.selected) box.append(node('strong','Case selected: '+state.selected.row.title),node('p',`${state.selected.ref.step_ids.length} steps · ${state.selected.ref.evidence_refs.length} link descriptions · resolution ${state.selected.ref.include_resolution ? 'included' : 'excluded'} · ${state.selected.ref.report_refs?.length || 0} recorded-facts summaries. Full linked bodies and earlier chat excluded.`),button('Review case selection',()=>open(state.selected.row)),button('Remove case',removeContext));
    changed();
  }
  function invalidateReview() { if ($('case-context-ack')) $('case-context-ack').checked=false; updateUse(); }
  function updateUse() { if ($('case-context-use')) $('case-context-use').disabled=state.loading || !state.checked || state.locked || !state.review || (state.review.reportKey && !state.review.reportPreview) || !$('case-context-ack')?.checked; }
  function selectionChanged(){state.read++;state.loading=false;if(state.review)state.review.reportPreview=null;invalidateReview();if(state.review?.reportKey)status('Selection changed. Review the selected report facts again before acknowledging.');}
  function reviewRef(draft) { return {id:draft.row.id,revision:draft.row.revision,step_ids:[...draft.stepIds],include_resolution:draft.resolution,
    evidence_refs:draft.row.evidence.filter(p=>draft.links.has(key(p))).map(pointer),...(draft.reportKey ? {report_refs:draft.row.evidence.filter(p=>key(p)===draft.reportKey).map(pointer)} : {})}; }
  function matchesSelection(r, wanted) { return validReceipt(r) && r.id===wanted.id && r.revision===wanted.revision && r.resolution_included===wanted.include_resolution && JSON.stringify(r.steps.map(s=>s.id))===JSON.stringify(wanted.step_ids) && JSON.stringify(r.evidence_links.map(key))===JSON.stringify(wanted.evidence_refs.map(key)) && JSON.stringify((r.included_reports || []).map(p=>key({kind:'report',...p})))===JSON.stringify((wanted.report_refs || []).map(key)); }
  function validFacts(meta,r) { const included=r?.included_reports?.[0], facts=meta?.recorded_report;
    return included && window.TLIReportFacts?.validate(facts,{reportId:included.id,hostId:included.host_id,targetId:included.target_id}) && facts.recorded_at===included.recorded_at && meta.sources?.some(s=>s.handle==='R1' && s.kind==='report' && s.id===included.id && s.revision===included.revision && s.host_id===included.host_id && s.target_id===included.target_id); }
  async function previewReport(){
    const draft=state.review;if(state.loading || !draft?.reportKey || !state.reportSupported || state.locked)return;
    const epoch=state.epoch,ticket=++state.read,wanted=reviewRef(draft);state.loading=true;draft.reportPreview=null;invalidateReview();status('Checking the selected report facts…');
    const fresh=()=>epoch===state.epoch && ticket===state.read && !state.locked && state.review===draft && state.ownerCurrent?.()!==false;
    try { const response=await fetch('/api/intelligence/cases/context-review',{method:'POST',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({case_ref:wanted})});
      if(!fresh())return;if(response.status===401 || response.status===403){window.dispatchEvent(new CustomEvent('tli-session-locked'));return;}
      const data=await response.json();if(!fresh())return;
      if(!response.ok)throw new Error(typeof data?.detail==='string'?data.detail:'The report facts could not be reviewed.');
      if(data?.ok!==true || data.protocol!=='tli-cases-v1' || data.actions_performed!==false || data.case_report_context!==reportProtocol || !matchesSelection(data.case_context,wanted) || !validFacts(data.evidence_context,data.case_context))throw new Error('The selected report facts or their scope could not be confirmed. Nothing was attached.');
      draft.reportPreview=data.evidence_context.recorded_report;renderReview();status('Review the recorded measurements and limitations below, then acknowledge the selection. No question was sent.');
    } catch(error){if(fresh())status(error.message || 'The report facts could not be reviewed.');}
    finally{if(fresh()){state.loading=false;updateUse();}}
  }
  function renderReview() {
    const box=$('case-context-preview'); if (!box) return; box.replaceChildren();
    const draft=state.review;
    if (!draft) { box.append(node('p','Loading saved case details…')); updateUse(); return; }
    const row=draft.row;
    box.append(node('h3',row.title),node('p',`Saved ${date(row.updated_at)} · ${row.computer?.name || 'No computer selected'} · ${row.status === 'resolved' ? 'Resolved by the user' : 'Open'}${row.archived ? ' · Archived' : ''}`),node('p',row.symptom,'case-context-body'));
    const steps=node('fieldset'); steps.append(node('legend','Choose whole steps to include (up to 8)'));
    row.steps.forEach(step=>{const card=node('section',null,'case-context-card'); card.append(choice(`${step.status}: ${step.text}`,draft.stepIds.has(step.id),input=>{if(input.checked && draft.stepIds.size>=8){input.checked=false;status('Choose up to eight steps.');return;} input.checked?draft.stepIds.add(step.id):draft.stepIds.delete(step.id);selectionChanged();}),node('p',step.outcome || 'No outcome recorded.','case-context-body'));steps.append(card);});
    if(!row.steps.length) steps.append(node('p','No saved steps.')); box.append(steps);
    box.append(choice('Include the user-recorded resolution',draft.resolution,input=>{draft.resolution=input.checked;selectionChanged();}),node('p',row.resolution || 'No resolution text recorded.','case-context-body'));
    const links=node('fieldset'); links.append(node('legend','Choose evidence-link descriptions (up to 8; bodies excluded)'));
    row.evidence.forEach(link=>links.append(choice(`${link.label} · ${link.availability} · ${link.kind}`,draft.links.has(key(link)),input=>{if(input.checked && draft.links.size>=8){input.checked=false;status('Choose up to eight evidence links.');return;} input.checked?draft.links.add(key(link)):draft.links.delete(key(link));if(!input.checked && draft.reportKey===key(link))draft.reportKey=null;selectionChanged();renderReview();})));
    if(!row.evidence.length) links.append(node('p','No linked evidence.')); box.append(links);
    const reports=row.evidence.filter(l=>l.kind==='report');
    if(reports.length){const section=node('fieldset');section.append(node('legend','Include recorded facts from one linked report'),node('p','Optional: review its measured host, time, coverage and limitations. Full reports, raw samples, attachments and private linked bodies stay excluded.'));
      reports.forEach(link=>{const wrap=choice('Recorded facts: '+link.label,draft.reportKey===key(link),input=>{if(input.checked && !draft.links.has(key(link)) && draft.links.size>=8){input.checked=false;status('Remove a link description before selecting this report.');return;}draft.reportKey=input.checked?key(link):null;if(input.checked)draft.links.add(key(link));selectionChanged();renderReview();if(input.checked)return previewReport();});wrap.querySelector('input').disabled=!state.reportSupported || link.availability!=='current';section.append(wrap);});
      if(!state.reportSupported)section.append(node('p','This host does not support reviewed report facts in case questions. Case-only selections remain available.'));
      if(draft.reportKey)section.append(button('Review selected report facts',previewReport));
      if(draft.reportPreview)section.append(window.TLIReportFacts.render(draft.reportPreview));box.append(section);
    }updateUse();
  }
  async function capability(signal, isFresh) {
    const epoch=state.epoch, fresh=isFresh || (()=>epoch===state.epoch && !state.locked);
    const response=await fetch('/api/intelligence/cases/capabilities',{cache:'no-store',signal,redirect:'error'});
    if(!fresh())throw new Error('This case request is no longer current.');
    if(response.status===401 || response.status===403){window.dispatchEvent(new CustomEvent('tli-session-locked'));throw new Error('Unlock TLI before sharing a case.');}
    const data=await response.json();
    if(!fresh())throw new Error('This case request is no longer current.');
    if(!response.ok || data?.ok!==true || data.protocol!=='tli-cases-v1' || data.case_context!==protocol || data.actions_performed!==false) throw new Error('This host does not support reviewed case questions. Update and restart it normally before sending. No case question was sent.');
    return data;
  }
  async function load(row, ownerCurrent) {
    if(state.loading || state.locked || !id(row?.id)) return;
    const epoch=state.epoch, ticket=++state.read; state.loading=true; state.checked=false; invalidateReview(); status('Checking the current saved case…'); updateUse();
    try {
      const caps=await capability(undefined,()=>epoch===state.epoch && ticket===state.read && !state.locked && ownerCurrent?.()!==false); if(epoch!==state.epoch || ticket!==state.read || state.locked || ownerCurrent?.()===false) return;
      if(state.purpose==='next_check' && caps.next_check!=='tli-case-next-check-v1')throw new Error('This host does not support reviewed next-check guidance. No check or AI request was sent.');
      state.reportSupported=caps.case_report_context===reportProtocol && caps.max_case_reports===1;
      const response=await fetch('/api/intelligence/cases/'+encodeURIComponent(row.id),{cache:'no-store',redirect:'error'});
      if(epoch!==state.epoch || ticket!==state.read || state.locked || ownerCurrent?.()===false) return;
      if(response.status===401 || response.status===403){window.dispatchEvent(new CustomEvent('tli-session-locked'));return;}
      const data=await response.json();
      if(epoch!==state.epoch || ticket!==state.read || state.locked || ownerCurrent?.()===false) return;
      if(!response.ok || data?.ok!==true || data.protocol!=='tli-cases-v1' || data.actions_performed!==false || !validRow(data.case) || data.case.id!==row.id) throw new Error('This saved case could not be checked. Your previous selection is retained.');
      const previous=state.review?.row.id===row.id ? state.review : null;
      state.review={row:data.case,stepIds:new Set(data.case.steps.filter(s=>previous?.stepIds.has(s.id)).map(s=>s.id)),links:new Set(data.case.evidence.filter(l=>previous?.links.has(key(l))).map(key)),resolution:previous?.resolution || false,reportKey:data.case.evidence.some(l=>l.kind==='report' && l.availability==='current' && key(l)===previous?.reportKey)?previous.reportKey:null,reportPreview:null};
      state.ownerCurrent=ownerCurrent || null; state.checked=true; renderReview(); invalidateReview();
      status(row.revision!==data.case.revision ? 'This case changed. Review the current saved details and choose what to include again.' : state.purpose==='next_check' ? 'Review this saved selection for rule-based guidance. No check, repair or AI request will run.' : 'Review this saved selection. Nothing is sent until you write and send a chat question.');
    } catch(error){if(epoch===state.epoch && ticket===state.read && !state.locked) status(error.message || 'Case review is unavailable. Your previous selection is retained.');}
    finally{if(epoch===state.epoch && ticket===state.read){state.loading=false;updateUse();}}
  }
  function open(row, {current,purpose='chat',onReview}={}) { if(state.locked || current?.()===false) return; const dialog=$('case-context-dialog'); if(!dialog)return;
    if(purpose!==state.purpose){close();state.review=null;}state.purpose=purpose==='next_check'?'next_check':'chat';state.onReview=onReview || null;
    $('case-context-heading').textContent=state.purpose==='next_check'?'Review evidence for a next check':'Ask about a saved case';
    $('case-context-use').textContent=state.purpose==='next_check'?'Review next check':'Use selection in chat';
    $('case-context-purpose').textContent=state.purpose==='next_check'?'This reads the selected saved evidence and existing check capabilities only. It does not run a check, save a report, send Chat or use AI.':'This does not run steps or send a message. Your question and answer may quote saved details and are retained in chat history.';
    if(!dialog.open)dialog.showModal();invalidateReview();return load(row,current); }
  function close() { state.read++;state.loading=false;state.checked=false;state.ownerCurrent=null;state.onReview=null; if($('case-context-dialog')?.open)$('case-context-dialog').close();invalidateReview(); }
  function use() {
    if(!$('case-context-dialog')?.open || state.loading || !state.checked || state.locked || !state.review || (state.review.reportKey && !state.review.reportPreview) || !$('case-context-ack')?.checked || state.ownerCurrent?.()===false) return;
    const {row,stepIds,links,resolution}=state.review;
    if(state.purpose==='next_check') { const callback=state.onReview,ref=reviewRef(state.review);if(typeof callback!=='function')return;close();return callback(ref); }
    state.epoch++; state.selected={row,ref:reviewRef(state.review)};
    close();renderSelected();window.switchPanel?.('panel-main');$('chat-input')?.focus();
  }
  function removeContext(){state.epoch++;state.selected=null;renderSelected();}
  function clear(){state.epoch++;close();state.review=null;state.selected=null;$('case-context-preview')?.replaceChildren();status('');renderSelected();}
  function requestContext(context,{image=false,text=''}={}) {
    if(state.loading || $('case-context-dialog')?.open) throw new Error('Finish or cancel the case review before sending.');
    if(!state.selected) return context;
    if(image || context.note_refs?.length || context.documents?.length || context.target_id || context.diagnostic_id || context.screenshot || context.include_vault_secrets || context.script_request || /\[vault:[^\]]+\]/i.test(text)) throw new Error('Ask about the case selection on its own. Remove other selected context or remove the case; nothing is removed automatically.');
    const result={...context,case_ref:JSON.parse(JSON.stringify(state.selected.ref))};requests.set(result,{epoch:state.epoch,selected:state.selected});return result;
  }
  const isCurrent = context => !context.case_ref || requests.get(context)?.epoch===state.epoch && (requests.get(context)?.completed || requests.get(context)?.selected===state.selected);
  async function ensureAvailable(context,signal){if(!context.case_ref)return;const caps=await capability(signal,()=>isCurrent(context));if(!isCurrent(context))throw new Error('The case selection changed. Review it before sending.');if(context.case_ref.report_refs?.length && (caps.case_report_context!==reportProtocol || caps.max_case_reports!==1))throw new Error('This host no longer supports the selected report facts. Review the case before sending.');}
  function sent(context,meta){if(!context.case_ref || !isCurrent(context))return;const r=meta?.case_context, wanted=context.case_ref;
    if(!matchesSelection(r,wanted) || wanted.report_refs?.length && !validFacts(meta.evidence_context,r)) throw new Error('TLI did not confirm the reviewed case selection. It remains selected; review before any retry.');
    requests.get(context).completed=true;state.selected=null;state.review=null;renderSelected();
  }
  function decorateReply(bubble,meta){const r=meta?.case_context;if(!bubble || !validReceipt(r) || decorated.has(bubble))return;const box=node('details',null,'case-context-receipt');box.append(node('summary','Case selection for this answer'),node('strong',r.title),node('p',`Saved ${date(r.updated_at)} · ${r.status==='resolved'?'User-marked resolved':'Open'} · ${r.steps.length} steps included, ${r.omitted_step_count} omitted · resolution ${r.resolution_included?'included':'excluded'}.`),node('p',`${r.evidence_links.length} link descriptions included, ${r.omitted_link_count} omitted. Linked bodies and earlier chat were excluded. This is historical user-recorded context; no actions ran.`));
    r.evidence_links.forEach(link=>box.append(node('p',`${link.label} · ${link.availability} when prepared · body not supplied`)));
    r.included_reports?.forEach(report=>box.append(node('p',`Separately included recorded facts [R1] · ${report.id} · host ${report.host_id} · target ${report.target_id || report.host_id} · recorded ${date(report.recorded_at)}. Full report and raw samples excluded.`)));
    box.append(button('Open current case',()=>window.TLITroubleshooting?.open({id:r.id})));bubble.append(box);decorated.add(bubble);
  }
  function init(){const row=document.querySelector('.chat-input-row');if(!row || $('case-context-dialog'))return;
    const selected=node('section',null,'case-context-selected');selected.id='case-context-selected';selected.hidden=true;row.before(selected);
    const dialog=node('dialog',null,'case-context-dialog');dialog.id='case-context-dialog';dialog.setAttribute('aria-labelledby','case-context-heading');const heading=node('h2','Ask about a saved case');heading.id='case-context-heading';
    const preview=node('div');preview.id='case-context-preview';const feedback=node('p');feedback.id='case-context-status';feedback.setAttribute('role','status');
    const ack=choice('I reviewed these saved details and the selected items.',false,updateUse);ack.querySelector('input').id='case-context-ack';
    const apply=button('Use selection in chat',use);apply.id='case-context-use';apply.disabled=true;
    const purpose=node('p','This does not run steps or send a message. Your question and answer may quote saved details and are retained in chat history.');purpose.id='case-context-purpose';
    dialog.append(heading,node('p','Title, symptom and computer are included. Choose up to eight whole steps and link descriptions, plus the resolution if useful. Optionally review recorded facts from one linked report. Full linked bodies, raw samples and earlier chat stay excluded.'),purpose,feedback,preview,ack,button('Reload saved case',()=>state.review && load(state.review.row,state.ownerCurrent)),apply,button('Cancel',close));dialog.addEventListener('cancel',e=>{e.preventDefault();close();});document.body.append(dialog);
    $('new-chat-btn')?.addEventListener('click',clear);
  }
  window.addEventListener('tli-session-locked',()=>{state.locked=true;clear();});window.addEventListener('tli-session-unlocked',()=>{state.locked=false;});window.addEventListener('pagehide',clear);document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();});
  window.TLICaseContext={open,close,clear,requestContext,isCurrent,ensureAvailable,sent,decorateReply,validReceipt,matchesSelection,validFacts,describeContext:()=>state.selected?[{id:'case:'+state.selected.row.id,label:state.selected.row.title,kind:'case'}]:[],removeContext};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
