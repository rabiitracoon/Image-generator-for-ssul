import {filterScenes,pageItems,characterLocked,projectLocked,sheetProgress,mergeProjectProgress,analysisProgress} from './view-model.js';
import {refreshSourceAssignments,splitNarration,mergeNarration} from './narration.js';
let state={projects:[],presets:[],sources:[],favorites:[]};
let current=localStorage.getItem('scene-project'),dirty=false,tab='script',refreshing=null,saving=false;
let boardView='focus',gridPage=0,stylePage=0,styleTarget=null,detailId=null;
const selectedByProject=new Map(),versions=new Map();
let styleDraft={id:null,references:[],uploads:[]},styleSaving=false,engineStatus=null;
let characterDraft={id:null,references:[],uploads:[]},characterSaving=false,characterReading=false,sheetCharacterId=null,sheetSubmitting=false;
let analysisPromptInfo=null,analysisPromptSaving=false;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const p=()=>state.projects.find(x=>x.id===current);
const locked=()=>projectLocked(p());
const statuses={draft:'생성 필요',queued:'대기',running:'생성 중',retrying:'재시도',failed:'실패',done:'완료'};
async function api(url,method='GET',data){const r=await fetch('/api/'+url,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const result=await r.json();if(!r.ok)throw Error(result.error||'요청 실패');return result;}
function notice(message=''){$('#notice').textContent=message;}
function mark(){dirty=true;$('#save-state').textContent='저장하지 않은 변경';}
async function action(fn){try{notice();await fn();}catch(e){notice(e.message);}}
function imageMarkup(url,alt,empty='예시 이미지 없음',className='') {
  const safe=typeof url==='string'&&(/^(https:\/\/)/.test(url)||url.startsWith('/media/')||url.startsWith('blob:'));
  return `<div class="preview-visual ${className}">${safe?`<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="image-unavailable hidden">이미지를 불러올 수 없어요</span>`:`<span class="image-unavailable">${esc(empty)}</span>`}</div>`;
}
document.addEventListener('error',e=>{if(e.target.tagName==='IMG'&&e.target.closest('.preview-visual')){e.target.classList.add('hidden');e.target.parentElement.querySelector('.image-unavailable')?.classList.remove('hidden');}},true);
function preset(id){return state.presets.find(s=>s.id===id);}
function renderProjectStyle(){const style=preset(p().defaultStyleId);$('#default-style').value=p().defaultStyleId||'';$('#project-style-card').innerHTML=style?`<div class="selected-style">${imageMarkup(style.previewUrls?.[0],style.name,style.sourceType==='custom'?'텍스트 스타일':'예시 이미지 없음')}<div><small>PROJECT STYLE</small><strong>${esc(style.name)}</strong><button data-project-style-clear class="text-button">스타일 해제</button></div></div>`:`<div class="style-empty"><span>▧</span><div><strong>${p().defaultStyleId?'스타일을 찾을 수 없습니다':'아직 정한 스타일이 없어요'}</strong><p>예시 이미지를 보고 이야기의 분위기를 정하세요.</p></div></div>`;$('#choose-project-style').disabled=locked();}
function showTab(next){if(p())collect();tab=next;$$('.tab').forEach(x=>x.classList.toggle('hidden',x.id!==tab));$$('nav button').forEach(x=>{x.classList.toggle('active',x.dataset.tab===tab);x.setAttribute('aria-current',x.dataset.tab===tab?'page':'false');});if(next==='scenes'){renderScenes();revealSelected();}if(next==='styles'){if(!styleTarget||styleTarget.projectId!==current)styleTarget={projectId:current,returnTab:'script'};renderStyles();}}
function render(){const project=p();$('#projects').innerHTML=state.projects.map(x=>`<button data-project="${x.id}" class="${x.id===current?'active':''}">▤ ${esc(x.name)}</button>`).join('');if(!project)return;
 $('#project-title').textContent=project.name;$('#scene-count').textContent=project.scenes.length;$('#export').href=`/api/projects/${project.id}/export`;
 $('#name').value=project.name;$('#script-input').value=project.script;$('#constraints').value=project.constraints;$('#aspect').value=project.aspectRatio;$('#char-count').textContent=`${project.script.length.toLocaleString()}자`;
 $('#analyze').textContent=project.analyzing?'✦ 장면 분석 중…':'✦ AI 장면 분석';$('#analyze').disabled=locked();$('#generate').disabled=locked()||!project.scenes.length||!!project.sourceMappingError;
 ['#add-scene','#save','#name','#script-input','#constraints','#aspect'].forEach(s=>$(s).disabled=locked());
 ['#add-character','#create-character-sheet'].forEach(s=>$(s).disabled=characterLocked(project));
 renderAnalysisModel();renderAnalysisProgress();
 renderProjectStyle();
 renderCharacters(project);renderContinuity(project);
 renderScenes();renderStyles();$('#source-mapping-error').textContent=project.sourceMappingError?'이전 분석의 대본 구간이 겹치거나 누락되어 있습니다. 대본을 다시 분석하거나 각 컷에 서로 겹치지 않는 구절을 배정해 주세요.': '';$('#source-mapping-error').classList.toggle('hidden',!project.sourceMappingError);if(project.analysisError)notice(project.analysisError);if(project.continuityRun?.error)notice(project.continuityRun.error);
}
function renderContinuity(project){
 const run=project.continuityRun,active=run?.status==='running',assets=run?.assets||[],done=assets.filter(a=>a.status==='done').length;
 $('#continuity-progress-banner').classList.toggle('hidden',!active);
 const phase=run?.phase==='references'?`기준 이미지 준비 ${done}/${assets.length} · ${assets.filter(a=>a.status==='running'||a.status==='retrying').map(a=>a.name).join(', ')}`:run?.phase==='queuing'?'기준 이미지 완료 · 컷 생성 대기열 준비 중':'대본 전체에서 등장 인물과 배경 장소를 찾는 중';
 const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(run?.startedAt||new Date().toISOString()))/1000));
 $('#continuity-progress-text').textContent=`${phase} · ${Math.floor(elapsed/60)}분 ${elapsed%60}초 · ${run?.model||'선택한 분석 모델'}${run?.phase==='retrying'?' · 응답 지연으로 재시도 중':''}`;
 $('#prepare-continuity').disabled=locked()||!project.scenes.length||!!project.sourceMappingError;
 $('#locations').innerHTML=(project.locations||[]).map(l=>`<article class="character" data-location="${l.id}"><h3>▧ ${esc(l.name)}</h3><label>장소 이름<input data-location-name value="${esc(l.name)}" maxlength="200" ${locked()?'disabled':''}></label><label>고정할 공간 설명<textarea data-location-description maxlength="10000" ${locked()?'disabled':''}>${esc(l.description)}</textarea></label><div class="refs">${(l.references||[]).map(r=>`<div class="ref"><button class="reference-view" data-view-ref="${r.id}" aria-label="${esc(r.name)} 크게 보기"><img src="${esc(r.url)}" alt="${esc(r.name)}"><span class="reference-kind">배경 기준 이미지</span></button></div>`).join('')}</div><div class="actions"><button data-save-location="${l.id}" ${locked()?'disabled':''}>설명 저장</button><button data-reset-location="${l.id}" ${locked()?'disabled':''}>기준 이미지 다시 준비</button></div><label class="upload">＋ 배경 기준 이미지 첨부<input data-upload-location="${l.id}" type="file" accept="image/png,image/jpeg,image/webp" ${locked()?'disabled':''}></label><p class="hint">${project.scenes.filter(s=>(s.locationIds||[]).includes(l.id)).length}개 컷에 연결 · 공간 배치와 특징을 고정하고 컷마다 카메라와 조명을 바꿉니다.</p></article>`).join('')||'<div class="empty">기준 이미지 준비를 누르면 대본에서 배경 장소를 자동으로 찾아 여기에 표시합니다. 컷 생성 버튼을 눌러도 먼저 준비합니다.</div>';
}
$('#prepare-continuity').onclick=()=>action(async()=>{await save();const r=await api(`projects/${current}/continuity`,'POST',{});await refresh();notice(r.ready?'모든 기준 이미지가 준비되어 있습니다.':'인물과 배경 기준 이미지를 준비합니다.');});
$('#cancel-continuity').onclick=()=>action(async()=>{await api(`projects/${current}/continuity-cancel`,'POST',{});await refresh();});
$('#locations').onclick=e=>action(async()=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.viewRef)return viewReference(b.dataset.viewRef);const locationId=b.dataset.saveLocation||b.dataset.resetLocation;if(!locationId)return;const card=b.closest('[data-location]');if(dirty)await save();await api(`projects/${current}/locations/${locationId}`,'PUT',{name:card.querySelector('[data-location-name]').value,description:card.querySelector('[data-location-description]').value,resetReference:!!b.dataset.resetLocation});await refresh();if(b.dataset.resetLocation){await api(`projects/${current}/continuity`,'POST',{});await refresh();}else notice('배경 설명을 저장했습니다. 기준 이미지를 바꾸려면 다시 준비를 눌러 주세요.');});
$('#locations').onchange=e=>action(async()=>{const input=e.target;if(!input.dataset.uploadLocation||!input.files.length)return;const image=await readImage(input.files[0]);if(dirty)await save();await api(`projects/${current}/locations/${input.dataset.uploadLocation}`,'PUT',{images:[image]});await refresh();notice('배경 기준 이미지를 첨부했습니다. 연결된 컷에 자동 적용됩니다.');});
function matches(){return filterScenes(p().scenes,$('#scene-search').value,$('#scene-filter').value);}
function selectedScene(){return p()?.scenes.find(s=>s.id===selectedByProject.get(current));}
function sceneStatus(s){return s.status==='draft'&&s.images.length?'변경됨':statuses[s.status]||s.status;}
function revealSelected(){$('#scene-nav .active')?.scrollIntoView({block:'nearest',inline:'nearest'});}
function selectScene(id,{focus=true}={}){collect();selectedByProject.set(current,id);if(focus)boardView='focus';renderScenes();$('#scene-nav .active')?.scrollIntoView({block:'nearest',inline:'nearest'});}
function navigateScene(offset){const list=matches(),i=list.findIndex(s=>s.id===selectedByProject.get(current));if(list[i+offset])selectScene(list[i+offset].id);}
function renderScenes(){const project=p(),list=matches();let selected=selectedScene();if(!selected||!list.some(s=>s.id===selected.id)){selected=list[0];selectedByProject.set(current,selected?.id);}
 $('#scene-count').textContent=project.scenes.length;
 $('#progress').textContent=`${project.scenes.filter(s=>s.images.length).length} / ${project.scenes.length}장 생성${locked()?' · 작업 중':''}`;
 $('#scene-results').textContent=`${list.length}개 장면`;
 $('#scene-jump').max=project.scenes.length||1;
 $('#view-focus').classList.toggle('active',boardView==='focus');$('#view-grid').classList.toggle('active',boardView==='grid');$('#view-focus').setAttribute('aria-pressed',boardView==='focus');$('#view-grid').setAttribute('aria-pressed',boardView==='grid');
 $('#board-workspace').classList.toggle('hidden',boardView!=='focus');$('#board-grid').classList.toggle('hidden',boardView!=='grid');
 const scrollTop=$('#scene-nav').scrollTop,scrollLeft=$('#scene-nav').scrollLeft;
 $('#scene-nav').innerHTML=list.map(s=>{const index=project.scenes.indexOf(s),im=s.images.at(-1);return `<button class="scene-nav-item ${selected?.id===s.id?'active':''}" data-select-scene="${s.id}" aria-current="${selected?.id===s.id?'true':'false'}">${imageMarkup(im?.url,s.title,String(index+1).padStart(2,'0'))}<span class="nav-scene-info"><small>SCENE ${String(index+1).padStart(2,'0')} <i class="status-dot ${s.status}"></i></small><strong>${esc(s.title)}</strong><span>${esc(sceneStatus(s))}</span></span></button>`;}).join('')||'<div class="empty compact">일치하는 장면 없음</div>';
 $('#scene-nav').scrollTop=scrollTop;$('#scene-nav').scrollLeft=scrollLeft;
 const inspectorScroll=$('.scene')?.dataset.id===selected?.id?$('.scene-fields')?.scrollTop||0:0;
 $('#scene-list').innerHTML=selected?sceneEditor(selected,project.scenes.indexOf(selected),list):`<div class="empty editor-empty"><span>▧</span><h3>${project.analyzing?'대본을 분석하고 있어요':project.scenes.length?'검색 결과가 없어요':'아직 장면이 없어요'}</h3><p>${project.scenes.length?'검색어나 상태 필터를 바꿔보세요.':'대본 & 캐릭터에서 AI 장면 분석을 시작하세요.'}</p></div>`;
 if($('.scene-fields'))$('.scene-fields').scrollTop=inspectorScroll;
 const page=pageItems(list,gridPage,24);gridPage=page.index;
 $('#scene-grid').innerHTML=page.items.map(s=>{const index=project.scenes.indexOf(s);return `<button class="board-card" data-select-scene="${s.id}">${imageMarkup(s.images.at(-1)?.url,s.title,'이미지 생성 대기')}<div class="board-card-info"><small>SCENE ${String(index+1).padStart(2,'0')} <span class="badge ${s.status}">${sceneStatus(s)}</span></small><strong>${esc(s.title)}</strong><p>${esc(s.sourceText)}</p></div></button>`;}).join('')||'<div class="empty">검색 결과가 없습니다.</div>';
 $('#grid-page').textContent=`${page.index+1} / ${page.pages} 페이지 · ${list.length}개 장면`;
 $('#grid-prev').disabled=page.index===0;$('#grid-next').disabled=page.index+1>=page.pages;
 if(locked())$$('#scene-list [data-field],#scene-list [data-cast],#scene-list [data-location-cast]').forEach(el=>el.disabled=true);
}
function sceneEditor(s,index,list){const vi=Math.min(versions.get(s.id)??s.images.length-1,s.images.length-1),im=s.images[vi];const si=list.findIndex(x=>x.id===s.id),effective=s.styleId===null?p().defaultStyleId:s.styleId,style=preset(effective);
 return `<article class="scene" data-id="${s.id}"><div class="scene-head"><span class="scene-number">${String(index+1).padStart(2,'0')}</span><input data-field="title" value="${esc(s.title)}" aria-label="장면 제목"><span class="badge ${s.status}">${sceneStatus(s)}${s.attempts?` · ${s.attempts}회`:''}</span><div class="actions"><button data-prev-scene ${si<=0?'disabled':''} title="이전 장면 (Alt+←)" aria-label="이전 장면">←</button><button data-next-scene ${si+1>=list.length?'disabled':''} title="다음 장면 (Alt+→)" aria-label="다음 장면">→</button></div></div>
 <div class="scene-body"><div class="scene-stage"><div class="scene-image">${imageMarkup(im?.url,s.title,['running','retrying','queued'].includes(s.status)?'✦ '+statuses[s.status]+'…':'이 장면의 첫 이미지를 만들어보세요.')}</div><div class="image-actions">${im?`<select data-history="${s.id}" aria-label="이미지 버전">${s.images.map((v,j)=>`<option value="${j}" ${j===vi?'selected':''}>버전 ${j+1} · ${new Date(v.createdAt).toLocaleTimeString()}</option>`).join('')}</select><a class="button download" href="${im.url}" download="${esc(im.downloadName||'')}">이미지 ↓</a>${im.metadataUrl?`<a class="button" href="${esc(im.metadataUrl)}" download>대본 연결 정보 ↓</a>`:''}`:'<span class="hint">검토한 프롬프트로 이미지를 생성합니다.</span>'}<button data-gen="${s.id}" class="primary" ${locked()||p().sourceMappingError?'disabled':''}>${im?'↻ 재생성':'✦ 이미지 생성'}</button></div>${s.error?`<div class="scene-error">${esc(s.error)}</div>`:''}<details class="cut-reason"><summary>장면 전환 이유</summary><p>${esc(s.reason||'사용자가 추가한 장면입니다.')}</p></details></div>
 <div class="scene-fields"><div class="inspector-label">SCENE DETAILS</div><label>이 이미지에 배정된 대본 구절<small class="source-cue hint">${s.sourceRange?`삽입: 원문 ${s.sourceRange.startLine}행 ${s.sourceRange.startColumn}열 · 이 구절이 시작될 때`:'정확한 구절을 배정하고 저장하면 삽입 위치가 표시됩니다.'}</small><textarea data-field="sourceText">${esc(s.sourceText)}</textarea></label><label>카메라 연출<input data-field="camera" value="${esc(s.camera||'')}" placeholder="예: 풀샷 → 말하는 인물의 바스트샷"></label><label>이미지 프롬프트<textarea data-field="prompt">${esc(s.prompt)}</textarea></label><div class="field-label">장면 스타일 <small>${s.styleId===null?'프로젝트 기본 적용':'이 장면만 적용'}</small></div><input type="hidden" data-field="styleId" value="${esc(s.styleId===null?'__inherit':s.styleId)}"><button class="scene-style-picker" data-scene-style="${s.id}" ${locked()?'disabled':''}>${imageMarkup(style?.previewUrls?.[0],style?.name||'스타일 없음','▧')}<span><strong>${esc(style?.name||'스타일 없음')}</strong><small>미리보고 다른 스타일 선택 →</small></span></button>${s.styleId!==null?'<button class="text-button" data-inherit-style>프로젝트 기본 스타일로 되돌리기</button>':''}<div class="field-label">등장 캐릭터</div><div class="cast">${p().characters.map(c=>`<label><input type="checkbox" data-cast="${c.id}" ${s.characterIds.includes(c.id)?'checked':''}>${esc(c.name)}</label>`).join('')||'<span class="hint">등록된 캐릭터가 없습니다.</span>'}</div><div class="field-label">배경 장소</div><div class="cast">${(p().locations||[]).map(l=>`<label><input type="checkbox" data-location-cast="${l.id}" ${(s.locationIds||[]).includes(l.id)?'checked':''}>${esc(l.name)}</label>`).join('')||'<span class="hint">컷 생성 전에 배경 기준을 자동 준비합니다.</span>'}</div><button data-preview="${s.id}" class="wide secondary">최종 프롬프트 확인</button></div></div>
 <div class="scene-foot"><span>장면 ${index+1} / ${p().scenes.length} · 편집 내용은 변경 저장으로 보관됩니다.</span><div class="actions"><button data-split="${s.id}" ${locked()?'disabled':''}>장면 분할</button>${index<p().scenes.length-1?`<button data-merge="${s.id}" ${locked()?'disabled':''}>다음과 병합</button>`:''}</div></div></article>`;
}

function renderCharacters(project){
 $('#character-sheet-progress').textContent=sheetProgress(project);
 $('#characters').innerHTML=project.characters.length?project.characters.map(c=>`<article class="character"><div class="character-head"><h3>◉ ${esc(c.name)}</h3><div><button data-edit-char="${c.id}" title="캐릭터 설명 및 첨부 수정" ${characterLocked(project,c)?'disabled':''}>편집</button><button data-delete-char="${c.id}" title="캐릭터 삭제" ${characterLocked(project,c)?'disabled':''}>✕</button></div></div><p>${esc(c.description||'외형 설명 없음')}</p><div class="refs">${c.references.map(r=>`<div class="ref" title="${esc(r.name)}"><button class="reference-view" data-view-ref="${r.id}" aria-label="${esc(r.name)} 크게 보기"><img src="${esc(r.url)}" alt="${esc(r.name)}"><span class="reference-kind">${r.kind==='character-sheet'?'캐릭터 시트':'외형 참고'}</span></button><button data-delete-ref="${r.id}" aria-label="${esc(r.name)} 삭제" ${characterLocked(project,c)?'disabled':''}>✕</button></div>`).join('')}</div><div class="character-uploads"><label class="upload">＋ 일반 참고 이미지<input data-upload="${c.id}" data-kind="reference" type="file" accept="image/png,image/jpeg,image/webp" multiple ${characterLocked(project,c)?'disabled':''}></label><label class="upload sheet-upload">＋ 캐릭터 시트 첨부<input data-upload="${c.id}" data-kind="character-sheet" type="file" accept="image/png,image/jpeg,image/webp" multiple ${characterLocked(project,c)?'disabled':''}></label></div><button data-generate-sheet="${c.id}" class="wide secondary character-sheet-button" ${characterLocked(project,c)||c.references.length>=10?'disabled':''}>✦ 설명으로 시트 생성</button>${c.sheetJob?`<div class="sheet-job"><span class="badge ${esc(c.sheetJob.status)}">시트 ${esc(statuses[c.sheetJob.status]||c.sheetJob.status)}</span>${c.sheetJob.status==='done'?'<span class="hint">참고 이미지에 등록됨</span>':''}${c.sheetJob.error?`<p class="error-text">${esc(c.sheetJob.error)}</p>`:''}</div>`:''}<p class="hint">등록된 시트는 이 캐릭터가 선택된 장면에 자동 적용됩니다.<br>시트와 일반 이미지 합계 최대 10장 · 파일당 32MB</p></article>`).join(''):'<div class="empty"><strong>시트가 있다면 첨부하고, 없다면 설명으로 만들어보세요.</strong><br>위의 ‘캐릭터 추가 · 시트 첨부’ 또는 ‘설명으로 시트 만들기’를 눌러 시작하세요.</div>';
}
async function readImage(file){
 if(file.size>32e6)throw Error('이미지는 32MB 이하만 가능합니다.');
 if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('PNG, JPEG, WebP 이미지를 선택해 주세요.');
 const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('이미지를 읽지 못했습니다. 다시 선택해 주세요.'));reader.readAsDataURL(file);});
 return {name:file.name,base64};
}
function releaseStyleUploads(){for(const image of styleDraft.uploads)URL.revokeObjectURL(image.previewUrl);}
function renderStyleReferences(){
 $('#custom-style-references').innerHTML=[...styleDraft.references.map(r=>({url:r.url,name:r.name,id:r.id})),...styleDraft.uploads.map((r,index)=>({url:r.previewUrl,name:r.name,index}))].map(r=>`<div class="custom-style-reference">${imageMarkup(r.url,r.name)}<span title="${esc(r.name)}">${esc(r.name)}</span><button type="button" ${r.id?`data-remove-style-ref="${esc(r.id)}"`:`data-remove-style-upload="${r.index}"`} aria-label="${esc(r.name)} 제거">✕</button></div>`).join('')||'<span class="hint">이미지 없이 프롬프트만 저장할 수도 있어요.</span>';
}
function resetStyleDraft(){releaseStyleUploads();styleDraft={id:null,references:[],uploads:[]};$('#custom-style-form').reset();$('#custom-style-title').textContent='직접 스타일 만들기';$('#custom-style-status').textContent='';renderStyleReferences();}
function editStyle(id){
 if(locked())throw Error('작업이 완료된 후 스타일을 편집해 주세요.');
 const style=preset(id);if(!style)return;
 releaseStyleUploads();styleDraft={id:style.sourceType==='custom'?style.id:null,references:structuredClone(style.references||[]),uploads:[]};
 $('#custom-style-name').value=style.sourceType==='custom'?style.name:style.name+' (내 스타일)';$('#custom-style-prompt').value=style.prompt||'';$('#custom-style-images').value='';
 $('#custom-style-title').textContent=style.sourceType==='custom'?'내 스타일 편집':'저장소 스타일을 복사해서 편집';$('#custom-style-status').textContent=style.sourceType==='custom'?'이 스타일을 사용하는 장면에도 수정 내용이 적용됩니다.':'저장소 원본은 유지하고 내 스타일로 따로 저장합니다.';
 $('#style-detail').close();showTab('styles');renderStyleReferences();$('.custom-style-panel').scrollIntoView({block:'start',behavior:'smooth'});$('#custom-style-name').focus();
}
$('#custom-style-reset').onclick=()=>{resetStyleDraft();$('#custom-style-name').focus();};
$('#detail-edit').onclick=()=>editStyle(detailId);
$('#custom-style-images').onchange=e=>action(async()=>{
 const files=[...e.target.files];e.target.value='';
 if(styleDraft.references.length+styleDraft.uploads.length+files.length>5)throw Error('스타일 이미지는 최대 5장입니다.');
 if(styleDraft.uploads.reduce((sum,image)=>sum+image.size,0)+files.reduce((sum,file)=>sum+file.size,0)>32e6)throw Error('한 번에 추가하는 이미지의 합계는 32MB 이하로 해 주세요.');
 const additions=[];
 try{for(const file of files)additions.push({...await readImage(file),size:file.size,previewUrl:URL.createObjectURL(file)});}
 catch(error){for(const image of additions)URL.revokeObjectURL(image.previewUrl);throw error;}
 styleDraft.uploads.push(...additions);renderStyleReferences();
});
$('#custom-style-references').onclick=e=>{
 const button=e.target.closest('button');if(!button)return;
 if(button.dataset.removeStyleRef)styleDraft.references=styleDraft.references.filter(r=>r.id!==button.dataset.removeStyleRef);
 if(button.hasAttribute('data-remove-style-upload')){const [removed]=styleDraft.uploads.splice(Number(button.dataset.removeStyleUpload),1);URL.revokeObjectURL(removed.previewUrl);}
 renderStyleReferences();
};
$('#custom-style-form').onsubmit=e=>{e.preventDefault();const apply=e.submitter?.dataset.apply==='true';action(async()=>{
 if(styleSaving)throw Error('스타일을 저장하고 있습니다.');
 if(locked())throw Error('작업이 완료된 후 스타일을 변경해 주세요.');
 const name=$('#custom-style-name').value.trim(),prompt=$('#custom-style-prompt').value.trim();
 if(!name)throw Error('스타일 이름을 입력해 주세요.');
 if(!prompt&&!styleDraft.references.length&&!styleDraft.uploads.length)throw Error('스타일 프롬프트 또는 참고 이미지를 입력해 주세요.');
 const payload={name,prompt,referenceIds:styleDraft.references.map(r=>r.id),images:styleDraft.uploads.map(({name,base64})=>({name,base64}))};
 styleSaving=true;renderStyles();$('#custom-style-status').textContent='스타일을 저장하고 있습니다…';
 try{
  if(dirty)await save();
  const saved=await api(styleDraft.id?`styles/${encodeURIComponent(styleDraft.id)}`:'styles',styleDraft.id?'PUT':'POST',payload);
  await refresh();resetStyleDraft();
  if(apply){applyStyle(saved.id);await save();notice('직접 만든 스타일을 저장하고 적용했습니다.');}
  else{renderStyles();notice('스타일을 라이브러리에 저장했습니다.');}
 }catch(error){$('#custom-style-status').textContent='저장하지 못했습니다. 입력한 내용은 유지됩니다.';throw error;}finally{styleSaving=false;renderStyles();}
});};
renderStyleReferences();

function currentStyleTarget(){if(!styleTarget||styleTarget.projectId!==current)styleTarget={projectId:current,returnTab:'script'};const scene=styleTarget.sceneId?p().scenes.find(s=>s.id===styleTarget.sceneId):null;return {scene,label:scene?`장면 ${p().scenes.indexOf(scene)+1} · ${scene.title}`:'프로젝트 전체 기본 스타일',styleId:scene?scene.styleId:p().defaultStyleId};}
function renderStyles(){if(!p())return;const target=currentStyleTarget();$('#custom-style-apply').textContent=target.scene?'저장하고 이 장면에 적용':'저장하고 프로젝트에 적용';$('#custom-style-form').querySelectorAll('input,textarea,button').forEach(el=>el.disabled=locked()||styleSaving);$('#style-target').innerHTML=`<div><small>APPLY TO</small><strong>${esc(target.label)}</strong><span>선택 후 ${target.scene?'스토리보드':'프로젝트 설정'}로 돌아갑니다.</span></div><div class="actions">${target.scene?'<button data-target-inherit>기본 스타일 상속</button>':''}<button data-target-none>스타일 없음</button></div>`;
 $('#source-count').textContent=`${state.sources.length}개 저장소`;
 $('#sources').innerHTML=state.sources.map(s=>`<div class="source"><div><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url.replace('https://github.com/',''))} ↗</a><p>${s.syncedAt?'동기화 '+new Date(s.syncedAt).toLocaleString():'동기화되지 않음'} ${s.sha?'· '+s.sha.slice(0,7):''}</p>${s.error?`<p class="danger">${esc(s.error)}</p>`:''}${s.warnings?.length?`<details><summary>${s.warnings.length}개 경고</summary><p>${s.warnings.map(esc).join('<br>')}</p></details>`:''}</div><button data-sync="${s.id}">↻ 동기화</button></div>`).join('');
 const category=$('#style-category').value;$('#style-category').innerHTML='<option value="">모든 카테고리</option>'+[...new Set(state.presets.map(s=>s.category).filter(Boolean))].sort().map(c=>`<option ${c===category?'selected':''}>${esc(c)}</option>`).join('');
 const query=$('#style-search').value.toLowerCase(),fav=$('#favorite-only').checked,previewOnly=$('#preview-only').checked;
 const styles=state.presets.filter(x=>(!fav||state.favorites.includes(x.id))&&(!previewOnly||x.previewUrls?.length)&&(!category||x.category===category)&&(x.name+' '+(x.description||'')+' '+x.prompt).toLowerCase().includes(query));
 const page=pageItems(styles,stylePage,24);stylePage=page.index;$('#preset-count').textContent=`${styles.length}개 스타일`;
 const imported=state.presets.filter(s=>s.sourceType!=='custom');$('#preview-notice').textContent=imported.length&&!imported.some(s=>s.previewUrls?.length)?'저장소를 다시 동기화하면 예시 이미지도 불러옵니다. 이미지가 없는 프리셋은 “예시 없음”으로 표시합니다.':'';
 $('#presets').innerHTML=page.items.map(s=>`<article class="preset ${target.styleId===s.id?'selected':''}"><button class="preset-preview" data-read="${esc(s.id)}" aria-label="${esc(s.name)} 미리보기">${imageMarkup(s.previewUrls?.[0],s.name,s.sourceType==='custom'?'텍스트 스타일':'예시 이미지 없음')}<span class="preview-caption">${s.previewUrls?.length?'예시 확대 ↗':'원본 프롬프트 확인 →'}</span></button><div class="preset-content"><div class="preset-head"><small>${esc(s.category||'STYLE PRESET')}</small><button class="star" data-favorite="${esc(s.id)}" aria-label="${esc(s.name)} 즐겨찾기" aria-pressed="${state.favorites.includes(s.id)}">${state.favorites.includes(s.id)?'★':'☆'}</button></div><h3>${esc(s.name)}</h3><p>${esc(s.description||s.prompt)}</p><div class="preset-foot"><small>${s.sourceType==='custom'?'직접 만든 스타일':s.stale?'이전 버전 보존':s.previewUrls?.length?'저장소 제공 예시':'예시 이미지 없음'}</small><button data-edit-style="${esc(s.id)}" ${locked()?'disabled':''}>${s.sourceType==='custom'?'편집':'복사해서 편집'}</button><button data-use="${esc(s.id)}" ${locked()?'disabled':''}>${target.styleId===s.id?'✓ 선택됨':'이 스타일 선택'}</button></div></div></article>`).join('')||'<div class="empty">조건에 맞는 스타일이 없습니다.<br>위에서 직접 스타일을 만들거나 검색 조건을 바꿔보세요.</div>';
 $('#styles-page').textContent=`${page.index+1} / ${page.pages} 페이지`;
 $('#styles-prev').disabled=page.index===0;$('#styles-next').disabled=page.index+1>=page.pages;
}
function openStyles(sceneId){collect();styleTarget={projectId:current,sceneId,returnTab:sceneId?'scenes':'script'};stylePage=0;showTab('styles');$('#styles').scrollTop=0;}
function returnFromStyles(){const dest=styleTarget?.returnTab||'script';showTab(dest);renderProjectStyle();}
function applyStyle(id){if(locked())throw Error('생성이 완료된 후 스타일을 변경해 주세요.');collect();const target=currentStyleTarget();if(target.scene){target.scene.styleId=id;const input=$('#scene-list [data-field="styleId"]');if(input&&selectedScene()?.id===target.scene.id)input.value=id===null?'__inherit':id;}else{p().defaultStyleId=id||'';$('#default-style').value=id||'';}mark();$('#style-detail').close();renderProjectStyle();renderScenes();returnFromStyles();notice('스타일을 선택했습니다. 변경 저장을 누르면 적용됩니다.');}
function openStyleDetail(id){const s=preset(id);if(!s)return;detailId=id;$('#detail-name').textContent=s.name;$('#detail-description').textContent=s.description||'색감, 질감, 조명과 표현 방식을 예시에서 확인하세요.';$('#detail-prompt').textContent=s.prompt||'참고 이미지로 스타일을 지정했습니다.';$('#detail-edit').textContent=s.sourceType==='custom'?'스타일 편집':'복사해서 편집';$('#detail-edit').disabled=locked();$('#detail-image-caption').textContent=s.sourceType==='custom'?'업로드한 스타일 참고 이미지 · 생성에 전달됩니다.':'저장소 예시 · 현재 대본으로 생성한 이미지가 아닙니다.';const source=state.sources.find(x=>x.id===s.sourceId);$('#detail-meta').innerHTML=`<span class="badge">${esc(s.category||'STYLE PRESET')}</span><p>${esc(s.sourceType==='custom'?'내가 저장한 스타일':s.file||'')}</p>${source?`<a href="${esc(source.url)}" target="_blank" rel="noreferrer">원본 저장소 ↗</a>`:''}`;
 $('#detail-image').innerHTML=imageMarkup(s.previewUrls?.[0],s.name,'참고 이미지 없이 텍스트 프롬프트로 지정한 스타일입니다.');$('#detail-thumbs').innerHTML=(s.previewUrls||[]).length>1?s.previewUrls.map((url,i)=>`<button data-preview-index="${i}" aria-label="예시 ${i+1}">${imageMarkup(url,`예시 ${i+1}`)}</button>`).join(''):'';$('#detail-favorite').textContent=state.favorites.includes(id)?'★ 즐겨찾기됨':'☆ 즐겨찾기';$('#detail-apply').textContent=currentStyleTarget().scene?'이 장면에 스타일 적용':'프로젝트 기본 스타일로 적용';$('#detail-apply').disabled=locked();$('#style-detail').showModal();}
async function refresh(){
 const previous=refreshing;
 const request=(async()=>{
  if(previous)await previous;
  const next=await api('state');
  if(dirty){
   collect();state.presets=next.presets;state.sources=next.sources;state.favorites=next.favorites;state.settings=next.settings;
   const remote=next.projects.find(x=>x.id===current),local=p();
   if(remote&&local)mergeProjectProgress(local,remote);
  }else state=next;
  if(!p())current=state.projects[0]?.id;if(!p()){const created=await api('projects','POST',{name:'나의 첫 스토리보드'});state.projects.push(created);current=created.id;}
  localStorage.setItem('scene-project',current);render();
 })();refreshing=request;try{await request;}finally{if(refreshing===request)refreshing=null;}
}
function collect(){const project=p();if(!project)return;Object.assign(project,{name:$('#name').value,script:$('#script-input').value,constraints:$('#constraints').value,aspectRatio:$('#aspect').value,defaultStyleId:$('#default-style').value});$$('.scene').forEach(el=>{const s=project.scenes.find(x=>x.id===el.dataset.id);if(!s)return;el.querySelectorAll('[data-field]').forEach(input=>s[input.dataset.field]=input.value==='__inherit'?null:input.value);s.locationIds=[...el.querySelectorAll('[data-location-cast]:checked')].map(x=>x.dataset.locationCast);s.characterIds=[...el.querySelectorAll('[data-cast]:checked')].map(x=>x.dataset.cast);});refreshSourceAssignments(project);}
async function save(){
 if(saving)throw Error('저장 중입니다. 잠시 기다려 주세요.');
 collect();const {scenes,...fields}=p();saving=true;$('main').inert=true;$('.app-sidebar').inert=true;$('main').setAttribute('aria-busy','true');$('#save-state').textContent='저장 중…';
 try{await api(`projects/${current}`,'PUT',{...fields,...(scenes.length?{scenes}:{})});dirty=false;await refresh();$('#save-state').textContent='저장됨';}
 catch(e){dirty=true;$('#save-state').textContent='저장 확인 실패 · 변경 보존됨';throw e;}
 finally{saving=false;$('main').inert=false;$('.app-sidebar').inert=false;$('main').removeAttribute('aria-busy');}
}
function modal(title,text){$('#modal-title').textContent=title;$('#modal-content').textContent=text;$('#modal').showModal();}
function ask(title,fields=[],description=''){return new Promise(resolve=>{const dialog=$('#input-modal');$('#input-title').textContent=title;$('#input-description').textContent=description;$('#input-fields').replaceChildren();for(const field of fields){const label=document.createElement('label');label.textContent=field.label;const input=document.createElement(field.multiline?'textarea':'input');input.name=field.key;input.value=field.value||'';input.required=field.required!==false;label.append(input);$('#input-fields').append(label);}const finish=value=>{dialog.close();resolve(value);};$('#input-form').onsubmit=e=>{e.preventDefault();finish(Object.fromEntries(new FormData(e.target)));};$('#input-cancel').onclick=()=>finish(null);dialog.oncancel=e=>{e.preventDefault();finish(null);};dialog.showModal();});}
$('#close-modal').onclick=()=>$('#modal').close();$('#close-detail').onclick=()=>$('#style-detail').close();
$$('nav button').forEach(b=>b.onclick=()=>{if(b.dataset.tab==='styles')styleTarget={projectId:current,returnTab:tab==='styles'?'script':tab};showTab(b.dataset.tab);});
$('#save').onclick=()=>action(save);
$('#editing-export').onclick=()=>action(async()=>{
 const button=$('#editing-export');button.disabled=true;
 try{
  if(dirty)await save();
  const result=await api(`projects/${current}/editing-export?validate=1`),link=document.createElement('a');
  link.href=`/api/projects/${current}/editing-export`;link.download=result.filename;document.body.append(link);link.click();link.remove();
  notice('편집용 ZIP을 저장했습니다. 이미지·원문·대본 연결표가 함께 들어 있습니다.');
 }finally{button.disabled=false;}
});
$('#new-project').onclick=()=>action(async()=>{if(dirty)await save();const created=await api('projects','POST',{name:'새 스토리보드'});current=created.id;styleTarget=null;$('#scene-search').value='';$('#scene-filter').value='all';await refresh();showTab('script');});
$('#projects').onclick=e=>action(async()=>{const b=e.target.closest('[data-project]');if(!b)return;if(dirty)await save();current=b.dataset.project;styleTarget=null;gridPage=0;$('#scene-search').value='';$('#scene-filter').value='all';await refresh();});
$$('#name,#script-input,#constraints,#aspect').forEach(el=>el.addEventListener('input',()=>{mark();$('#char-count').textContent=`${$('#script-input').value.length.toLocaleString()}자`;}));
$('#scene-list').addEventListener('input',e=>{if(!e.target.dataset.history)mark();if(e.target.dataset.field==='sourceText')$('.source-cue').textContent='변경 저장 후 삽입 위치가 다시 계산됩니다.';});
$('#choose-project-style').onclick=()=>openStyles();
$('#project-style-card').onclick=e=>action(async()=>{if(e.target.closest('[data-project-style-clear]')){if(locked())throw Error('작업 완료 후 수정해 주세요.');collect();p().defaultStyleId='';$('#default-style').value='';mark();renderProjectStyle();renderScenes();}});
$('#analyze').onclick=()=>action(async()=>{if(p().scenes.length&&!await ask('대본을 다시 분석할까요?',[],'현재 장면 편집과 이미지 연결은 새 분석 결과로 바뀝니다. 기존 이미지 파일은 로컬에 남습니다.'))return;collect();const {scenes,...fields}=p();await api(`projects/${current}`,'PUT',fields);dirty=false;$('#save-state').textContent='저장됨';await api(`projects/${current}/analyze`,'POST',{});selectedByProject.delete(current);$('#scene-search').value='';$('#scene-filter').value='all';await refresh();showTab('scenes');});
$('#cancel-analysis').onclick=()=>action(async()=>{const button=$('#cancel-analysis');button.disabled=true;try{await api(`projects/${current}/analysis-cancel`,'POST',{});await refresh();}finally{button.disabled=false;}});
function renderAnalysisProgress(){const active=!!p()?.analyzing;$('#analysis-progress-banner').classList.toggle('hidden',!active);$('#analysis-progress-text').textContent=analysisProgress(p());$('#cancel-analysis').disabled=!active;}
const analysisDraft=()=>({instructions:$('#analysis-instructions').value,density:$('#analysis-density').value,script:$('#script-input').value,constraints:$('#constraints').value});
async function previewAnalysisPrompt(){
 const result=await api(`projects/${current}/analysis-prompt-preview`,'POST',analysisDraft());
 $('#analysis-full-prompt').textContent=result.prompt;$('#analysis-guide').textContent=`참고 ${result.guide.minCuts}~${result.guide.maxCuts}컷 · 이야기의 행동·대사·반응에 따라 컷 수가 달라집니다.`;
 $('#analysis-prompt-status').textContent=locked()?'작업 중에는 확인만 가능합니다. 완료 후 설정을 저장해 주세요.':'';
}
$('#edit-analysis-prompt').onclick=()=>action(async()=>{
 collect();analysisPromptInfo=await api(`projects/${current}/analysis-prompt`);
 $('#analysis-density').innerHTML=analysisPromptInfo.densities.map(v=>`<option value="${esc(v.value)}">${esc(v.label)}</option>`).join('');$('#analysis-density').value=analysisPromptInfo.density;
 $('#analysis-instructions').value=analysisPromptInfo.instructions;$('#analysis-last-prompt').textContent=analysisPromptInfo.lastPrompt||'아직 기록된 분석 프롬프트가 없습니다.';
 $('#analysis-preview-details').open=false;$('#analysis-history-details').open=false;
 $('#analysis-prompt-save').disabled=locked();$('#analysis-prompt-reset').disabled=locked();$('#analysis-instructions').readOnly=locked();$('#analysis-density').disabled=locked();
 await previewAnalysisPrompt();$('#analysis-prompt-modal').showModal();
});
$('#analysis-prompt-preview').onclick=()=>action(async()=>{try{await previewAnalysisPrompt();}catch(error){$('#analysis-prompt-status').textContent=error.message;throw error;}});
$('#analysis-density').onchange=()=>action(previewAnalysisPrompt);
$('#analysis-instructions').oninput=()=>{$('#analysis-prompt-status').textContent='지시문을 수정했습니다. 미리보기를 갱신한 뒤 설정을 저장해 주세요.';};
$('#analysis-prompt-reset').onclick=()=>action(async()=>{$('#analysis-instructions').value=analysisPromptInfo.defaultInstructions;$('#analysis-density').value='dynamic';await previewAnalysisPrompt();});
$('#analysis-prompt-cancel').onclick=()=>{if(!analysisPromptSaving)$('#analysis-prompt-modal').close();};
$('#analysis-prompt-modal').addEventListener('cancel',e=>{if(analysisPromptSaving)e.preventDefault();});
$('#analysis-prompt-form').onsubmit=e=>{e.preventDefault();if(analysisPromptSaving)return;action(async()=>{
 analysisPromptSaving=true;$('#analysis-prompt-form').querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=true);
 try{const {instructions,density}=analysisDraft(),settings=await api(`projects/${current}/analysis-prompt`,'PUT',{instructions,density});p().analysisSettings=settings;$('#analysis-prompt-modal').close();renderAnalysisModel();notice('분석 설정을 저장했습니다. 다음 대본 분석부터 적용됩니다.');}
 catch(error){$('#analysis-prompt-status').textContent=error.message;throw error;}
 finally{analysisPromptSaving=false;$('#analysis-prompt-form').querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);$('#analysis-prompt-save').disabled=locked();}
});};
$('#generate').onclick=()=>action(async()=>{await save();await api(`projects/${current}/generate`,'POST',{});await refresh();});
function releaseCharacterUploads(){for(const upload of characterDraft.uploads)URL.revokeObjectURL(upload.previewUrl);}
function renderCharacterDraft(){
 const images=[...characterDraft.references.map(r=>({...r,stored:true})),...characterDraft.uploads.map((r,index)=>({...r,index,url:r.previewUrl}))];
 $('#character-draft-images').innerHTML=images.map(r=>`<div class="character-draft-image">${imageMarkup(r.url,r.name)}<span>${r.kind==='character-sheet'?'캐릭터 시트':'외형 참고'}</span><button type="button" ${r.stored?`data-remove-char-ref="${r.id}"`:`data-remove-char-upload="${r.index}"`} aria-label="${esc(r.name)} 첨부 제거">✕</button></div>`).join('')||'<p class="hint">첨부된 이미지가 없습니다. 설명으로 시트를 만들 수 있어요.</p>';
}
function openCharacterEditor(character=null,generateNext=false){
 if(characterLocked(p(),character))throw Error('이 캐릭터의 시트 생성 또는 장면 작업 완료 후 편집해 주세요.');
 releaseCharacterUploads();characterDraft={id:character?.id||null,references:structuredClone(character?.references||[]),uploads:[]};
 $('#character-form').reset();$('#character-name').value=character?.name||'';$('#character-description').value=character?.description||'';
 $('#character-form-title').textContent=character?'캐릭터 편집 · 시트 첨부':generateNext?'설명으로 새 캐릭터 시트 만들기':'캐릭터 추가 · 시트 첨부';
 $('#character-form-status').textContent='';renderCharacterDraft();$('#character-modal').showModal();
}
$('#add-character').onclick=()=>action(()=>openCharacterEditor());
$('#create-character-sheet').onclick=()=>action(()=>openCharacterEditor(null,true));
$('#character-cancel').onclick=()=>{if(!characterSaving&&!characterReading)$('#character-modal').close();};
$('#character-modal').addEventListener('close',()=>{releaseCharacterUploads();characterDraft={id:null,references:[],uploads:[]};});
$('#character-modal').addEventListener('cancel',e=>{if(characterSaving||characterReading)e.preventDefault();});
$('#character-images').onchange=()=>action(async()=>{
 const input=$('#character-images'),files=[...input.files],kind=$('#character-upload-kind').value;input.value='';
 characterReading=true;$('#character-form').querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=true);
 try{
  if(characterDraft.references.length+characterDraft.uploads.length+files.length>10)throw Error('캐릭터당 참고 이미지는 최대 10장입니다.');
  if(characterDraft.uploads.reduce((sum,r)=>sum+r.size,0)+files.reduce((sum,f)=>sum+f.size,0)>32e6)throw Error('한 번에 첨부하는 이미지 합계는 32MB 이하로 선택해 주세요.');
  // Read all files before changing the draft so one bad file cannot leave a partial upload.
  const uploads=await Promise.all(files.map(readImage));
  uploads.forEach((r,index)=>characterDraft.uploads.push({...r,kind,size:files[index].size,previewUrl:URL.createObjectURL(files[index])}));renderCharacterDraft();$('#character-form-status').textContent='';
 }catch(error){$('#character-form-status').textContent=error.message;throw error;}
 finally{characterReading=false;$('#character-form').querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);}
});
$('#character-draft-images').onclick=e=>{
 const button=e.target.closest('button');if(!button||characterSaving||characterReading)return;
 if(button.dataset.removeCharRef)characterDraft.references=characterDraft.references.filter(r=>r.id!==button.dataset.removeCharRef);
 if(button.hasAttribute('data-remove-char-upload')){const [r]=characterDraft.uploads.splice(Number(button.dataset.removeCharUpload),1);URL.revokeObjectURL(r.previewUrl);}
 renderCharacterDraft();
};
$('#character-form').onsubmit=e=>{e.preventDefault();if(characterSaving||characterReading)return;action(async()=>{
 const generateNext=e.submitter?.dataset.sheet==='true',name=$('#character-name').value.trim(),description=$('#character-description').value;
 if(generateNext&&!description.trim()){$('#character-form-status').textContent='시트를 만들려면 캐릭터의 외형을 설명해 주세요.';return;}
 characterSaving=true;$('#character-form').querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=true);
 try{
  if(dirty&&!locked())await save();const payload={name,description,referenceIds:characterDraft.references.map(r=>r.id),images:characterDraft.uploads.map(({name,base64,kind})=>({name,base64,kind}))};
  const character=await api(`projects/${current}/characters${characterDraft.id?'/'+characterDraft.id:''}`,characterDraft.id?'PUT':'POST',payload);
  $('#character-modal').close();await refresh();notice('캐릭터와 첨부 이미지를 저장했습니다.');if(generateNext)await openSheetGenerator(character.id);
 }catch(error){$('#character-form-status').textContent=error.message;throw error;}
 finally{characterSaving=false;$('#character-form').querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);}
});};
async function openSheetGenerator(characterId){
 if(dirty&&!locked())await save();
 const c=p().characters.find(c=>c.id===characterId);if(!c)throw Error('캐릭터를 찾을 수 없습니다.');if(c.references.length>=10)throw Error('이미지 한 장을 제거한 뒤 시트를 생성해 주세요.');
 if(characterLocked(p(),c))throw Error('이 캐릭터의 시트 생성 또는 장면 작업이 이미 진행 중입니다.');
 sheetCharacterId=c.id;$('#sheet-form').reset();$('#sheet-title').textContent=`${c.name} · 캐릭터 시트 만들기`;$('#sheet-description').value=c.description;
 $('#sheet-form-status').textContent='';$('#sheet-prompt-preview').textContent='';
 const template=await api('character-sheet-template');$('#sheet-source').href=template.source.url;
 const settings=state.settings,engine=settings.imageProvider==='openai'?`${settings.imageModel} · 품질 ${settings.imageQuality}`:'ChatGPT 공식 이미지 도구 · 이미지 모델 자동 선택';
 $('#sheet-engine').textContent=`생성: ${engine}. 기존 캐릭터 참고 이미지 ${c.references.length}장도 외형 유지에 사용합니다.`;$('#sheet-modal').showModal();
}
const sheetInput=()=>({characterId:sheetCharacterId,description:$('#sheet-description').value,stylePrompt:$('#sheet-style-prompt').value,useProjectStyle:$('#sheet-use-style').checked});
$('#sheet-cancel').onclick=()=>{if(!sheetSubmitting)$('#sheet-modal').close();};
$('#sheet-modal').addEventListener('cancel',e=>{if(sheetSubmitting)e.preventDefault();});
$('#sheet-preview').onclick=()=>action(async()=>{try{const r=await api(`projects/${current}/character-sheet-preview`,'POST',sheetInput());$('#sheet-prompt-preview').textContent=r.prompt;$('#sheet-form-status').textContent='';}catch(error){$('#sheet-form-status').textContent=error.message;throw error;}});
$('#sheet-form').onsubmit=e=>{e.preventDefault();if(sheetSubmitting)return;action(async()=>{
 sheetSubmitting=true;const input=sheetInput();$('#sheet-form').querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);$('#sheet-form-status').textContent='생성을 준비하는 중…';
 try{await api(`projects/${current}/character-sheet`,'POST',input);$('#sheet-modal').close();await refresh();notice('캐릭터 시트를 생성 대기열에 추가했습니다. 다른 캐릭터도 계속 추가할 수 있어요.');}
 catch(error){$('#sheet-form-status').textContent=error.message;throw error;}finally{sheetSubmitting=false;$('#sheet-form').querySelectorAll('button,input,textarea').forEach(el=>el.disabled=false);}
});};
function viewReference(id){const ref=[...p().characters,...(p().locations||[])].flatMap(c=>c.references).find(r=>r.id===id);if(!ref)return;$('#reference-title').textContent=ref.name;$('#reference-image').src=ref.url;$('#reference-image').alt=ref.name;$('#reference-download').href=ref.url;$('#reference-download').download=ref.name;$('#reference-model').textContent=ref.engine?`생성: ${ref.engine==='codex'?'ChatGPT 공식 이미지 도구':ref.engine}${ref.controllerModel?' · 작업 지시 GPT: '+ref.controllerModel:''}`:'첨부한 참고 이미지';$('#reference-modal').showModal();}
$('#close-reference').onclick=()=>$('#reference-modal').close();
$('#characters').addEventListener('change',e=>action(async()=>{const input=e.target;if(!input.dataset.upload)return;if(dirty&&!locked())await save();for(const file of input.files){const image=await readImage(file);await api(`projects/${current}/references`,'POST',{characterId:input.dataset.upload,...image,kind:input.dataset.kind||'reference'});}await refresh();notice(input.dataset.kind==='character-sheet'?'캐릭터 시트를 등록했습니다. 등장 장면에 외형 참고로 적용됩니다.':'캐릭터 참고 이미지를 등록했습니다.');}));
$('#characters').onclick=e=>action(async()=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.viewRef)return viewReference(b.dataset.viewRef);if(b.dataset.editChar)return openCharacterEditor(p().characters.find(c=>c.id===b.dataset.editChar));if(b.dataset.generateSheet)return openSheetGenerator(b.dataset.generateSheet);if(dirty&&!locked())await save();if(b.dataset.deleteChar)await api(`projects/${current}/characters/${b.dataset.deleteChar}`,'DELETE',{});if(b.dataset.deleteRef)await api(`projects/${current}/references/${b.dataset.deleteRef}`,'DELETE',{});await refresh();});
$('#add-scene').onclick=()=>{collect();const id=crypto.randomUUID();p().scenes.push({id,title:'새 장면',sourceText:'',prompt:'',reason:'사용자 추가',characterIds:[],styleId:null,status:'draft',images:[]});$('#scene-search').value='';$('#scene-filter').value='all';selectedByProject.set(current,id);boardView='focus';mark();renderScenes();$('#scene-nav .active')?.scrollIntoView({block:'nearest'});};
$('#scene-nav').onclick=e=>{const b=e.target.closest('[data-select-scene]');if(b)selectScene(b.dataset.selectScene);};
$('#scene-grid').onclick=e=>{const b=e.target.closest('[data-select-scene]');if(b)selectScene(b.dataset.selectScene);};
$('#view-focus').onclick=()=>{collect();boardView='focus';renderScenes();revealSelected();};$('#view-grid').onclick=()=>{collect();boardView='grid';renderScenes();};
function filterBoard(){collect();gridPage=0;renderScenes();revealSelected();}
$('#scene-search').oninput=filterBoard;$('#scene-filter').onchange=filterBoard;
function jump(){const n=Number($('#scene-jump').value);if(!Number.isInteger(n)||n<1||n>p().scenes.length)return notice(`1~${p().scenes.length} 사이의 장면 번호를 입력하세요.`);notice();collect();$('#scene-search').value='';$('#scene-filter').value='all';selectScene(p().scenes[n-1].id);}
$('#jump-button').onclick=jump;$('#scene-jump').onkeydown=e=>{if(e.key==='Enter')jump();};
$('#grid-prev').onclick=()=>{collect();gridPage--;renderScenes();$('#scene-grid').scrollTop=0;};$('#grid-next').onclick=()=>{collect();gridPage++;renderScenes();$('#scene-grid').scrollTop=0;};
$('#scene-list').onclick=e=>action(async()=>{const b=e.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-prev-scene'))return navigateScene(-1);if(b.hasAttribute('data-next-scene'))return navigateScene(1);
 if(b.dataset.sceneStyle)return openStyles(b.dataset.sceneStyle);
 if(b.hasAttribute('data-inherit-style')){collect();selectedScene().styleId=null;mark();renderScenes();return;}
 const sid=b.dataset.gen||b.dataset.preview||b.dataset.split||b.dataset.merge;if(!sid)return;collect();const scene=p().scenes.find(s=>s.id===sid),index=p().scenes.indexOf(scene);
 if(b.dataset.gen){await save();versions.delete(sid);await api(`projects/${current}/generate`,'POST',{sceneIds:[sid]});await refresh();}
 if(b.dataset.preview){if(!locked())await save();const r=await api(`projects/${current}/preview`,'POST',{sceneId:sid});modal('최종 이미지 프롬프트',r.prompt);}
 if(b.dataset.split){const answer=await ask('장면 분할',[{key:'boundary',label:'새 장면이 시작할 정확한 원문 구절'}],'입력한 구절부터 다음 장면으로 옮깁니다. 분할 후 각 프롬프트를 다듬어 주세요.');if(!answer)return;const n=scene.sourceText.indexOf(answer.boundary);if(n<=0)throw Error('현재 장면 중간에 있는 정확한 원문 구절을 입력해 주세요.');const next={...structuredClone(scene),id:crypto.randomUUID(),title:scene.title+' (후반)',sourceText:splitNarration(p().scenes,index,n),status:'draft',images:[]};scene.status='draft';p().scenes.splice(index+1,0,next);refreshSourceAssignments(p());selectedByProject.set(current,next.id);mark();renderScenes();}
 if(b.dataset.merge){const next=p().scenes[index+1];mergeNarration(p().scenes,index);scene.prompt+='\n'+next.prompt;scene.characterIds=[...new Set([...scene.characterIds,...next.characterIds])];scene.locationIds=[...new Set([...(scene.locationIds||[]),...(next.locationIds||[])])];scene.status='draft';p().scenes.splice(index+1,1);refreshSourceAssignments(p());mark();renderScenes();}
});
$('#scene-list').addEventListener('change',e=>{if(!e.target.dataset.history)return;versions.set(e.target.dataset.history,Number(e.target.value));collect();renderScenes();});
$('#source-form').onsubmit=e=>{e.preventDefault();action(async()=>{const b=e.target.querySelector('button');b.disabled=true;try{const s=await api('sources','POST',{url:$('#repo-url').value.trim(),ref:$('#repo-ref').value.trim()});notice('프리셋과 예시 이미지 링크 동기화 중…');await api(`sources/${s.id}/sync`,'POST',{});await refresh();renderStyles();notice('프리셋과 예시 이미지 동기화 완료');}finally{b.disabled=false;}});};
$('#sources').onclick=e=>action(async()=>{const b=e.target.closest('[data-sync]');if(!b)return;b.disabled=true;b.textContent='동기화 중…';try{await api(`sources/${b.dataset.sync}/sync`,'POST',{});await refresh();renderStyles();notice('예시 이미지까지 동기화했습니다.');}finally{b.disabled=false;b.textContent='↻ 동기화';}});
$('#presets').onclick=e=>action(async()=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.favorite){state.favorites=await api('favorites','POST',{id:b.dataset.favorite});renderStyles();}if(b.dataset.editStyle)editStyle(b.dataset.editStyle);if(b.dataset.use)applyStyle(b.dataset.use);if(b.dataset.read)openStyleDetail(b.dataset.read);});
$('#style-return').onclick=returnFromStyles;
$('#style-target').onclick=e=>action(async()=>{if(e.target.closest('[data-target-inherit]'))applyStyle(null);if(e.target.closest('[data-target-none]'))applyStyle('');});
$('#detail-apply').onclick=()=>action(async()=>applyStyle(detailId));
$('#detail-favorite').onclick=()=>action(async()=>{state.favorites=await api('favorites','POST',{id:detailId});$('#detail-favorite').textContent=state.favorites.includes(detailId)?'★ 즐겨찾기됨':'☆ 즐겨찾기';renderStyles();});
$('#detail-thumbs').onclick=e=>{const b=e.target.closest('[data-preview-index]');if(b){const s=preset(detailId);$('#detail-image').innerHTML=imageMarkup(s.previewUrls[Number(b.dataset.previewIndex)],s.name);}};
function filterStyles(){stylePage=0;renderStyles();}
$('#style-search').oninput=filterStyles;$('#favorite-only').onchange=filterStyles;$('#preview-only').onchange=filterStyles;$('#style-category').onchange=filterStyles;
$('#styles-prev').onclick=()=>{stylePage--;renderStyles();$('#styles').scrollTop=0;};$('#styles-next').onclick=()=>{stylePage++;renderStyles();$('#styles').scrollTop=0;};
document.addEventListener('keydown',e=>{if(!saving&&!e.target.closest('input,textarea,select,[contenteditable="true"]')&&e.altKey&&tab==='scenes'&&!document.querySelector('dialog[open]')&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();navigateScene(e.key==='ArrowLeft'?-1:1);}if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();if(!locked()&&!saving)action(save);}});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
const textNames={codex:'ChatGPT',claude:'Claude'};
function renderAnalysisModel(){
 const settings=state.settings||engineStatus?.settings;if(!settings)return;
 const model=settings.textProvider==='claude'?settings.claudeModel:settings.codexModel||engineStatus?.codexModel?.model;
 $('#analysis-model').textContent=`분석 모델: ${settings.textProvider==='claude'?'Claude':'GPT'} · ${model||'확인 필요'}${settings.textProvider==='codex'&&!settings.codexModel?' (기본 모델)':''}`;
 const labels={balanced:'차분한 전환',dynamic:'풍부한 컷 · 기본',dense:'매우 촘촘한 전환'};$('#analysis-cut-summary').textContent=`컷 구성: ${labels[p()?.analysisSettings?.density||'dynamic']} · ${p()?.analysisSettings?'저장한 지시문':'기본 지시문'}`;
 const run=p()?.analysisRun;$('#last-analysis-model').textContent=run?`${run.status==='running'?'현재 분석':run.status==='done'?'최근 분석':run.status==='cancelled'?'최근 분석 중단':'최근 분석 실패'}: ${run.provider==='claude'?'Claude':'GPT'} · ${run.model||'모델 확인 중'}`:'';
}
function showEngine(status){const s=status.settings,api=s.imageProvider==='openai';
 engineStatus=status;state.settings=s;renderAnalysisModel();
 $('#connection').textContent=status.ready?`${textNames[s.textProvider]} 분석 · ${api?'API':'ChatGPT'} 이미지`:'AI 연결 확인 필요';
 $('#engine-summary').textContent=`분석: ${status.textModel||'모델 확인 필요'}\n이미지: ${api?s.imageModel:'ChatGPT 자동 선택'}`;
 $('#engine-note-title').textContent=api?`OpenAI API로 생성 · ${s.imageModel}`:'ChatGPT 로그인으로 생성';
 $('#engine-note').textContent=(api?`OpenAI Images API를 API 키로 직접 호출합니다 (품질 ${s.imageQuality}). 장면 프롬프트와 선택한 스타일 이미지, 등장 캐릭터의 참고 이미지·시트가 OpenAI로 전달되며 API 사용량이 과금됩니다.`:'Codex 공식 이미지 도구가 모델을 자동 선택합니다. 대본과 선택한 스타일 이미지, 등장 캐릭터의 참고 이미지·시트가 OpenAI로 전달되며 계정 사용량이 적용됩니다.')+(s.textProvider==='claude'?` 장면 분석에는 대본이 Anthropic(Claude ${s.claudeModel})으로 전달됩니다.`:'');}
const loginNames={codex:'ChatGPT',claude:'Claude'},loginPolls={};
function showLogins(status){for(const service of ['codex','claude']){const info=status[service],login=info?.login||{};
 $$(`.app-sidebar [data-login="${service}"]`).forEach(b=>b.classList.toggle('hidden',!info||info.ready));
 const st=$(`[data-login-status="${service}"]`);st.textContent='';
 if(info?.ready)st.textContent=`✓ ${loginNames[service]} 로그인됨`;
 else if(login.running){st.textContent='브라우저에서 로그인을 완료해 주세요. ';if(login.url){const a=document.createElement('a');a.href=login.url;a.target='_blank';a.rel='noopener';a.textContent='로그인 창 다시 열기';st.append(a);}}
 else if(login.error)st.textContent=login.error;
 $(`[data-login-code="${service}"]`)?.classList.toggle('hidden',!login.running);
 $$(`[data-login="${service}"]`).forEach(b=>{b.disabled=!!login.running;b.textContent=login.running?'로그인 대기 중…':`${loginNames[service]} 로그인`;});}}
function pollLogin(service){clearInterval(loginPolls[service]);
 loginPolls[service]=setInterval(()=>action(async()=>{const status=await api('status');showEngine(status);showLogins(status);const info=status[service];
  if(info?.ready){clearInterval(loginPolls[service]);notice(status.ready?`${loginNames[service]} 로그인 완료!`:status.message);}
  else if(!info?.login?.running){clearInterval(loginPolls[service]);if(info?.login?.error)notice(info.login.error);}}),3000);}
document.addEventListener('click',e=>{const b=e.target.closest('[data-login],[data-submit-code]');if(!b)return;
 if(b.dataset.login)action(async()=>{const service=b.dataset.login;await api(`login/${service}`,'POST',{});
  notice(`브라우저에서 ${loginNames[service]} 계정으로 로그인해 주세요.${service==='claude'?' 인증 코드가 표시되면 AI 설정의 입력칸에 붙여 넣으세요.':''}`);
  showLogins(await api('status'));pollLogin(service);});
 if(b.dataset.submitCode)action(async()=>{const service=b.dataset.submitCode,input=$(`[data-login-code="${service}"] input`);
  await api(`login/${service}/code`,'POST',{code:input.value});input.value='';$(`[data-login-status="${service}"]`).textContent='코드를 확인하는 중…';});});
async function checkStatus(){const status=await api('status');showEngine(status);showLogins(status);if(!status.ready)notice(status.message);return status;}
let settingsInfo=null;
function settingsVisibility(){$('[data-login-row="codex"]').classList.toggle('hidden',![$('#set-text-provider').value,$('#set-image-provider').value].includes('codex'));$$('#settings-form [data-show]').forEach(el=>el.classList.toggle('hidden',![$('#set-text-provider').value,$('#set-image-provider').value].includes(el.dataset.show)));}
function fillOptions(select,values,selected){select.innerHTML=values.map(v=>`<option>${v}</option>`).join('');select.value=selected;}
function fillCodexModels(info,selected=info.settings.codexModel){
 const models=info.options.codexModels,defaultInfo=info.defaultCodexModel||info.codexModel;
 const automatic=defaultInfo.source==='environment'?`환경 설정 · ${defaultInfo.model}`:`기본 모델 · ${defaultInfo.model||'확인 필요'}`;
 $('#set-codex-model').innerHTML=`<option value="">${esc(automatic)}</option>`+models.map(m=>`<option value="${esc(m.model)}">${esc(m.displayName)} · ${esc(m.model)}</option>`).join('')+'<option value="__custom">모델 ID 직접 입력</option>';
 $('#set-codex-model').value=!selected?'':models.some(m=>m.model===selected)?selected:'__custom';
 $('#set-codex-model-custom').value=selected||'';codexModelSelection();
}
function codexModelSelection(){
 const selected=$('#set-codex-model').value,info=settingsInfo;$('#custom-codex-model-field').classList.toggle('hidden',selected!=='__custom');
 const model=selected==='__custom'?$('#set-codex-model-custom').value.trim():selected||(info?.defaultCodexModel||info?.codexModel)?.model;
 $('#codex-model-info').textContent=`선택: ${model||'기본 모델 확인 필요'}${info?.modelCatalogError?' · '+info.modelCatalogError+' 모델 ID를 직접 지정할 수 있습니다.':''}`;
}
$('#set-codex-model').onchange=codexModelSelection;$('#set-codex-model-custom').oninput=codexModelSelection;
$('#reload-codex-models').onclick=()=>action(async()=>{const button=$('#reload-codex-models'),selected=$('#set-codex-model').value==='__custom'?$('#set-codex-model-custom').value.trim():$('#set-codex-model').value;button.disabled=true;try{settingsInfo=await api('settings?refreshModels=1');fillCodexModels(settingsInfo,selected);}finally{button.disabled=false;}});
function showKeyStatus(openai){$('#openai-key-status').textContent=openai.configured?`${openai.source==='env'?'환경 변수 OPENAI_API_KEY':'저장된 키'} 사용 중 (…${openai.last4})`:'저장된 키 없음';$('#clear-openai-key').classList.toggle('hidden',openai.source!=='saved');}
$('#ai-settings').onclick=()=>action(async()=>{settingsInfo=await api('settings');const {settings,options,openai}=settingsInfo;
 $('#set-text-provider').value=settings.textProvider;$('#set-image-provider').value=settings.imageProvider;
 fillOptions($('#set-claude-model'),options.claudeModels,settings.claudeModel);fillOptions($('#set-image-model'),options.imageModels,settings.imageModel);fillOptions($('#set-image-quality'),options.imageQualities,settings.imageQuality);
 fillCodexModels(settingsInfo);
 $('#set-openai-key').value='';showKeyStatus(openai);$('#text-status').textContent='';$('#image-status').textContent='';settingsVisibility();$('#settings-modal').showModal();});
$('#set-text-provider').onchange=$('#set-image-provider').onchange=settingsVisibility;
$('#change-analysis-model').onclick=()=>$('#ai-settings').click();
$('#settings-cancel').onclick=()=>$('#settings-modal').close();
$('#clear-openai-key').onclick=()=>action(async()=>{const r=await api('settings','PUT',{clearOpenaiKey:true});showKeyStatus(r.openai);});
$('#settings-form').onsubmit=e=>{e.preventDefault();action(async()=>{const button=e.submitter;button.disabled=true;
 try{await api('settings','PUT',{textProvider:$('#set-text-provider').value,codexModel:$('#set-codex-model').value==='__custom'?$('#set-codex-model-custom').value.trim():$('#set-codex-model').value,claudeModel:$('#set-claude-model').value,imageProvider:$('#set-image-provider').value,imageModel:$('#set-image-model').value,imageQuality:$('#set-image-quality').value,openaiApiKey:$('#set-openai-key').value});
  $('#set-openai-key').value='';$('#text-status').textContent='연결 확인 중…';const status=await checkStatus();
  $('#text-status').textContent=status.text.ready?'✓ 장면 분석 연결됨':status.text.message;$('#image-status').textContent=status.image.ready?'✓ 이미지 생성 준비됨':status.image.message;
  if(status.ready){$('#settings-modal').close();notice('AI 설정을 저장했습니다.');}}
 catch(error){$('#image-status').textContent=error.message;throw error;}
 finally{button.disabled=false;}});};
setInterval(()=>{if(p()?.analyzing)renderAnalysisProgress();},1000);
setInterval(()=>{if(locked())action(refresh);},2500);
await action(async()=>{await refresh();await checkStatus();});
