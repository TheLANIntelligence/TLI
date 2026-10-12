import { ApiError,type Client } from './client';
import { transientRunRead,watchHostRun } from './host-runs';
import { settings,terminalRun,validateRun,type ConversationSettings,type HostRun } from './workspace-model';
import type { Conversation } from './types';

type Options={current:()=>boolean;ready:()=>boolean;sharedSettings:boolean;context:(conversation:Conversation|undefined,configuration:ConversationSettings|null,run:HostRun)=>void;update:(run:HostRun)=>void;reconcile:(conversation:Conversation)=>void;sleep?:(ms:number)=>Promise<void>};
/** Attach only by owner-scoped reads. A transient read waits for the reviewed
 * connection to return; trust failures and missing runs require explicit review. */
export async function followChatRun(api:Pick<Client,'json'>,id:string,options:Options):Promise<HostRun>{
  const sleep=options.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
  const stale=()=>new Error('The workspace changed. Review saved work before attaching again.');
  async function read<T>(path:string):Promise<T>{
    while(options.current()){
      if(!options.ready()){await sleep(500);continue;}
      try{const value=await api.json<T>(path);if(!options.current())throw stale();if(!options.ready())continue;return value;}
      catch(error){if(!options.current())throw stale();if(transientRunRead(error)){await sleep(500);continue;}if(error instanceof ApiError&&error.status===404)throw new Error('This saved run or conversation is no longer available. Review conversation history before trying again; nothing was resent.');throw error;}
    }
    throw stale();
  }
  const initial=validateRun(await read('/api/runs/'+encodeURIComponent(id)),id);
  if(initial.kind!=='chat')throw new Error('This saved work is an app generation. Open it from Builder.');
  const path=initial.conversation_id?'/api/ai/conversations/'+encodeURIComponent(initial.conversation_id):null;
  const conversation=path?await read<Conversation>(path):undefined;
  const configuration=path&&options.sharedSettings?settings(await read(path+'/settings')):null;
  if(!options.current()||!options.ready())throw stale();
  options.context(conversation,configuration,initial);
  const result=terminalRun(initial)?initial:await watchHostRun(api,initial.id,{initial,current:options.current,foreground:options.ready,update:options.update,sleep});
  if(terminalRun(initial))options.update(initial);
  if(result.status==='completed'&&result.conversation_id){const saved=await read<Conversation>('/api/ai/conversations/'+encodeURIComponent(result.conversation_id));if(options.current()&&options.ready())options.reconcile(saved);}
  return result;
}
