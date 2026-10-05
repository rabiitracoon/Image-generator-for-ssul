const compact=text=>text.replace(/\s/g,'');
export function narrationText(scenes){
 return scenes.map((scene,index)=>{
  if(scene.continuation){if(!index||compact(scene.sourceText)!==compact(scenes[index-1].sourceText))throw Error('같은 대본의 추가 컷은 바로 앞 컷과 원문이 같아야 합니다.');return '';}
  return scene.sourceText;
 }).join('');
}
export function syncContinuations(scenes){
 for(let i=1;i<scenes.length;i++)if(scenes[i].continuation)scenes[i].sourceText=scenes[i-1].sourceText;
}
function group(scenes,index){
 let start=index,end=index;while(start>0&&scenes[start].continuation)start--;while(end+1<scenes.length&&scenes[end+1].continuation)end++;return {start,end};
}
export function splitNarration(scenes,index,offset){
 const {start,end}=group(scenes,index),source=scenes[index].sourceText;
 if(offset<=0||offset>=source.length)throw Error('현재 대본 구간 중간에 있는 정확한 원문 구절을 입력해 주세요.');
 for(let i=start;i<=end;i++){scenes[i].sourceText=i<=index?source.slice(0,offset):source.slice(offset);scenes[i].status='draft';}
 return source.slice(offset);
}
export function mergeNarration(scenes,index){
 const scene=scenes[index],next=scenes[index+1];if(!next)throw Error('다음 컷이 없습니다.');
 if(!next.continuation){
  const first=group(scenes,index),second=group(scenes,index+1),source=scene.sourceText+' '+next.sourceText;
  for(let i=first.start;i<=second.end;i++){scenes[i].sourceText=source;scenes[i].continuation=i!==first.start;scenes[i].status='draft';}
 }
}
