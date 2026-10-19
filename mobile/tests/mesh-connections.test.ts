import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionRows} from '../src/mesh-connections';
const row=(connection:any={},peer:any={})=>({protocol:'tli-connections-v1',schema_version:1,peers:[{id:'peer',name:'Laptop',status:'allowed',...peer,connection:{protocol:'tli-connections-v1',schema_version:1,state:'unknown',...connection}}]});
test('saved grants and discovery do not imply a connected phone tool',()=>{
 assert.equal(connectionRows(row({}, {reviewed_grants:['messages']}))[0]!.state,'Connection not checked');
 assert.equal(connectionRows(row({state:'review_required',discovery:{seen_recently:true}},{status:'pending'}))[0]!.state,'Nearby · needs approval');
 assert.equal(connectionRows(row({state:'connected',fresh:false}))[0]!.state,'Connection not checked');
});
test('phone tools show only freshly verified per-operation readiness',()=>{
 const p=connectionRows(row({state:'connected',fresh:true,expires_at:new Date(Date.now()+90000).toISOString(),ready_grants:['messages','inference'],capabilities:{messages:{state:'ready'},observe:{state:'permission_required'},inference:{state:'no_model'}}}))[0]!;
 assert.equal(p.state,'Connected');assert.deepEqual(p.ready,['Messages']);
 assert.deepEqual(connectionRows(row({state:'unreachable',reason:{message:'Listener refused'},capabilities:{messages:{state:'not_checked'}}}))[0]!.ready,[]);
});
test('expired or missing freshness cannot retain connected or ready labels',()=>{
 const page=row({state:'connected',fresh:true,expires_at:'2026-10-12T12:00:00Z',capabilities:{messages:{state:'ready'}}});
 assert.deepEqual(connectionRows(page,Date.parse('2026-10-12T12:00:01Z'))[0]!.ready,[]);
 assert.equal(connectionRows(page,Date.parse('2026-10-12T12:00:01Z'))[0]!.state,'Connection not checked');
 assert.equal(connectionRows(row({state:'connected',fresh:true}))[0]!.state,'Connection not checked');
});
test('unsupported snapshots fail visibly and previous discoveries stay out of the active roster',()=>{
 assert.throws(()=>connectionRows({peers:[]}));assert.throws(()=>connectionRows(row({state:'online'})));
 assert.deepEqual(connectionRows(row({},{previous_discovery:true})),[]);
});
