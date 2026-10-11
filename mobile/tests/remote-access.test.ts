import test from 'node:test';
import assert from 'node:assert/strict';
import { privateNetworkPlan, PRIVATE_NETWORK_LIMIT, PRIVATE_NETWORK_LINKS, PRIVATE_NETWORK_STEPS } from '../src/remote-access';
import { connectionIssue, readConnection } from '../src/connection';
import { Client, type Transport } from '../src/client';
import { validateOrigin } from '../src/protocol';

test('private network plans keep exact existing RFC1918 origin and bound route to one host and port', () => {
  for (const origin of ['https://10.8.0.2:8443','https://172.16.0.2','https://172.31.255.254:65535','https://192.168.50.12:8000']) {
    const plan=privateNetworkPlan(origin);assert.equal(plan.eligible,true);
    if(plan.eligible){assert.equal(plan.origin,validateOrigin(origin));assert.equal(plan.route,new URL(origin).hostname+'/32');assert.equal(plan.port,Number(new URL(origin).port||443));}
  }
});

test('link-local pairing remains supported by LAN policy but cannot yield a remote routing plan', () => {
  assert.equal(validateOrigin('https://169.254.1.2:8000'),'https://169.254.1.2:8000');
  const plan=privateNetworkPlan('https://169.254.1.2:8000');assert.equal(plan.eligible,false);assert.match(plan.reason,/link-local.*existing pairing has not changed/);
});

test('remote guide never widens authority to public, direct tailnet, DNS or URL injection destinations', () => {
  for(const origin of ['https://100.64.0.2:8000','https://100.127.255.254','https://8.8.8.8','https://host.ts.net','http://192.168.1.2','https://192.168.1.2/path','https://user:secret@192.168.1.2','https://[::1]','https://192.168.1.2?x=1','https://192.168.1.2#x'])assert.equal(privateNetworkPlan(origin).eligible,false,origin);
});

test('manual setup is distinct from verified remote acceptance and links are fixed primary documentation', () => {
  assert.match(PRIVATE_NETWORK_LIMIT,/Remote path: not verified.*cannot establish which network/);
  assert.match(PRIVATE_NETWORK_STEPS.join(' '),/outside TLI.*administrator.*No message, command or save is queued/);
  assert.deepEqual(PRIVATE_NETWORK_LINKS.map(v=>new URL(v.url).hostname),['tailscale.com','tailscale.com','www.wireguard.com']);
});

test('network failures do not claim the VPN is missing, the phone is on Wi-Fi or AI is offline', () => {
  for(const code of ['E_NO_ROUTE','E_OFFLINE','E_TIMEOUT','E_NETWORK']){const issue=connectionIssue({code});assert.match(issue.detail,/private-network/);assert.doesNotMatch(issue.detail,/VPN is (?:off|disconnected)|AI is (?:offline|unavailable)/);}
});

test('connection check reads paired identity and preferences without re-pairing, configuration or mutations', async () => {
  const calls:any[]=[];
  const transport:Transport={configure:async()=>{throw Error('Unexpected trust change');},reset:async()=>{throw Error('Unexpected reset');},cancel(){},addListener(){return{remove(){}};},async request(req){calls.push(req);return{status:200,headers:{},body:JSON.stringify(req.path.endsWith('/bootstrap')?{api_version:1,node:{id:'paired-host',name:'Paired host'},capabilities:{vision:false},ai:{status:'unavailable',detail:'No AI confirmed',checked_at:'2026-09-08T12:00:00Z'}}:{theme:'light',favorite_devices:[],favorite_scenes:[]})};}};
  const checked=await readConnection(new Client(transport,'tlic_test'),{node_id:'paired-host'});
  assert.equal(checked.bootstrap.node.id,'paired-host');assert.equal(checked.bootstrap.ai?.status,'unavailable');
  assert.deepEqual(calls.map(c=>[c.method,c.path]),[['GET','/api/companion/v1/bootstrap'],['GET','/api/companion/v1/preferences']]);assert.ok(calls.every(c=>c.headers.Authorization==='Bearer tlic_test'));
  await assert.rejects(readConnection(new Client(transport,'tlic_test'),{node_id:'different-host'}),/does not match/);
});
