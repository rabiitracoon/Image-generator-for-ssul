import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startServer() {
  const port = await unusedPort();
  const data = await mkdtemp(path.join(tmpdir(), 'scene-studio-api-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SCENE_DATA_DIR: data, SCENE_REFERENCE_DIR: path.join(data, '참고이미지') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  for (let i = 0; i < 50 && !output.includes('Scene Studio:'); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!output.includes('Scene Studio:')) throw Error(`Test server did not start: ${output}`);
  return { child, data, referenceDir: path.join(data, '참고이미지'), base: `http://127.0.0.1:${port}` };
}

async function api(base, route, method = 'GET', body) {
  const response = await fetch(`${base}/api/${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('scenes PUT preserves requested IDs and rejects narration coverage gaps without mutating the project', async t => {
  const { child, base } = await startServer();
  t.after(() => child.kill('SIGTERM'));

  const created = await api(base, 'projects', 'POST', { name: 'HTTP integration' });
  assert.equal(created.status, 201);
  const projectId = created.body.id;
  const script = '첫 장면입니다. 둘째 장면입니다.';
  assert.equal((await api(base, `projects/${projectId}`, 'PUT', { script })).status, 200);

  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const scenes = [
    { id: ids[0], title: '첫 장면', sourceText: '첫 장면입니다.', reason: '행동 시작', prompt: '비어 있지 않은 이미지 프롬프트', characterIds: [], styleId: null },
    { id: ids[1], title: '둘째 장면', sourceText: '둘째 장면입니다.', reason: '행동 변화', prompt: '두 번째 이미지 프롬프트', characterIds: [], styleId: null },
  ];
  const saved = await api(base, `projects/${projectId}/scenes`, 'PUT', { scenes });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.scenes.map(scene => scene.id), ids);
  assert.deepEqual(saved.body.scenes.map(scene => scene.status), ['draft', 'draft']);

  const invalid = await api(base, `projects/${projectId}/scenes`, 'PUT', { scenes: [scenes[0]] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /원문 누락\/중복/);

  const invalidProjectUpdate = await api(base, `projects/${projectId}`, 'PUT', {
    name: '변경되면 안 되는 이름',
    script: '변경되면 안 되는 대본',
    scenes: [scenes[0]],
  });
  assert.equal(invalidProjectUpdate.status, 400);
  assert.match(invalidProjectUpdate.body.error, /원문 누락\/중복/);

  const state = await api(base, 'state');
  const persisted = state.body.projects.find(project => project.id === projectId);
  assert.equal(persisted.name, 'HTTP integration');
  assert.equal(persisted.script, script);
  assert.deepEqual(persisted.scenes.map(scene => scene.id), ids);
  assert.equal(
    persisted.scenes.map(scene => scene.sourceText).join('').replace(/\s/g, ''),
    script.replace(/\s/g, ''),
  );
});

test('analysis prompt settings persist per project and preview unsaved inputs without changing the project',async t=>{
 const {child,base}=await startServer();t.after(()=>child.kill('SIGTERM'));
 const p=(await api(base,'projects','POST',{name:'프롬프트 편집'})).body,route=`projects/${p.id}`;
 const defaults=(await api(base,route+'/analysis-prompt')).body;assert.equal(defaults.density,'dynamic');assert.match(defaults.instructions,/바스트샷/);
 const saved=await api(base,route+'/analysis-prompt','PUT',{instructions:'리액션 클로즈업을 늘려주세요.',density:'dense'});assert.equal(saved.status,200);
 const preview=await api(base,route+'/analysis-prompt-preview','POST',{instructions:'미리보기만 적용',density:'balanced',script:'문이 열리고 민지가 웃었다.',constraints:'글자 없음'});
 assert.equal(preview.status,200);assert.match(preview.body.prompt,/미리보기만 적용/);assert.match(preview.body.prompt,/문이 열리고 민지가 웃었다/);
 const stored=(await api(base,route+'/analysis-prompt')).body;assert.equal(stored.instructions,'리액션 클로즈업을 늘려주세요.');assert.equal(stored.density,'dense');
 assert.equal((await api(base,'state')).body.projects[0].script,'');
 assert.equal((await api(base,route+'/analysis-prompt','PUT',{instructions:''})).status,400);
 assert.equal((await api(base,route+'/analysis-prompt','PUT',{density:'bad'})).status,400);
 const p2=(await api(base,'projects','POST',{name:'별도 프로젝트'})).body;assert.equal((await api(base,`projects/${p2.id}/analysis-prompt`)).body.instructions,defaults.instructions);
 const script='민지가 말했다.',scenes=[{title:'풀샷',sourceText:'민지가 ',camera:'풀샷',prompt:'wide shot',characterIds:[],styleId:null},{title:'대사',sourceText:'말했다.',camera:'바스트샷',prompt:'bust shot',characterIds:[],styleId:null}];
 await api(base,route,'PUT',{script});assert.equal((await api(base,route+'/scenes','PUT',{scenes})).status,200);
 const state=(await api(base,'state')).body.projects[0];assert.equal(state.scenes.length,2);assert.equal(state.scenes[1].sourceRange.start,4);assert.equal(state.scenes.map(s=>s.sourceText).join(''),script);assert.equal(state.scenes[1].camera,'바스트샷');
 const generation=(await api(base,route+'/preview','POST',{sceneId:state.scenes[1].id})).body;assert.match(generation.prompt,/Camera direction: 바스트샷/);
});

test('text and image-only custom styles are editable; scene previews carry style images and character sheets', async t => {
  const {child,data,referenceDir,base}=await startServer();
  t.after(()=>child.kill('SIGTERM'));
  const image={name:'수채화.png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII='};
  const empty=await api(base,'styles','POST',{name:'비어 있는 스타일',prompt:''});
  assert.equal(empty.status,400);
  const textStyle=await api(base,'styles','POST',{name:'텍스트 스타일',prompt:'간결한 선화'});
  assert.equal(textStyle.status,201);
  const imageStyle=await api(base,'styles','POST',{name:'이미지 스타일',images:[image]});
  assert.equal(imageStyle.status,201);
  assert.equal(imageStyle.body.prompt,'');
  assert.equal(imageStyle.body.sourceType,'custom');
  assert.equal(path.isAbsolute(imageStyle.body.references[0].path),false);
  const pid=(await api(base,'projects','POST',{name:'스타일 및 캐릭터 시트'})).body.id;
  const character=(await api(base,`projects/${pid}/characters`,'POST',{name:'미나'})).body;
  const sheet=await api(base,`projects/${pid}/references`,'POST',{characterId:character.id,...image,name:'캐릭터시트.png',kind:'character-sheet'});
  assert.equal(sheet.body.references[0].kind,'character-sheet');
  await api(base,`projects/${pid}`,'PUT',{script:'첫 장면. 둘째 장면.',defaultStyleId:imageStyle.body.id});
  const scenes=(await api(base,`projects/${pid}/scenes`,'PUT',{scenes:[
    {title:'기본 스타일',sourceText:'첫 장면.',prompt:'미나가 서 있다.',characterIds:[character.id],styleId:null},
    {title:'장면 스타일',sourceText:'둘째 장면.',prompt:'미나가 걷는다.',characterIds:[character.id],styleId:textStyle.body.id},
  ]})).body.scenes;
  const preview=await api(base,`projects/${pid}/preview`,'POST',{sceneId:scenes[0].id});
  assert.equal(preview.status,200);
  assert.equal(preview.body.refs.length,2);
  assert.equal(preview.body.refs[0].kind,'character-sheet');
  assert.equal(preview.body.refs[1].purpose,'style');
  assert.equal(preview.body.refs[1].path,path.join(referenceDir,path.basename(imageStyle.body.references[0].path)));
  assert.match(preview.body.prompt,/multiple views, poses or expressions of ONE character/);
  const overridden=await api(base,`projects/${pid}/preview`,'POST',{sceneId:scenes[1].id});
  assert.equal(overridden.body.refs.length,1);
  assert.match(overridden.body.prompt,/간결한 선화/);
  const persisted=JSON.parse(await readFile(path.join(data,'state.json'),'utf8'));
  assert.equal(persisted.presets[0].references[0].path,imageStyle.body.references[0].path);
  const edit=await api(base,`styles/${encodeURIComponent(imageStyle.body.id)}`,'PUT',{name:'수정된 수채화',prompt:'따뜻한 종이 질감',referenceIds:[]});
  assert.equal(edit.status,200);
  assert.equal(edit.body.references.length,0);
  const editedPreview=await api(base,`projects/${pid}/preview`,'POST',{sceneId:scenes[0].id});
  assert.match(editedPreview.body.prompt,/따뜻한 종이 질감/);
  assert.equal(editedPreview.body.refs.length,1);
  const invalid=await api(base,`styles/${encodeURIComponent(imageStyle.body.id)}`,'PUT',{name:'잘못된 이미지',prompt:'x',images:[{name:'broken.png',base64:'not-an-image'}]});
  assert.equal(invalid.status,400);
  assert.equal((await api(base,'state')).body.presets[0].name,'수정된 수채화');
});

test('reference uploads persist relative paths and are resolved from the current folder for preview', async t => {
  const { child, data, referenceDir, base } = await startServer();
  t.after(() => child.kill('SIGTERM'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=', 'base64');
  const created = await api(base, 'projects', 'POST', { name: 'Portable images' });
  const pid = created.body.id;
  const character = await api(base, `projects/${pid}/characters`, 'POST', { name: '지수' });
  const upload = await api(base, `projects/${pid}/references`, 'POST', {
    characterId: character.body.id, name: '지수.png', base64: png.toString('base64'),
  });
  assert.equal(upload.status, 201);
  const reference = upload.body.references[0];
  assert.equal(path.isAbsolute(reference.path), false);
  assert.equal(reference.path, `참고이미지/${path.basename(reference.path)}`);
  const file = path.join(referenceDir, path.basename(reference.path));
  assert.deepEqual(await readFile(file), png);
  const media = await fetch(`${base}${reference.url}`);
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  await api(base, `projects/${pid}`, 'PUT', { script: '지수가 서 있다.' });
  const scenes = [{ title: '지수', sourceText: '지수가 서 있다.', prompt: '지수가 창가에 서 있다.', characterIds: [character.body.id], styleId: null }];
  const saved = await api(base, `projects/${pid}/scenes`, 'PUT', { scenes });
  const preview = await api(base, `projects/${pid}/preview`, 'POST', { sceneId: saved.body.scenes[0].id });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.refs[0].path, file);
  assert.ok(preview.body.prompt.includes(file));
  const persisted = JSON.parse(await readFile(path.join(data, 'state.json'), 'utf8'));
  assert.equal(persisted.projects[0].characters[0].references[0].path, reference.path);
  await rm(file);
  const missing = await api(base, `projects/${pid}/generate`, 'POST', {});
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /참고 이미지.*찾을 수 없습니다/);
  const state = await api(base, 'state');
  assert.equal(state.body.projects[0].scenes[0].status, 'draft');
});
