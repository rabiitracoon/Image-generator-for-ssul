import http from 'node:http';
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {id,validateScenes,composePrompt,Queue} from './lib/core.mjs';
import {authStatus,analyze,generate,imageType,codexLogin} from './lib/codex.mjs';
import {CLAUDE_MODELS,claudeAuthStatus,analyzeWithClaude,claudeLogin} from './lib/claude.mjs';
import {IMAGE_MODELS,IMAGE_QUALITIES,generateWithOpenAI} from './lib/openai-image.mjs';
import {parseRepo,syncSource} from './lib/presets.mjs';
import {REFERENCE_FOLDER,migrateReferences,portableReferencePath,resolveProjectReferences,resolveStyleReferences} from './lib/references.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url)),DATA=path.resolve(process.env.SCENE_DATA_DIR||path.join(ROOT,'data')),PORT=Number(process.env.PORT||4317);
const REFERENCE_DIR=path.resolve(process.env.SCENE_REFERENCE_DIR||path.join(ROOT,REFERENCE_FOLDER));
await mkdir(DATA,{recursive:true});
let db;try{db=JSON.parse(await readFile(path.join(DATA,'state.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;db={projects:[],presets:[],sources:[],favorites:[]};}
const DEFAULT_SETTINGS={textProvider:'codex',claudeModel:'sonnet',imageProvider:'codex',imageModel:IMAGE_MODELS[0],imageQuality:'auto'};
db.settings={...DEFAULT_SETTINGS,...db.settings};
// The API key lives outside state.json so /api/state and project exports never contain it.
const SECRETS=path.join(DATA,'secrets.json');let secrets={};try{secrets=JSON.parse(await readFile(SECRETS,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
async function saveSecrets(){await writeFile(SECRETS+'.tmp',JSON.stringify(secrets),{mode:0o600});await rename(SECRETS+'.tmp',SECRETS);}
const openaiKey=()=>secrets.openaiApiKey||process.env.OPENAI_API_KEY||'';
const openaiStatus=()=>{const key=openaiKey();return {configured:!!key,source:secrets.openaiApiKey?'saved':key?'env':null,last4:key?key.slice(-4):''};};
const engineLabel=s=>s.imageProvider==='openai'?s.imageModel:'codex';
const beforeMigration=JSON.stringify(db,null,2);
const migration=await migrateReferences(db,{dataDir:DATA,referenceDir:REFERENCE_DIR});
if(migration.changed){await mkdir(path.join(DATA,'backups'),{recursive:true});await writeFile(path.join(DATA,'backups',`reference-paths-${Date.now()}-${id()}.json`),beforeMigration);}
if(migration.missing.length)console.warn(`참고 이미지 파일을 찾을 수 없습니다: ${migration.missing.join(', ')}. 참고이미지 폴더를 확인해 주세요.`);
for(const p of db.projects){p.analyzing=false;for(const s of p.scenes)if(['queued','running','retrying'].includes(s.status)){s.status='failed';s.error='앱이 종료되어 작업이 중단되었습니다. 재생성해 주세요.';}}
let writes=Promise.resolve();function save(){const value=JSON.stringify(db,null,2);writes=writes.catch(()=>{}).then(async()=>{await writeFile(path.join(DATA,'state.tmp'),value);await rename(path.join(DATA,'state.tmp'),path.join(DATA,'state.json'));});return writes;}await save();
function editedScenes(p, scenes, script) {
 const valid=validateScenes(scenes,script,p.characters);
 if(new Set(scenes.map(s=>s.id).filter(Boolean)).size!==scenes.filter(s=>s.id).length)throw Error('장면 ID가 중복되었습니다.');
 for(const s of scenes)style(s.styleId??null);
 const previous=new Map(p.scenes.map(s=>[s.id,s]));
 return valid.map((v,i)=>{const input=scenes[i],old=previous.get(input.id);const styleId=input.styleId??null;
 const changed=!old||['prompt','sourceText'].some(k=>old[k]!==v[k])||JSON.stringify(old.characterIds)!==JSON.stringify(v.characterIds)||old.styleId!==styleId;
 return {...v,id:old?.id||(/^[a-f0-9-]{36}$/.test(input.id||'')?input.id:v.id),images:old?.images||[],status:changed?'draft':old.status,attempts:old?.attempts||0,error:changed?'':old?.error||'',styleId};});
}
const project=(pid)=>{const p=db.projects.find(p=>p.id===pid);if(!p)throw Error('프로젝트를 찾을 수 없습니다.');return p;};
const scenePrompt=async(p,s)=>{
 const styleId=s.styleId===null?p.defaultStyleId:s.styleId;
 const selectedStyle=await resolveStyleReferences(db.presets.find(style=>style.id===styleId),REFERENCE_DIR);
 return composePrompt(await resolveProjectReferences({...p,characters:p.characters.filter(c=>s.characterIds.includes(c.id))},REFERENCE_DIR),s,selectedStyle?[selectedStyle]:db.presets);
};
const busy=p=>p.analyzing||p.scenes.some(s=>queue.keys.has(`${p.id}/${s.id}`));
const usesStyle=(p,styleId)=>p.defaultStyleId===styleId||p.scenes.some(s=>s.styleId===styleId);
function invalidateStyle(styleId){for(const p of db.projects)for(const s of p.scenes)if((s.styleId===null?p.defaultStyleId:s.styleId)===styleId)s.status='draft';}
function invalidateCharacter(p,characterId){for(const s of p.scenes)if(s.characterIds.includes(characterId))s.status='draft';}
const queue=new Queue({limit:3,retries:2,run:async task=>{const r=task.engine?.provider==='openai'?await generateWithOpenAI({...task,...task.engine,apiKey:openaiKey()}):await generate(task);const filename=`${id()}.${r.ext}`;await mkdir(path.join(DATA,'images'),{recursive:true});await writeFile(path.join(DATA,'images',filename),r.data);return {url:`/media/images/${filename}`,createdAt:new Date().toISOString(),prompt:task.prompt,style:task.style,engine:task.engine?.provider==='openai'?task.engine.model:'codex'};},onChange:async(key,status,info)=>{const [pid,sid]=key.split('/');const s=project(pid).scenes.find(s=>s.id===sid);s.status=status;s.attempts=info.attempt;s.error=info.error||'';if(info.result)s.images.push(info.result);await save();}});
function str(v,max=100000){if(typeof v!=='string'||v.length>max)throw Error('텍스트 값 또는 길이가 올바르지 않습니다.');return v;}
function style(v){if(v!==null&&v!==''&&!db.presets.some(p=>p.id===v))throw Error('존재하지 않는 스타일입니다.');return v;}
function uploadedImage(input){const displayName=str(input.name,200);const data=Buffer.from(str(input.base64,44e6),'base64');const ext=imageType(data);if(!ext||data.length>32e6)throw Error('PNG/JPEG/WebP 파일만 지원합니다 (최대 32MB).');return {displayName,data,ext};}
async function storeReference({displayName,data,ext},extra={}){const name=`${id()}.${ext}`;await writeFile(path.join(REFERENCE_DIR,name),data);return {id:id(),name:displayName,path:portableReferencePath(name),url:`/media/references/${name}`,...extra};}
async function body(req){let b='';for await(const c of req){b+=c;if(b.length>45e6)throw Error('업로드는 32MB 이하로 나누어 주세요.');}return b?JSON.parse(b):{};}
function send(res,status,data,type='application/json'){res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"});res.end(type==='application/json'?JSON.stringify(data):data);}
const syncs=new Set();
async function api(req,res,url){const b=req.method==='GET'?{}:await body(req);const parts=url.pathname.split('/').filter(Boolean).map(part=>decodeURIComponent(part));const [,resource,pid,action,sid]=parts;
 if(resource==='health'&&req.method==='GET')return send(res,200,{application:'scene-studio',root:ROOT});
 if(resource==='status'){
  const settings=db.settings,useCodex=settings.textProvider==='codex'||settings.imageProvider==='codex';
  const [codex,claude]=await Promise.all([useCodex?authStatus():null,settings.textProvider==='claude'?claudeAuthStatus():null]);if(claude)claude.login=claudeLogin.state();if(codex){codex.login=codexLogin.state();if(!codex.ready)codex.message+='\n[ChatGPT 로그인] 버튼을 눌러 로그인해 주세요.';}const openai=openaiStatus();
  const text=settings.textProvider==='claude'?claude:codex,image=settings.imageProvider==='openai'?{ready:openai.configured,message:openai.configured?'':'OpenAI API 키가 없습니다. AI 설정에서 키를 입력해 주세요.'}:codex;
  return send(res,200,{ready:text.ready&&image.ready,message:[...new Set([text,image].filter(x=>!x.ready).map(x=>x.message))].join('\n'),text,image,codex,claude,openai,settings,queue:{active:queue.active,pending:queue.pending.length},imageModel:settings.imageProvider==='openai'?`${settings.imageModel} (OpenAI API, 품질 ${settings.imageQuality})`:'Codex 공식 이미지 도구 자동 선택 (직접 지정 불가)'});
 }
 if(resource==='login'&&req.method==='POST'){const login={codex:codexLogin,claude:claudeLogin}[pid];if(!login)throw Error('알 수 없는 로그인 서비스입니다.');
  if(action==='code'){const code=str(b.code,2000);if(!code.trim())throw Error('인증 코드를 입력해 주세요.');return send(res,200,login.submitCode(code));}
  return send(res,202,login.start());}
 if(resource==='settings'&&req.method==='GET')return send(res,200,{settings:db.settings,openai:openaiStatus(),options:{claudeModels:CLAUDE_MODELS,imageModels:IMAGE_MODELS,imageQualities:IMAGE_QUALITIES}});
 if(resource==='settings'&&req.method==='PUT'){
  const allowed={textProvider:['codex','claude'],claudeModel:CLAUDE_MODELS,imageProvider:['codex','openai'],imageModel:IMAGE_MODELS,imageQuality:IMAGE_QUALITIES};const next={...db.settings};
  for(const [k,values] of Object.entries(allowed))if(k in b){if(!values.includes(b[k]))throw Error(`지원하지 않는 설정 값입니다: ${k}`);next[k]=b[k];}
  const nextSecrets={...secrets};if(b.clearOpenaiKey)delete nextSecrets.openaiApiKey;
  else if(typeof b.openaiApiKey==='string'&&b.openaiApiKey.trim()){const key=b.openaiApiKey.trim();if(!/^\S{20,300}$/.test(key))throw Error('OpenAI API 키 형식이 올바르지 않습니다.');nextSecrets.openaiApiKey=key;}
  if(next.imageProvider==='openai'&&!(nextSecrets.openaiApiKey||process.env.OPENAI_API_KEY))throw Error('OpenAI API 이미지 생성을 사용하려면 API 키를 입력해 주세요.');
  if(JSON.stringify(nextSecrets)!==JSON.stringify(secrets)){secrets=nextSecrets;await saveSecrets();}
  db.settings=next;await save();return send(res,200,{settings:db.settings,openai:openaiStatus()});
 }
 if(resource==='state'&&req.method==='GET')return send(res,200,db);
 if(resource==='styles'){
  const existing=pid?db.presets.find(style=>style.id===pid):null;
  if(pid&&(!existing||existing.sourceType!=='custom'))throw Error('직접 만든 스타일만 수정할 수 있습니다. 저장소 스타일은 복사해서 편집해 주세요.');
  if(existing&&db.projects.some(p=>usesStyle(p,pid)&&busy(p)))throw Error('이 스타일로 작업이 진행 중입니다. 완료 후 수정해 주세요.');
  if((req.method==='POST'&&!pid)||(req.method==='PUT'&&existing)){
   const name=str(b.name||'',200).trim(),prompt=str(b.prompt||'',20000).trim();
   if(!name)throw Error('스타일 이름을 입력해 주세요.');
   const previous=existing?.references||[];
   const keep=b.referenceIds??previous.map(r=>r.id);
   if(!Array.isArray(keep)||new Set(keep).size!==keep.length||keep.some(key=>!previous.some(r=>r.id===key)))throw Error('스타일 참고 이미지 선택이 올바르지 않습니다.');
   const references=keep.map(key=>previous.find(r=>r.id===key));
   const images=b.images??[];
   if(!Array.isArray(images)||references.length+images.length>5)throw Error('스타일 참고 이미지는 최대 5장입니다.');
   if(!prompt&&!references.length&&!images.length)throw Error('스타일 프롬프트 또는 참고 이미지를 입력해 주세요.');
   const uploads=images.map(uploadedImage);
   if(uploads.reduce((sum,item)=>sum+item.data.length,0)>32e6)throw Error('한 번에 업로드하는 스타일 이미지의 합계는 32MB 이하로 해 주세요.');
   for(const upload of uploads)references.push(await storeReference(upload,{purpose:'style'}));
   const custom={id:existing?.id||`custom:${id()}`,sourceType:'custom',category:'내 스타일',name,prompt,references,previewUrls:references.map(r=>r.url),updatedAt:new Date().toISOString()};
   if(existing){invalidateStyle(existing.id);Object.assign(existing,custom);}else db.presets.unshift(custom);
   await save();return send(res,existing?200:201,custom);
  }
  if(req.method==='DELETE'&&existing){invalidateStyle(pid);for(const p of db.projects){if(p.defaultStyleId===pid)p.defaultStyleId='';for(const s of p.scenes)if(s.styleId===pid)s.styleId='';}db.presets=db.presets.filter(s=>s.id!==pid);db.favorites=db.favorites.filter(key=>key!==pid);await save();return send(res,200,{deleted:true});}
 }
 if(resource==='projects'&&req.method==='POST'&&!pid){const p={id:id(),name:str(b.name||'새 프로젝트',200),script:'',constraints:'',aspectRatio:'16:9',defaultStyleId:'',characters:[],scenes:[],createdAt:new Date().toISOString()};db.projects.push(p);await save();return send(res,201,p);}
 if(resource==='projects'&&pid){const p=project(pid);
  if(req.method==='PUT'&&!action){if(busy(p))throw Error('작업이 진행 중입니다. 완료 후 편집해 주세요.');const changes={};for(const k of ['name','script','constraints'])if(k in b)changes[k]=str(b[k]);if('defaultStyleId'in b)changes.defaultStyleId=style(b.defaultStyleId);if('aspectRatio'in b){if(!['16:9','9:16','1:1','4:3'].includes(b.aspectRatio))throw Error('화면 비율 오류');changes.aspectRatio=b.aspectRatio;}if('scenes'in b)changes.scenes=editedScenes(p,b.scenes,changes.script??p.script);if(['constraints','aspectRatio','defaultStyleId'].some(k=>k in changes&&changes[k]!==p[k])){changes.scenes=(changes.scenes||p.scenes).map(s=>({...s,status:'draft'}));}Object.assign(p,changes);await save();return send(res,200,p);}
  if(action==='characters'&&req.method==='POST'){if(busy(p))throw Error('작업 완료 후 캐릭터를 수정해 주세요.');const c={id:id(),name:str(b.name,100),description:str(b.description||'',10000),references:[]};if(!c.name.trim())throw Error('캐릭터 이름이 필요합니다.');p.characters.push(c);await save();return send(res,201,c);}
  if(action==='characters'&&sid&&req.method==='DELETE'){if(busy(p))throw Error('작업 중입니다.');p.characters=p.characters.filter(c=>c.id!==sid);for(const s of p.scenes)s.characterIds=s.characterIds.filter(x=>x!==sid);await save();return send(res,200,p);}
  if(action==='references'&&req.method==='POST'){if(busy(p))throw Error('작업 중입니다.');const c=p.characters.find(c=>c.id===b.characterId);if(!c)throw Error('캐릭터를 찾을 수 없습니다.');if(c.references.length>=10)throw Error('캐릭터당 레퍼런스 최대 10장');const kind=b.kind||'reference';if(!['reference','character-sheet'].includes(kind))throw Error('참고 이미지 종류가 올바르지 않습니다.');c.references.push(await storeReference(uploadedImage(b),{kind}));invalidateCharacter(p,c.id);await save();return send(res,201,c);}
  if(action==='references'&&req.method==='DELETE'){if(busy(p))throw Error('작업 중입니다.');for(const c of p.characters){if(c.references.some(r=>r.id===sid))invalidateCharacter(p,c.id);c.references=c.references.filter(r=>r.id!==sid);}await save();return send(res,200,p);}
  if(action==='analyze'&&req.method==='POST'){if(busy(p))throw Error('이미 작업 중입니다.');if(!p.script.trim())throw Error('대본을 입력해 주세요.');p.analyzing=true;p.analysisError='';await save();send(res,202,{accepted:true});(async()=>{try{const job={project:structuredClone(p),cwd:path.join(DATA,'jobs',id())};const scenes=db.settings.textProvider==='claude'?await analyzeWithClaude({...job,model:db.settings.claudeModel}):await analyze(job);p.scenes=validateScenes(scenes,p.script,p.characters);}catch(e){p.analysisError=e.message;}finally{p.analyzing=false;await save();}})();return;}
  if(action==='scenes'&&req.method==='PUT'){if(busy(p))throw Error('작업 중입니다.');if(!Array.isArray(b.scenes)||b.scenes.length>100)throw Error('장면 형식 오류');p.scenes=editedScenes(p,b.scenes,p.script);await save();return send(res,200,p);}
  if(action==='preview'&&req.method==='POST'){const s=p.scenes.find(s=>s.id===b.sceneId);if(!s)throw Error('장면 없음');return send(res,200,await scenePrompt(p,s));}
  if(action==='generate'&&req.method==='POST'){if(p.analyzing)throw Error('분석 중입니다.');const selected=b.sceneIds? p.scenes.filter(s=>b.sceneIds.includes(s.id)):p.scenes.filter(s=>!s.images.length||['failed','draft'].includes(s.status));if(!selected.length)throw Error('생성할 장면이 없습니다.');const tasks=await Promise.all(selected.filter(s=>!queue.keys.has(`${p.id}/${s.id}`)).map(async s=>({s,task:{...await scenePrompt(p,s),aspectRatio:p.aspectRatio,engine:{provider:db.settings.imageProvider,model:db.settings.imageModel,quality:db.settings.imageQuality},cwd:path.join(DATA,'jobs',id())}})));const available=tasks.filter(({s})=>!queue.keys.has(`${p.id}/${s.id}`));for(const {s,task}of available){s.status='queued';s.error='';queue.add(`${p.id}/${s.id}`,task);}await save();return send(res,202,{queued:available.length});}
  if(action==='export'&&req.method==='GET'){res.setHeader('Content-Disposition',`attachment; filename="project-${p.id}.json"`);return send(res,200,p);}
 }
 if(resource==='sources'&&req.method==='POST'&&!pid){parseRepo(b.url);if(db.sources.some(s=>s.url===b.url&&s.ref===(b.ref||'')))throw Error('이미 등록된 저장소입니다.');const s={id:id(),url:str(b.url,500),ref:str(b.ref||'',200),warnings:[]};db.sources.push(s);await save();return send(res,201,s);}
 if(resource==='sources'&&pid&&action==='sync'&&req.method==='POST'){const s=db.sources.find(s=>s.id===pid);if(!s)throw Error('저장소 없음');if(syncs.has(pid))throw Error('이미 동기화 중입니다.');syncs.add(pid);try{const r=await syncSource(s,db.presets.filter(p=>p.sourceId===pid));db.presets=[...db.presets.filter(p=>p.sourceId!==pid),...r.presets];Object.assign(s,{warnings:r.warnings,sha:r.sha,syncedAt:r.syncedAt,error:''});await save();return send(res,200,s);}catch(e){s.error=e.message;await save();throw e;}finally{syncs.delete(pid);}}
 if(resource==='favorites'&&req.method==='POST'){if(!db.presets.some(p=>p.id===b.id))throw Error('프리셋 없음');db.favorites=db.favorites.includes(b.id)?db.favorites.filter(x=>x!==b.id):[...db.favorites,b.id];await save();return send(res,200,db.favorites);}
 send(res,404,{error:'요청을 찾을 수 없습니다.'});
}
const server=http.createServer(async(req,res)=>{try{
 const expected=new Set([`127.0.0.1:${PORT}`,`localhost:${PORT}`]);if(!expected.has(req.headers.host))return send(res,403,{error:'로컬 접속만 허용됩니다.'});
 if(req.headers.origin&&!new Set([`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`]).has(req.headers.origin))return send(res,403,{error:'다른 사이트의 요청은 허용되지 않습니다.'});
 if(!['GET','HEAD'].includes(req.method)&&!req.headers['content-type']?.startsWith('application/json'))return send(res,415,{error:'JSON 요청만 허용됩니다.'});
 const url=new URL(req.url,`http://127.0.0.1:${PORT}`);if(url.pathname.startsWith('/api/'))return await api(req,res,url);
 let file,type;if(url.pathname.startsWith('/media/')){const m=/^\/media\/(images|references)\/([a-f0-9-]+\.(png|jpg|webp))$/.exec(url.pathname);if(!m)return send(res,404,{error:'파일 없음'});file=m[1]==='references'?path.join(REFERENCE_DIR,m[2]):path.join(DATA,'images',m[2]);type=`image/${m[3]==='jpg'?'jpeg':m[3]}`;}else {const routes={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/view-model.js':['view-model.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/custom-style.css':['custom-style.css','text/css; charset=utf-8']};const r=routes[url.pathname];if(!r)return send(res,404,{error:'파일 없음'});file=path.join(ROOT,'public',r[0]);type=r[1];}send(res,200,await readFile(file),type);
 }catch(e){send(res,e.code==='ENOENT'?404:400,{error:e.message});}});
server.listen(PORT,'127.0.0.1',()=>console.log(`Scene Studio: http://127.0.0.1:${PORT}`));
