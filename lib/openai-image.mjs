import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {imageType} from './codex.mjs';
export const IMAGE_MODELS=['gpt-image-2.5-flare','gpt-image-2.5-sunburst'];
export const IMAGE_QUALITIES=['auto','low','medium','high','xhigh','max'];
export const MAX_API_REFERENCES=16;
// Sizes are multiples of 16 that keep the project's aspect ratio.
export const API_SIZES={'16:9':'2048x1152','9:16':'1152x2048','1:1':'1024x1024','4:3':'1536x1152'};
const MIME={png:'image/png',jpg:'image/jpeg',webp:'image/webp'};
export function referenceLegend(refs) {
  const unique=refs.filter((r,i)=>refs.findIndex(x=>x.path===r.path)===i);
  if(unique.length>MAX_API_REFERENCES)throw Object.assign(Error(`이 컷의 참고 이미지가 ${unique.length}장입니다. 최대 ${MAX_API_REFERENCES}장까지 전달할 수 있으므로 캐릭터 또는 스타일 첨부를 줄여 주세요.`),{permanent:true});
  const lines=unique.map((r,i)=>`Image ${i+1}: ${r.purpose==='style'?`style reference "${r.style}" — visual style only`:r.purpose==='location'?`location "${r.location}" (multiple angles of ONE place) — environment geometry and appearance only`:`character "${r.character}"${r.kind==='character-sheet'?' (character-sheet: multiple views of ONE character)':''} — identity only`}`);
  return {unique,legend:lines.length?`ATTACHED REFERENCE IMAGES (upload order)\n${lines.join('\n')}\n\n`:''};
}
export async function generateWithOpenAI({prompt,refs=[],aspectRatio='16:9',apiKey,model=IMAGE_MODELS[0],quality='auto',baseUrl=process.env.OPENAI_BASE_URL||'https://api.openai.com/v1',timeout=600000,signal,fetchImpl=fetch}) {
  if(!apiKey)throw Object.assign(Error('OpenAI API 키가 없습니다. AI 설정에서 키를 입력해 주세요.'),{permanent:true});
  const {unique,legend}=referenceLegend(refs);
  const fields={model,prompt:legend+prompt,size:API_SIZES[aspectRatio]||'auto',quality,n:'1'};
  const headers={Authorization:`Bearer ${apiKey}`};let body;
  if(unique.length){
    body=new FormData();for(const [k,v] of Object.entries(fields))body.append(k,v);
    for(const r of unique){const data=await readFile(r.path);const ext=imageType(data);if(!ext)throw Object.assign(Error(`참고 이미지 형식 오류: ${r.name||path.basename(r.path)}`),{permanent:true});body.append('image[]',new Blob([data],{type:MIME[ext]}),path.basename(r.path));}
  } else {headers['Content-Type']='application/json';body=JSON.stringify({...fields,n:1});}
  let response;
  try{response=await fetchImpl(`${baseUrl.replace(/\/$/,'')}/images/${unique.length?'edits':'generations'}`,{method:'POST',headers,body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});}
  catch(e){throw Error(e.name==='TimeoutError'?'OpenAI 이미지 API 응답 시간이 초과되었습니다.':`OpenAI 이미지 API 연결 실패: ${e.message}`);}
  const result=await response.json().catch(()=>({}));
  if(!response.ok){
    const message=result.error?.message||response.statusText;
    const permanent=[400,401,403,404].includes(response.status)||result.error?.code==='insufficient_quota';
    throw Object.assign(Error(`OpenAI 이미지 API 오류 (${response.status}): ${message}`),{permanent});
  }
  const b64=result.data?.[0]?.b64_json;if(!b64)throw Error('OpenAI 이미지 API 응답에 이미지가 없습니다.');
  const data=Buffer.from(b64,'base64');const ext=imageType(data);if(!ext)throw Error('OpenAI 이미지 API 결과가 유효한 PNG/JPEG/WebP 이미지가 아닙니다.');
  return {data,ext};
}
