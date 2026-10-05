import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_ANALYSIS_INSTRUCTIONS,analysisPrompt,analysisSettings,analysisGuide,analysisSchema,MAX_SCENES} from '../lib/analysis.mjs';
import {validateScenes,composePrompt} from '../lib/core.mjs';
import {narrationText,splitNarration,mergeNarration,refreshSourceAssignments} from '../lib/narration.mjs';

const shot=(sourceText,camera='바스트샷')=>({sourceText,camera,prompt:`ONE frame, ${camera}`,characterIds:[]});
test('analysis asks for rich coverage and short exclusive phrases even with custom instructions',()=>{
 const p={script:'민지가 문을 열고 말했다. 준호는 깜짝 놀랐다.',constraints:'자막 없음',characters:[]},prompt=analysisPrompt(p);
 assert.equal(analysisSettings(p).density,'dynamic');assert.ok(prompt.includes(DEFAULT_ANALYSIS_INSTRUCTIONS));
 for(const technique of ['풀샷','바스트샷','클로즈업','오버더숄더','숏/리버스숏','리액션샷','로우앵글','POV','인서트','180도'])assert.ok(prompt.includes(technique),technique);
 assert.match(prompt,/한 문장도 연출상 효과적이면 여러 컷/);assert.match(prompt,/4~7컷/);
 const custom=analysisPrompt(p,{instructions:'같은 문장 전체를 반복해서 공포 연출을 보여주세요.',density:'dense'});
 assert.match(custom,/공포 연출/);assert.match(custom,/겹치게 배정하지 마세요/);assert.match(custom,/첫 글자가 편집 에이전트/);
 assert.equal(JSON.parse(custom.slice(custom.lastIndexOf('\n')+1)).script,p.script);
 assert.ok(analysisSchema.properties.scenes.items.required.includes('camera'));
 assert.equal(analysisSchema.properties.scenes.items.properties.continuation,undefined);
 assert.throws(()=>analysisSettings(p,{instructions:' '}),/지시문/);assert.throws(()=>analysisSettings(p,{density:'invalid'}),/전환/);
 const long='이야기가 이어진다. '.repeat(100),balanced=analysisGuide(long,'balanced'),dynamic=analysisGuide(long),dense=analysisGuide(long,'dense');
 assert.ok(balanced.minCuts<dynamic.minCuts);assert.ok(dynamic.minCuts<dense.minCuts);assert.equal(analysisGuide('가'.repeat(100000),'dense').maxCuts,MAX_SCENES);
});

test('a sentence is divided into exclusive phrases, preserving exact punctuation and whitespace',()=>{
 const script='민지가 문을 열고, "누구세요?"라고 물었다.\n준호는 놀라서 뒤로 물러났다. ';
 const scenes=validateScenes([shot('민지가 문을 열고,','풀샷'),shot('"누구세요?"라고 물었다.'),shot('준호는 놀라서','반응 클로즈업'),shot('뒤로 물러났다.','로우앵글')],script,[]);
 assert.equal(scenes.length,4);assert.equal(narrationText(scenes),script);
 for(let i=0;i<scenes.length;i++){
  const s=scenes[i];assert.equal(Array.from(script).slice(s.sourceRange.start,s.sourceRange.end).join(''),s.sourceText);
  assert.equal(s.sourceRange.start,i?scenes[i-1].sourceRange.end:0);assert.equal(s.continuation,undefined);
 }
 assert.equal(scenes[2].sourceRange.startLine,2);assert.equal(scenes.at(-1).sourceRange.end,Array.from(script).length);
 const composed=composePrompt({characters:[],defaultStyleId:'',constraints:'',aspectRatio:'16:9'},scenes[1],[]);assert.match(composed.prompt,/Camera direction: 바스트샷/);
 for(const invalid of [[shot(script),{...shot(script),continuation:true}],[shot('민지가 문을 열고,')],[shot('문을 열고,'),shot('민지가')],[shot(' ')]] )assert.throws(()=>validateScenes(invalid,script,[]));
 assert.equal(validateScenes(Array.from({length:300},()=>shot('원문')),'원문'.repeat(300),[]).length,300);
 assert.throws(()=>validateScenes(Array.from({length:301},()=>shot('원문')),'원문'.repeat(301),[]),/1~300/);
});

test('emoji and repeated phrases have distinct original positions; model offsets are ignored',()=>{
 const script='😀 안녕.\n안녕. 끝.',scenes=validateScenes([{...shot('😀안녕.'),sourceRange:{start:999} },shot('안녕.'),shot('끝.')],script,[]);
 assert.equal(narrationText(scenes),script);assert.equal(scenes[0].sourceRange.start,0);assert.equal(scenes[1].sourceRange.start,6);
 assert.equal(scenes[1].sourceRange.startLine,2);assert.equal(scenes[1].sourceRange.startColumn,1);
});

test('split and merge preserve every character; legacy overlapping projects are flagged without guessing boundaries',()=>{
 const source='민지가 말했다. 준호가 뛰었다.',scenes=validateScenes([shot(source),shot('끝.')],source+'끝.',[]);
 const second=splitNarration(scenes,0,source.indexOf('준호'));scenes.splice(1,0,shot(second));
 assert.equal(narrationText(validateScenes(scenes,source+'끝.',[])),source+'끝.');
 mergeNarration(scenes,0);scenes.splice(1,1);assert.equal(narrationText(validateScenes(scenes,source+'끝.',[])),source+'끝.');
 const legacy={script:source,scenes:[shot(source),{...shot(source),continuation:true,sourceRange:{start:0}}]};refreshSourceAssignments(legacy);
 assert.match(legacy.sourceMappingError,/누락\/중복/);assert.equal(legacy.scenes[1].sourceText,source);assert.equal(legacy.scenes[1].sourceRange,undefined);
 const valid={script:source,scenes:[{...shot(source),continuation:false}]};refreshSourceAssignments(valid);assert.equal(valid.scenes[0].continuation,undefined);assert.equal(valid.sourceMappingError,'');
});
