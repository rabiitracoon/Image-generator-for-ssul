const activeStatuses=['queued','running','retrying'];
export const jobActive=status=>activeStatuses.includes(status);
export const sceneWorkActive=project=>!!project&&(!!project.analyzing||project.scenes.some(s=>jobActive(s.status)));
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
