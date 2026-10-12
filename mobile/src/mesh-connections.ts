export type ConnectionRow = {id:string;name:string;state:string;detail:string;checkedAt?:string;ready:string[]};
const labels:Record<string,string>={discovered:'Nearby',review_required:'Review required',checking:'Checking',connected:'Connected',unreachable:'Not reachable',identity_changed:'Review required',unknown:'Connection not checked'};
const grants:Record<string,string>={messages:'Messages',observe:'Basic observations',coordinate:'Coordination',inference:'AI sharing'};
/** Display host facts; grants and discovery never manufacture online status. */
export function connectionRows(value:unknown,now=Date.now()):ConnectionRow[]{
  const page=value as any;
  if(page?.protocol!=='tli-connections-v1'||page.schema_version!==1||!Array.isArray(page.peers))throw Error('This host did not return supported connection information.');
  return page.peers.slice(0,512).filter((p:any)=>!p?.previous_discovery).map((p:any)=>{
    const c=p?.connection;
    if(typeof p?.id!=='string'||p.id.length>128||typeof p.name!=='string'||p.name.length>256||c?.protocol!=='tli-connections-v1'||c.schema_version!==1||!Object.hasOwn(labels,c.state))throw Error('The connection list was incomplete. Refresh it from the host.');
    const fresh=c.fresh===true&&c.state==='connected'&&typeof c.expires_at==='string'&&Date.parse(c.expires_at)>now;
    const state=c.state==='connected'&&!fresh?'Connection not checked':c.state==='review_required'&&c.discovery?.seen_recently===true&&p.status==='pending'?'Nearby · needs approval':labels[c.state]!;
    const ready=fresh?Object.entries(grants).filter(([key])=>c.capabilities?.[key]?.state==='ready').map(([,label])=>label):[];
    return {id:p.id,name:p.name,state,ready,checkedAt:typeof c.checked_at==='string'?c.checked_at:undefined,
      detail:typeof c.reason?.message==='string'?c.reason.message.slice(0,1000):fresh?'Verified by your home TLI.':'Trust and saved work are retained; this is not a live connection confirmation.'};
  });
}
