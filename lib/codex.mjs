import {spawn} from 'node:child_process';
import {accessSync,constants} from 'node:fs';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {analysisSchema,analysisPrompt} from './analysis.mjs';
export {analysisSchema,analysisPrompt} from './analysis.mjs';
export function findCodexBinary({override=process.env.CODEX_BIN,searchPath=process.env.PATH||'',applications=['/Applications',path.join(homedir(),'Applications')]}={}) {
  if(override)return override;
  const candidates=searchPath.split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,'codex'));
  for(const dir of applications)for(const app of ['ChatGPT.app','Codex.app']) {
    candidates.push(path.join(dir,app,'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'));
    candidates.push(path.join(dir,app,'Contents/Resources/codex'));
  }
  return candidates.find(file=>{try{accessSync(file,constants.X_OK);return true;}catch{return false;}})||'codex';
}
const binary=findCodexBinary();
export function runProcess(file,args,{cwd,input='',timeout=600000,env=process.env,label='Codex',missing,signal}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(signal.reason||Object.assign(Error('작업을 중단했습니다.'),{name:'AbortError'}));
    const child=spawn(file,args,{cwd,env,stdio:['pipe','pipe','pipe']}); let out='',err='',settled=false,forceTimer;
    const stop=()=>{child.kill('SIGTERM');forceTimer=setTimeout(()=>child.kill('SIGKILL'),3000);forceTimer.unref();};
    const cancel=()=>{stop();finish(signal.reason||Object.assign(Error('작업을 중단했습니다.'),{name:'AbortError'}));};
    const timer=setTimeout(()=>{stop();finish(Error(`${label} 응답 시간이 초과되었습니다.`));},timeout);
    signal?.addEventListener('abort',cancel,{once:true});
    function finish(e){if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);e?reject(Object.assign(e,{out,err})):resolve({out,err});}
    child.once('close',()=>clearTimeout(forceTimer));
    child.stdout.on('data',d=>{out+=d; if(out.length>8e6){stop();finish(Error(`${label} 출력 제한 초과`));}});child.stderr.on('data',d=>{err=(err+d).slice(-8000);});
    child.on('error',e=>finish(e.code==='ENOENT'&&missing?Error(missing):e));child.on('close',code=>finish(code?Object.assign(Error(`${label} 실패 (${code}): ${err.slice(-1600)} ${out.slice(-1600)}`),{out,err}):null));child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export function runCommand(args,options={}) {
  return runProcess(binary,args,{...options,env:codexEnv(),label:'Codex',missing:'이 Mac에서 Codex 실행 파일을 찾을 수 없습니다. ChatGPT 또는 Codex 앱을 설치하거나 CODEX_BIN을 지정해 주세요.'});
}
// Runs an official CLI's browser OAuth login in the background; stdin stays open for CLIs that ask to paste a code.
export function loginProcess(file,args,{env=process.env,missing,label,timeout=600000}={}) {
  const state={running:false,url:'',error:'',child:null};
  return {
    state:()=>({running:state.running,url:state.url,error:state.error}),
    start(){
      if(state.running)return this.state();
      Object.assign(state,{running:true,url:'',error:''});
      const child=state.child=spawn(file,args,{env,stdio:['pipe','pipe','pipe']});
      const timer=setTimeout(()=>{child.kill('SIGTERM');state.error='로그인 시간이 초과되었습니다. 다시 시도해 주세요.';},timeout);
      const scan=d=>{const m=/https:\/\/\S+/.exec(String(d));if(m&&!state.url)state.url=m[0];};
      child.stdout.on('data',scan);child.stderr.on('data',scan);child.stdin.on('error',()=>{});
      child.on('error',e=>{state.error=e.code==='ENOENT'&&missing?missing:e.message;});
      child.on('close',code=>{clearTimeout(timer);state.running=false;state.child=null;if(code&&!state.error)state.error=`${label} 로그인이 완료되지 않았습니다 (${code}).`;});
      return this.state();
    },
    submitCode(code){if(!state.running||!state.child)throw Error('진행 중인 로그인이 없습니다. 로그인 버튼을 다시 눌러 주세요.');state.child.stdin.write(code.trim()+'\n');return this.state();},
  };
}
export const codexEnv=()=>{const env={...process.env}; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; return env;};
export const codexLogin=loginProcess(binary,['login'],{env:codexEnv(),label:'Codex',missing:'Codex 실행 파일을 찾을 수 없습니다. ChatGPT 앱을 설치해 주세요.'});
export async function authStatus(){try{const {out,err}=await runCommand(['login','status'],{timeout:15000});return {ready:/ChatGPT/i.test(out+err),message:(out+err).trim(),binary};}catch(e){return {ready:false,message:e.message,binary};}}
export async function codexJSON({cwd,prompt,schema,images=[],timeout,model,signal}) {
  await mkdir(cwd,{recursive:true}); const schemaFile=path.join(cwd,'schema.json');const output=path.join(cwd,'result.json');await writeFile(schemaFile,JSON.stringify(schema));
  const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','-C',cwd,'-s','workspace-write','--json','--output-schema',schemaFile,'-o',output];
  const selectedModel=model||process.env.SCENE_CODEX_MODEL;
  if(selectedModel)args.push('-m',selectedModel);
  for(const image of images)args.push('-i',image); args.push('-');
  let response;
  try{response=await runCommand(args,{cwd,input:prompt,timeout,signal});}
  catch(error){await Promise.all([writeFile(path.join(cwd,'events.jsonl'),error.out||''),writeFile(path.join(cwd,'stderr.log'),error.err||'')]);throw error;}
  await writeFile(path.join(cwd,'events.jsonl'),response.out);
  return JSON.parse(await readFile(output,'utf8'));
}
const text={type:'string'};
export async function analyze({project,cwd,model,prompt,signal,timeout}) {
  return (await codexJSON({cwd,model,signal,timeout,schema:analysisSchema,prompt:prompt??analysisPrompt(project)})).scenes;
}
export async function generate({cwd,prompt,refs,model,signal}) {
  const schema={type:'object',properties:{imagePath:text,error:text},required:['imagePath','error'],additionalProperties:false};
  const result=await codexJSON({cwd,model,signal,schema,images:[...new Set(refs.map(r=>r.path))],timeout:900000,prompt:`Use the official image_gen.imagegen tool to generate exactly one image. Do not use API keys, browsers, SVG, Python drawing, or substitute generators. If the official tool is unavailable return error. For references, inspect attached images and pass all their absolute paths to referenced_image_paths. Preserve the role mapping in the image generation prompt: purpose=style images supply visual style only; purpose=location images supply the fixed geometry and appearance of their named physical space, with kind=location-sheet showing angles of ONE place; named character images supply identity; kind=character-sheet contains multiple views of one character, not extra people or a requested output layout. After the tool returns, copy its real generated raster image into this working directory as output.png (or output.webp/jpg). You may use shell only to copy the generated image. Return its absolute imagePath and empty error; otherwise empty imagePath and the real error.\nReference mapping: ${JSON.stringify(refs)}\n\n${prompt}`});
  if(result.error) {const e=Error(result.error);e.permanent=/unavailable|not available|지원하지|사용할 수 없|policy|정책/i.test(result.error);throw e;}
  const workingRoot=await realpath(cwd),imagePath=await realpath(path.resolve(cwd,result.imagePath));if(!imagePath.startsWith(workingRoot+path.sep))throw Error('이미지 결과가 작업 폴더 외부에 있습니다.');
  const data=await readFile(imagePath); const ext=imageType(data); if(!ext)throw Error('공식 생성 결과가 유효한 PNG/JPEG/WebP 이미지가 아닙니다.');
  return {data,ext};
}
export function imageType(b){if(b.length<12)return null;if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';if(b[0]===255&&b[1]===216&&b[2]===255)return 'jpg';if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'webp';return null;}
