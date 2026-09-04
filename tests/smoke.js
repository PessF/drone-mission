#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

class FakeClassList {
  constructor(){ this.values = new Set(); }
  add(...names){ names.forEach(name=>this.values.add(name)); }
  remove(...names){ names.forEach(name=>this.values.delete(name)); }
  toggle(name, force){
    const enabled = force === undefined ? !this.values.has(name) : !!force;
    enabled ? this.values.add(name) : this.values.delete(name);
    return enabled;
  }
  contains(name){ return this.values.has(name); }
}

function createBrowserContext(search=''){
  const elements = new Map();
  const storage = new Map();
  const scheduled = [];
  let clock = 1_000_000;
  const element = id => {
    if(!elements.has(id)) elements.set(id, {
      id, value:'0', textContent:'', innerHTML:'', className:'', disabled:false,
      src:'asset.mp3', style:{}, classList:new FakeClassList(),
      focus(){}, pause(){}, play(){ return Promise.resolve(); }
    });
    return elements.get(id);
  };
  const document = {
    activeElement:{id:''}, body:element('body'), documentElement:{dataset:{}}, visibilityState:'visible',
    getElementById:element,
    addEventListener(){},
  };
  const firebaseDatabase = ()=>({});
  firebaseDatabase.ServerValue = {TIMESTAMP:{'.sv':'timestamp'}};
  const context = {
    console, URL, URLSearchParams, Promise, Math,
    Date:{now:()=>clock},
    document,
    location:{search, pathname:'/index.html', href:'https://example.test/index.html'},
    navigator:{clipboard:{writeText:()=>Promise.resolve()}},
    localStorage:{
      get length(){ return storage.size; },
      getItem:key=>storage.has(key)?storage.get(key):null,
      setItem:(key,value)=>storage.set(key,String(value)),
      removeItem:key=>storage.delete(key),
      key:index=>[...storage.keys()][index]??null
    },
    firebase:{database:firebaseDatabase},
    window:{addEventListener(){}, open(){}},
    confirm:()=>true,
    setTimeout(fn){ scheduled.push(fn); return scheduled.length; },
    clearTimeout(){}, setInterval(){ return 1; }, clearInterval(){},
    requestAnimationFrame(){ return 1; }, cancelAnimationFrame(){},
  };
  context.globalThis = context;
  vm.createContext(context);
  return {context, elements, element, scheduled, storage, advance(ms){ clock += ms; }};
}

function inlineScripts(file){
  const html = fs.readFileSync(path.join(root,file),'utf8');
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match=>match[1]).filter(script=>script.trim());
}

function loadMainScript(file, browser){
  const scripts = inlineScripts(file);
  vm.runInContext(scripts.at(-1), browser.context, {filename:file});
}

async function flushPromises(){
  await new Promise(resolve=>setImmediate(resolve));
}

async function testController(){
  const browser = createBrowserContext();
  browser.element('scoreAuto').value = '0';
  browser.element('scoreManual').value = '0';
  loadMainScript('index.html', browser);

  assert.equal(browser.context.clamp50(-3), 0);
  assert.equal(browser.context.clamp50(87), 50);
  assert.equal(browser.context.formatMissionTime(61_230), '01:01.23');

  browser.element('scoreAuto').value = '81';
  browser.element('scoreManual').value = '-4';
  browser.context.normalizeScoreInputs();
  assert.equal(browser.element('scoreAuto').value, 50);
  assert.equal(browser.element('scoreManual').value, 0);
  assert.equal(browser.element('scoreTotal').textContent, 50);

  vm.runInContext("phase='done'; doneReason='completed'; running=false; remainingMs=123000; autonomousTimeMs=1000; manualTimeMs=2000", browser.context);
  browser.context.toggleMissionStamp('manual');
  assert.equal(vm.runInContext('phase', browser.context), 'match');
  assert.equal(vm.runInContext('running', browser.context), false);
  assert.equal(vm.runInContext('manualTimeMs', browser.context), null);
  assert.equal(vm.runInContext('autonomousTimeMs', browser.context), 1000);

  vm.runInContext("roomRef=null; phase='idle'; running=false", browser.context);
  browser.context.startCountdown321();
  assert.equal(vm.runInContext('countdownValue', browser.context), 3);
  browser.advance(1001);
  browser.context.syncCountdown();
  assert.equal(vm.runInContext('countdownValue', browser.context), 2);
  browser.advance(2000);
  browser.context.syncCountdown();
  assert.equal(vm.runInContext('phase', browser.context), 'match');
  assert.equal(vm.runInContext('running', browser.context), true);

  const writes = [];
  const updates = [];
  const fakeRoomRef = {
    update(value){ updates.push(value); return Promise.resolve(); },
    child(key){
      return {
        set(value){ writes.push([key,value]); return Promise.resolve(); },
        once(){
          return Promise.resolve({val:()=>key.includes('teams_rounds') && key.includes('round1') ? {autonomousScore:12,manualScore:23,clientSubmittedAt:1} : null});
        },
        push(){ return {key:'revision-1'}; }
      };
    }
  };
  browser.context.testRoomRef = fakeRoomRef;
  vm.runInContext("roomRef=testRoomRef; phase='idle'; teamName=''; activeDataTeam=''", browser.context);
  browser.context.onTeamNameInput('Bravo');
  browser.scheduled.at(-1)();
  await flushPromises();
  assert.equal(updates[0].team.name, 'Bravo');
  assert.equal(browser.element('scoreAuto').value, 12);
  assert.equal(browser.element('scoreManual').value, 23);

  const flattened = browser.context.flattenAllRounds({
    alpha:{round1:{team:'Alpha',autonomousScore:10,manualScore:20,clientSubmittedAt:1}},
    bravo:{round1:{team:'Bravo',autonomousScore:30,manualScore:40,clientSubmittedAt:2},round2:{team:'Bravo',autonomousScore:31,manualScore:41,clientSubmittedAt:3}}
  });
  assert.deepEqual(JSON.parse(JSON.stringify(flattened.map(row=>[row.team,row.round]))), [['Alpha',1],['Bravo',1],['Bravo',2]]);

  const deduped = browser.context.flattenAllRounds({
    legacy:{round1:{team:'Same Team',autonomousScore:1,manualScore:2,clientSubmittedAt:1}},
    current:{round1:{team:'same  team',autonomousScore:40,manualScore:41,clientSubmittedAt:2}}
  });
  assert.equal(deduped.length,1);
  assert.equal(deduped[0].autonomousScore,40);
  assert.equal(deduped[0]._sourceKeys.length,2);
  assert.notEqual(browser.context.teamStorageKey('A.B'),browser.context.teamStorageKey('A#B'));

  vm.runInContext("phase='idle'; teamName='Bravo'; activeDataTeam='Bravo'; curRound=1; loadedRoundSnapshot={team:'Bravo',round:1,autonomousTimeMs:1234,manualTimeMs:5678,matchTimeUsedMs:5678,completionStatus:'completed'}",browser.context);
  const preserved=browser.context.buildDraft('Bravo',1);
  assert.equal(preserved.autonomousTimeMs,1234);
  assert.equal(preserved.manualTimeMs,5678);
  assert.equal(preserved.matchTimeUsedMs,5678);

  updates.length=0;
  browser.element('scoreAuto').value='22';
  browser.element('scoreManual').value='33';
  vm.runInContext("teamName='Bravo'; activeDataTeam='Bravo'; curRound=1; phase='done'; doneReason='completed'; autonomousTimeMs=1000; manualTimeMs=2000",browser.context);
  browser.context.saveRound();
  await flushPromises();
  const finalSave=updates.at(-1);
  assert.ok(Object.keys(finalSave).some(key=>key.startsWith('teams_rounds/')&&key.endsWith('/round1')));
  assert.ok(Object.keys(finalSave).some(key=>key.startsWith('record_history/')));
  assert.ok(Object.entries(finalSave).some(([key,value])=>key.startsWith('drafts/')&&value===null));

  vm.runInContext("roomRef=null; myRoom='1234'; teamName='Offline Team'; activeDataTeam='Offline Team'; curRound=2; phase='idle'",browser.context);
  browser.element('scoreAuto').value='17';
  browser.element('scoreManual').value='29';
  browser.context.onScoreInput();
  browser.element('scoreAuto').value='0';
  browser.element('scoreManual').value='0';
  browser.context.loadRoundIntoInputs(2);
  assert.equal(browser.element('scoreAuto').value,17);
  assert.equal(browser.element('scoreManual').value,29);
}

function testDisplay(){
  const browser = createBrowserContext('?room=12ab');
  loadMainScript('display.html', browser);
  assert.equal(browser.context.getRoomFromUrl(), null);
  browser.context.location.search = '?room=1234';
  assert.equal(browser.context.getRoomFromUrl(), '1234');

  browser.context.whistles = 0;
  vm.runInContext('playWhistleSound=()=>{ whistles++ }', browser.context);
  browser.context.handleTimer({phase:'countdown',countdownValue:3,remainingMs:0,running:false,round:1});
  browser.context.handleTimer({phase:'match',remainingMs:480000,running:false,round:1});
  assert.equal(browser.context.whistles, 1, 'countdown-to-match race should still whistle once');

  browser.context.handleTimer({phase:'idle',remainingMs:120000,running:false,round:1});
  browser.context.handleTimer({phase:'countdown',countdownValue:0,remainingMs:0,running:false,round:1});
  browser.context.handleTimer({phase:'match',remainingMs:480000,running:false,round:1});
  assert.equal(browser.context.whistles, 2, 'delivered GO packet must not cause a duplicate whistle');
}

function testDocumentIntegrity(){
  for(const file of ['index.html','display.html']){
    const html = fs.readFileSync(path.join(root,file),'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
    assert.equal(new Set(ids).size, ids.length, `${file} contains duplicate element IDs`);
    for(const match of html.matchAll(/(?:src|href)="((?!https?:|#|data:)[^"]+)"/g)){
      assert.ok(fs.existsSync(path.join(root,match[1].split(/[?#]/)[0])), `${file} is missing ${match[1]}`);
    }
    for(const [index,script] of inlineScripts(file).entries()){
      assert.doesNotThrow(()=>new Function(script), `${file} inline script ${index+1} has invalid syntax`);
    }
  }
}

(async()=>{
  testDocumentIntegrity();
  await testController();
  testDisplay();
  console.log('Smoke tests passed');
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
