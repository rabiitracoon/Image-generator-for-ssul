export const SOURCE_ERROR='대본 구간에서 원문 누락/중복 또는 순서 변경을 발견했습니다. 컷마다 겹치지 않는 원문 구절을 배정하거나 다시 분석해 주세요.';
export const narrationText=scenes=>scenes.map(s=>s.sourceText).join('');
export function sourceAssignments(scenes,script){
 const chars=Array.from(script),tokens=[];
 for(let i=0;i<chars.length;i++)if(!/\s/u.test(chars[i]))tokens.push({char:chars[i],index:i});
 let cursor=0,start=0,line=1,column=1;
 const assignments=scenes.map(scene=>{
  if(typeof scene.sourceText!=='string'||!scene.sourceText.trim())throw Error('장면 원문과 프롬프트가 필요합니다.');
  const text=Array.from(scene.sourceText).filter(c=>!/\s/u.test(c));
  for(let i=0;i<text.length;i++)if(tokens[cursor+i]?.char!==text[i])throw Error(SOURCE_ERROR);
  cursor+=text.length;
  const end=cursor<tokens.length?tokens[cursor].index:chars.length;
  const sourceRange={start,end,unit:'unicode-code-point',startLine:line,startColumn:column};
  for(let i=start;i<end;i++){if(chars[i]==='\n'){line++;column=1;}else column++;}
  Object.assign(sourceRange,{endLine:line,endColumn:column});
  const sourceText=chars.slice(start,end).join('');start=end;
  return {sourceText,sourceRange};
 });
 if(cursor!==tokens.length||!scenes.length&&tokens.length)throw Error(SOURCE_ERROR);
 return assignments;
}
export function refreshSourceAssignments(project){
 if(!project.scenes.length){project.sourceMappingError='';return;}
 try{const assignments=sourceAssignments(project.scenes,project.script);project.scenes.forEach((s,i)=>{Object.assign(s,assignments[i]);delete s.continuation;});project.sourceMappingError='';}
 catch(error){project.sourceMappingError=error.message;for(const s of project.scenes)delete s.sourceRange;}
}
export function splitNarration(scenes,index,offset){
 const scene=scenes[index],source=scene.sourceText;
 if(offset<=0||offset>=source.length)throw Error('현재 대본 구간 중간에 있는 정확한 원문 구절을 입력해 주세요.');
 scene.sourceText=source.slice(0,offset);scene.status='draft';delete scene.sourceRange;
 return source.slice(offset);
}
export function mergeNarration(scenes,index){
 const scene=scenes[index],next=scenes[index+1];if(!next)throw Error('다음 컷이 없습니다.');
 scene.sourceText+=next.sourceText;scene.status='draft';delete scene.sourceRange;
}
