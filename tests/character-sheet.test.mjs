import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import test from 'node:test';
import {listCodexModels,effectiveCodexModel} from '../lib/codex-models.mjs';
import {composeCharacterSheet,SHEET_TEMPLATE,SHEET_SOURCE} from '../lib/character-sheet.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=';
const image={name:'시트.png',base64:PNG,kind:'character-sheet'};
const waitFor=async check=>{for(let i=0;i<150;i++){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,30));}throw Error('timed out');};
async function api(base,route,method='GET',body){const r=await fetch(base+'/api/'+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
async function fakeCodex(dir){
 const binary=path.join(dir,'codex');
 await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');const args=process.argv.slice(2);
if(args[0]==='app-server'){
 let initialized=false;
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
  if(m.method==='initialized')initialized=true;
  if(m.method==='model/list'){
   if(!initialized)throw Error('Missing initialized notification');
   const model=m.params.cursor?'gpt-test-other':'gpt-test-default';
   console.log(JSON.stringify({id:m.id,result:{data:[{model,displayName:model,isDefault:!m.params.cursor,inputModalities:['text','image']}],nextCursor:m.params.cursor?null:'next-page'}}));
  }
 });
}else if(args[0]==='login'){console.log('Logged in using ChatGPT');}
else {
 if(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)throw Error('API key leaked');
 let prompt='';process.stdin.on('data',d=>prompt+=d).on('end',()=>{
  fs.writeFileSync(process.cwd()+'/received.json',JSON.stringify({args,prompt}));
  const output=args[args.indexOf('-o')+1];
  setTimeout(()=>{
   if(prompt.includes('You are a storyboard editor.')){
    const input=JSON.parse(prompt.slice(prompt.indexOf('{')));
    fs.writeFileSync(output,JSON.stringify({scenes:[{title:'장면',sourceText:input.script,reason:'하나',prompt:'standing in the rain',characterIds:input.characters.map(c=>c.id)}]}));
   }else{const file=process.cwd()+'/output.png';fs.writeFileSync(file,Buffer.from('${PNG}','base64'));fs.writeFileSync(output,JSON.stringify({imagePath:file,error:''}));}
   console.log(JSON.stringify({type:'turn.completed'}));
  },180);
 });
}
`);
 await chmod(binary,0o755);return binary;
}
async function start(t,{initial,extraEnv={}}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'scene-sheet-')),binary=await fakeCodex(dir),data=path.join(dir,'data');
 if(initial){const {mkdir}=await import('node:fs/promises');await mkdir(data);await writeFile(path.join(data,'state.json'),JSON.stringify(initial));}
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const env={...process.env,PORT:String(port),CODEX_BIN:binary,SCENE_DATA_DIR:data,SCENE_REFERENCE_DIR:path.join(dir,'refs'),OPENAI_API_KEY:'must-not-pass',...extraEnv};delete env.SCENE_CODEX_MODEL;
 const child=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGTERM'));
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);await waitFor(()=>output.includes('Scene Studio:'));
 return {base:`http://127.0.0.1:${port}`,data,dir,binary};
}

test('model discovery performs handshake, paginates, and resolves settings before environment before default',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'model-list-')),binary=await fakeCodex(dir);
 const models=await listCodexModels({binary,timeout:3000});assert.equal(models.length,2);
 assert.equal(effectiveCodexModel({codexModel:'chosen'},{models},'env').model,'chosen');
 assert.equal(effectiveCodexModel({codexModel:''},{models},'env').model,'env');
 assert.equal(effectiveCodexModel({codexModel:''},{models},'').model,'gpt-test-default');
 assert.equal(effectiveCodexModel({},{models:[],error:'offline'},'').error,'offline');
 await assert.rejects(listCodexModels({binary:'/missing/codex',timeout:100}),/실행 파일/);
 const stalled=path.join(dir,'stalled');await writeFile(stalled,`#!${process.execPath}\nprocess.stdin.resume();`);await chmod(stalled,0o755);
 await assert.rejects(listCodexModels({binary:stalled,timeout:80}),/초과/);
});

test('sheet prompt preserves the published template and maps identity and style images separately',()=>{
 const c={name:'민지',description:'검은 단발과 노란 우비',references:[{path:'/ref/sheet.png',kind:'character-sheet'}]};
 const style={id:'s',name:'수채화',prompt:'soft watercolor',references:[{path:'/ref/style.png'}]};
 const result=composeCharacterSheet({constraints:'글자 금지'},c,style);
 assert.ok(result.prompt.includes(SHEET_TEMPLATE));assert.equal(result.source.url,SHEET_SOURCE.url);
 assert.equal(result.aspectRatio,'4:3');assert.equal(result.refs[0].character,'민지');assert.equal(result.refs[1].purpose,'style');
 assert.match(result.prompt,/SAME single character/);assert.match(result.prompt,/검은 단발과 노란 우비/);
 assert.match(result.prompt,/글자 금지/);assert.match(result.prompt,/soft watercolor/);
});

test('characters accept sheets on creation and editing, rejecting bad uploads without partial changes',async t=>{
 const {base}=await start(t);const p=(await api(base,'projects','POST',{name:'첨부'})).body;
 const invalid=await api(base,`projects/${p.id}/characters`,'POST',{name:'잘못된 첨부',images:[image,{name:'bad.png',base64:'invalid'}]});assert.equal(invalid.status,400);
 assert.equal((await api(base,'state')).body.projects[0].characters.length,0);
 const c=(await api(base,`projects/${p.id}/characters`,'POST',{name:'민지',description:'노란 우비',images:[image]})).body;
 assert.equal(c.references[0].kind,'character-sheet');assert.ok(!path.isAbsolute(c.references[0].path));
 const media=await fetch(base+c.references[0].url);assert.equal(media.status,200);
 const edited=await api(base,`projects/${p.id}/characters/${c.id}`,'PUT',{description:'검은 단발',referenceIds:[c.references[0].id],images:[{...image,kind:'reference'}]});
 assert.equal(edited.status,200);assert.equal(edited.body.references.length,2);assert.equal(edited.body.description,'검은 단발');
 assert.equal((await api(base,`projects/${p.id}/characters/${c.id}`,'PUT',{name:'망가지면 안 됨',images:[{name:'bad',base64:'x'}]})).status,400);
 assert.equal((await api(base,'state')).body.projects[0].characters[0].name,'민지');
 assert.equal((await api(base,`projects/${p.id}/characters/${c.id}`,'PUT',{images:Array(9).fill(image)})).status,400);
});

test('selected GPT reaches analysis and image control; generated sheet auto-registers and is used in scenes',async t=>{
 const {base,data}=await start(t);
 const catalog=(await api(base,'settings')).body;assert.equal(catalog.codexModel.model,'gpt-test-default');assert.equal(catalog.options.codexModels.length,2);
 assert.equal((await api(base,'settings','PUT',{codexModel:'--bad'})).status,400);
 await api(base,'settings','PUT',{codexModel:'gpt-test-other'});
 assert.equal((await api(base,'status')).body.textModel,'gpt-test-other');
 const p=(await api(base,'projects','POST',{name:'시트 자동 등록'})).body;
 const c=(await api(base,`projects/${p.id}/characters`,'POST',{name:'민지',description:'검은 단발, 노란 우비',images:[image]})).body;
 const style=(await api(base,'styles','POST',{name:'수채화',prompt:'warm watercolor',images:[image]})).body;
 await api(base,`projects/${p.id}`,'PUT',{script:'민지가 비를 바라봤다.',defaultStyleId:style.id});
 await api(base,`projects/${p.id}/analysis-prompt`,'PUT',{instructions:'클로즈업과 반응샷을 더 많이 사용하세요.',density:'dense'});
 const expectedPrompt=(await api(base,`projects/${p.id}/analysis-prompt`)).body.prompt;
 assert.equal((await api(base,`projects/${p.id}/analyze`,'POST',{})).status,202);
 assert.equal((await api(base,`projects/${p.id}/analysis-prompt`,'PUT',{instructions:'작업 중 변경'})).status,400);
 await api(base,'settings','PUT',{codexModel:'gpt-test-default'});
 const analyzed=await waitFor(async()=>{const p=(await api(base,'state')).body.projects[0];return !p.analyzing&&p.scenes.length&&p;});
 assert.equal(analyzed.analysisRun.model,'gpt-test-other');assert.equal(analyzed.analysisRun.status,'done');
 assert.equal(analyzed.analysisRun.prompt,expectedPrompt);assert.equal(analyzed.analysisRun.density,'dense');
 assert.equal((await api(base,`projects/${p.id}/analysis-prompt`)).body.lastPrompt,expectedPrompt);
 const preview=(await api(base,`projects/${p.id}/character-sheet-preview`,'POST',{characterId:c.id})).body;
 assert.equal(preview.refs.length,2);assert.match(preview.prompt,/warm watercolor/);
 const noStyle=(await api(base,`projects/${p.id}/character-sheet-preview`,'POST',{characterId:c.id,useProjectStyle:false,stylePrompt:'flat 2D'})).body;
 assert.equal(noStyle.refs.length,1);assert.match(noStyle.prompt,/flat 2D/);
 assert.equal((await api(base,`projects/${p.id}/character-sheet`,'POST',{characterId:c.id})).status,202);
 assert.equal((await api(base,`projects/${p.id}/character-sheet`,'POST',{characterId:c.id})).status,400);
 assert.equal((await api(base,`projects/${p.id}/characters/${c.id}`,'DELETE',{})).status,400);
 const done=await waitFor(async()=>{const p=(await api(base,'state')).body.projects[0];return p.characters[0].sheetJob?.status==='done'&&p;});
 assert.equal(done.characters[0].references.length,2);const generated=done.characters[0].references[1];
 assert.equal(generated.kind,'character-sheet');assert.equal(generated.controllerModel,'gpt-test-default');assert.equal(generated.source.url,SHEET_SOURCE.url);
 const actual=(await api(base,`projects/${p.id}/preview`,'POST',{sceneId:done.scenes[0].id})).body;
 assert.ok(actual.refs.some(r=>r.id===generated.id));assert.equal(done.scenes[0].status,'draft');
 assert.ok(!actual.refs.some(r=>r.prompt));
 const repeat=(await api(base,`projects/${p.id}/character-sheet-preview`,'POST',{characterId:c.id})).body;
 assert.ok(!repeat.refs.some(r=>r.prompt));assert.equal(repeat.prompt.split('REFERENCE-SHEET TEMPLATE').length,2);
 const {readdir}=await import('node:fs/promises');const received=await Promise.all((await readdir(path.join(data,'jobs'))).map(async name=>JSON.parse(await readFile(path.join(data,'jobs',name,'received.json'),'utf8'))));
 const analysis=received.find(r=>r.prompt.startsWith('You are a storyboard editor.'));assert.equal(analysis.args[analysis.args.indexOf('-m')+1],'gpt-test-other');
 assert.equal(analysis.prompt,expectedPrompt);
 const sheet=received.find(r=>r.prompt.includes('REFERENCE-SHEET TEMPLATE'));assert.equal(sheet.args[sheet.args.indexOf('-m')+1],'gpt-test-default');assert.equal(sheet.args.filter(v=>v==='-i').length,2);
 assert.ok(!(await readFile(path.join(data,'state.json'),'utf8')).includes('must-not-pass'));
});

test('incomplete sheet generation recovers as failed after restart',async t=>{
 const initial={projects:[{id:'p',name:'복구',script:'',characters:[{id:'c',name:'민지',description:'단발',references:[],sheetJob:{status:'running'}}],scenes:[]}],sources:[],presets:[],favorites:[]};
 const {base}=await start(t,{initial});const c=(await api(base,'state')).body.projects[0].characters[0];
 assert.equal(c.sheetJob.status,'failed');assert.match(c.sheetJob.error,/중단/);
});

test('OpenAI sheets use the image model and 4:3 size, attach identity on regeneration, and preserve refs on failure',async t=>{
 const requests=[];let fail=false;
 const openai=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d).on('end',()=>{requests.push({url:req.url,body});res.writeHead(fail?403:200,{'Content-Type':'application/json'});res.end(JSON.stringify(fail?{error:{message:'test policy failure'}}:{data:[{b64_json:PNG}]}));});});
 openai.listen(0,'127.0.0.1');await once(openai,'listening');t.after(()=>openai.close());
 const {base}=await start(t,{extraEnv:{OPENAI_BASE_URL:`http://127.0.0.1:${openai.address().port}/v1`}});
 await api(base,'settings','PUT',{imageProvider:'openai',imageModel:'gpt-image-2.5-sunburst',imageQuality:'high'});
 const p=(await api(base,'projects','POST',{name:'API 시트'})).body;
 const c=(await api(base,`projects/${p.id}/characters`,'POST',{name:'민지',description:'단발, 노란 우비'})).body;
 const run=()=>api(base,`projects/${p.id}/character-sheet`,'POST',{characterId:c.id,useProjectStyle:false});
 assert.equal((await run()).status,202);
 const readCharacter=async()=> (await api(base,'state')).body.projects[0].characters[0];
 await waitFor(async()=>{const c=await readCharacter();return c.sheetJob.status==='done'&&c.references.length===1;});
 assert.equal(requests[0].url,'/v1/images/generations');const plain=JSON.parse(requests[0].body);assert.equal(plain.size,'1536x1152');assert.equal(plain.model,'gpt-image-2.5-sunburst');assert.equal(plain.quality,'high');
 const ref=(await readCharacter()).references[0];assert.equal(ref.engine,'gpt-image-2.5-sunburst');assert.ok(!ref.controllerModel);
 assert.equal((await run()).status,202);await waitFor(async()=>{const c=await readCharacter();return c.sheetJob.status==='done'&&c.references.length===2;});
 assert.equal(requests[1].url,'/v1/images/edits');assert.match(requests[1].body,/Image 1: character "민지"/);
 fail=true;assert.equal((await run()).status,202);await waitFor(async()=> (await readCharacter()).sheetJob.status==='failed');
 assert.equal((await readCharacter()).references.length,2);assert.equal((await readCharacter()).sheetJob.attempts,1);assert.match((await readCharacter()).sheetJob.error,/403/);
 const capped=(await api(base,`projects/${p.id}/characters`,'POST',{name:'최대 첨부',description:'외형',images:Array(10).fill(image)})).body;
 assert.equal((await api(base,`projects/${p.id}/character-sheet`,'POST',{characterId:capped.id})).status,400);
});

test('characters can be added and sheets queued during generation, with independent results and a limit of three',async t=>{
 const requests=[];let active=0,maxActive=0;
 const openai=http.createServer((req,res)=>{
  let body='';req.on('data',d=>body+=d).on('end',()=>{
   active++;maxActive=Math.max(maxActive,active);
   requests.push({body,finish:(fail=false)=>{active--;res.writeHead(fail?403:200,{'Content-Type':'application/json'});res.end(JSON.stringify(fail?{error:{message:'one character failed'}}:{data:[{b64_json:PNG}]}));}});
  });
 });
 openai.listen(0,'127.0.0.1');await once(openai,'listening');t.after(()=>{openai.closeAllConnections();openai.close();});
 const {base}=await start(t,{extraEnv:{OPENAI_BASE_URL:`http://127.0.0.1:${openai.address().port}/v1`}});
 await api(base,'settings','PUT',{imageProvider:'openai'});
 const p=(await api(base,'projects','POST',{name:'여러 캐릭터'})).body,route=`projects/${p.id}`,characters=[];
 const readProject=async()=> (await api(base,'state')).body.projects[0];
 const add=async(name,images=[])=>{const result=await api(base,route+'/characters','POST',{name,description:`${name}의 고유 외형`,images});assert.equal(result.status,201);return result.body;};
 const run=character=>api(base,route+'/character-sheet','POST',{characterId:character.id});
 const first=await add('첫째',[image]);characters.push(first);
 // Two requests arrive together while the first is still preparing its prompt.
 const duplicates=await Promise.all([run(first),run(first)]);assert.deepEqual(duplicates.map(r=>r.status).sort(),[202,400]);
 await waitFor(()=>requests.length===1);
 const firstJob=(await readProject()).characters[0].sheetJob.id;
 assert.equal((await api(base,route+'/characters/'+first.id,'PUT',{description:'변경 금지'})).status,400);
 assert.equal((await api(base,route+'/characters/'+first.id,'DELETE',{})).status,400);
 assert.equal((await api(base,route+'/references','POST',{characterId:first.id,...image})).status,400);
 assert.equal((await api(base,route+'/references/'+first.references[0].id,'DELETE',{})).status,400);
 assert.equal((await api(base,route,'PUT',{script:'작업 중 변경'})).status,400);
 assert.equal((await api(base,route+'/analyze','POST',{})).status,400);
 const second=await add('둘째');
 assert.equal((await api(base,route+'/characters/'+second.id,'PUT',{description:'둘째의 수정된 외형'})).status,200);
 const uploaded=await api(base,route+'/references','POST',{characterId:second.id,...image});assert.equal(uploaded.status,201);
 assert.equal((await api(base,route+'/references/'+uploaded.body.references[0].id,'DELETE',{})).status,200);
 characters.push(second);assert.equal((await run(second)).status,202);
 for(const name of ['셋째','넷째']){const c=await add(name);characters.push(c);assert.equal((await run(c)).status,202);}
 await waitFor(()=>requests.length===3);
 const queued=await readProject();assert.deepEqual(queued.characters.map(c=>c.sheetJob.status),['running','running','running','queued']);assert.equal(queued.characters[0].sheetJob.id,firstJob);
 assert.equal((await run(characters[3])).status,400);
 assert.equal((await api(base,route+'/generate','POST',{})).status,400);
 // A failure frees a slot and leaves the other characters' jobs running.
 requests[2].finish(true);await waitFor(()=>requests.length===4);
 const afterFailure=await waitFor(async()=>{const p=await readProject();return p.characters[2].sheetJob.status==='failed'&&p;});
 assert.equal(afterFailure.characters[2].references.length,0);assert.equal(afterFailure.characters[0].sheetJob.status,'running');
 requests[0].finish();
 const finished=await waitFor(async()=>{const p=await readProject();return p.characters[0].sheetJob.status==='done'&&p;});
 assert.equal(finished.characters[0].references.length,2);
 assert.equal((await api(base,route+'/characters/'+first.id,'PUT',{name:'첫째 완료'})).status,200);
 const fifth=await add('추가 캐릭터');assert.equal((await run(fifth)).status,202);await waitFor(()=>requests.length===5);
 for(const index of [1,3,4])requests[index].finish();
 const done=await waitFor(async()=>{const p=await readProject();return p.characters.every(c=>['done','failed'].includes(c.sheetJob.status))&&p;});
 assert.equal(maxActive,3);assert.equal(done.characters[1].description,'둘째의 수정된 외형');
 const refs=done.characters.flatMap(c=>c.references.filter(r=>r.engine));assert.equal(refs.length,4);assert.equal(new Set(refs.map(r=>r.id)).size,4);
 for(const c of done.characters.filter(c=>c.sheetJob.status==='done')){const r=c.references.find(r=>r.id===c.sheetJob.referenceId);assert.ok(r);assert.match(r.prompt,new RegExp(c.description));}
 const idle=await add('삭제 가능');assert.equal((await api(base,route+'/characters/'+idle.id,'DELETE',{})).status,200);
 // Character mutations remain protected while a scene itself is generating.
 await api(base,route,'PUT',{script:'등장인물들이 만났다.'});
 assert.equal((await api(base,route+'/analyze','POST',{})).status,202);
 assert.equal((await api(base,route+'/characters','POST',{name:'분석 중'})).status,400);
 await waitFor(async()=>{const p=await readProject();return !p.analyzing&&p.scenes.length;});
 assert.equal((await api(base,route+'/generate','POST',{})).status,202);await waitFor(()=>requests.length===6);
 assert.equal((await api(base,route+'/characters','POST',{name:'장면 생성 중'})).status,400);
 assert.equal((await run(fifth)).status,400);
 requests[5].finish();await waitFor(async()=> (await readProject()).scenes[0].status==='done');
});
