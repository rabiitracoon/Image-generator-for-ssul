const activeStatuses=['queued','running','retrying'];
export const jobActive=status=>activeStatuses.includes(status);
export const sceneWorkActive=project=>!!project&&(!!project.analyzing||project.continuityRun?.status==='running'||project.scenes.some(s=>jobActive(s.status)));
export const characterLocked=(project,character)=>sceneWorkActive(project)||jobActive(character?.sheetJob?.status);
export const projectLocked=project=>sceneWorkActive(project)||!!project?.characters.some(c=>jobActive(c.sheetJob?.status));
export function sheetProgress(project){
  const jobs=(project?.characters||[]).map(c=>c.sheetJob?.status);
  const running=jobs.filter(status=>status==='running'||status==='retrying').length,queued=jobs.filter(status=>status==='queued').length;
  return `${running}개 생성 중 · ${queued}개 대기 · 최대 3개 동시 생성`;
}
export function filterScenes(scenes, query='', status='all') {
  const needle=query.trim().toLocaleLowerCase();
  return scenes.filter(s=>{
    const matches=!needle||[s.title,s.sourceText,s.prompt].join(' ').toLocaleLowerCase().includes(needle);
    const running=['queued','running','retrying'].includes(s.status);
    const pending=!running&&(!s.images?.length||['draft','failed'].includes(s.status));
    return matches&&(status==='all'||(status==='running'?running:status==='pending'?pending:s.status===status));
  });
}
export function pageItems(items, page=0, size=24) {
  const pages=Math.max(1,Math.ceil(items.length/size));
  const index=Math.min(Math.max(0,Math.floor(page)||0),pages-1);
  return {items:items.slice(index*size,(index+1)*size),index,pages,total:items.length};
}

export function mergeProjectProgress(local,remote){
 const completed=remote.analysisRun?.status==='done'&&(local.analyzing||local.analysisRun?.startedAt!==remote.analysisRun.startedAt||local.analysisRun?.id!==remote.analysisRun.id);
 const continuityChanged=remote.continuityRun?.id!==local.continuityRun?.id||local.continuityRun?.status==='running';
 local.characters=remote.characters;local.locations=remote.locations;local.continuityRun=remote.continuityRun;local.continuityPlan=remote.continuityPlan;
 for(const key of ['analyzing','analysisRun','analysisError'])local[key]=remote[key];
 if(completed){local.scenes=remote.scenes;local.sourceMappingError=remote.sourceMappingError;}
 else for(const scene of local.scenes){const updated=remote.scenes.find(s=>s.id===scene.id);if(updated)for(const key of ['status','images','attempts','error',...(continuityChanged?['characterIds','locationIds']:[])])scene[key]=updated[key];}
}
export function analysisProgress(project,now=Date.now()){
 const run=project?.analysisRun;
 if(!project?.analyzing)return '';
 const seconds=Math.max(0,Math.floor((now-Date.parse(run?.startedAt||new Date(now).toISOString()))/1000)),elapsed=`${Math.floor(seconds/60)}분 ${String(seconds%60).padStart(2,'0')}초`;
 const phase={preparing:'분석 모델 준비 중',waiting:'GPT 응답을 기다리는 중',retrying:'응답 지연으로 다시 시도하는 중',validating:'새 장면의 대본 구간 검증 중'}[run?.phase]||'분석 응답을 기다리는 중';
 return `${run?.provider==='claude'?phase.replace('GPT','Claude'):phase} · ${elapsed} · 시도 ${run?.attempt||1}/${run?.maxAttempts||1} · 기존 장면은 완료 후 교체됩니다.`;
}
