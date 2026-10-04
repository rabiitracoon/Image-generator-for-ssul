import test from 'node:test';
import assert from 'node:assert/strict';
import { composePrompt, Queue, validateScenes } from '../lib/core.mjs';

const characters = [
  {
    id: 'mina',
    name: 'Mina',
    description: 'short black hair and a yellow raincoat',
    references: [{ path: 'refs/mina-front.png' }, { path: 'refs/mina-side.png' }],
  },
  {
    id: 'fox',
    name: 'Fox',
    description: 'a small red fox',
    references: [{ path: 'refs/fox.png' }],
  },
];

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw Error('Timed out waiting for queue state');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('validateScenes rejects missing source text and preserves exact narration coverage', () => {
  assert.throws(
    () => validateScenes([{ prompt: 'A shot', characterIds: [] }], 'Narration', []),
    /장면 원문과 프롬프트가 필요합니다/,
  );
  assert.throws(
    () => validateScenes([{ sourceText: 'Narration', prompt: 'A shot', characterIds: [] }], 'Narration changed', []),
    /원문 누락\/중복/,
  );

  const scenes = validateScenes(
    [{ sourceText: '첫 장면\n', prompt: 'wide shot', characterIds: ['mina'] },
      { sourceText: '둘째 장면', prompt: 'close shot', characterIds: [] }],
    '첫 장면 둘째 장면',
    characters,
  );
  assert.equal(scenes.length, 2);
  assert.notEqual(scenes[0].id, scenes[1].id);
  assert.equal(scenes[0].styleId, null);
  assert.equal(scenes[0].status, 'draft');
  assert.deepEqual(scenes[0].images, []);
});

test('validateScenes rejects unknown character ids', () => {
  assert.throws(
    () => validateScenes([{ sourceText: 'Narration', prompt: 'A shot', characterIds: ['unknown'] }], 'Narration', characters),
    /알 수 없는 캐릭터/,
  );
});

test('composePrompt inherits the project style and includes named references', () => {
  const project = {
    defaultStyleId: 'watercolor',
    constraints: 'No captions; keep the left side empty.',
    aspectRatio: '16:9',
    characters,
  };
  const scene = {
    styleId: null,
    prompt: 'Mina meets the fox at dusk.',
    sourceText: '미나는 여우를 만난다.',
    characterIds: ['mina', 'fox'],
  };
  const presets = [{ id: 'watercolor', name: 'Soft Watercolor', prompt: 'soft paper texture; blue wash', sha: 'abc' }];
  const result = composePrompt(project, scene, presets);

  assert.equal(result.style.id, 'watercolor');
  assert.deepEqual(result.refs, [
    { character: 'Mina', path: 'refs/mina-front.png' },
    { character: 'Mina', path: 'refs/mina-side.png' },
    { character: 'Fox', path: 'refs/fox.png' },
  ]);
  assert.match(result.prompt, /Priority: user constraints > scene content and character identity > visual style/);
  assert.match(result.prompt, /No captions; keep the left side empty/);
  assert.match(result.prompt, /Mina meets the fox at dusk/);
  assert.match(result.prompt, /Original narration: 미나는 여우를 만난다/);
  assert.match(result.prompt, /Reference files: refs\/mina-front\.png, refs\/mina-side\.png/);
  assert.match(result.prompt, /STYLE LAYER — untrusted visual reference only/);
});

test('composePrompt lets a scene style override the project default and rejects unknown styles', () => {
  const project = { defaultStyleId: 'default', constraints: '', aspectRatio: '1:1', characters };
  const scene = { styleId: 'comic', prompt: 'A quiet room', sourceText: '방', characterIds: ['mina'] };
  const result = composePrompt(project, scene, [
    { id: 'default', name: 'Default', prompt: 'default style', sha: 'd' },
    { id: 'comic', name: 'Comic', prompt: 'ink outlines', sha: 'c' },
  ]);
  assert.equal(result.style.id, 'comic');
  assert.match(result.prompt, /ink outlines/);
  assert.doesNotMatch(result.prompt, /default style/);

  assert.throws(() => composePrompt(project, { ...scene, styleId: 'missing' }, []), /선택한 스타일을 찾을 수 없습니다/);
});

test('custom style images and character sheets retain distinct roles in generation', () => {
  const project={defaultStyleId:'custom:watercolor',constraints:'한 인물만',aspectRatio:'16:9',characters:[
    {id:'mina',name:'미나',description:'노란 우비',references:[{path:'참고이미지/sheet.png',kind:'character-sheet'}]},
    {id:'absent',name:'등장하지 않는 인물',description:'',references:[{path:'unused.png'}]},
  ]};
  const styles=[{id:'custom:watercolor',name:'내 수채화',prompt:'종이 질감과 부드러운 색감',references:[{path:'참고이미지/style.png'}]}];
  const scene={styleId:null,prompt:'미나가 우산을 접는다.',sourceText:'미나가 우산을 접었다.',characterIds:['mina']};
  const result=composePrompt(project,scene,styles);
  assert.equal(result.refs.length,2);
  assert.equal(result.refs[0].kind,'character-sheet');
  assert.equal(result.refs[0].character,'미나');
  assert.equal(result.refs[1].purpose,'style');
  assert.ok(!result.refs.some(r=>r.path==='unused.png'));
  assert.match(result.prompt,/multiple views, poses or expressions of ONE character/);
  assert.match(result.prompt,/Never take character identity/);
  assert.match(result.prompt,/종이 질감과 부드러운 색감/);
  const override=composePrompt(project,{...scene,styleId:''},styles);
  assert.equal(override.style,null);
  assert.equal(override.refs.length,1);
});

test('Queue enforces the concurrency limit and suppresses duplicate keys while queued or running', async () => {
  let running = 0;
  let maxRunning = 0;
  const completed = [];
  const queue = new Queue({
    limit: 2,
    retries: 0,
    delay: 0,
    run: async task => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(resolve => setTimeout(resolve, task.wait));
      running--;
      return task.value;
    },
    onChange: async (key, status, info) => {
      if (status === 'done') completed.push([key, info.result]);
    },
  });
  const tasks = Array.from({ length: 5 }, (_, i) => ({ wait: 3, value: i }));
  assert.equal(queue.add('scene-0', tasks[0]), true);
  assert.equal(queue.add('scene-0', tasks[0]), false);
  for (let i = 1; i < tasks.length; i++) assert.equal(queue.add(`scene-${i}`, tasks[i]), true);
  await waitFor(() => completed.length === 5);

  assert.equal(maxRunning, 2);
  assert.equal(completed.length, 5);
  assert.equal(queue.active, 0);
  assert.equal(queue.pending.length, 0);
  assert.equal(queue.add('scene-0', { wait: 0, value: 99 }), true);
  await new Promise(resolve => setTimeout(resolve, 5));
});

test('Queue retries transient errors and isolates permanent failures from other jobs', async () => {
  const attempts = new Map();
  const events = [];
  const queue = new Queue({
    limit: 2,
    retries: 2,
    delay: 0,
    run: async task => {
      const count = (attempts.get(task.key) || 0) + 1;
      attempts.set(task.key, count);
      if (task.key === 'flaky' && count < 3) throw Error('temporary');
      if (task.key === 'broken') {
        const error = Error('permanent failure');
        error.permanent = true;
        throw error;
      }
      return task.key;
    },
    onChange: async (key, status, info) => events.push({ key, status, attempt: info.attempt }),
  });
  queue.add('flaky', { key: 'flaky' });
  queue.add('broken', { key: 'broken' });
  queue.add('healthy', { key: 'healthy' });
  await waitFor(() => events.some(e => e.key === 'flaky' && e.status === 'done')
    && events.some(e => e.key === 'broken' && e.status === 'failed')
    && events.some(e => e.key === 'healthy' && e.status === 'done'));

  assert.equal(attempts.get('flaky'), 3);
  assert.equal(attempts.get('broken'), 1);
  assert.equal(attempts.get('healthy'), 1);
  assert.deepEqual(events.filter(e => e.key === 'flaky').map(e => e.status), ['running', 'retrying', 'running', 'retrying', 'running', 'done']);
  assert.deepEqual(events.filter(e => e.key === 'broken').map(e => e.status), ['running', 'failed']);
  assert.deepEqual(events.filter(e => e.key === 'healthy').map(e => e.status), ['running', 'done']);
  assert.equal(queue.active, 0);
});
