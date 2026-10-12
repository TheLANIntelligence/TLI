import { ApiError,isConnectionError,type Client } from './client';
import { terminalRun,validateRun,type HostRun } from './workspace-model';
export function transientRunRead(error:unknown){const code=(error as any)?.code;return !['E_TLS_TRUST','E_CERTIFICATE','E_IDENTITY','E_LOCAL_NETWORK_PERMISSION'].includes(code)&&(isConnectionError(error)||code==='E_CANCELLED'||code==='E_PAUSED');}
export async function watchHostRun(api:Pick<Client,'json'>,id:string,options:{current:()=>boolean;foreground:()=>boolean;update:(run:HostRun)=>void;sleep?:(ms:number)=>Promise<void>;initial?:HostRun}):Promise<HostRun>{
  const sleep=options.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));let run=options.initial,cursor=0;
  while(options.current()){
    if(!options.foreground()){await sleep(500);continue;}
    try{
      run=run||validateRun(await api.json('/api/runs/'+encodeURIComponent(id)+'?after='+cursor),id);
      if(!options.current())break;
      if(!options.foreground()){run=undefined;continue;}
      cursor=run.cursor;options.update(run);
      if(terminalRun(run))return run;
      run=undefined;await sleep(1000);
    }catch(error){
      if(!options.current())break;
      const code=(error as any)?.code;
      if(['E_TLS_TRUST','E_CERTIFICATE','E_IDENTITY','E_LOCAL_NETWORK_PERMISSION'].includes(code))throw error;
      if(transientRunRead(error)||!options.foreground()){run=undefined;await sleep(1500);continue;}
      if(error instanceof ApiError&&error.status===404)throw new Error('The host has no accepted run with this ID. Your request was not automatically resent; review history before trying again.');
      throw error;
    }
  }
  throw new Error('The workspace changed. Reopen the saved conversation to review the host result.');
}
