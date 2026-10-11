const test=require('node:test'),assert=require('node:assert/strict');
const {guide,draftText,bounded,templates}=require('../js/workflow-assistant.js');
const {validate}=require('../js/case-guides.js');
for(const kind of Object.keys(templates))test(kind+' prepares only an unsaved, valid guide with no target authority',()=>{
  const value=guide(kind,'Selected folder: C:\\Example\\[keep] & <safe>','First attempt failed.\nThe old result remains.');
  assert.deepEqual(validate(value),value);
  assert.equal(value.steps.length,3);
  assert.deepEqual(Object.keys(value).sort(),['format','steps','symptom','title','version']);
  assert.match(value.symptom,/C:\\Example\\\[keep\] & <safe>/);
  assert.match(value.symptom,/not a fresh observation/);
  assert.ok(value.steps.every(step=>typeof step==='string'));
});
test('exact folder starter is quoted as data and contains no generated shell command',()=>{
  const root='C:\\My photos\\$(anything) & quote"';
  const text=draftText('backup',root);
  assert.ok(text.endsWith(JSON.stringify(root)));
  assert.match(text,/dry-run plan/);assert.match(text,/Do not execute anything/);
  assert.match(draftText('inventory',root),/Do not recurse, modify files/);
});
test('unknown, multiline and oversized targets are refused, never silently truncated',()=>{
  for(const value of ['C:\\x\nC:\\y','x'.repeat(2049),{},'\u0000'])assert.throws(()=>bounded(value));
  assert.throws(()=>guide('missing'));
  assert.throws(()=>draftText('missing'));
  assert.throws(()=>guide('folder','','x'.repeat(1001)));
});
test('long exact context remains valid within guide limits',()=>{
  const context='Selected folder: C:\\'+ 'x'.repeat(2028),symptom='y'.repeat(1000);
  const value=guide('folder',context,symptom);assert.deepEqual(validate(value),value);assert.ok(value.symptom.includes(context));
});
test('guides and starters are independent copies and do not imply completed work',()=>{
  const first=guide('game');first.steps[0]='changed';assert.notEqual(guide('game').steps[0],'changed');
  assert.match(draftText('inspect'),/do not edit files, install dependencies or execute commands/);
  assert.match(guide('routine').steps[0],/partial or uncertain/);
});
