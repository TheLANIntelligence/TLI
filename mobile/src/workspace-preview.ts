// In-memory examples only. This module has no network or filesystem access.
import type { NativeResponse } from './client';
import type { Conversation } from './types';
import type { AppProject } from './builder-model';
import { validSelection,type ConversationSettings } from './workspace-model';
export class PreviewWorkspace {
  private configurations=new Map<string,ConversationSettings>();
  private projects:AppProject[]=[];
  private json(body:unknown,status=200):NativeResponse{return{status,headers:{'content-type':'application/json'},body:JSON.stringify(body)};}
  request(raw:string,method:string,body:Record<string,unknown>,conversations:Conversation[]):NativeResponse|undefined{
    const url=new URL(raw,'https://sample.invalid'),path=url.pathname;
    if((globalThis as any).__TLI_PREVIEW_VERIFY__&&(globalThis as any).__TLI_PREVIEW_HOST_RUNS__){
      const id='run_sample_shared',conversationId='sample-shared-run';
      let conversation=conversations.find(value=>value.id===conversationId);
      if(!conversation){conversation={id:conversationId,title:'Shared sample answer',messages:[{role:'user',content:'A question started on the sample desktop'}]};conversations.unshift(conversation);}
      if(path==='/api/runs/'+id+'/cancel'&&method==='POST')(globalThis as any).__TLI_PREVIEW_RUN_STATE__='cancelled';
      const status=(globalThis as any).__TLI_PREVIEW_RUN_STATE__||'running';
      if(status==='completed')conversation.messages=[{role:'user',content:'A question started on the sample desktop'},{role:'assistant',content:'Saved shared sample answer',model:'Sample model',host:'Sample desktop'}];
      const run={id,request_id:'sample-accepted-request',kind:'chat',status,conversation_id:conversationId,cursor:status==='running'?1:2,events:[],text:status==='completed'?'Saved shared sample answer':'Shared sample answer in progress',metadata:{model:'Sample model',host:'Sample desktop'},...(status==='completed'?{result:{conversation_id:conversationId,reply:'Saved shared sample answer'}}:{})};
      if(path==='/api/runs')return this.json({runs:[run]});
      if(path==='/api/runs/'+id||path==='/api/runs/'+id+'/cancel')return this.json(run);
    }
    if(path==='/api/ai/documents/capabilities')return this.json({ok:true,protocol:'tli-document-questions-v1'});
    if(path==='/api/ai/lan/peers')return this.json({protocol:'tli-peer-inference-v1',peers:[{id:'sample-worker',name:'Sample study computer'}]});
    if(path==='/api/ai/lan/models')return this.json({protocol:'tli-peer-inference-v1',peer:{id:'sample-worker',name:'Sample study computer'},trust_revision:'a'.repeat(64),resources:[{id:'b'.repeat(64),revision:'c'.repeat(64),label:'Sample text model',model_id:'sample-text'}]});
    const config=path.match(/^\/api\/ai\/conversations\/([^/]+)\/settings$/);
    if(config){const id=decodeURIComponent(config[1]!),value=this.configurations.get(id)||{compute_selection:null,settings_revision:0};if(method==='PATCH'){if(body.expected_settings_revision!==value.settings_revision)return this.json({detail:'Sample settings changed. Refresh the conversation.'},409);if(body.compute_selection!==null&&!validSelection(body.compute_selection))return this.json({detail:'Invalid sample selection.'},422);const next={compute_selection:body.compute_selection as any,settings_revision:value.settings_revision+1};this.configurations.set(id,next);return this.json(next);}return this.json(value);}
    if(path==='/api/intelligence/conversation-search'){const query=url.searchParams.get('q')||'',items=conversations.filter(c=>JSON.stringify(c).toLowerCase().includes(query.toLowerCase())).map(c=>({id:c.id,title:c.title,last_updated:c.last_updated,message_count:c.messages?.length||0,snippet:c.messages?.[0]?.content||''}));return this.json({ok:true,protocol:'tli-conversation-search-v1',query,items,next_cursor:null,coverage:{scanned_conversations:conversations.length,owned_conversations:conversations.length}});}
    if(method==='DELETE'&&/^\/conversations\/[^/]+$/.test(path)){const id=decodeURIComponent(path.split('/').pop()!),index=conversations.findIndex(c=>c.id===id);if(index>=0)conversations.splice(index,1);return this.json({ok:true,existed:index>=0});}
    if(path==='/api/builder/web-apps'&&method==='GET')return this.json({projects:this.projects.map(({revisions,...p})=>p)});
    if(path==='/api/builder/web-apps'&&method==='POST'){const project:AppProject={id:'app_'+(this.projects.length+1).toString(16).padStart(16,'0'),name:'Sample counter',brief:String(body.brief),status:'ready_for_preview',revisions:[]};this.revise(project);this.projects.unshift(project);return this.json({project});}
    const app=path.match(/^\/api\/builder\/web-apps\/(app_[a-f0-9]{16})(\/revise)?$/);
    if(app){const project=this.projects.find(p=>p.id===app[1]);if(!project)return this.json({detail:'Sample app unavailable.'},404);if(app[2]){if(body.expected_revision!==project.revisions.length)return this.json({detail:'Sample app changed. Refresh before repair.'},409);this.revise(project);}return this.json({project});}
  }
  private revise(project:AppProject){project.revisions.push({revision:project.revisions.length+1,summary:'An in-memory example counter. No AI model was called.',backend:'Sample only',files:{'index.html':'<button id="count">0</button>','style.css':'button { font-size: 2rem; padding: 1rem; }','app.js':'let n=0; document.querySelector("#count").onclick=e=>e.target.textContent=String(++n);'},checks:[{name:'Counter increments',steps:[]}],manual_checks:['Tap the counter twice and check that it reads 2.'],validation:{checks:['Sample files only']}});}
}
