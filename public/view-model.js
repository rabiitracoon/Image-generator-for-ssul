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
