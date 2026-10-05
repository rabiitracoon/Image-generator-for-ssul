import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,chmod,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {once} from 'node:events';
import {runProcess} from '../lib/codex.mjs';
import {runAnalysis,analysisCancelled} from '../lib/analysis-job.mjs';
import {validateScenes} from '../lib/core.mjs';
import {mergeProjectProgress,analysisProgress} from '../public/view-model.js';
const waitFor=async check=>{for(let i=0;i<200;i++){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out');};

test('analysis retries a transient provider error once, validates only success, and does not retry malformed narration',async()=>{
 let calls=0,validations=0;const phases=[];
 const result=await runAnalysis({execute:async()=>{if(++calls===1)throw Error('connection reset');return ['new cut'];},validate:value=>{validations++;return value;},onPhase:async(phase,attempt)=>phases.push({phase,attempt}),retryDelay:0});
 assert.deepEqual(result,['new cut']);assert.equal(calls,2);assert.equal(validations,1);assert.ok(phases.some(p=>p.phase==='retrying'&&p.attempt===2));assert.equal(phases.at(-1).phase,'validating');
 calls=0;await assert.rejects(runAnalysis({execute:async()=>{calls++;return [];},validate:()=>{throw Error('원문 누락');}}),/원문 누락/);assert.equal(calls,1);
});
test('unresponsive provider has a bounded timeout and preserves partial diagnostics; abort stops waiting immediately',async()=>{
 const script="process.stdout.write('started\\n'); process.stderr.write('diagnostic\\n'); setInterval(()=>{},1000);";
 await assert.rejects(runProcess(process.execPath,['-e',script],{timeout:100}),error=>{assert.match(error.message,/초과/);assert.match(error.out,/started/);assert.match(error.err,/diagnostic/);return true;});
 const controller=new AbortController(),pending=runProcess(process.execPath,['-e',script],{timeout:10000,signal:controller.signal});controller.abort(analysisCancelled());await assert.rejects(pending,/장면 분석을 중단/);
 const preAborted=new AbortController();preAborted.abort(analysisCancelled());await assert.rejects(runProcess('/missing',[],{signal:preAborted.signal}),/장면 분석을 중단/);
});
test('completed reanalysis replaces old scene IDs while unsaved project fields and failed-analysis scenes survive refresh',()=>{
 const local={name:'unsaved name',scenes:[{id:'old',status:'draft',images:[]}],characters:[],analyzing:true,analysisRun:{id:'a',status:'running',startedAt:'old'}},remote={scenes:[{id:'new',status:'draft',images:[]}],characters:[],analyzing:false,analysisRun:{id:'a',status:'done',startedAt:'old'},sourceMappingError:''};
 mergeProjectProgress(local,remote);assert.equal(local.name,'unsaved name');assert.deepEqual(local.scenes,remote.scenes);assert.equal(local.analyzing,false);
 remote.analysisRun={id:'b',status:'failed',startedAt:'new'};remote.scenes=[{id:'new',status:'draft',images:[]}];local.scenes[0].prompt='unsaved prompt';mergeProjectProgress(local,remote);assert.equal(local.scenes[0].prompt,'unsaved prompt');
 assert.equal(analysisProgress(local),'');assert.match(analysisProgress({...local,analyzing:true,analysisRun:{phase:'retrying',attempt:2,maxAttempts:2,startedAt:new Date(0).toISOString()}},65000),/1분 05초.*2\/2/);
});

async function start(t){
 const dir=await mkdtemp(path.join(tmpdir(),'analysis-retry-')),data=path.join(dir,'data'),binary=path.join(dir,'codex');await mkdir(data);
 const script='민지가 문을 열었다.',p={id:'11111111-1111-4111-8111-111111111111',name:'재분석 검증',script,characters:[],defaultStyleId:'',aspectRatio:'16:9',constraints:'',scenes:validateScenes([{sourceText:script,prompt:'old image',characterIds:[]}],script,[])};
 p.scenes[0].images=[{url:'/media/images/abcdef.png'}];p.scenes[0].status='done';
 await writeFile(path.join(data,'state.json'),JSON.stringify({projects:[p],presets:[],sources:[],favorites:[],settings:{codexModel:'gpt-test'}}));
 await writeFile(path.join(dir,'mode'),'success');
 await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline'),args=process.argv.slice(2),dir=${JSON.stringify(dir)};
if(args[0]==='login')console.log('Logged in using ChatGPT');
else if(args[0]==='app-server')rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='model/list')console.log(JSON.stringify({id:m.id,result:{data:[{model:'gpt-test',isDefault:true}],nextCursor:null}}));});
else{let prompt='';process.stdin.on('data',d=>prompt+=d).on('end',()=>{
 const mode=fs.readFileSync(dir+'/mode','utf8');let count=0;try{count=Number(fs.readFileSync(dir+'/calls','utf8'));}catch{}fs.writeFileSync(dir+'/calls',String(count+1));
 console.log(JSON.stringify({type:'thread.started'}));
 if(mode==='hang'){setInterval(()=>{},1000);return;}
 if(mode==='transient'&&count===0){console.error('connection reset');process.exitCode=1;return;}
 const input=JSON.parse(prompt.slice(prompt.lastIndexOf('\\n')+1)),text=input.script,n=text.indexOf(' ')+1;
 setTimeout(()=>{fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({scenes:(mode==='invalid'?['wrong script']:[text.slice(0,n),text.slice(n)]).map((sourceText,i)=>({title:'재분석 '+(i+1),sourceText,reason:'동작별 컷',camera:'바스트샷',prompt:'new frame',characterIds:[]}))}));console.log(JSON.stringify({type:'turn.completed'}));},250);
});}
`);await chmod(binary,0o755);
 const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),SCENE_DATA_DIR:data,SCENE_REFERENCE_DIR:path.join(dir,'refs'),CODEX_BIN:binary},stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGTERM'));
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);await waitFor(()=>output.includes('Scene Studio:'));return {base:`http://127.0.0.1:${port}`,dir,p};
}
async function api(base,route,method='GET',body){const r=await fetch(base+'/api/'+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
const state=async base=>(await api(base,'state')).body.projects[0];
test('reanalyzing an existing project completes repeatedly; failure/cancel retain existing images and permit a new analysis',async t=>{
 const {base,dir,p}=await start(t),route=`projects/${p.id}`,original=p.scenes[0];
 const first=await api(base,route+'/analyze','POST',{});assert.equal(first.status,202);
 assert.equal((await api(base,route+'/analyze','POST',{})).status,400);
 let during=await state(base);assert.equal(during.analyzing,true);assert.equal(during.scenes[0].id,original.id);assert.deepEqual(during.scenes[0].images,original.images);
 const done=await waitFor(async()=>{const p=await state(base);return !p.analyzing&&p;});assert.equal(done.analysisRun.status,'done');assert.equal(done.scenes.length,2);assert.ok(done.scenes.every(s=>s.id!==original.id));assert.equal(done.scenes.map(s=>s.sourceText).join(''),p.script);
 const previous=structuredClone(done.scenes);
 await writeFile(path.join(dir,'mode'),'invalid');await api(base,route+'/analyze','POST',{});
 const failed=await waitFor(async()=>{const p=await state(base);return !p.analyzing&&p;});assert.equal(failed.analysisRun.status,'failed');assert.match(failed.analysisError,/누락\/중복/);assert.deepEqual(failed.scenes,previous);
 await writeFile(path.join(dir,'mode'),'hang');await api(base,route+'/analyze','POST',{});await waitFor(async()=>Number(await readFile(path.join(dir,'calls'),'utf8'))>=3);
 assert.equal((await api(base,route+'/analysis-cancel','POST',{})).status,202);
 const cancelled=await waitFor(async()=>{const p=await state(base);return !p.analyzing&&p;});assert.equal(cancelled.analysisRun.status,'cancelled');assert.deepEqual(cancelled.scenes,previous);
 await writeFile(path.join(dir,'mode'),'success');assert.equal((await api(base,route+'/analyze','POST',{})).status,202);
 const recovered=await waitFor(async()=>{const p=await state(base);return !p.analyzing&&p;});assert.equal(recovered.analysisRun.status,'done');assert.equal(recovered.scenes.length,2);assert.notEqual(recovered.scenes[0].id,previous[0].id);
});
test('a connection failure during reanalysis automatically retries once and replaces scenes only after validation',async t=>{
 const {base,dir,p}=await start(t);await writeFile(path.join(dir,'mode'),'transient');
 await api(base,`projects/${p.id}/analyze`,'POST',{});
 const done=await waitFor(async()=>{const p=await state(base);return !p.analyzing&&p;});assert.equal(done.analysisRun.status,'done');assert.equal(done.analysisRun.attempt,2);assert.equal(Number(await readFile(path.join(dir,'calls'),'utf8')),2);assert.equal(done.scenes.length,2);
});
