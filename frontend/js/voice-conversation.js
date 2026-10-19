/* Host-local push-to-talk. Audio is sent only to this TLI host after recording. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = {epoch:0, open:false, locked:false, pressed:false, recording:null, stream:null,
    timer:null, speechTimer:null, speaking:false, abort:null, request:null, audio:null, audioURL:null, busy:false, caps:null};
  const make = (tag, text, id) => {const n=document.createElement(tag);if(text!==null)n.textContent=text;if(id)n.id=id;return n;};
  const button = (text, action, id) => {const n=make('button',text,id);n.type='button';n.className='btn-outline';if(action)n.addEventListener('click',action);return n;};
  const uuid = () => crypto.randomUUID();
  const allowed = () => state.open && !state.locked && !document.hidden && (!$('panel-main') || !$('panel-main').hidden);
  const current = epoch => epoch===state.epoch && allowed();
  const notice = message => {if($('voice-conversation-status'))$('voice-conversation-status').textContent=message;};
  function update(){
    if(!$('voice-conversation-talk'))return;
    $('voice-conversation-talk').disabled=state.speaking || (state.busy && !state.pressed) || !state.caps?.host_voice_supported || !state.caps?.transcription_installed || !state.caps?.settings?.model_path;
    $('voice-conversation-talk').setAttribute('aria-pressed',String(!!state.recording));
    $('voice-conversation-send').disabled=state.busy || state.speaking || !!state.recording || !$('voice-conversation-transcript').value.trim();
    $('voice-conversation-transcript').readOnly=state.busy || !!state.recording;
    $('voice-conversation-announcement').readOnly=state.busy || !!state.recording;
    $('voice-conversation-announce').disabled=state.busy || state.speaking || !!state.recording || !$('voice-conversation-speaker').value || !$('voice-conversation-announcement').value.trim();
    for(const id of ['voice-conversation-speaker','voice-conversation-volume','voice-conversation-save','voice-conversation-enable','voice-conversation-auto'])$(id).disabled=state.busy || state.speaking || !!state.recording;
  }
  async function api(path, options={}){
    const headers={...(options.body && !(options.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...options.headers};
    const response=await fetch('/api/voice'+path,{credentials:'same-origin',cache:'no-store',...options,headers});
    if(!response.ok){let message='Host voice could not complete this request.';try{const value=await response.json();if(typeof value.detail==='string')message=value.detail;}catch{}throw new Error(message);}
    return response;
  }
  function releaseMic(){clearTimeout(state.timer);state.timer=null;state.stream?.getTracks().forEach(track=>track.stop());state.stream=null;}
  function stopPlayback(){clearTimeout(state.speechTimer);state.speechTimer=null;state.speaking=false;if(state.audio){state.audio.onended=state.audio.onerror=null;state.audio.pause();state.audio.src='';state.audio=null;}if(state.audioURL){URL.revokeObjectURL(state.audioURL);state.audioURL=null;}if($('voice-conversation-play'))$('voice-conversation-play').hidden=true;}
  function holdSpeakerCapture(value,epoch){
    if(!['accepted','unknown'].includes(value.outcome))return;
    clearTimeout(state.speechTimer);state.speaking=true;
    const seconds=Number(value.capture_hold_seconds);
    // Missing timing never means silent; an explicit Stop remains available.
    if(Number.isFinite(seconds) && seconds>0 && seconds<=190)state.speechTimer=setTimeout(()=>{if(current(epoch)){state.speechTimer=null;state.speaking=false;notice('The estimated speaker speech window has elapsed. Hold Talk for the next turn, or wait if the speaker is still playing.');update();}},Math.ceil(seconds*1000));
    update();
  }
  function stop(){
    state.epoch++;state.pressed=false;state.abort?.abort();state.abort=null;
    const recorder=state.recording;state.recording=null;
    if(recorder){recorder.onstop=recorder.ondataavailable=recorder.onerror=null;try{recorder.stop();}catch{}}
    releaseMic();stopPlayback();
    const request=state.request;state.request=null;state.busy=false;
    if(request)api('/cancel',{method:'POST',body:JSON.stringify({request_id:request}),keepalive:true}).catch(()=>{});
    window.dispatchEvent(new CustomEvent('tli:voice-stop'));
    notice('Voice stopped. Any speaker audio already fetched may continue if that speaker cannot cancel its clip.');update();
  }
  function close(){
    if(!state.open)return;
    stop();state.open=false;
    api('/media/disable',{method:'POST',body:'{}',keepalive:true}).catch(()=>{});
    if($('voice-conversation-dialog').open)$('voice-conversation-dialog').close();
    $('voice-conversation-transcript').value='';
    $('voice-conversation-announcement').value='';$('voice-conversation-reply').textContent='';
    $('voice-conversation-auto').checked=false;
  }
  async function refresh(){
    const epoch=state.epoch;
    try{
      const caps=await (await api('/capabilities')).json();if(!current(epoch))return;state.caps=caps;
      $('voice-conversation-model').value=caps.settings?.model_path || '';
      $('voice-conversation-port').value=caps.settings?.port || 8766;
      const bind=$('voice-conversation-bind');bind.replaceChildren(make('option','Select this host’s LAN address'));bind.firstChild.value='';
      for(const address of caps.interfaces || []){const option=make('option',address);option.value=address;bind.append(option);}bind.value=caps.settings?.bind_ip || '';
      $('voice-conversation-enable').textContent=caps.media_enabled?'Disable Sonos audio sharing':'Enable Sonos audio sharing';
      notice(caps.reason || (caps.transcription_installed && caps.settings?.model_path?'Hold Talk, then release and review your words. Audio is transcribed on this TLI host.':'Set a preinstalled local base.en model directory. The optional voice dependencies must be installed on this host.'));
      update();
      try{
        const response=await fetch('/api/sonos/devices',{credentials:'same-origin',cache:'no-store'});
        if(!response.ok)return;
        const devices=await response.json();if(!current(epoch))return;
        const select=$('voice-conversation-speaker'),previous=select.value;
        select.replaceChildren(make('option','This browser'));select.firstChild.value='';
        for(const device of devices.devices || []){const option=make('option',device.name || device.id);option.value=device.id || device.device_id;select.append(option);}select.value=previous;if(select.selectedIndex<0)select.selectedIndex=0;
      }catch{}
    }catch(error){if(current(epoch)){notice(error.message);update();}}
  }
  async function save(){
    try{await api('/settings',{method:'PUT',body:JSON.stringify({model_path:$('voice-conversation-model').value.trim(),bind_ip:$('voice-conversation-bind').value,port:Number($('voice-conversation-port').value)})});await refresh();}catch(error){notice(error.message);}
  }
  async function media(){
    try{await api('/media/'+(state.caps?.media_enabled?'disable':'enable'),{method:'POST',body:'{}'});await refresh();}catch(error){notice(error.message);}
  }
  async function record(){
    if(!allowed() || state.recording || state.busy || state.speaking || $('voice-conversation-talk').disabled)return;
    state.pressed=true;
    const epoch=state.epoch;
    if(window.isSecureContext!==true || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder==='undefined'){
      state.pressed=false;notice('Microphone recording needs HTTPS trusted by this device, or localhost, and a compatible browser. You can type a message here.');return;
    }
    state.busy=true;update();notice('Requesting microphone access…');
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
      if(!current(epoch) || !state.pressed){stream.getTracks().forEach(track=>track.stop());return;}
      state.stream=stream;
      const type=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(value=>MediaRecorder.isTypeSupported(value));
      const recorder=new MediaRecorder(stream,type?{mimeType:type}:{}),parts=[];let size=0;
      state.recording=recorder;state.busy=false;update();
      recorder.ondataavailable=event=>{if(!current(epoch) || state.recording!==recorder)return;if(event.data?.size){size+=event.data.size;if(size>8*1024*1024){stop();notice('Recording exceeded eight MB. Nothing was transcribed or sent.');return;}parts.push(event.data);}};
      recorder.onerror=()=>{if(current(epoch)){stop();notice('Microphone recording failed. Nothing was sent.');}};
      recorder.onstop=()=>{
        if(!current(epoch) || state.recording!==recorder)return;
        state.recording=null;releaseMic();
        if(!parts.length){notice('No audio was recorded.');update();return;}
        transcribe(new Blob(parts,{type:recorder.mimeType}),epoch,$('voice-conversation-auto').checked===true);
      };
      recorder.start(250);state.timer=setTimeout(finishRecording,30000);notice('Listening on this device · release Talk to finish (maximum 30 seconds).');
    }catch(error){if(current(epoch)){releaseMic();state.pressed=false;notice(error.name==='NotAllowedError'?'Microphone access was denied. You can type a message here.':'This browser could not start the microphone.');}}
    finally{if(current(epoch)){state.busy=false;update();}}
  }
  function finishRecording(){
    state.pressed=false;const recorder=state.recording;
    if(recorder?.state==='recording'){clearTimeout(state.timer);state.timer=null;try{recorder.stop();}catch{stop();}}
  }
  async function transcribe(blob,epoch,autoSend=false){
    let readyToSend=false;
    state.busy=true;state.request=uuid();state.abort=new AbortController();update();notice('Transcribing on this TLI host…');
    const form=new FormData();form.append('audio',blob,'recording.audio');form.append('request_id',state.request);
    try{const value=await (await api('/transcribe',{method:'POST',body:form,signal:state.abort.signal})).json();if(!current(epoch))return;$('voice-conversation-transcript').value=value.text || '';readyToSend=autoSend && typeof value.text==='string' && !!value.text.trim();notice(value.text?'Review or edit the transcript, then choose Send. Nothing has been sent to Chat.':'No speech was recognized. Try again or type your message.');}
    catch(error){if(current(epoch))notice(error.message);}
    finally{if(current(epoch)){state.busy=false;state.request=null;state.abort=null;update();if(readyToSend)send();}}
  }
  async function completed(reply, info, epoch){
    if(!current(epoch))return;
    const run_id=typeof reply==='object'?reply?.run_id:info?.run_id;
    const text=typeof reply==='string'?reply:reply?.reply;
    if(typeof text==='string')$('voice-conversation-reply').textContent=text;
    if(!run_id){state.busy=false;notice('Response complete. Speech is unavailable because a saved run identity was not provided.');update();return;}
    state.request=uuid();state.abort=new AbortController();notice('Preparing the completed response with this host’s Windows voice…');
    try{
      const value=await (await api('/speak',{method:'POST',body:JSON.stringify({run_id,request_id:state.request,speaker_id:$('voice-conversation-speaker').value || null,volume:Number($('voice-conversation-volume').value)}),signal:state.abort.signal})).json();
      if(!current(epoch))return;
      if($('voice-conversation-speaker').value){holdSpeakerCapture(value,epoch);notice(value.outcome==='accepted'?'The speaker acknowledged the audio clip. Talk is paused during its estimated speech window; Stop enables the next turn.':value.outcome==='unknown'?'The speaker did not confirm playback. Talk stays paused while the clip may be playing; choose Stop when ready.':'The speaker rejected this clip. The completed response remains available.');return;}
      const response=await api('/audio/'+encodeURIComponent(value.clip_id),{signal:state.abort.signal}),blob=await response.blob();
      if(!current(epoch))return;
      stopPlayback();state.speaking=true;state.audioURL=URL.createObjectURL(blob);const audio=new Audio(state.audioURL);state.audio=audio;update();
      audio.onended=()=>{if(!current(epoch) || state.audio!==audio)return;stopPlayback();notice('Finished reading the completed response.');update();};
      audio.onerror=()=>{if(!current(epoch) || state.audio!==audio)return;stopPlayback();notice('This browser could not play the audio. The completed response remains available.');update();};
      try{await audio.play();if(current(epoch) && state.audio===audio)notice('Reading the completed response on this browser.');}
      catch{if(current(epoch) && state.audio===audio){notice('Your browser requires a playback gesture. Choose Play response.');$('voice-conversation-play').hidden=false;}}
    }catch(error){if(current(epoch))notice(error.message);}
    finally{if(current(epoch)){state.busy=false;state.abort=null;update();}}
  }
  async function announce(){
    if(!allowed() || state.busy || state.recording || $('voice-conversation-announce').disabled)return;
    const epoch=state.epoch;state.busy=true;state.request=uuid();state.abort=new AbortController();update();
    notice('Preparing your reviewed announcement with the local host voice…');
    try{
      const value=await (await api('/announce',{method:'POST',body:JSON.stringify({request_id:state.request,speaker_id:$('voice-conversation-speaker').value,text:$('voice-conversation-announcement').value.trim(),volume:Number($('voice-conversation-volume').value)}),signal:state.abort.signal})).json();
      if(!current(epoch))return;
      holdSpeakerCapture(value,epoch);notice(value.outcome==='accepted'?'The speaker acknowledged your announcement. Talk is paused during its estimated speech window; Stop enables the next turn.':value.outcome==='unknown'?'The speaker did not confirm the announcement. Talk stays paused while the clip may be playing; choose Stop when ready.':'The speaker rejected this announcement.');
    }catch(error){if(current(epoch))notice(error.message);}
    finally{if(current(epoch)){state.busy=false;state.abort=null;update();}}
  }
  function send(){
    const text=$('voice-conversation-transcript').value.trim();if(!allowed() || state.busy || state.speaking || state.recording || !text)return;
    const epoch=state.epoch;state.busy=true;update();notice('Sending your reviewed message…');
    let settled=false;
    const detail={text,speaker_id:$('voice-conversation-speaker').value || null,request_id:uuid(),handled:false,
      complete:(reply,info)=>{if(settled)return;settled=true;return completed(reply,info,epoch);},fail:message=>{if(settled)return;settled=true;if(current(epoch)){state.busy=false;notice(message || 'The response did not complete. Nothing was spoken.');update();}}};
    window.dispatchEvent(new CustomEvent('tli:voice-turn',{detail}));
    if(!detail.handled){const draft=$('chat-input');if(draft){draft.value+=(draft.value?'\n':'')+text;draft.dispatchEvent(new Event('input',{bubbles:true}));}state.busy=false;notice('Added to your Chat draft. Use Chat Send when ready.');update();}
  }
  function init(){
    if($('voice-conversation-dialog'))return;
    const dialog=make('dialog',null,'voice-conversation-dialog');dialog.className='voice-conversation';dialog.setAttribute('aria-labelledby','voice-conversation-heading');
    const head=make('header');head.append(make('h2','Talk to TLI','voice-conversation-heading'),button('Close',close));dialog.append(head);
    dialog.append(make('p','Record on this phone or PC, review your words, then Send. Transcription and speech stay on your TLI host. Completed responses can play here or on a supported Sonos speaker.'));
    const feedback=make('p','','voice-conversation-status');feedback.setAttribute('role','status');dialog.append(feedback);
    const talk=button('Hold Talk',null,'voice-conversation-talk');talk.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();talk.setPointerCapture?.(e.pointerId);record();});talk.addEventListener('pointerup',finishRecording);talk.addEventListener('pointercancel',()=>stop());talk.addEventListener('keydown',e=>{if((e.key===' ' || e.key==='Enter') && !e.repeat){e.preventDefault();record();}});talk.addEventListener('keyup',e=>{if(e.key===' ' || e.key==='Enter'){e.preventDefault();finishRecording();}});
    const controls=make('div');controls.className='voice-conversation-actions';controls.append(talk,button('Stop',stop));dialog.append(controls);
    const automatic=make('input',null,'voice-conversation-auto');automatic.type='checkbox';automatic.checked=false;
    const automaticLabel=make('label');automaticLabel.className='voice-conversation-auto-label';automaticLabel.append(automatic,make('span','Send push-to-talk turns on release'));dialog.append(automaticLabel,make('p','Optional: when enabled, releasing Talk transcribes and sends the turn. Otherwise, review the words and choose Send. Microphone capture pauses while TLI reads a response.'));
    const transcript=make('textarea',null,'voice-conversation-transcript');transcript.rows=4;transcript.maxLength=8000;transcript.setAttribute('aria-label','Review and edit your message');transcript.addEventListener('input',update);dialog.append(transcript);
    const speaker=make('select',null,'voice-conversation-speaker'),option=make('option','This browser');option.value='';speaker.append(option);speaker.addEventListener('change',update);const label=make('label','Read completed response on ');label.append(speaker);dialog.append(label);
    const volume=make('input',null,'voice-conversation-volume');volume.type='number';volume.min='0';volume.max='100';volume.value='25';const volumeLabel=make('label','Sonos volume (speaker cap applies) ');volumeLabel.append(volume);dialog.append(volumeLabel);
    const play=button('Play response',()=>state.audio?.play().catch(()=>notice('Playback was blocked.')),'voice-conversation-play');play.hidden=true;
    dialog.append(button('Send reviewed message',send,'voice-conversation-send'),play,make('p','','voice-conversation-reply'));
    const announcement=make('details');announcement.append(make('summary','Announce a message on Sonos'));
    const announcementText=make('textarea',null,'voice-conversation-announcement');announcementText.rows=3;announcementText.maxLength=8000;announcementText.setAttribute('aria-label','Message to announce on the selected Sonos speaker');announcementText.addEventListener('input',update);
    announcement.append(make('p','Choose a Sonos speaker above, type and review exactly what you want said, then announce. This text uses local speech without an AI model.'),announcementText,button('Announce this message',announce,'voice-conversation-announce'));dialog.append(announcement);
    const settings=make('details'),summary=make('summary','Host voice setup');settings.append(summary,make('p','Install backend/requirements-voice.txt in a Windows Python 3.11+ environment and provide a preinstalled faster-whisper base.en model directory. TLI never downloads speech models. Sonos audio sharing opens a temporary HTTP listener at the chosen host address, limited to generated clips and their enrolled speaker IP; it closes when this session expires.'));
    const model=make('input',null,'voice-conversation-model');model.type='text';model.placeholder='C:\\Models\\faster-whisper-base.en';const modelLabel=make('label','Model directory on the TLI host ');modelLabel.append(model);settings.append(modelLabel);
    const bind=make('select',null,'voice-conversation-bind'),bindLabel=make('label','Media LAN address ');bindLabel.append(bind);settings.append(bindLabel);
    const port=make('input',null,'voice-conversation-port');port.type='number';port.min='1024';port.max='65535';port.value='8766';const portLabel=make('label','Media port ');portLabel.append(port);settings.append(portLabel);
    settings.append(button('Save host settings',save,'voice-conversation-save'),button('Enable Sonos audio sharing',media,'voice-conversation-enable'));dialog.append(settings);
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});document.body.append(dialog);
  }
  function open(){if(state.locked)return;init();state.open=true;state.epoch++;$('voice-conversation-dialog').showModal();refresh();update();}
  function setup(){const input=$('chat-input');if(!input || $('voice-conversation-open'))return;const opener=button('Talk to TLI',open,'voice-conversation-open');opener.title='Push to talk using this TLI host';const mic=$('chat-mic-btn');if(mic)mic.insertAdjacentElement('afterend',opener);else input.parentElement.append(opener);}
  window.TLIVoice={setup,open,stop,close};
  window.addEventListener('tli-session-locked',()=>{state.locked=true;close();});window.addEventListener('tli-session-unlocked',()=>{state.locked=false;});window.addEventListener('pagehide',close);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});document.addEventListener('tli-panel-switched',event=>{if(event.detail?.panelId!=='panel-main')close();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup);else setup();
})();
