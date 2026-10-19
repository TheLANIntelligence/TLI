const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname,'../js',file),'utf8');
const descendants = root => root.children.flatMap(child=>[child,...descendants(child)]);

function fixture() {
  const nodes={},events={},writes=[];
  function element(tag) {
    const node={tag,children:[],dataset:{},handlers:{},hidden:false,textContent:'',
      append(...children){this.children.push(...children);},prepend(...children){this.children.unshift(...children);},
      replaceChildren(...children){this.children=children;},after(...children){body.append(...children);},
      setAttribute(){},querySelector(){return null;},closest(){return null;},
      addEventListener(type,handler){this.handlers[type]=handler;},click(){return this.handlers.click?.();},
      showModal(){this.open=true;},close(){this.open=false;},focus(){}};
    Object.defineProperty(node,'id',{get(){return this._id;},set(id){this._id=id;nodes[id]=this;}});
    return node;
  }
  const body=element('body');
  const document={body,readyState:'complete',activeElement:null,createElement:element,
    getElementById:id=>nodes[id]||null,querySelector:()=>null,querySelectorAll:()=>[],
    addEventListener(type,handler){events[type]=handler;}};
  let stored=JSON.stringify(['homelab','ask']);
  const context=vm.createContext({document,localStorage:{getItem(){return stored;},setItem(key,value){writes.push({key,value});stored=value;}},
    fetch(){assert.fail('Presentation must not request data');},addEventListener(){},
    TLIUI:{navigation:[],icon:()=>element('span'),getPins:()=>[],rootFor:()=>''}});
  context.window=context;
  return {nodes,events,writes,body,context,element,stored:()=>stored,run:file=>vm.runInContext(read(file),context)};
}

test('Home customization hides a saved HomeLab shortcut and retains it when other choices are saved',()=>{
  const f=fixture(),panel=f.element('section'),wrap=f.element('div');
  panel.id='panel-dashboard2';panel.querySelector=selector=>selector==='.nd-wrap'?wrap:null;
  const access=f.element('div');access.id='dashboard-access';f.body.append(panel,access);
  const original=f.stored();f.run('smart-hub.js');
  assert.equal(f.context.TLISmartHub.tasks.some(task=>task.id==='homelab'),false);
  assert.deepEqual(Array.from(f.context.TLISmartHub.normalize(['homelab','ask'])),['ask']);
  assert.equal(f.nodes['home-task-list'].children.length,1);
  assert.equal(f.nodes['home-task-list'].children[0].dataset.homeTask,'ask');
  assert.equal(f.stored(),original);assert.equal(f.writes.length,0);
  descendants(f.body).find(node=>node.textContent==='Edit shortcuts').click();
  const choices=descendants(f.nodes['home-edit-dialog']);
  assert.equal(choices.some(node=>node.value==='homelab'),false);
  assert.equal(choices.some(node=>/HomeLab/.test(node.textContent)),false);
  choices.find(node=>node.textContent==='Save shortcuts').click();
  assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].key,'tli_home_tasks_v1');
  assert.deepEqual(JSON.parse(f.stored()),['ask','homelab']);
});

test('More and Devices directories omit HomeLab even with an older catalogue',()=>{
  const f=fixture(),grids={};
  for(const id of ['panel-devices-home','panel-more']) grids[id]=f.element('div');
  f.context.document.querySelector=selector=>grids[selector.match(/data-destination-grid="([^"]+)"/)?.[1]]||null;
  f.context.TLIUI.navigation=[
    {id:'panel-homelab',label:'HomeLab',icon:'network'},
    {id:'panel-mesh',label:'Computers',icon:'network'},
    {id:'panel-vault',label:'Vault',icon:'lock'},
  ];
  f.run('simplification.js');
  assert.deepEqual(grids['panel-devices-home'].children.map(node=>node.dataset.panelTarget),['panel-mesh']);
  assert.deepEqual(grids['panel-more'].children.map(node=>node.dataset.panelTarget),['panel-vault']);
  assert.equal(f.writes.length,0);
});
