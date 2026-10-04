import test from 'node:test';
import assert from 'node:assert/strict';
import { filterScenes, pageItems, characterLocked, projectLocked, sheetProgress } from '../public/view-model.js';

test('sheet jobs lock only their own characters while scene work locks the character workspace',()=>{
  const idle={sheetJob:{status:'done'}},running={sheetJob:{status:'running'}},queued={sheetJob:{status:'queued'}},retrying={sheetJob:{status:'retrying'}};
  const project={characters:[idle,running,queued,retrying],scenes:[],analyzing:false};
  assert.equal(projectLocked(project),true);
  assert.equal(characterLocked(project),false);
  assert.equal(characterLocked(project,idle),false);
  for(const c of [running,queued,retrying])assert.equal(characterLocked(project,c),true);
  assert.equal(sheetProgress(project),'2개 생성 중 · 1개 대기 · 최대 3개 동시 생성');
  project.analyzing=true;assert.equal(characterLocked(project),true);assert.equal(characterLocked(project,idle),true);
  project.analyzing=false;project.scenes=[{status:'running'}];assert.equal(characterLocked(project),true);
  project.scenes=[];project.characters=[idle];assert.equal(projectLocked(project),false);
});

function makeScenes() {
  return Array.from({ length: 100 }, (_, index) => {
    const number = index + 1;
    let status = 'draft';
    let images = [];
    if (number <= 3) status = 'running';
    else if (number <= 6) status = 'queued';
    else if (number <= 9) status = 'retrying';
    else if (number === 98) status = 'done';
    else if (number === 99) status = 'failed';
    else if (number === 100) {
      status = 'done';
      images = ['/media/scene-100.png'];
    }
    return {
      id: `scene-${number}`,
      title: `Shot ${number}`,
      sourceText: `Narration ${number}`,
      prompt: `Prompt ${number}`,
      status,
      images,
    };
  });
}

test('filterScenes searches title, source text, and prompt and groups running statuses', () => {
  const scenes = makeScenes();

  assert.deepEqual(filterScenes(scenes, 'pRoMpT 100').map(scene => scene.id), ['scene-100']);
  assert.deepEqual(filterScenes(scenes, '', 'running').map(scene => scene.id), [
    ...Array.from({ length: 9 }, (_, index) => `scene-${index + 1}`),
  ]);
  assert.equal(filterScenes(scenes, '', 'pending').length, 90);
  assert.equal(filterScenes(scenes, '', 'pending').at(-1).id, 'scene-99');
  assert.deepEqual(filterScenes(scenes, 'narration 100', 'done').map(scene => scene.id), ['scene-100']);
});

test('pageItems handles 100-item page boundaries and clamps invalid pages', () => {
  const scenes = makeScenes();

  const first = pageItems(scenes, 0, 24);
  assert.equal(first.index, 0);
  assert.equal(first.pages, 5);
  assert.equal(first.total, 100);
  assert.deepEqual(first.items.map(scene => scene.id), scenes.slice(0, 24).map(scene => scene.id));

  const last = pageItems(scenes, 4, 24);
  assert.equal(last.index, 4);
  assert.equal(last.items.length, 4);
  assert.equal(last.items[0].id, 'scene-97');
  assert.equal(last.items.at(-1).id, 'scene-100');
  assert.equal(pageItems(scenes, 100, 24).index, 4);
  assert.equal(pageItems(scenes, -1, 24).index, 0);
  assert.equal(pageItems([], 3, 24).pages, 1);
  assert.equal(pageItems([], 3, 24).index, 0);
});
