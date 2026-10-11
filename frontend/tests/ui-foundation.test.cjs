const test=require('node:test');
const assert=require('node:assert/strict');
const {render,safeLink}=require('../js/chat-format.js');
const {dashboard,observation,meshNode,percent}=require('../js/ui-health.js');
test('model citation-shaped links remain plain text during streaming and in history',()=>{
 const html=render('Claim [N1](https://evil.example). [manual.txt:L1-L3](/action/run). [Guide](https://example.com).');
 assert.doesNotMatch(html,/evil.example|href="\/action/);
 assert.match(html,/\[N1\]/); assert.match(html,/\[manual.txt:L1-L3\]/);
 assert.match(html,/href="https:\/\/example.com"/);
});
test('AI readiness and observed system health remain separate',()=>{
 const now=1000000,state={probed_ts:1000,cpu_pct:18,ram_pct:43};
 assert.equal(dashboard({aiOk:true,lmOnline:false},now).orb,'idle');
 const noAi=dashboard({aiOk:false,lmOnline:false,state},now);
 assert.equal(noAi.orb,'good');assert.equal(noAi.aiReady,false);assert.equal(noAi.aiLabel,'Unavailable');
 assert.equal(noAi.observed.freshness,'fresh');assert.equal(noAi.observed.stamp,now);
 assert.equal(dashboard({aiOk:false,lmOnline:false,health:{level:'good'}},now).orb,'idle','An unsupported health assertion cannot replace a probe');
 assert.equal(dashboard({aiOk:true,state,activeAlerts:[{severity:'critical'}]},now).orb,'warn');
 assert.equal(dashboard({},now).aiLabel,'Unknown');
 assert.equal(dashboard({aiOk:false},now).aiLabel,'Unknown','An unchecked alternate provider stays unknown');
 assert.equal(dashboard({lmOnline:true,state},now).aiLabel,'LM Studio');
});

test('observation expires at thirty seconds and cannot turn missing metrics into healthy zeros',()=>{
 const state={probed_ts:1000,cpu_pct:0,ram_pct:0};
 assert.equal(observation({state},1029999).freshness,'fresh');
 assert.equal(observation({state},1030000).freshness,'stale');
 assert.equal(observation({state},1030001).freshness,'stale');
 assert.equal(observation({state:{...state,cpu_pct:null}},1000000).freshness,'incomplete');
 assert.equal(observation({state:{...state,ram_pct:-1}},1000000).freshness,'incomplete');
 assert.equal(observation({state:{cpu_pct:50,ram_pct:30}},1000000).freshness,'unknown');
 assert.equal(observation({state},990000).freshness,'unknown','A future timestamp does not establish current health');
 for(const value of [null,undefined,NaN,Infinity,-1,101,'0','50%'])assert.equal(percent(value),null);
 assert.equal(percent(0),0);assert.equal(percent(100),100);
});

test('invalid probe timestamps stay unknown without an invalid displayed time',()=>{
 for(const probed_ts of [null,undefined,0,-1,NaN,Infinity,'1000']){
  const facts=observation({state:{probed_ts,cpu_pct:20,ram_pct:30}},1000000);
  assert.equal(facts.freshness,'unknown');assert.equal(facts.stamp,null);
 }
});

test('shared provider policy wins over old Dashboard model flags without changing system health',()=>{
 const input={aiOk:true,lmOnline:false,state:{probed_ts:1000,cpu_pct:18,ram_pct:43},aiSource:{text:'AI: Not confirmed',state:'warn',title:'LAN-only AI is selected.'}};
 const facts=dashboard(input,1000000);
 assert.equal(facts.aiLabel,'Not confirmed');assert.equal(facts.aiReady,false);assert.equal(facts.aiDetail,'LAN-only AI is selected.');assert.equal(facts.orb,'good');
 input.aiSource={text:'AI: Mesh',state:'ok',title:'Available on Office'};
 assert.equal(dashboard(input,1000000).aiLabel,'Mesh');assert.equal(dashboard(input,1000000).aiReady,true);
});

test('invalid shared clock age remains unknown even when browser time happens to match the probe',()=>{
 const data={state:{probed_ts:1000,cpu_pct:10,ram_pct:20},observationClock:{receivedAt:1000000,ageAtReceipt:null}};
 assert.equal(observation(data,1000000).freshness,'unknown');
});

test('monitoring failures only claim retained results when a previous probe exists',()=>{
 assert.match(observation({monitoringUnavailable:true},1000000).label,/no successful readings yet/);
 assert.doesNotMatch(observation({monitoringUnavailable:true},1000000).label,/retained/);
 assert.match(observation({monitoringUnavailable:true,state:{probed_ts:999,cpu_pct:20,ram_pct:40}},1000000).label,/previous results retained/);
});

test('mesh nodes preserve unknown availability, AI readiness and invalid resource readings',()=>{
 assert.deepEqual(meshNode(),{availability:'Status unknown',ai:'AI status unknown',cpu:null,ram:null});
 assert.deepEqual(meshNode({online:true,ai_healthy:false,cpu_percent:0,ram_percent:100}),{availability:'Reported online',ai:'AI unavailable',cpu:0,ram:100});
 const failed=meshNode({online:true,error:'read failed',has_ai:true,cpu_percent:'0',ram_percent:NaN});
 assert.equal(failed.availability,'Status unknown');assert.equal(failed.ai,'AI status unknown');
 assert.equal(failed.cpu,null);assert.equal(failed.ram,null);
 assert.equal(meshNode({online:false,ai_healthy:false}).availability,'Not reachable');
 assert.equal(meshNode({ai_healthy:true}).ai,'AI ready');
});

test('tables use semantic cells and preserve escaped text',()=>{
 const html=render('| Drive | Free |\n| --- | ---: |\n| C: | **12 GB** |\n| D: | <img src=x onerror=alert(1)> |');
 assert.match(html,/<th scope="col">Drive<\/th>/);assert.match(html,/<strong>12 GB<\/strong>/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/aria-label="Answer table"/);
});
test('partial fenced streams are escaped and converge on the same complete rendering',()=>{
 const text='```html\n<script>alert("test")</script>\n```\n\nFinished.';
 for(let i=1;i<=text.length;i++){const partial=render(text.slice(0,i));assert.doesNotMatch(partial,/<script|<img|<iframe/i);}
 const html=render(text);assert.match(html,/&lt;script&gt;/);assert.match(html,/<p>Finished\.<\/p>/);assert.doesNotMatch(render('`**literal**`'),/<strong>/);
});
test('links reject executable schemes and cannot inject attributes',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,test','//external.test','java\nscript:test','file:///private'])assert.equal(safeLink(value),null);
 const html=render('[unsafe](javascript:alert(1)) [safe](https://example.invalid/"onmouseover="x) <svg onload=x>');
 assert.doesNotMatch(html,/href="javascript:|<svg|"onmouseover="/);assert.match(html,/&quot;onmouseover=&quot;/);
 assert.match(render('[Help](/manual.html)'),/href="\/manual.html"/);
});
test('ordinary headings, paragraphs, lists, quotes and literal paths remain readable',()=>{
 const html=render('## Steps\n\n1. Open **Files**\n2. Review `C:\\Demo`\n\n> Check the paths\n\nA & B');
 assert.match(html,/<h2>Steps<\/h2>/);assert.match(html,/<ol>/);assert.match(html,/<code>C:\\Demo<\/code>/);assert.match(html,/<blockquote>/);assert.match(html,/A &amp; B/);
});
