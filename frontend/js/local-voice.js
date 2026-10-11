/* Browser-local dictation and playback; no cloud fallback or automatic send. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id), MAX_TEXT=8000;
  const state={epoch:0,open:false,locked:false,busy:false,installing:false,availability:'unknown',language:'en-US',checkedLanguage:null,checkCancel:null,recognition:null,stopping:false,timer:null,
    final:new Map(),interim:'',transcript:'',returnFocus:null,reading:null,utterance:null,voices:[],enabled:false};
  try{state.enabled=localStorage.getItem('tli_tts_enabled')==='1';}catch{}
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn)=>{const b=node('button',text,'btn-outline');b.type='button';b.addEventListener('click',fn);return b;};
  const notice=text=>{if($('local-voice-status'))$('local-voice-status').textContent=text;};
  const chatVisible=()=>!$('panel-main') || !$('panel-main').hidden;
  const allowed=()=>!state.locked && !document.hidden && chatVisible() && $('tli-lock-screen')?.getAttribute('aria-hidden')!=='false';
  const current=epoch=>state.open && state.epoch===epoch && allowed();
  function recognitionType(){return window.SpeechRecognition || window.webkitSpeechRecognition;}
  function supported(){const R=recognitionType();return window.isSecureContext===true && typeof R==='function' && typeof R.available==='function';}
  function update(){
    const busy=state.busy || state.installing || !!state.recognition;
    if($('local-voice-language'))$('local-voice-language').disabled=busy;
    if($('local-voice-check'))$('local-voice-check').disabled=busy;
    if($('local-voice-install')){ $('local-voice-install').hidden=state.availability!=='downloadable';$('local-voice-install').disabled=busy; }
    if($('local-voice-start'))$('local-voice-start').disabled=busy || state.availability!=='available';
    if($('local-voice-stop'))$('local-voice-stop').disabled=!state.recognition || state.stopping;
    if($('local-voice-insert'))$('local-voice-insert').disabled=busy || !state.transcript.trim();
    if($('local-voice-transcript'))$('local-voice-transcript').readOnly=busy;
    if($('chat-mic-btn')){ $('chat-mic-btn').classList.toggle('recording',!!state.recognition);$('chat-mic-btn').setAttribute('aria-pressed',String(!!state.recognition)); }
  }
  function resetTranscript(){state.final.clear();state.interim='';state.transcript='';if($('local-voice-transcript'))$('local-voice-transcript').value='';if($('local-voice-interim'))$('local-voice-interim').textContent='';}
  function abortRecognition(){const rec=state.recognition;state.recognition=null;state.stopping=false;state.interim='';if($('local-voice-interim'))$('local-voice-interim').textContent='';clearTimeout(state.timer);state.timer=null;if(rec){rec.onstart=rec.onresult=rec.onend=rec.onerror=null;try{rec.abort();}catch{}}update();}
  function close(){if(!state.open)return;state.epoch++;state.open=false;state.busy=false;state.availability='unknown';state.checkedLanguage=null;state.checkCancel?.();state.checkCancel=null;abortRecognition();stopPlayback();resetTranscript();notice('');if($('local-voice-dialog')?.open)$('local-voice-dialog').close();if(allowed())state.returnFocus?.focus?.();state.returnFocus=null;}
  async function check(){
    if(!current(state.epoch) || state.busy || state.installing || state.recognition)return;
    const epoch=state.epoch,language=$('local-voice-language').value;state.language=language;state.busy=true;state.availability='unknown';state.checkedLanguage=null;update();notice('Checking on-device recognition for this browser…');
    try{
      if(!supported())throw new Error(window.isSecureContext!==true?'Microphone access needs HTTPS or localhost. Open TLI securely on this device.':'This browser cannot confirm on-device speech recognition. Type your question; TLI will not use a cloud speech service.');
      const R=recognitionType(),rec=new R();
      if(!('processLocally' in rec))throw new Error('This browser does not expose enforced local recognition. Dictation is unavailable here.');
      rec.processLocally=true;
      if(rec.processLocally!==true)throw new Error('Local recognition could not be enforced. Dictation is unavailable here.');
      let deadline;
      const availability=await Promise.race([R.available({langs:[language],processLocally:true}),new Promise((_,reject)=>{state.checkCancel=()=>reject(new Error('Local support check closed.'));deadline=setTimeout(()=>reject(new Error('The browser did not confirm local support within ten seconds.')),10000);})]).finally(()=>{clearTimeout(deadline);if(state.epoch===epoch)state.checkCancel=null;});
      if(!current(epoch))return;
      if($('local-voice-language').value!==language)throw new Error('The selected language changed. Recheck local support before recording.');
      if(!['available','unavailable','downloadable','downloading'].includes(availability))throw new Error('The browser returned an unknown language-pack status.');
      state.availability=availability;state.checkedLanguage=language;
      notice(availability==='available'?'On-device recognition is available. Start dictation when ready; review the transcript before adding it to Chat.':availability==='downloadable'?'A browser language pack is needed. Downloading it contacts the browser vendor. Choose Download language pack if you want to install it on this device.':availability==='downloading'?'The browser reports a language-pack download in progress. Recheck when it finishes; TLI will not start another.':'On-device recognition is unavailable for this language in this browser. No cloud fallback will be used.');
    }catch(error){if(current(epoch))notice(error.message || 'Local recognition support could not be checked.');}
    finally{if(current(epoch)){state.busy=false;update();}}
  }
  async function install(){
    if(!current(state.epoch) || state.busy || state.installing || state.recognition || state.availability!=='downloadable' || state.checkedLanguage!==$('local-voice-language').value)return;
    const R=recognitionType();if(typeof R?.install!=='function'){notice('This browser cannot install the language pack from TLI. Check its language settings.');return;}
    const epoch=state.epoch;state.installing=true;update();notice('The browser is installing the selected language pack. Closing TLI does not cancel the browser-managed download.');
    try{const installed=await R.install({langs:[$('local-voice-language').value]});
      if(current(epoch)){state.availability='unknown';notice(installed===true?'Language-pack installation reported complete. Recheck support before starting dictation.':'The browser did not confirm installation. Recheck support; no recording has started.');}
    }catch{if(current(epoch)){state.availability='unknown';notice('The browser could not install the language pack. No microphone recording started.');}}
    finally{state.installing=false;update();}
  }
  function finish(rec,epoch,message){
    if(state.recognition!==rec || !current(epoch))return;
    clearTimeout(state.timer);state.timer=null;state.recognition=null;state.stopping=false;rec.onstart=rec.onresult=rec.onend=rec.onerror=null;state.interim='';$('local-voice-interim').textContent='';
    notice(message || (state.transcript?'Dictation finished. Review and edit the transcript, then choose Add to draft.':'No speech was recognized. Nothing was added to Chat.'));update();
  }
  function stop(){
    const rec=state.recognition,epoch=state.epoch;if(!rec || state.stopping || !current(epoch))return;state.stopping=true;
    notice('Finishing dictation…');$('local-voice-stop').disabled=true;
    try{rec.stop();}catch{finish(rec,epoch,'Recording stopped unexpectedly. Review any completed transcript.');try{rec.abort();}catch{}}
    if(state.recognition!==rec || !current(epoch))return;
    clearTimeout(state.timer);state.timer=setTimeout(()=>{if(state.recognition===rec){abortRecognition();notice('The browser did not finish in time. Recording was aborted; only completed transcript text is available.');}},3000);
  }
  function start(){
    if(!current(state.epoch) || state.busy || state.installing || state.recognition || state.availability!=='available' || state.checkedLanguage!==$('local-voice-language').value || !supported())return;
    if(state.transcript){notice('Add or discard the current transcript before starting another dictation.');return;}
    const epoch=state.epoch,R=recognitionType();let rec;
    try{
      rec=new R();if(!('processLocally' in rec))throw new Error();rec.processLocally=true;if(rec.processLocally!==true)throw new Error();
      rec.lang=$('local-voice-language').value;rec.continuous=false;rec.interimResults=true;rec.maxAlternatives=1;
      state.recognition=rec;resetTranscript();stopPlayback();update();notice('Starting local dictation… You may be asked for microphone permission.');
      rec.onstart=()=>{if(!current(epoch) || state.recognition!==rec){try{rec.abort();}catch{}return;}notice('Listening on this device · up to 30 seconds. Choose Stop when finished.');};
      rec.onresult=e=>{
        if(!current(epoch) || state.recognition!==rec)return;
        let interim='';
        if(!Number.isInteger(e.resultIndex) || e.resultIndex<0 || !e.results || e.results.length>128){abortRecognition();notice('The browser returned an unreadable transcript. Nothing was sent.');return;}
        for(let i=e.resultIndex;i<e.results.length;i++){
          const result=e.results[i],text=result?.[0]?.transcript;
          if(typeof text!=='string')continue;
          if(result.isFinal)state.final.set(i,text.trim());else interim+=text;
        }
        const text=[...state.final].sort((a,b)=>a[0]-b[0]).map(x=>x[1]).join(' ');
        if(text.length>MAX_TEXT || interim.length>MAX_TEXT){abortRecognition();notice('Dictation exceeded 8,000 characters. The previous completed transcript is retained; no truncated replacement was added.');return;}
        state.transcript=text;state.interim=interim;$('local-voice-transcript').value=text;$('local-voice-interim').textContent=interim?'Still recognizing: '+interim:'';
      };
      rec.onend=()=>finish(rec,epoch);
      rec.onerror=e=>{
        const descriptions={'not-allowed':'Microphone permission was denied. Review this site’s microphone permission before trying again.','service-not-allowed':'The browser blocked local recognition. Check its permissions and on-device speech support.','language-not-supported':'This local language pack is unavailable. Recheck or select another language.','audio-capture':'The browser could not access a microphone.','no-speech':'No speech was detected.','network':'The local recognition service failed. TLI will not fall back to cloud recognition.','aborted':'Dictation was stopped.'};
        finish(rec,epoch,(descriptions[e.error] || 'Local dictation failed.')+' Any completed transcript remains for review. Nothing was sent to Chat.');
        try{rec.abort();}catch{}
      };
      state.timer=setTimeout(stop,30000);rec.start();
    }catch{abortRecognition();notice('Local dictation could not start. No cloud fallback or automatic retry was attempted.');}
  }
  function insert(){
    if(!current(state.epoch) || state.busy || state.installing || state.recognition)return;
    const text=$('local-voice-transcript').value.trim(),input=$('chat-input');
    if(!text || !input)return;
    const draft=input.value+(input.value?'\n':'')+text,limit=input.maxLength>0?input.maxLength:12000;
    if(text.length>MAX_TEXT || draft.length>limit){notice('This transcript will not fit with the current draft. Shorten it before adding; your Chat draft is unchanged.');return;}
    input.value=draft;input.dispatchEvent(new Event('input',{bubbles:true}));close();input.focus();
  }
  function initDialog(){
    if($('local-voice-dialog'))return;
    const dialog=node('dialog',null,'local-voice-dialog');dialog.id='local-voice-dialog';dialog.setAttribute('aria-labelledby','local-voice-heading');
    const head=node('header'),h=node('h2','Local voice');h.id='local-voice-heading';h.tabIndex=-1;head.append(h,button('Close voice',close));
    const info=node('p','Dictate on the device running this browser, review the words and add them to your draft. Nothing is sent to AI until you choose Send. Local recognition support varies by browser and language.');
    const feedback=node('p');feedback.id='local-voice-status';feedback.setAttribute('role','status');
    const language=node('select');language.id='local-voice-language';
    for(const [value,label]of [['en-US','English (US)'],['en-GB','English (UK)'],['es-ES','Spanish'],['fr-FR','French'],['de-DE','German'],['it-IT','Italian'],['pt-BR','Portuguese (Brazil)'],['ja-JP','Japanese'],['ko-KR','Korean'],['zh-CN','Chinese (Mandarin)']]){const o=node('option',label);o.value=value;language.append(o);}
    const languageLabel=node('label');languageLabel.append(node('span','Dictation language'),language);
    language.addEventListener('change',()=>{if(state.busy || state.installing || state.recognition){language.value=state.language;return;}state.language=language.value;state.checkedLanguage=null;state.availability='unknown';notice('Recheck on-device support for the selected language.');update();});
    const checkBtn=button('Check local support',check);checkBtn.id='local-voice-check';
    const download=button('Download language pack',install);download.id='local-voice-install';download.hidden=true;
    const startBtn=button('Start dictation',start);startBtn.id='local-voice-start';
    const stopBtn=button('Stop dictation',stop);stopBtn.id='local-voice-stop';
    const actions=node('div',null,'local-voice-actions');actions.append(checkBtn,download,startBtn,stopBtn);
    const transcript=node('textarea');transcript.id='local-voice-transcript';transcript.rows=6;transcript.maxLength=MAX_TEXT;transcript.addEventListener('input',()=>{state.transcript=transcript.value;update();});
    const label=node('label');label.append(node('span','Review transcript'),transcript);
    const interim=node('p');interim.id='local-voice-interim';
    const add=button('Add to draft',insert);add.id='local-voice-insert';
    const discard=button('Discard transcript',()=>{if(!state.recognition){resetTranscript();update();notice('Transcript discarded. Your existing Chat draft is unchanged.');}});
    const footer=node('div',null,'local-voice-actions');footer.append(add,discard);
    dialog.append(head,info,languageLabel,actions,feedback,label,interim,footer,node('p','TLI does not store audio. The browser provides recognition; no cloud fallback is permitted. Closing or locking this view clears its transcript.'));
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',()=>{if(!dialog.open)close();});document.body.append(dialog);update();
  }
  function open(){if(state.open || !allowed())return;initDialog();state.open=true;state.epoch++;state.availability='unknown';state.checkedLanguage=null;state.returnFocus=document.activeElement;$('local-voice-dialog').showModal();$('local-voice-heading').focus();notice(state.installing?'A previously requested browser language-pack installation is still pending. Closing this view does not cancel that browser-managed download.':'Choose Check local support. Opening this view does not start the microphone or install a language pack.');update();}
  function cleanText(text){return String(text || '').replace(/```[\s\S]*?```/g,'Code block omitted.').replace(/`([^`]+)`/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*#]/g,'').trim();}
  function stopPlayback(){
    const btn=state.reading;state.reading=null;state.utterance=null;
    if(btn){btn.classList.remove('speaking');btn.textContent='▶';btn.setAttribute('aria-label','Read aloud using a local voice');}
    try{window.speechSynthesis?.cancel();}catch{}
  }
  function refreshVoices(){
    const synth=window.speechSynthesis;try{state.voices=(synth?.getVoices?.() || []).filter(v=>v?.localService===true);}catch{state.voices=[];}
    const select=$('tts-voice-select');if(select){let saved='';try{saved=localStorage.getItem('tli_tts_voice') || '';}catch{}
      select.replaceChildren();for(const voice of state.voices){const o=node('option',`${voice.name} (${voice.lang}) · local`);o.value=voice.voiceURI || voice.name;select.append(o);}
      const chosen=state.voices.find(v=>(v.voiceURI || v.name)===saved || v.name===saved) || state.voices.find(v=>v.default) || state.voices[0];if(chosen)select.value=chosen.voiceURI || chosen.name;
      if(!state.voices.length){const o=node('option','No confirmed local playback voices');o.value='';select.append(o);}select.disabled=!state.voices.length;
    }
    const toggle=$('tts-toggle');if(toggle){toggle.disabled=!state.voices.length;toggle.title=state.voices.length?'Read completed replies using a voice reported as local by this browser.':'No confirmed local playback voice is available in this browser.';toggle.classList.toggle('active',state.enabled && !!state.voices.length);toggle.setAttribute('aria-pressed',String(state.enabled && !!state.voices.length));}
    if(state.utterance && !state.voices.some(v=>(v.voiceURI || v.name)===(state.utterance.voice?.voiceURI || state.utterance.voice?.name)))stopPlayback();
  }
  function speak(text,{automatic=false,button:btn=null}={}){
    if(!allowed() || state.recognition || automatic && !state.enabled)return false;
    if(btn && state.reading===btn){stopPlayback();return true;}
    refreshVoices();const value=$('tts-voice-select')?.value;
    const voice=state.voices.find(v=>(v.voiceURI || v.name)===value) || state.voices.find(v=>v.default) || state.voices[0];
    if(!voice || voice.localService!==true){if(!automatic)window.showToast?.('No confirmed local playback voice is available. Check your browser or operating-system voices.','warn');return false;}
    const clean=cleanText(text);if(!clean)return false;
    if(clean.length>24000){if(!automatic)window.showToast?.('This reply is too long for local playback. Copy a shorter section into your operating system’s reading tool.','warn');return false;}
    stopPlayback();
    try{const utt=new SpeechSynthesisUtterance(clean);utt.voice=voice;utt.rate=1;utt.pitch=1;state.utterance=utt;state.reading=btn;
      if(btn){btn.classList.add('speaking');btn.textContent='■';btn.setAttribute('aria-label','Stop reading aloud');}
      utt.onend=utt.onerror=()=>{if(state.utterance===utt)stopPlayback();};window.speechSynthesis.speak(utt);return true;
    }catch{stopPlayback();return false;}
  }
  function attach(bubble,text){if(!bubble || !window.speechSynthesis)return;bubble.querySelectorAll('.chat-bubble-speak').forEach(b=>b.remove());const b=button('▶',()=>speak(text,{button:b}));b.className='chat-bubble-speak';b.title='Read aloud using a local voice';b.setAttribute('aria-label',b.title);bubble.append(b);}
  function setup(){
    const mic=$('chat-mic-btn');if(mic && !mic.dataset.localVoiceBound){mic.dataset.localVoiceBound='1';mic.title='Local dictation · review before sending';mic.setAttribute('aria-label','Open local voice dictation');mic.addEventListener('click',open);}
    const toggle=$('tts-toggle');if(toggle && !toggle.dataset.localVoiceBound){toggle.dataset.localVoiceBound='1';toggle.title='Read completed replies using a local voice';toggle.addEventListener('click',()=>{refreshVoices();if(!state.voices.length)return;state.enabled=!state.enabled;try{localStorage.setItem('tli_tts_enabled',state.enabled?'1':'0');}catch{}if(!state.enabled)stopPlayback();refreshVoices();});}
    const select=$('tts-voice-select');if(select && !select.dataset.localVoiceBound){select.dataset.localVoiceBound='1';select.classList.remove('hidden');select.setAttribute('aria-label','Local read-aloud voice');select.addEventListener('change',()=>{stopPlayback();try{localStorage.setItem('tli_tts_voice',select.value);}catch{}});}
    refreshVoices();
  }
  window.TLILocalVoice={setup,open,close,speak,attach,stop:()=>{abortRecognition();stopPlayback();},cleanText};
  window.speechSynthesis?.addEventListener?.('voiceschanged',refreshVoices);
  window.addEventListener('tli-session-locked',()=>{state.locked=true;close();stopPlayback();});window.addEventListener('tli-session-unlocked',()=>{state.locked=false;});window.addEventListener('pagehide',()=>{close();stopPlayback();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){close();stopPlayback();}});
  document.addEventListener('tli-panel-switched',e=>{if(e.detail?.panelId!=='panel-main'){close();stopPlayback();}});
})();
