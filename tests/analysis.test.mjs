import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_ANALYSIS_INSTRUCTIONS,analysisPrompt,analysisSettings,analysisGuide,analysisSchema,MAX_SCENES} from '../lib/analysis.mjs';
import {validateScenes,composePrompt} from '../lib/core.mjs';
import {narrationText,splitNarration,mergeNarration,syncContinuations} from '../lib/narration.mjs';

const shot=(sourceText,continuation=false,camera='바스트샷')=>({sourceText,continuation,camera,prompt:`ONE frame, ${camera}`,characterIds:[]});
test('analysis defaults ask for visual beats and camera coverage; custom instructions keep the narration contract',()=>{
 const p={script:'민지가 문을 열고 말했다. 준호는 깜짝 놀랐다.',constraints:'자막 없음',characters:[]};
 const prompt=analysisPrompt(p);
 assert.equal(analysisSettings(p).density,'dynamic');assert.ok(prompt.includes(DEFAULT_ANALYSIS_INSTRUCTIONS));
 for(const technique of ['풀샷','바스트샷','클로즈업','오버더숄더','숏/리버스숏','리액션샷','로우앵글','POV','인서트','180도'])assert.ok(prompt.includes(technique),technique);
 assert.match(prompt,/한 문장도 연출상 효과적이면 여러 컷/);assert.match(prompt,/4~7컷/);
 const custom=analysisPrompt(p,{instructions:'공포 연출과 리액션을 더 많이 보여주세요.',density:'dense'});
 assert.match(custom,/공포 연출/);assert.match(custom,/continuation=false/);assert.match(custom,/continuation=true/);assert.match(custom,/바로 앞 컷/);
 assert.equal(JSON.parse(custom.slice(custom.lastIndexOf('\n')+1)).script,p.script);
 assert.ok(analysisSchema.properties.scenes.items.required.includes('camera'));
 assert.ok(analysisSchema.properties.scenes.items.required.includes('continuation'));
 assert.throws(()=>analysisSettings(p,{instructions:' '}),/지시문/);assert.throws(()=>analysisSettings(p,{density:'invalid'}),/전환/);
 const long='이야기가 이어진다. '.repeat(100),balanced=analysisGuide(long,'balanced'),dynamic=analysisGuide(long),dense=analysisGuide(long,'dense');
 assert.ok(balanced.minCuts<dynamic.minCuts);assert.ok(dynamic.minCuts<dense.minCuts);assert.equal(analysisGuide('가'.repeat(100000),'dense').maxCuts,MAX_SCENES);
});

test('one sentence supports several camera cuts without losing or repeating narration',()=>{
 const script='민지가 말했다. 준호가 달렸다.';
 const scenes=validateScenes([shot('민지가 말했다.',false,'풀샷'),shot('민지가 말했다.',true,'바스트샷'),shot('민지가 말했다.',true,'반응 클로즈업'),shot('준호가 달렸다.',false,'로우앵글'),shot('준호가 달렸다.',true,'발 인서트')],script,[]);
 assert.equal(scenes.length,5);assert.equal(narrationText(scenes).replace(/\s/g,''),script.replace(/\s/g,''));
 assert.deepEqual(scenes.map(s=>s.continuation),[false,true,true,false,true]);
 const composed=composePrompt({characters:[],defaultStyleId:'',constraints:'',aspectRatio:'16:9'},scenes[1],[]);
 assert.match(composed.prompt,/Camera direction: 바스트샷/);
 assert.throws(()=>validateScenes([shot('민지가 말했다.',true)],'민지가 말했다.',[]),/바로 앞 컷/);
 assert.throws(()=>validateScenes([shot('민지가 말했다.'),shot('준호가 달렸다.',true)],script,[]),/바로 앞 컷/);
 assert.throws(()=>validateScenes([shot('민지가 말했다.'),shot('민지가 말했다.')],'민지가 말했다.',[]),/누락\/중복/);
 assert.throws(()=>validateScenes([shot('민지가 말했다.'),shot('민지가 말했다.',true)],script,[]),/누락\/중복/);
 assert.throws(()=>validateScenes([{...shot(script),continuation:'true'}],script,[]),/연결/);
 const legacy=validateScenes([shot(script,undefined)],script,[]);assert.equal(legacy[0].continuation,false);
 assert.equal(validateScenes(Array.from({length:150},(_,i)=>shot('원문',i>0)),'원문',[]).length,150);
 assert.throws(()=>validateScenes(Array.from({length:301},(_,i)=>shot('원문',i>0)),'원문',[]),/1~300/);
});

test('splitting and merging linked shots preserve the source timeline',()=>{
 for(const index of [0,1,2]){
  const source='민지가 말했다. 준호가 뛰었다.',scenes=[shot(source),shot(source,true),shot(source,true),shot('끝.')];
  const second=splitNarration(scenes,index,source.indexOf('준호'));
  scenes.splice(index+1,0,shot(second));
  assert.doesNotThrow(()=>validateScenes(scenes,source+'끝.',[]));
 }
 for(const index of [0,1,2]){
  const scenes=[shot('첫째.'),shot('첫째.',true),shot('둘째.'),shot('둘째.',true),shot('셋째.')];
  mergeNarration(scenes,index);scenes.splice(index+1,1);
  assert.doesNotThrow(()=>validateScenes(scenes,'첫째. 둘째. 셋째.',[]));
 }
 const scenes=[shot('새 원문'),shot('이전 원문',true),shot('이전 원문',true)];syncContinuations(scenes);
 assert.ok(scenes.every(s=>s.sourceText==='새 원문'));
});
