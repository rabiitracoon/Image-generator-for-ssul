import {createHash} from 'node:crypto';
export function parseRepo(url){const m=/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/.exec(url.trim());if(!m)throw Error('https://github.com/소유자/저장소 형식으로 입력해 주세요. 브랜치는 별도 입력합니다.');return {owner:m[1],repo:m[2].replace(/\.git$/,'')};}

function imageCandidates(p) {
  const candidates=[p.preview_image,p.previewImage,p.image_url,p.image,p.thumbnail,...(Array.isArray(p.output_images)?p.output_images:[]),...(Array.isArray(p.remote_images)?p.remote_images:[]),...(Array.isArray(p.images)?p.images:[])];
  const references=new Set((p.reference_images||[]).filter?.(x=>typeof x==='string')||[]);
  return [...new Set(candidates.map(x=>typeof x==='string'?x:x?.url||x?.src).filter(x=>typeof x==='string'&&!references.has(x)))].slice(0,8);
}
function markdownImages(section) {
  return [...section.matchAll(/!\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)|<img\b[^>]*?src=["']([^"']+)["'][^>]*>/gi)].map(m=>m[1]||m[2]).slice(0,8);
}
export function resolvePreviewURL(value,{owner,repo,sha,file}) {
  if(typeof value!=='string'||!value.trim()||/^(?:data|javascript|file|blob):/i.test(value))return null;
  try {
    const base=`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/`;
    const url=new URL(value.startsWith('/')&&!value.startsWith('//')?value.slice(1):value,value.startsWith('/')?base:new URL(file,base));
    if(url.protocol!=='https:'||url.username||url.password)return null;
    const host=url.hostname.toLowerCase();
    if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host))return null;
    if(host==='github.com'&&url.pathname.includes('/blob/')){url.hostname='raw.githubusercontent.com';url.pathname=url.pathname.replace('/blob/','/');}
    return url.href;
  } catch{return null;}
}

export function parsePresets(content,file){
  if(/\.json$/i.test(file)) {
    const obj=JSON.parse(content); const items=Array.isArray(obj)?obj:Array.isArray(obj.presets)?obj.presets:Array.isArray(obj.styles)?obj.styles:[obj];
    const result=[]; for(const p of items){if(!p || typeof p!=='object')continue;const prompt=p.style_prompt||p.prompt||p.content||p.style;const name=p.name||p.title||p.id;if(typeof prompt==='string'&&prompt.trim()&&typeof name==='string'){const previews=imageCandidates(p);result.push({key:String(p.id||name),name,prompt,...(previews.length?{previewCandidates:previews}:{}),...(typeof p.description==='string'?{description:p.description}:{}),...(typeof p.category==='string'?{category:p.category}:{})});}} return result;
  }
  const sections=content.split(/(?=^#{1,4}\s+)/m), result=[];
  for(const section of sections){const heading=/^#{1,4}\s+(.+)$/m.exec(section)?.[1];if(!heading)continue; const blocks=[...section.matchAll(/```(?:text|markdown|prompt|plaintext)?\s*\n([\s\S]*?)```/g)].map(m=>m[1].trim()).filter(Boolean);let prompt=blocks.join('\n\n');
    if(!prompt){const match=/(?:\*\*)?(?:Prompt|프롬프트|Style prompt)(?:\*\*)?\s*[:：]\s*([\s\S]+)/i.exec(section);if(match)prompt=match[1].replace(/!\[[^\]]*\]\([^)]*\)/g,'').trim();}
    if(prompt){const previews=markdownImages(section);result.push({key:heading,name:heading,prompt,...(previews.length?{previewCandidates:previews}:{})});}
  }
  if(!result.length&&!/(^|\/)readme\.md$/i.test(file) && /(?:style|preset|prompt)/i.test(file) && content.trim().length>20)result.push({key:file,name:file.split('/').at(-1).replace(/\.md$/i,''),prompt:content.trim()});
  return result;
}
async function get(url,json=true){const r=await fetch(url,{headers:{Accept:json?'application/vnd.github+json':'text/plain','User-Agent':'SceneStudio-local'},signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error(`GitHub ${r.status}${r.status===403?' — 요청 제한, 나중에 재시도해 주세요.':''}`);const txt=await r.text();if(txt.length>3e6)throw Error('파일 크기 제한(3MB) 초과');return json?JSON.parse(txt):txt;}
export async function syncSource(source,previous=[],fetcher=get){
  const {owner,repo}=parseRepo(source.url);const root=`https://api.github.com/repos/${owner}/${repo}`;
  const ref=source.ref || (await fetcher(root)).default_branch; const commit=await fetcher(`${root}/commits/${encodeURIComponent(ref)}`); const sha=commit.sha;
  const tree=await fetcher(`${root}/git/trees/${sha}?recursive=1`); if(tree.truncated)throw Error('저장소 파일 목록이 너무 큽니다. 작은 프리셋 저장소를 사용해 주세요. 기존 프리셋을 유지합니다.');
  const files=tree.tree.filter(f=>f.type==='blob'&&/\.(md|json)$/i.test(f.path)&&!/(^|\/)(node_modules|package-lock|package\.json|\.github)(\/|$)/.test(f.path));
  if(files.length>400)throw Error('지원 파일이 400개를 초과합니다. 프리셋 전용 저장소를 사용해 주세요.');
  const presets=[],warnings=[]; let cursor=0;
  async function worker(){while(cursor<files.length){const f=files[cursor++];try{const content=await fetcher(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${f.path.split('/').map(encodeURIComponent).join('/')}`,false);const parsed=parsePresets(content,f.path); if(!parsed.length&&previous.some(p=>p.file===f.path))throw Error('기존 프리셋 형식을 해석할 수 없습니다.');for(const p of parsed){const key=createHash('sha256').update(p.key).digest('hex').slice(0,16);const previewUrls=(p.previewCandidates||[]).map(v=>resolvePreviewURL(v,{owner,repo,sha,file:f.path})).filter(Boolean);const {previewCandidates,...metadata}=p;presets.push({...metadata,previewUrls,id:`${source.id}:${f.path}:${key}`,sourceId:source.id,file:f.path,sha});}}catch(e){warnings.push(`${f.path}: ${e.message}`);presets.push(...previous.filter(p=>p.file===f.path).map(p=>({...p,stale:true})));}}}
  await Promise.all(Array.from({length:4},worker));
  if(!presets.length&&previous.length)throw Error('읽을 수 있는 프리셋이 없어 기존 목록을 유지했습니다. 저장소 형식을 확인해 주세요.');
  const priority=p=>(p.stale?100:0)+(/(?:locale|i18n|translations)/i.test(p.file)?20:0)+(/\.json$/i.test(p.file)?0:/(^|\/)readme/i.test(p.file)?30:10);
  presets.sort((a,b)=>priority(a)-priority(b)||a.file.localeCompare(b.file)||a.key.localeCompare(b.key));
  const unique=new Map();for(const p of presets){const fingerprint=p.prompt.trim();if(!unique.has(fingerprint))unique.set(fingerprint,p);else {const representative=unique.get(fingerprint);representative.previewUrls=[...new Set([...(representative.previewUrls||[]),...(p.previewUrls||[])])].slice(0,8);}}
  const result=[...unique.values()];
  // Preserve references/favorites when a unique preset key moves to another file.
  for(const p of result){const candidates=previous.filter(old=>old.key===p.key);if(candidates.length===1&&!result.some(other=>other!==p&&other.id===candidates[0].id))p.id=candidates[0].id;}
  return {presets:result,warnings,sha,syncedAt:new Date().toISOString()};
}
