import {accessSync,constants,readdirSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {runProcess,loginProcess,analysisSchema,analysisPrompt} from './codex.mjs';
export const CLAUDE_MODELS=['sonnet','opus','haiku'];
const executable=file=>{try{accessSync(file,constants.X_OK);return true;}catch{return false;}};
const versionKey=v=>v.split('.').map(n=>String(Number(n)||0).padStart(6,'0')).join('.');
// The Claude desktop app keeps its own copy of Claude Code under Application Support/<version>/<hash>/claude.app.
function bundledClaude(home) {
  const base=path.join(home,'Library/Application Support/Claude/claude-code');
  let versions=[];try{versions=readdirSync(base).sort((a,b)=>versionKey(b).localeCompare(versionKey(a)));}catch{return [];}
  return versions.flatMap(v=>{try{return readdirSync(path.join(base,v)).map(h=>path.join(base,v,h,'claude.app/Contents/MacOS/claude'));}catch{return [];}});
}
export function findClaudeBinary({override=process.env.CLAUDE_BIN,searchPath=process.env.PATH||'',home=homedir()}={}) {
  if(override)return override;
  const candidates=[...searchPath.split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,'claude')),
    path.join(home,'.claude/local/claude'),path.join(home,'.local/bin/claude'),'/opt/homebrew/bin/claude','/usr/local/bin/claude',...bundledClaude(home)];
  return candidates.find(executable)||'claude';
}
const binary=findClaudeBinary();
const MISSING='이 Mac에서 Claude Code 실행 파일을 찾을 수 없습니다. Claude Code를 설치하거나 CLAUDE_BIN을 지정해 주세요.';
// Force the subscription (OAuth) login: drop API keys and nested-session markers inherited from the launching shell.
function claudeEnv(){const env={...process.env};for(const k of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT'])delete env[k];return env;}
const run=(args,options={})=>runProcess(binary,args,{...options,env:claudeEnv(),label:'Claude',missing:MISSING});
const loginHint='[Claude 로그인] 버튼을 눌러 Claude 계정으로 로그인해 주세요.';
export const claudeLogin=loginProcess(binary,['auth','login','--claudeai'],{env:claudeEnv(),label:'Claude',missing:MISSING});
export async function claudeAuthStatus() {
  // `auth status` exits non-zero when logged out but still prints its JSON report.
  let out;try{({out}=await run(['auth','status','--json'],{timeout:15000}));}catch(e){out=e.out;if(!out)return {ready:false,message:e.message,binary};}
  let s;try{s=JSON.parse(out);}catch{return {ready:false,message:`Claude 로그인 상태를 확인하지 못했습니다. ${loginHint}`,binary};}
  return {ready:!!s.loggedIn,message:s.loggedIn?`Claude 로그인됨 (${s.authMethod})`:`Claude 로그인 필요. ${loginHint}`,binary};
}
export function parseClaudeResult(out) {
  let r;try{r=JSON.parse(out.trim());}catch{throw Error('Claude 응답을 해석하지 못했습니다.');}
  if(r.is_error){const msg=String(r.result||r.subtype||'알 수 없는 오류');throw Error(/log ?in|auth/i.test(msg)?`Claude 로그인 필요: ${msg}. ${loginHint}`:`Claude 실패: ${msg}`);}
  if(r.structured_output&&typeof r.structured_output==='object')return r.structured_output;
  const text=String(r.result||'');const m=/\{[\s\S]*\}/.exec(text);
  try{return JSON.parse(m?m[0]:text);}catch{throw Error('Claude가 JSON 결과를 반환하지 않았습니다.');}
}
export async function claudeJSON({cwd,prompt,schema,model='sonnet',timeout=600000}) {
  await mkdir(cwd,{recursive:true});
  const args=['-p','--output-format','json','--json-schema',JSON.stringify(schema),'--tools','','--strict-mcp-config','--setting-sources','','--no-session-persistence','--model',model];
  let response;
  try{response=await run(args,{cwd,input:prompt,timeout});}
  catch(e){let r;try{r=JSON.parse(e.out||'');}catch{throw e;}if(r?.type==='result')return parseClaudeResult(e.out);throw e;}
  await writeFile(path.join(cwd,'claude-result.json'),response.out);
  return parseClaudeResult(response.out);
}
export async function analyzeWithClaude({project,cwd,model}) {
  return (await claudeJSON({cwd,model,schema:analysisSchema,prompt:analysisPrompt(project)})).scenes;
}
