import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parsePairingCode } from '../src/protocol';

const source = readFileSync(resolve(__dirname, '../../frontend/js/companion-pair-link.js'), 'utf8');
const now = 1_900_000_000_000;
const fragment = new URLSearchParams({v:'1',c:'A'.repeat(256),t:'b'.repeat(43),e:String(now/1000+300),i:'node-a',n:'Test <host>'}).toString();
function landing(hash=fragment, query='') {
  let href = 'https://192.168.1.2:8000/api/companion/v1/pair' + query + '#' + hash;
  const opened: string[] = [], callbacks: Record<string, () => void> = {}, timers: (() => void)[] = [];
  const elements = new Map<string, any>();
  for(const id of ['pair-link-status','pair-link-host','pair-open-beta','pair-open-app'])elements.set(id,{textContent:'',disabled:true,addEventListener(type:string,callback:()=>void){this[type]=callback;}});
  const location = {get href(){return href;},set href(value:string){opened.push(value);},get pathname(){return new URL(href).pathname;}};
  const history = {replaceState(_state:unknown,_title:string,path:string){href=new URL(path,href).href;}};
  runInNewContext(source, {URL, URLSearchParams, location, history, Date:{now:()=>now}, setTimeout:(callback:()=>void)=>timers.push(callback), clearTimeout:()=>undefined, document:{addEventListener:(event:string,callback:()=>void)=>callbacks[event]=callback,getElementById:(id:string)=>elements.get(id)},window:{addEventListener:(event:string,callback:()=>void)=>callbacks[event]=callback}});
  callbacks.DOMContentLoaded!();
  return {elements,opened,callbacks,timers,get href(){return href;},newHash(hash:string){href='https://192.168.1.2:8000/api/companion/v1/pair#'+hash;callbacks.hashchange!();}};
}
test('landing scrubs browser history, makes no automatic opener, and passes the same invitation only on explicit tap',()=>{
  const page=landing();
  assert.equal(page.href,'https://192.168.1.2:8000/api/companion/v1/pair');
  assert.deepEqual(page.opened,[]);
  assert.equal(page.elements.get('pair-open-beta').disabled,false);
  assert.equal(page.elements.get('pair-link-host').textContent,'Test <host> · https://192.168.1.2:8000');
  page.elements.get('pair-open-beta').click();
  assert.equal(page.opened.length,1);assert.match(page.opened[0]!,/^tli-companion-beta:\/\/\/pair#/);
  assert.equal(parsePairingCode(page.opened[0]!,now).node_name,'Test <host>');
  assert.equal(parsePairingCode(page.opened[0]!,now).origin,'https://192.168.1.2:8000');
  page.elements.get('pair-open-app').click();assert.match(page.opened[1]!,/^tli-companion:\/\/\/pair#/);
});
test('landing rejects query/duplicate/expired input with disabled actions and safe generic feedback',()=>{
  for(const page of [landing(fragment,'?secret=wrong'),landing(fragment+'&t=duplicate'),landing(fragment.replace(String(now/1000+300),'1')),landing('bad%ZZ'),landing('')]){
    assert.equal(page.elements.get('pair-open-beta').disabled,true);assert.equal(page.elements.get('pair-open-app').disabled,true);
    assert.match(page.elements.get('pair-link-status').textContent,/invalid|expired/);
    assert.equal(page.href.includes('#'),false);assert.deepEqual(page.opened,[]);
  }
});
test('leaving the page or expiry clears its ephemeral invitation and cannot reopen it',()=>{
  for(const exit of ['pagehide','expiry']){
    const page=landing();if(exit==='pagehide')page.callbacks.pagehide!();else page.timers[0]!();
    assert.equal(page.elements.get('pair-open-beta').disabled,true);page.elements.get('pair-open-beta').click();
    assert.deepEqual(page.opened,[]);assert.equal(page.elements.get('pair-link-host').textContent,'');
  }
});
test('a reused camera browser tab replaces its pending invitation and scrubs the new fragment',()=>{
  const page=landing();page.newHash(fragment+'&t=duplicate');assert.equal(page.elements.get('pair-open-beta').disabled,true);
  page.newHash(fragment.replace('node-a','node-new'));assert.equal(page.elements.get('pair-open-beta').disabled,false);assert.equal(page.href.includes('#'),false);
  page.elements.get('pair-open-beta').click();assert.equal(parsePairingCode(page.opened[0]!,now).node_id,'node-new');
});
