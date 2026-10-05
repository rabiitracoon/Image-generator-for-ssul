import {createHash} from 'node:crypto';
import path from 'node:path';
import {sourceAssignments} from './narration.mjs';

export const scriptHash=script=>createHash('sha256').update(script,'utf8').digest('hex');
export function editingCue(project,scene,index){
 if(!scene.sourceRange)throw Error('정확한 대본 구간 배정이 필요합니다. 다시 분석하거나 대본 구간을 수정해 주세요.');
 return {projectId:project.id,sceneId:scene.id,cutIndex:index+1,sourceText:scene.sourceText,sourceRange:{...scene.sourceRange},insertAt:'sourceRange.start',scriptSha256:scriptHash(project.script),camera:scene.camera||'',characters:project.characters.filter(c=>scene.characterIds.includes(c.id)).map(({id,name})=>({id,name})),locations:(project.locations||[]).filter(l=>(scene.locationIds||[]).includes(l.id)).map(({id,name})=>({id,name}))};
}
const slug=text=>Array.from(text.replace(/[\s<>:"/\\|?*\u0000-\u001f]+/g,'_').replace(/[. ]+$/g,'')).slice(0,35).join('')||'컷';
export function imageDownloadName(scene,index,image,version){
 const extension=/\.(png|jpg|webp)$/.exec(image.url)?.[1]||'png';
 return `cut-${String(index+1).padStart(3,'0')}_${slug(scene.sourceText)}_${scene.id.slice(0,8)}_v${version}.${extension}`;
}
export function editingManifest(project){
 const assignments=sourceAssignments(project.scenes,project.script);
 return {format:'scene-studio-editing-manifest',schemaVersion:1,projectId:project.id,projectName:project.name,script:project.script,scriptSha256:scriptHash(project.script),offsetConvention:{unit:'unicode-code-point',start:'zero-based inclusive',end:'zero-based exclusive',lineAndColumn:'one-based'},insertionRule:'각 컷의 sourceRange.start에 해당하는 대본이 낭독되기 시작할 때 imageFile의 이미지를 삽입하고, 다음 컷의 시작 전까지 유지합니다. 오디오 시간이 없으므로 초 단위 타임코드는 포함하지 않습니다.',cuts:project.scenes.map((original,index)=>{
  const scene={...original,...assignments[index]},image=scene.images.at(-1),cue=editingCue(project,scene,index);
  return {...cue,title:scene.title,reason:scene.reason||'',status:scene.status,needsRegeneration:!!image&&scene.status!=='done',imageVersion:image?scene.images.length:null,imageFile:image?'images/'+imageDownloadName(scene,index,image,scene.images.length):null,imageUrl:image?.url||null,generatedCue:image?.cue||null};
 })};
}
const csvCell=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
export function editingFiles(project,dataDir){
 const manifest=editingManifest(project),rows=[['cut','scene_id','source_text','start_char','end_char','start_line','start_column','camera','image_file','status']];
 const entries=[];
 for(const cut of manifest.cuts){
  rows.push([cut.cutIndex,cut.sceneId,cut.sourceText,cut.sourceRange.start,cut.sourceRange.end,cut.sourceRange.startLine,cut.sourceRange.startColumn,cut.camera,cut.imageFile,cut.status]);
  if(cut.imageFile){const match=/^\/media\/images\/([a-f0-9-]+\.(png|jpg|webp))$/.exec(cut.imageUrl);if(!match)throw Error('이미지 파일 경로가 올바르지 않습니다.');entries.push({name:cut.imageFile,file:path.join(dataDir,'images',match[1])},{name:cut.imageFile.replace(/\.(png|jpg|webp)$/,'.json'),data:Buffer.from(JSON.stringify(cut,null,2))});}
 }
 return [{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest,null,2))},{name:'script.txt',data:Buffer.from(project.script)},{name:'cuts.csv',data:Buffer.from('\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'))},{name:'README.txt',data:Buffer.from('편집 에이전트는 manifest.json을 읽으세요.\n컷 순서(cutIndex), 정확한 대본 구절(sourceText), 원문 위치(sourceRange), 카메라 연출(camera), 이미지 경로(imageFile)가 기록되어 있습니다.\nstart는 0부터 세는 유니코드 문자 위치이며 포함, end는 미포함입니다. Python에서는 script[start:end], JavaScript에서는 Array.from(script).slice(start,end).join(\'\')로 확인합니다.\n각 구간의 시작에 이미지를 삽입하세요. 타임코드는 오디오/자막과 대본을 정렬하여 정해야 합니다.\n이미지는 각 컷의 최신 버전이며 대응하는 JSON도 함께 들어 있습니다. imageFile이 null이면 해당 컷의 이미지가 아직 없습니다. needsRegeneration=true이면 편집 후 재생성이 필요한 이전 이미지입니다.\nscriptSha256으로 대본 버전을 확인하세요.\n')},...entries];
}
