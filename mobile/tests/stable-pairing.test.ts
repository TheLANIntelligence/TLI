import assert from 'node:assert/strict';
import test from 'node:test';
import { configurePairing } from '../src/paired-transport';
import { parsePairingCode } from '../src/protocol';
import { Client, type Transport, type NativeRequest } from '../src/client';
import { PairingReplacement, loadSavedPairing, savePairing, type PairingStore } from '../src/pairing-recovery';
import type { Pairing } from '../src/types';

const old:Pairing={version:1,origin:'https://192.168.1.12:8443',certificate_der:'A'.repeat(256),node_id:'home',node_name:'Home',device_id:'phone-one',owner_id:'owner-one',credential:'tlic_'+ 's'.repeat(40)};
const stable:Pairing={...old,version:2,origin:'https://tli-home.local:8443',public_key:'f'.repeat(64)};
const code=()=>JSON.stringify({...stable,token:'t'.repeat(32),expires_at:Date.now()/1000+300});
function harness(){
 const order:string[]=[],requests:NativeRequest[]=[],configurations:unknown[]=[];
 const transport:Transport={
  async discover(){order.push('discover');return [{origin:stable.origin,nodeId:stable.node_id,name:'Hint',addresses:['192.168.1.33']},{origin:'https://hostile.local:8443',nodeId:stable.node_id,name:'Other',addresses:['192.168.1.99']}];},
  async probeConnection(options){order.push('probe');assert.deepEqual(options.resolvedAddresses,['192.168.1.33']);return {verified:true,origin:options.origin,nodeId:options.nodeId,publicKey:options.publicKey,certificateSha256:'b'.repeat(64),resolvedAddresses:['192.168.1.33']};},
  async configure(options){order.push('configure');configurations.push(options);},
  async request(options){requests.push(options);order.push(options.path);return {status:200,headers:{},body:JSON.stringify(options.path.endsWith('/upgrade')?{node:{id:stable.node_id,name:'Home'},owner_id:old.owner_id,device_id:old.device_id,credential_retained:true}:options.path.endsWith('/bootstrap')?{api_version:1,node:{id:stable.node_id,name:'Home'},capabilities:{vision:false},chat:{path:'/chat',streaming:false}}:{favorite_devices:[],favorite_scenes:[],theme:'system'})};},
  async reset(){},cancel(){},addListener(){return {remove(){}};}
 };
 const values=new Map<string,string>();const store:PairingStore={async get(k){return values.get(k)??null;},async set(k,v){values.set(k,v);},async remove(k){values.delete(k);}};
 return {transport,order,requests,configurations,store};
}
test('reviewed v2 names require signed identity material; old IP codes remain valid',()=>{
 assert.equal(parsePairingCode(code()).origin,stable.origin);
 assert.equal(parsePairingCode(JSON.stringify({...JSON.parse(code()),origin:'https://tli-home.local'})).origin,'https://tli-home.local:443');
 assert.throws(()=>parsePairingCode(JSON.stringify({...JSON.parse(code()),public_key:undefined})));
 assert.throws(()=>parsePairingCode(JSON.stringify({...JSON.parse(code()),version:1})));
 const fields=new URLSearchParams({v:'2',k:stable.public_key!,c:stable.certificate_der,t:'t'.repeat(32),e:String(Math.floor(Date.now()/1000)+300),i:stable.node_id,n:stable.node_name});
 assert.equal(parsePairingCode(stable.origin+'/api/companion/v1/pair#'+fields).public_key,stable.public_key);
});
test('new DHCP hints need a native proof before transport activation',async()=>{
 const h=harness();await configurePairing(h.transport,stable);
 assert.deepEqual(h.order,['discover','probe','configure']);assert.deepEqual((h.configurations[0] as any).resolvedAddresses,['192.168.1.33']);
 const bad=harness();bad.transport.probeConnection=async options=>({verified:true,...options,nodeId:'wrong-host',certificateSha256:'b'.repeat(64),resolvedAddresses:[]});
 await assert.rejects(configurePairing(bad.transport,stable),(error:any)=>error.code==='E_IDENTITY' && /reviewed TLI identity/.test(error.message));assert.equal(bad.configurations.length,0);assert.equal(bad.requests.length,0);
});
test('reviewed stable-name upgrade preserves protected credential and sends it only after proof',async()=>{
 const h=harness();await savePairing(h.store,old);
 const result=await new PairingReplacement().run({raw:code(),name:'Phone',platform:'android',transport:h.transport,store:h.store,previous:old,previousClient:new Client(h.transport,old.credential),isCurrent:()=>true});
 assert.equal(result.pairing.credential,old.credential);assert.equal((await loadSavedPairing(h.store))?.origin,stable.origin);
 assert.deepEqual(h.order.slice(0,4),['discover','probe','configure','/api/companion/v1/pairings/upgrade']);
 assert.equal(h.requests[0]?.headers.Authorization,'Bearer '+old.credential);assert.equal(h.requests.some(r=>r.path.endsWith('/redeem')),false);
});
test('a changed signed identity never receives the old phone credential',async()=>{
 const h=harness();await savePairing(h.store,old);
 h.transport.probeConnection=async()=>{throw Object.assign(new Error('Identity proof rejected'),{code:'E_TLS_TRUST'});};
 await assert.rejects(new PairingReplacement().run({raw:code(),name:'Phone',platform:'android',transport:h.transport,store:h.store,previous:old,previousClient:new Client(h.transport,old.credential),isCurrent:()=>true}));
 assert.equal(h.requests.length,0);assert.deepEqual(await loadSavedPairing(h.store),old);
});

test('dead-first and hostile routes do not hide a valid reviewed identity',async()=>{
 const h=harness(),attempts:string[]=[];
 h.transport.discover=async()=>[
  {origin:'not a URL',nodeId:stable.node_id,name:'Malformed',addresses:['192.168.1.90']},
  {origin:stable.origin,nodeId:stable.node_id,name:'Hint',addresses:['192.168.1.31','192.168.1.32','192.168.1.33']},
 ];
 const original=h.transport.probeConnection!;
 h.transport.probeConnection=async options=>{
  const address=options.resolvedAddresses![0]!;attempts.push(address);
  if(address.endsWith('.31'))throw Object.assign(new Error('dead'),{code:'E_TIMEOUT'});
  if(address.endsWith('.32'))throw Object.assign(new Error('wrong cert'),{code:'E_TLS_TRUST'});
  return original(options);
 };
 await configurePairing(h.transport,stable);
 assert.deepEqual(attempts,['192.168.1.31','192.168.1.32','192.168.1.33']);assert.equal(h.configurations.length,1);assert.equal(h.requests.length,0);
 attempts.length=0;await configurePairing(h.transport,stable);assert.deepEqual(attempts,['192.168.1.33']);
});

test('bounded DNS fallback works without multicast and filters public routes',async()=>{
 const h=harness();h.transport.discover=async()=>{throw Error('multicast blocked');};
 h.transport.resolveConnection=async options=>{assert.equal(options.origin,stable.origin);return ['8.8.8.8','127.0.0.1','192.168.1.33'];};
 await configurePairing(h.transport,stable);assert.equal(h.configurations.length,1);assert.equal(h.requests.length,0);
});
test('a full batch of untrusted advertisements cannot displace the DNS fallback',async()=>{
 const h=harness();h.transport.discover=async()=>[{origin:stable.origin,nodeId:stable.node_id,name:'Hint',addresses:Array.from({length:8},(_,i)=>'192.168.1.'+(i+40))}];
 h.transport.resolveConnection=async()=>['192.168.1.33'];
 await configurePairing(h.transport,stable);assert.equal(h.configurations.length,1);assert.equal(h.requests.length,0);
});

test('cancelled candidate verification never tries another route or configures',async()=>{
 const h=harness();h.transport.resolveConnection=async()=>['192.168.1.34'];let calls=0;
 h.transport.probeConnection=async()=>{calls++;throw Object.assign(new Error('cancelled'),{code:'E_CANCELLED'});};
 await assert.rejects(configurePairing(h.transport,stable));assert.equal(calls,1);assert.equal(h.configurations.length,0);
});

test('proof cannot activate an address other than the attempted socket',async()=>{
 const h=harness();h.transport.probeConnection=async options=>({verified:true,...options,certificateSha256:'b'.repeat(64),resolvedAddresses:['192.168.1.99']});
 await assert.rejects(configurePairing(h.transport,stable),(error:any)=>error.code==='E_IDENTITY');assert.equal(h.configurations.length,0);
});
