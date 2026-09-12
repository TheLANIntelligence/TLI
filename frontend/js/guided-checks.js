/* Reviewed host checks shared by the Troubleshooting editor. No automatic runs. */
(function () {
  'use strict';
  const protocol = 'tli-guided-checks-v1';
  const text = (v, max = 256) => typeof v === 'string' && v.length <= max;
  const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const target = v => v && text(v.id) && v.id && text(v.name, 240);
  const requestId = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  function validOptions(v, computerId) {
    return v?.ok === true && v.protocol === protocol && v.actions_performed === false && target(v.host) &&
      v.computer_id === (computerId || null) && Number.isFinite(Date.parse(v.checked_at)) && Array.isArray(v.options) && v.options.length > 0 && v.options.length <= 5 && new Set(v.options.map(o => o?.id)).size === v.options.length &&
      v.options.every(o => o && ['system', 'network', 'device', 'performance', 'peer_system'].includes(o.kind) && o.id === o.kind &&
        text(o.title) && text(o.detail, 2000) && typeof o.available === 'boolean' && text(o.reason, 2000) &&
        target(o.execution_host) && (o.kind==='peer_system' ? o.execution_host.id!==v.host.id && (!o.available || text(o.execution_host.identity_fingerprint,256) && o.execution_host.identity_fingerprint) : o.execution_host.id === v.host.id) && target(o.measured_target) && o.internet === false &&
        (o.kind === 'performance' ? o.panel === 'panel-games' : hash(o.scope_revision)) &&
        (o.kind !== 'network' || hash(o.internet_scope_revision) && text(o.internet_detail, 2000)) &&
        (['device','peer_system'].includes(o.kind) ? o.target_id === computerId && o.measured_target.id === o.target_id :
          (o.target_id === null || o.target_id === undefined) && o.measured_target.id === v.host.id));
  }
  function validReport(v, request) {
    return v && text(v.id) && v.id && v.kind === (request.kind==='peer_system'?'system':request.kind) && target(v.host) && v.host.id === request.expected_host_id &&
      (request.kind!=='peer_system' || v.execution?.kind==='peer_system' && hash(v.execution.peer_revision) && text(v.execution.identity_fingerprint,256) && v.execution.identity_fingerprint && v.host.identity_fingerprint===v.execution.identity_fingerprint && target(v.execution.requesting_host) && v.execution.requesting_host.id!==v.host.id && v.peer_observation?.protocol==='tli-peer-observation-v1' && v.peer_observation.host?.id===v.host.id && v.peer_observation.host?.identity_fingerprint===v.host.identity_fingerprint && v.peer_observation.peer_revision===v.execution.peer_revision && v.peer_observation.observed_at===v.created_at) &&
      ((v.target?.id || null) === (request.target_id || null)) && v.internet_checks === request.internet && Number.isFinite(Date.parse(v.created_at)) &&
      text(v.scope, 2000) && Array.isArray(v.checks) && v.checks.length <= 64 && v.checks.every(c => c && text(c.label) &&
        ['pass', 'fail', 'unavailable'].includes(c.status) && text(c.detail, 2000));
  }
  const selection = r => ({id:r.id,revision:r.revision,step_ids:r.step_ids || [],include_resolution:r.include_resolution || false,
    evidence_refs:(r.evidence_refs || []).map(p=>({kind:p.kind,id:p.id,revision:p.revision,...(p.kind==='chat'?{message_index:p.message_index}:{})})),
    report_refs:(r.report_refs || []).map(p=>({kind:p.kind,id:p.id,revision:p.revision}))});
  function validGuidance(v, wanted, computer) {
    const g=v?.guidance, c=v?.case_context, check=window.TLICaseContext;
    if(v?.ok!==true || v.protocol!=='tli-cases-v1' || v.actions_performed!==false || !Number.isFinite(Date.parse(v.checked_at)) || v.next_check_protocol!=='tli-case-next-check-v1' ||
       !g || g.version!==1 || !['suggested','unavailable'].includes(g.status) || !hash(g.selection_sha256) || !g.selection ||
       JSON.stringify(selection(g.selection))!==JSON.stringify(selection(wanted)) || !check?.matchesSelection(c,wanted) || c.computer_id!==(computer || null) ||
       (wanted.report_refs?.length ? !check.validFacts(v.evidence_context,c) : v.evidence_context?.recorded_report!==undefined))return false;
    const rows=(value,max,validate)=>Array.isArray(value) && value.length<=max && new Set(value.map(r=>r?.id)).size===value.length && value.every(r=>r && text(r.id,80) && r.id && validate(r));
    if(!rows(g.known,4,r=>text(r.label,240) && text(r.text,4000) && ['C1','R1'].includes(r.source) && r.recorded_at===(r.source==='C1'?c.updated_at:c.included_reports?.[0]?.recorded_at) && (r.source!=='R1' || c.included_reports?.length===1)) ||
       !rows(g.missing,8,r=>text(r.text,1000)) || !rows(g.steps,8,r=>text(r.text,1000) && text(r.outcome,2000) && ['planned','tried','skipped'].includes(r.status)) ||
       JSON.stringify(g.steps.map(r=>({id:r.id,status:r.status})))!==JSON.stringify(c.steps) || !Array.isArray(g.limitations) || g.limitations.length>8 || !g.limitations.every(r=>text(r,1000)) ||
       (computer ? !validOptions(g.check_options,computer) : g.check_options!==null))return false;
    if(g.status==='unavailable')return g.suggestion===null;
    const chosen=g.check_options?.options.find(o=>o.id===g.suggestion?.option_id);
    return !!computer && !!chosen && chosen.available && ['system','network','device','peer_system'].includes(chosen.kind) && text(g.suggestion.rule_id,80) && text(g.suggestion.rationale,1000);
  }
  function create() {
    const s = { box: null, context: null, options: null, choice: null, report: null, internet: false,
      busy: false, epoch: 0, request: null, notice: '', error: false, unknown: false, linked: false, pendingRun:false,
      guidance:null,guidanceRef:null,guidanceValid:false,fromGuidance:false,alternativesOpen:false };
    const node = (tag, value, cls) => { const e = document.createElement(tag); if (value != null) e.textContent = value; if (cls) e.className = cls; return e; };
    const current = epoch => s.epoch === epoch && s.context?.current();
    function message(value, error = false) { s.notice = value; s.error = error; paint(); }
    function button(label, action, primary = false) {
      const e = node('button', label, primary ? 'btn-primary' : 'btn-outline'); e.type = 'button'; e.disabled = s.busy;
      e.addEventListener('click', () => { if (!s.busy && s.context?.current()) Promise.resolve().then(action).catch(err => { if(s.context?.current()) message(err.message, true); }); }); return e;
    }
    async function request(url, method = 'GET', body) {
      const epoch=s.epoch;
      const r = await fetch(url, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (r.status === 401) { if(current(epoch))window.dispatchEvent(new CustomEvent('tli-session-locked')); throw new Error('Unlock TLI before continuing.'); }
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `The request failed (${r.status}).`);
      return data;
    }
    async function load() {
      if (s.busy) return;
      const epoch = ++s.epoch, computer = s.context.computerId; s.busy = true; message('Checking which existing checks fit this computer…');
      try {
        const data = await request('/api/intelligence/diagnostics/options?include_peer_observation=true' + (computer ? '&computer_id=' + encodeURIComponent(computer) : ''));
        if (!current(epoch)) return;
        if (!validOptions(data, computer)) throw new Error('Check choices are unavailable or incomplete. Previous results are retained.');
        s.options = data; s.choice = null; s.request = null; s.unknown = false;s.fromGuidance=false;s.alternativesOpen=true;
        message('Choose a check to review its host, target and scope. Nothing has run.');
        return data;
      } catch (e) { if (current(epoch)) message(e.message, true); }
      finally { if (current(epoch)) { s.busy = false; paint(); } }
    }
    async function reviewPerformance() {
      const data=await load();if(!data || !s.context?.current())return;
      const option=data.options.find(o=>o.kind==='performance');
      if(!option?.available){message(option?.reason || 'App performance is available only on the TLI host. Select that host explicitly; no computer was substituted.',true);return;}
      s.choice=option;s.fromGuidance=false;s.alternativesOpen=false;message('Review this host-only workspace below. Opening it does not start an observation.');
    }
    async function reviewSelection(ref) {
      if(s.busy || !s.context?.guidanceCurrent?.())return;
      const epoch=++s.epoch,computer=s.context.computerId;s.busy=true;s.guidanceValid=false;
      message('Reviewing the selected saved facts and available check scopes. No check or AI request is running.');
      try {
        const data=await request('/api/intelligence/cases/next-check','POST',{case_ref:ref});
        if(!current(epoch) || !s.context.guidanceCurrent())return;
        if(!validGuidance(data,ref,computer))throw new Error('The selected evidence or suggested scope could not be confirmed. Previous guidance remains for reference.');
        s.guidance=data;s.guidanceRef=selection(ref);s.guidanceValid=true;s.options=data.guidance.check_options;
        s.choice=data.guidance.suggestion?s.options.options.find(o=>o.id===data.guidance.suggestion.option_id):null;
        s.fromGuidance=!!s.choice;s.request=null;s.internet=false;s.alternativesOpen=false;
        message(s.choice?'Review the evidence, computer and scope below, then choose Run this check. Nothing has run.':'No supported next observation was selected. Review the missing information and capability limits.');
      }catch(e){if(current(epoch))message(e.message,true);}
      finally{if(current(epoch)){s.busy=false;paint();}}
    }
    async function refreshedSuggestion(epoch) {
      if(!s.guidanceValid || !s.guidanceRef || !s.context.guidanceCurrent?.())throw new Error('The saved case or draft changed. Review its evidence again before a suggested check.');
      const data=await request('/api/intelligence/cases/next-check','POST',{case_ref:s.guidanceRef});
      if(!current(epoch) || !s.context.guidanceCurrent?.())return null;
      if(!validGuidance(data,s.guidanceRef,s.context.computerId) || !data.guidance.suggestion || data.guidance.selection_sha256!==s.guidance.guidance.selection_sha256)throw new Error('The selected evidence or suggestion changed. Review it again; no check was requested.');
      const previous=s.guidance.guidance.check_options.options.find(o=>o.id===s.guidance.guidance.suggestion?.option_id),next=data.guidance.check_options.options.find(o=>o.id===data.guidance.suggestion.option_id);
      if(JSON.stringify(previous)!==JSON.stringify(next))throw new Error('The suggested check identity or scope changed. Review the evidence again; no check was requested.');
      return {data,option:next};
    }
    async function run() {
      const choice = s.choice;
      if (s.busy || !choice?.available || choice.kind === 'performance' || s.unknown) return;
      const epoch = ++s.epoch;
      s.request ||= { kind: choice.kind, target_id: choice.target_id || null, internet: choice.kind === 'network' && s.internet,
        expected_host_id: choice.execution_host.id, expected_scope: s.internet ? choice.internet_scope_revision : choice.scope_revision,
        request_id: requestId() };
      const body = { ...s.request }; s.busy = true; message('Running the reviewed check… The previous report remains below.');
      let sent=false;
      try {
        if(s.fromGuidance){const fresh=await refreshedSuggestion(epoch);if(!fresh)return;
          body.next_check_ref={case_ref:selection(s.guidanceRef),selection_sha256:fresh.data.guidance.selection_sha256,option_id:fresh.option.id};}
        if(!current(epoch))return;
         sent=true;s.pendingRun=true;
        const data = await request('/api/intelligence/diagnostics', 'POST', body);
        if (!current(epoch)) return;
        if (!validReport(data, body)) throw new Error('The check result could not be confirmed.');
        s.report = data; s.linked = false; s.choice = null; s.request = null; s.unknown = false;
        message('Report saved. Review it before adding a link to this problem. No repair was performed.');
      } catch (e) {
        if (current(epoch)) { s.unknown = sent;if(!sent){s.guidanceValid=false;s.choice=null;} message(e.message + (sent?' The outcome may be uncertain; inspect saved report history before deliberately running a new check. Nothing will replay automatically.':' No check was requested. Review the saved evidence again.'), true); }
      } finally { if (current(epoch)) { s.pendingRun=false;s.busy = false; paint(); } }
    }
    async function link() {
      if (!s.report || s.busy) return;
      const epoch = s.epoch, id = s.report.id; s.busy = true; paint();
      try {
        await s.context.onLink(id);
        if (current(epoch)) { s.linked = true; message('Report saved; link added to your draft. Save the problem to keep that link.'); }
      } catch (e) { if (current(epoch)) message('Report saved; problem link not saved. ' + e.message, true); }
      finally { if (current(epoch)) { s.busy = false; paint(); } }
    }
    function paint() {
      const box = s.box; if (!box) return; const hadFocus = box.contains?.(document.activeElement); box.replaceChildren();
      box.append(node('h4', 'Next check'));
      const feedback = node('p', s.notice || 'No check requested in this view.', 'troubleshooting-check-status'); feedback.setAttribute('role', 'status'); feedback.tabIndex = -1; if (s.error) feedback.className += ' error'; box.append(feedback);
      if (!s.context?.computerId) box.append(node('p', 'Choose the computer involved above before running a check.', 'troubleshooting-muted'));
      if(s.context?.onGuidance)box.append(button('Review evidence for a next check',s.context.onGuidance));
      let guidanceCard;
      if(s.guidance){const g=s.guidance.guidance,card=node('section',null,'troubleshooting-next-check');card.append(node('h5','What the saved evidence tells us'));
        if(!s.guidanceValid)card.append(node('p','Previous guidance is retained for reference. Review the evidence again before using a suggestion.','troubleshooting-muted'));
        card.append(node('h5','Known'));g.known.forEach(r=>card.append(node('p',`${r.label}: ${r.text} [${r.source}] · ${r.recorded_at?new Date(r.recorded_at).toLocaleString():'Time unavailable'}`)));
        if(s.guidance.evidence_context?.recorded_report && window.TLIReportFacts){const facts=node('details');facts.append(node('summary','Recorded measurements & source details'),window.TLIReportFacts.render(s.guidance.evidence_context.recorded_report));card.append(facts);}
        card.append(node('h5','Missing'));g.missing.forEach(r=>card.append(node('p',r.text)));
        card.append(node('h5','Already tried / not attempted'));if(!g.steps.length)card.append(node('p','No step records selected.'));
        g.steps.forEach(r=>card.append(node('p',`${r.status==='tried'?'User recorded an attempt':r.status==='skipped'?'Skipped — not recorded as attempted':'Planned — not recorded as attempted'}: ${r.text}`),node('p',r.status==='tried'?(r.outcome || 'No outcome recorded; success is unknown.'):'Any outcome note does not establish that this step ran.')));
        g.limitations.forEach(r=>card.append(node('small',r)));
        guidanceCard=card;}
      let alternatives;
      if (s.options) {
        alternatives=node('details',null,'troubleshooting-check-alternatives');alternatives.open=s.alternativesOpen;
        alternatives.append(node('summary','Other available checks'),node('small', `Choices checked ${new Date(s.options.checked_at).toLocaleString()} · Requesting TLI host: ${s.options.host.name} (${s.options.host.id})`));
        alternatives.addEventListener('toggle',()=>{if(box.contains?.(alternatives))s.alternativesOpen=alternatives.open;});
        const choices = node('div', null, 'troubleshooting-check-options');
        s.options.options.forEach(o => {
          const card = node('article', null, 'troubleshooting-check-option'); card.append(node('strong', o.title), node('p', o.detail), node('small', `Runs on ${o.execution_host.name} · measures ${o.measured_target.name} (${o.measured_target.id})`));
          if (!o.available) card.append(node('p', o.reason, 'troubleshooting-muted'));
          const b = button('Review this check', () => {
            s.choice = o; s.internet = false; s.request = null; s.unknown = false;s.fromGuidance=false;s.alternativesOpen=false; message('Review the scope, then choose Run this check.');
          }); b.disabled ||= !o.available; card.append(b); choices.append(card);
        }); alternatives.append(choices);
      }
      if (s.choice) {
        const review = node('section', null, 'troubleshooting-check-review'); review.append(node('h5', s.choice.title), node('p', s.choice.detail), node('p', `Executing host: ${s.choice.execution_host.name} (${s.choice.execution_host.id}). Target: ${s.choice.measured_target.name} (${s.choice.measured_target.id}).`));
        if(s.fromGuidance)review.append(node('p',s.guidance.guidance.suggestion.rationale));
        if (s.choice.kind === 'network' && !s.fromGuidance) {
          const wrap = node('label', null, 'troubleshooting-field'), input = node('input'); input.type = 'checkbox'; input.checked = s.internet; input.disabled = s.busy;
          input.addEventListener('change', () => { s.internet = input.checked; s.request = null; });
          wrap.append(input, node('span', s.choice.internet_detail)); review.append(wrap);
        }
        if(s.choice.kind==='performance'){
          review.append(node('p','Performance & apps observes only this TLI host. Choose the exact running process there, then start explicitly. Opening it does not read processes, sample or save a report.','troubleshooting-muted'),button('Open Performance & apps',()=>window.switchPanel?.('panel-games'),true));box.append(review);
        }else{
        review.append(node('p', 'Running records and saves an observation, not a diagnosis or repair. Closing this view does not cancel it. Linking the report to this problem stays separate.', 'troubleshooting-muted'));
        const start = button('Run this check', run, true); start.disabled ||= s.unknown || (s.fromGuidance && (!s.guidanceValid || !s.context.guidanceCurrent?.())); review.append(start, button('Cancel check review', () => { s.choice = null; s.request = null; message('Review cancelled. No new check was requested.'); })); box.append(review);
        }
      }
      if(guidanceCard)box.append(guidanceCard);
      if (s.unknown) box.append(button('Open saved report history', () => window.switchPanel?.('panel-devices')));
      box.append(button('Review available checks',load),button('Review app performance',reviewPerformance));if(alternatives)box.append(alternatives);
      if (s.report) {
        const r = s.report, card = node('section', null, 'troubleshooting-check-report');
        card.append(node('h5', 'Last completed report'), node('p', `${r.kind} · ${r.host.name} · ${new Date(r.created_at).toLocaleString()}`), node('p', r.scope, 'troubleshooting-muted'));
        const list = node('ul'); r.checks.forEach(c => list.append(node('li', `${c.status.toUpperCase()} · ${c.label}: ${c.detail}`))); card.append(list);
        card.append(button(s.linked ? 'Review report link again' : 'Add report link to this draft', link), button('Open saved report', () => window.TLIIntelligence?.openSavedReport?.(r.id)), button('Ask AI about this report', () => window.TLIIntelligence?.discussReport?.(r.id)));
        box.append(card);
      }
      if (hadFocus) feedback.focus?.({ preventScroll: true });
    }
    return {
      render(box, context) {
        if (s.context && s.context.key !== context.key) { s.options = null; s.choice = null; s.report = null; s.request = null; s.notice = ''; s.unknown = false; s.linked = false; s.epoch++; s.busy = false;s.guidance=s.guidanceRef=null;s.guidanceValid=s.fromGuidance=false; }
        else if (s.context && s.context.computerId !== context.computerId) { s.options = null; s.choice = null; s.request = null; s.epoch++; s.busy = false; s.notice = 'Computer changed. Review new check choices; the last report keeps its original scope.'; }
        s.box = box; s.context = context; paint();
      },
      reviewSelection,
      invalidateGuidance(){if(!s.guidance)return;s.guidanceValid=false;if(s.fromGuidance && !s.busy){s.choice=null;s.request=null;}paint();},
      suspend(clear = false) { s.epoch++;s.guidanceValid=false; if (s.busy) { s.unknown ||= s.pendingRun; s.notice = s.unknown?'The view closed during a check request. Check saved report history; nothing will replay automatically.':'The evidence review was interrupted. No diagnostic was requested by that review.'; } s.busy = false;s.pendingRun=false; if (clear) { s.box?.replaceChildren();s.options = s.report = s.choice = s.request = s.context = s.box = s.guidance = s.guidanceRef = null; s.notice = ''; s.unknown = false;s.fromGuidance=false; } },
    };
  }
  window.TLIGuidedChecks = { create, validOptions, validReport, validGuidance };
})();
