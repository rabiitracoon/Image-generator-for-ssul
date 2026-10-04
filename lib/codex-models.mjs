import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {findCodexBinary,codexEnv} from './codex.mjs';

// Read the installed CLI's catalog; never start a model turn to discover models.
// Protocol: https://learn.chatgpt.com/docs/app-server#list-models-modellist
export function listCodexModels({binary=findCodexBinary(),env=codexEnv(),timeout=20000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['app-server'],{env,stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:child.stdout});
    let settled=false,requestId=1,models=[],pages=0;
    const timer=setTimeout(()=>finish(Error('GPT 모델 목록 조회 시간이 초과되었습니다.')),timeout);
    function finish(error){
      if(settled)return;settled=true;clearTimeout(timer);lines.close();child.stdin.end();child.kill('SIGTERM');
      const force=setTimeout(()=>child.kill('SIGKILL'),1000);force.unref();child.once('close',()=>clearTimeout(force));
      error?reject(error):resolve(models);
    }
    const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
    child.stdin.on('error',error=>finish(error));child.stderr.resume();
    child.on('error',error=>finish(Error(error.code==='ENOENT'?'Codex 실행 파일을 찾을 수 없습니다.':error.message)));
    child.on('close',()=>finish(Error('Codex가 모델 목록을 반환하지 못했습니다.')));
    lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      if(message.id!==requestId)return;
      if(message.error)return finish(Error(`GPT 모델 목록 조회 실패: ${message.error.message}`));
      if(requestId===1){
        send({method:'initialized',params:{}});requestId++;
        send({id:requestId,method:'model/list',params:{limit:100,includeHidden:false}});return;
      }
      if(!Array.isArray(message.result?.data))return finish(Error('GPT 모델 목록 형식이 올바르지 않습니다.'));
      models.push(...message.result.data.filter(m=>m.model&&!m.hidden&&(!m.inputModalities||m.inputModalities.includes('text'))).map(m=>({model:m.model,displayName:m.displayName||m.model,isDefault:!!m.isDefault,description:m.description||''})));
      if(message.result.nextCursor){
        if(++pages>20)return finish(Error('GPT 모델 목록 페이지가 너무 많습니다.'));
        requestId++;send({id:requestId,method:'model/list',params:{limit:100,includeHidden:false,cursor:message.result.nextCursor}});
      }else finish(models.length?null:Error('선택 가능한 GPT 모델이 없습니다. ChatGPT 로그인을 확인해 주세요.'));
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'scene_studio',title:'Scene Studio',version:'1.1.0'}}});
  });
}

let cached=null,pending=null;
export async function codexModelCatalog({refresh=false}={}) {
  if(!refresh&&cached&&Date.now()-cached.at<300000)return cached;
  if(pending)return pending;
  pending=listCodexModels().then(models=>({models,error:'',at:Date.now()})).catch(error=>({models:[],error:error.message,at:Date.now()-240000}));
  try{cached=await pending;return cached;}finally{pending=null;}
}

export function effectiveCodexModel(settings,catalog,envModel=process.env.SCENE_CODEX_MODEL||'') {
  const model=settings.codexModel||envModel||catalog.models.find(m=>m.isDefault)?.model||'';
  return {model,displayName:catalog.models.find(m=>m.model===model)?.displayName||model,source:settings.codexModel?'settings':envModel?'environment':'default',error:model?'':catalog.error||'기본 GPT 모델을 확인하지 못했습니다. AI 설정에서 모델을 직접 지정해 주세요.'};
}
export async function requireCodexModel(settings) {
  const info=effectiveCodexModel(settings,settings.codexModel||process.env.SCENE_CODEX_MODEL?{models:[],error:''}:await codexModelCatalog());
  if(!info.model)throw Error(info.error);
  return info;
}
