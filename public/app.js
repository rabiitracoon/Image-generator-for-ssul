import {filterScenes,pageItems} from './view-model.js';
let state={projects:[],presets:[],sources:[],favorites:[]};
let current=localStorage.getItem('scene-project'),dirty=false,tab='script',refreshing=false,saving=false;
let boardView='focus',gridPage=0,stylePage=0,styleTarget=null,detailId=null;
const selectedByProject=new Map(),versions=new Map();
let styleDraft={id:null,references:[],uploads:[]},styleSaving=false;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const p=()=>state.projects.find(x=>x.id===current);
const locked=()=>p()?.analyzing||p()?.scenes.some(s=>['queued','running','retrying'].includes(s.status));
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
 $('#analyze').textContent=project.analyzing?'✦ 장면 분석 중…':'✦ AI 장면 분석';$('#analyze').disabled=locked();$('#generate').disabled=locked()||!project.scenes.length;
 ['#add-scene','#add-character','#save','#name','#script-input','#constraints','#aspect'].forEach(s=>$(s).disabled=locked());
 renderProjectStyle();
 renderCharacters(project);
 renderScenes();renderStyles();if(project.analysisError)notice(project.analysisError);
}
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
 if(locked())$$('#scene-list [data-field],#scene-list [data-cast]').forEach(el=>el.disabled=true);
}
function sceneEditor(s,index,list){const vi=Math.min(versions.get(s.id)??s.images.length-1,s.images.length-1),im=s.images[vi];const si=list.findIndex(x=>x.id===s.id),effective=s.styleId===null?p().defaultStyleId:s.styleId,style=preset(effective);
 return `<article class="scene" data-id="${s.id}"><div class="scene-head"><span class="scene-number">${String(index+1).padStart(2,'0')}</span><input data-field="title" value="${esc(s.title)}" aria-label="장면 제목"><span class="badge ${s.status}">${sceneStatus(s)}${s.attempts?` · ${s.attempts}회`:''}</span><div class="actions"><button data-prev-scene ${si<=0?'disabled':''} title="이전 장면 (Alt+←)" aria-label="이전 장면">←</button><button data-next-scene ${si+1>=list.length?'disabled':''} title="다음 장면 (Alt+→)" aria-label="다음 장면">→</button></div></div>
 <div class="scene-body"><div class="scene-stage"><div class="scene-image">${imageMarkup(im?.url,s.title,['running','retrying','queued'].includes(s.status)?'✦ '+statuses[s.status]+'…':'이 장면의 첫 이미지를 만들어보세요.')}</div><div class="image-actions">${im?`<select data-history="${s.id}" aria-label="이미지 버전">${s.images.map((v,j)=>`<option value="${j}" ${j===vi?'selected':''}>버전 ${j+1} · ${new Date(v.createdAt).toLocaleTimeString()}</option>`).join('')}</select><a class="button download" href="${im.url}" download>다운로드 ↓</a>`:'<span class="hint">검토한 프롬프트로 이미지를 생성합니다.</span>'}<button data-gen="${s.id}" class="primary" ${locked()?'disabled':''}>${im?'↻ 재생성':'✦ 이미지 생성'}</button></div>${s.error?`<div class="scene-error">${esc(s.error)}</div>`:''}<details class="cut-reason"><summary>장면 전환 이유</summary><p>${esc(s.reason||'사용자가 추가한 장면입니다.')}</p></details></div>
 <div class="scene-fields"><div class="inspector-label">SCENE DETAILS</div><label>대본 구간<textarea data-field="sourceText">${esc(s.sourceText)}</textarea></label><label>이미지 프롬프트<textarea data-field="prompt">${esc(s.prompt)}</textarea></label><div class="field-label">장면 스타일 <small>${s.styleId===null?'프로젝트 기본 적용':'이 장면만 적용'}</small></div><input type="hidden" data-field="styleId" value="${esc(s.styleId===null?'__inherit':s.styleId)}"><button class="scene-style-picker" data-scene-style="${s.id}" ${locked()?'disabled':''}>${imageMarkup(style?.previewUrls?.[0],style?.name||'스타일 없음','▧')}<span><strong>${esc(style?.name||'스타일 없음')}</strong><small>미리보고 다른 스타일 선택 →</small></span></button>${s.styleId!==null?'<button class="text-button" data-inherit-style>프로젝트 기본 스타일로 되돌리기</button>':''}<div class="field-label">등장 캐릭터</div><div class="cast">${p().characters.map(c=>`<label><input type="checkbox" data-cast="${c.id}" ${s.characterIds.includes(c.id)?'checked':''}>${esc(c.name)}</label>`).join('')||'<span class="hint">등록된 캐릭터가 없습니다.</span>'}</div><button data-preview="${s.id}" class="wide secondary">최종 프롬프트 확인</button></div></div>
 <div class="scene-foot"><span>장면 ${index+1} / ${p().scenes.length} · 편집 내용은 변경 저장으로 보관됩니다.</span><div class="actions"><button data-split="${s.id}" ${locked()?'disabled':''}>장면 분할</button>${index<p().scenes.length-1?`<button data-merge="${s.id}" ${locked()?'disabled':''}>다음과 병합</button>`:''}</div></div></article>`;
}

function renderCharacters(project){
 $('#characters').innerHTML=project.characters.length?project.characters.map(c=>`<article class="character"><div class="character-head"><h3>◉ ${esc(c.name)}</h3><button data-delete-char="${c.id}" title="캐릭터 삭제" ${locked()?'disabled':''}>✕</button></div><p>${esc(c.description||'외형 설명 없음')}</p><div class="refs">${c.references.map(r=>`<div class="ref" title="${esc(r.name)}"><img src="${esc(r.url)}" alt="${esc(r.name)}"><span class="reference-kind">${r.kind==='character-sheet'?'캐릭터 시트':'외형 참고'}</span><button data-delete-ref="${r.id}" aria-label="${esc(r.name)} 삭제" ${locked()?'disabled':''}>✕</button></div>`).join('')}</div><div class="character-uploads"><label class="upload">＋ 일반 참고 이미지<input data-upload="${c.id}" data-kind="reference" type="file" accept="image/png,image/jpeg,image/webp" multiple ${locked()?'disabled':''}></label><label class="upload sheet-upload">＋ 캐릭터 시트 추가<input data-upload="${c.id}" data-kind="character-sheet" type="file" accept="image/png,image/jpeg,image/webp" multiple ${locked()?'disabled':''}></label></div><p class="hint">정면·측면·뒷모습·표정이 모인 시트도 한 장 그대로 등록하세요.<br>시트와 일반 이미지 합계 최대 10장 · 파일당 32MB</p></article>`).join(''):'<div class="empty">반복 등장하는 캐릭터가 있나요?<br>캐릭터를 추가한 뒤 참고 이미지나 캐릭터 시트를 등록하세요.</div>';
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
async function refresh(){if(refreshing)return;refreshing=true;try{const next=await api('state');if(dirty){state.presets=next.presets;state.sources=next.sources;state.favorites=next.favorites;return;}state=next;if(!p())current=state.projects[0]?.id;if(!p()){const created=await api('projects','POST',{name:'나의 첫 스토리보드'});state.projects.push(created);current=created.id;}localStorage.setItem('scene-project',current);render();}finally{refreshing=false;}}
function collect(){const project=p();if(!project)return;Object.assign(project,{name:$('#name').value,script:$('#script-input').value,constraints:$('#constraints').value,aspectRatio:$('#aspect').value,defaultStyleId:$('#default-style').value});$$('.scene').forEach(el=>{const s=project.scenes.find(x=>x.id===el.dataset.id);if(!s)return;el.querySelectorAll('[data-field]').forEach(input=>s[input.dataset.field]=input.value==='__inherit'?null:input.value);s.characterIds=[...el.querySelectorAll('[data-cast]:checked')].map(x=>x.dataset.cast);});}
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
$('#new-project').onclick=()=>action(async()=>{if(dirty)await save();const created=await api('projects','POST',{name:'새 스토리보드'});current=created.id;styleTarget=null;$('#scene-search').value='';$('#scene-filter').value='all';await refresh();showTab('script');});
$('#projects').onclick=e=>action(async()=>{const b=e.target.closest('[data-project]');if(!b)return;if(dirty)await save();current=b.dataset.project;styleTarget=null;gridPage=0;$('#scene-search').value='';$('#scene-filter').value='all';await refresh();});
$$('#name,#script-input,#constraints,#aspect').forEach(el=>el.addEventListener('input',()=>{mark();$('#char-count').textContent=`${$('#script-input').value.length.toLocaleString()}자`;}));
$('#scene-list').addEventListener('input',e=>{if(!e.target.dataset.history)mark();});
$('#choose-project-style').onclick=()=>openStyles();
$('#project-style-card').onclick=e=>action(async()=>{if(e.target.closest('[data-project-style-clear]')){if(locked())throw Error('작업 완료 후 수정해 주세요.');collect();p().defaultStyleId='';$('#default-style').value='';mark();renderProjectStyle();renderScenes();}});
$('#analyze').onclick=()=>action(async()=>{if(p().scenes.length&&!await ask('대본을 다시 분석할까요?',[],'현재 장면 편집과 이미지 연결은 새 분석 결과로 바뀝니다. 기존 이미지 파일은 로컬에 남습니다.'))return;collect();const {scenes,...fields}=p();await api(`projects/${current}`,'PUT',fields);dirty=false;await api(`projects/${current}/analyze`,'POST',{});await refresh();showTab('scenes');});
$('#generate').onclick=()=>action(async()=>{await save();await api(`projects/${current}/generate`,'POST',{});await refresh();});
$('#add-character').onclick=()=>action(async()=>{const answer=await ask('캐릭터 추가',[{key:'name',label:'캐릭터 이름'},{key:'description',label:'일관되게 유지할 외형 설명 (머리, 얼굴, 의상 등)',multiline:true,required:false}]);if(!answer)return;const {name,description}=answer;if(dirty)await save();await api(`projects/${current}/characters`,'POST',{name,description});await refresh();});
$('#characters').addEventListener('change',e=>action(async()=>{const input=e.target;if(!input.dataset.upload)return;if(dirty)await save();for(const file of input.files){const image=await readImage(file);await api(`projects/${current}/references`,'POST',{characterId:input.dataset.upload,...image,kind:input.dataset.kind||'reference'});}await refresh();notice(input.dataset.kind==='character-sheet'?'캐릭터 시트를 등록했습니다. 등장 장면에 외형 참고로 적용됩니다.':'캐릭터 참고 이미지를 등록했습니다.');}));
$('#characters').onclick=e=>action(async()=>{const b=e.target.closest('button');if(!b)return;if(dirty)await save();if(b.dataset.deleteChar)await api(`projects/${current}/characters/${b.dataset.deleteChar}`,'DELETE',{});if(b.dataset.deleteRef)await api(`projects/${current}/references/${b.dataset.deleteRef}`,'DELETE',{});await refresh();});
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
 if(b.dataset.split){const answer=await ask('장면 분할',[{key:'boundary',label:'새 장면이 시작할 정확한 원문 구절'}],'입력한 구절부터 다음 장면으로 옮깁니다. 분할 후 각 프롬프트를 다듬어 주세요.');if(!answer)return;const n=scene.sourceText.indexOf(answer.boundary);if(n<=0)throw Error('현재 장면 중간에 있는 정확한 원문 구절을 입력해 주세요.');const next={...structuredClone(scene),id:crypto.randomUUID(),title:scene.title+' (후반)',sourceText:scene.sourceText.slice(n),status:'draft',images:[]};scene.sourceText=scene.sourceText.slice(0,n);scene.status='draft';p().scenes.splice(index+1,0,next);selectedByProject.set(current,next.id);mark();renderScenes();}
 if(b.dataset.merge){const next=p().scenes[index+1];scene.sourceText+=' '+next.sourceText;scene.prompt+='\n'+next.prompt;scene.characterIds=[...new Set([...scene.characterIds,...next.characterIds])];scene.status='draft';p().scenes.splice(index+1,1);mark();renderScenes();}
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
await action(async()=>{await refresh();const status=await api('status');$('#connection').textContent=status.ready?'ChatGPT 연결됨':'Codex 로그인 필요';if(!status.ready)notice(status.message+'\n터미널에서 codex login을 실행해 주세요.');});
setInterval(()=>{if(locked()&&!dirty)action(refresh);},2500);
