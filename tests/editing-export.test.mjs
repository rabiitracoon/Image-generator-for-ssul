import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {mkdtemp,writeFile,mkdir,readFile,rm,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {validateScenes} from '../lib/core.mjs';
import {editingCue,editingManifest,editingFiles,scriptHash} from '../lib/editing-export.mjs';
import {zipEntries} from '../lib/zip.mjs';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=','base64');
const shot=sourceText=>({sourceText,prompt:'one frame',camera:'바스트샷',characterIds:[]});
const fixture=()=>({id:'project',name:'테스트',characters:[],script:'😀 민지는 문을 열고,\n"누구세요?"라고 물었다.',scenes:validateScenes([shot('😀 민지는 문을 열고,'),shot('"누구세요?"라고 물었다.')],'😀 민지는 문을 열고,\n"누구세요?"라고 물었다.',[])});
function unzipStored(buffer){
 const end=buffer.length-22;assert.equal(buffer.readUInt32LE(end),0x06054b50);
 let offset=buffer.readUInt32LE(end+16);const entries=new Map();
 for(let i=0;i<buffer.readUInt16LE(end+10);i++){
  assert.equal(buffer.readUInt32LE(offset),0x02014b50);assert.equal(buffer.readUInt16LE(offset+10),0);assert.equal(buffer.readUInt16LE(offset+8)&0x800,0x800);
  const size=buffer.readUInt32LE(offset+24),nameLength=buffer.readUInt16LE(offset+28),extra=buffer.readUInt16LE(offset+30),comment=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42);
  const name=buffer.subarray(offset+46,offset+46+nameLength).toString('utf8');assert.equal(buffer.readUInt32LE(local),0x04034b50);
  const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28);entries.set(name,buffer.subarray(start,start+size));offset+=46+nameLength+extra+comment;
 }
 return entries;
}
test('manifest maps every phrase to its actual position and names images with their script cue',()=>{
 const p=fixture(),s=p.scenes[1];s.images=[{url:'/media/images/abcdef.png',cue:editingCue(p,s,1)}];
 const m=editingManifest(p);assert.equal(m.scriptSha256,scriptHash(p.script));assert.equal(m.cuts[0].imageFile,null);
 assert.match(m.cuts[1].imageFile,/images\/cut-002_.*누구세요.*_v1.png/);
 for(const cut of m.cuts)assert.equal(Array.from(m.script).slice(cut.sourceRange.start,cut.sourceRange.end).join(''),cut.sourceText);
 assert.equal(m.cuts[1].sourceRange.startLine,2);assert.deepEqual(m.cuts[1].generatedCue,s.images[0].cue);
 p.scenes[0].sourceText+=p.scenes[1].sourceText;p.scenes[1].sourceText='';assert.throws(()=>editingManifest(p));
});
test('ZIP central directory and UTF-8 names round-trip exact script, CSV, image bytes and per-image cue JSON',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'editing-zip-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(path.join(dir,'images'));
 await writeFile(path.join(dir,'images','abcdef.png'),PNG);const p=fixture();p.scenes[1].images=[{url:'/media/images/abcdef.png'}];
 const chunks=[];for await(const chunk of zipEntries(editingFiles(p,dir)))chunks.push(chunk);
 const entries=unzipStored(Buffer.concat(chunks)),manifest=JSON.parse(entries.get('manifest.json'));
 assert.equal(entries.get('script.txt').toString(),p.script);assert.equal(entries.get('cuts.csv').toString()[0],'\ufeff');
 assert.deepEqual(entries.get(manifest.cuts[1].imageFile),PNG);
 assert.equal(JSON.parse(entries.get(manifest.cuts[1].imageFile.replace('.png','.json'))).sourceText,p.scenes[1].sourceText);
});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function start(t,initial,extraEnv={}){
 const dir=await mkdtemp(path.join(tmpdir(),'editing-api-')),data=path.join(dir,'data');await mkdir(data);
 if(initial)await writeFile(path.join(data,'state.json'),JSON.stringify(initial));
 const mock=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}));});});const mockPort=await listen(mock);
 const probe=http.createServer(),port=await listen(probe);await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,PORT:String(port),SCENE_DATA_DIR:data,SCENE_REFERENCE_DIR:path.join(dir,'refs'),OPENAI_BASE_URL:`http://127.0.0.1:${mockPort}/v1`,...extraEnv},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>mock.close(r));});
 for(let i=0;i<100&&!output.includes('Scene Studio:');i++)await new Promise(r=>setTimeout(r,20));assert.match(output,/Scene Studio:/);
 return {base:`http://127.0.0.1:${port}`,data};
}
async function api(base,route,method='GET',body){const r=await fetch(base+'/api/'+route,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
test('generation writes frozen cue sidecars; project JSON and ZIP export current assignment and latest images',async t=>{
 const {base,data}=await start(t);await api(base,'settings','PUT',{imageProvider:'openai',openaiApiKey:'sk-test-0123456789abcdef'});
 const p=(await api(base,'projects','POST',{name:'편집용 저장'})).body,route=`projects/${p.id}`,f=fixture();
 const saved=await api(base,route,'PUT',{script:f.script,scenes:f.scenes});assert.equal(saved.status,200);
 assert.equal((await api(base,route+'/generate','POST',{})).status,202);
 let done;for(let i=0;i<100;i++){done=(await api(base,'state')).body.projects[0];if(done.scenes.every(s=>s.status==='done'))break;await new Promise(r=>setTimeout(r,30));}
 assert.ok(done.scenes.every(s=>s.status==='done'));
 for(const s of done.scenes){const im=s.images[0],sidecar=await (await fetch(base+im.metadataUrl)).json();assert.deepEqual(sidecar.cue,im.cue);assert.equal(im.cue.sourceText,s.sourceText);assert.equal(im.cue.scriptSha256,scriptHash(f.script));assert.match(im.downloadName,/cut-00[12]_.*_v1.png/);assert.ok(await readFile(path.join(data,'images',sidecar.imageFile)));}
 assert.deepEqual((await api(base,route+'/editing-export?validate=1')).body,{ready:true,filename:`editing-${p.id}.zip`});
 const blob=await fetch(base+'/api/'+route+'/editing-export');assert.equal(blob.status,200);assert.match(blob.headers.get('content-type'),/zip/);
 const entries=unzipStored(Buffer.from(await blob.arrayBuffer())),m=JSON.parse(entries.get('manifest.json'));
 assert.equal(m.cuts.length,2);assert.ok(m.cuts.every(c=>entries.has(c.imageFile)));assert.equal(entries.get('script.txt').toString(),f.script);
 assert.deepEqual((await api(base,route+'/export')).body.editingManifest,m);
 // Moving a phrase boundary must preserve the original generation cue while marking old images for regeneration.
 const changed=structuredClone(done.scenes),boundary=changed[0].sourceText.indexOf('문을');changed[1].sourceText=changed[0].sourceText.slice(boundary)+changed[1].sourceText;changed[0].sourceText=changed[0].sourceText.slice(0,boundary);
 assert.equal((await api(base,route+'/scenes','PUT',{scenes:changed})).status,200);
 const updated=(await api(base,route+'/export')).body.editingManifest;assert.ok(updated.cuts.every(c=>c.needsRegeneration));assert.notEqual(updated.cuts[1].sourceRange.start,updated.cuts[1].generatedCue.sourceRange.start);
 const frozen=await (await fetch(base+done.scenes[1].images[0].metadataUrl)).json();assert.deepEqual(frozen.cue,done.scenes[1].images[0].cue);
});
test('legacy repeated source is preserved, clearly marked, and blocked from misleading editing export or generation',async t=>{
 const p=fixture();p.scenes=validateScenes([shot(p.script)],p.script,[]);p.scenes.push({...structuredClone(p.scenes[0]),id:'duplicate',continuation:true});
 const {base}=await start(t,{projects:[p],presets:[],sources:[],favorites:[]});
 const stored=(await api(base,'state')).body.projects[0];assert.equal(stored.scenes.length,2);assert.match(stored.sourceMappingError,/누락\/중복/);assert.ok(stored.scenes.every(s=>!s.sourceRange));
 assert.equal((await api(base,'projects/project/editing-export')).status,400);assert.equal((await api(base,'projects/project/generate','POST',{})).status,400);
 const raw=(await api(base,'projects/project/export')).body;assert.equal(raw.editingManifest,null);assert.match(raw.sourceMappingError,/누락\/중복/);
});

test('editing a script while model preparation is pending rejects the stale image task',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'editing-preparation-')),binary=path.join(dir,'codex'),marker=path.join(dir,'started');
 await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs'),rl=require('node:readline');
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='model/list'){fs.writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>console.log(JSON.stringify({id:m.id,result:{data:[{model:'gpt-test',isDefault:true,inputModalities:['text']}],nextCursor:null}})),500);}});
`);await chmod(binary,0o755);
 const p=fixture(),{base}=await start(t,{projects:[p],presets:[],sources:[],favorites:[]},{CODEX_BIN:binary,SCENE_CODEX_MODEL:''});
 const pending=api(base,'projects/project/generate','POST',{});
 let preparing=false;for(let i=0;i<100;i++){try{await readFile(marker);preparing=true;break;}catch{await new Promise(r=>setTimeout(r,10));}}assert.ok(preparing);
 const update=await api(base,'projects/project','PUT',{script:p.script+' 새 대본.'});assert.equal(update.status,200);
 const result=await pending;assert.equal(result.status,400);assert.match(result.body.error,/생성 준비 중 대본/);
 const state=(await api(base,'state')).body.projects[0];assert.ok(state.scenes.every(s=>s.images.length===0&&s.status==='draft'));
});
