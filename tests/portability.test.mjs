import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findCodexBinary } from '../lib/codex.mjs';
import { startStudio } from '../lib/launcher.mjs';
import { migrateReferences, resolveProjectReferences, resolveStyleReferences } from '../lib/references.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = '11111111-1111-4111-8111-111111111111.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=', 'base64');

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'scene-portability-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function database() {
  return { projects: [{ id: 'project', characters: [{ id: 'character', name: '지수', references: [{
    id: 'reference', name: '지수.png', path: `/Users/previous-mac/old-project/data/references/${filename}`,
    url: `/media/references/${filename}`,
  }] }], scenes: [] }] };
}

test('old Mac references migrate from the copied local files and survive another move', async t => {
  const dir = await workspace(t);
  const dataDir = path.join(dir, 'old', 'data');
  const referenceDir = path.join(dir, 'old', '참고이미지');
  await mkdir(path.join(dataDir, 'references'), { recursive: true });
  await writeFile(path.join(dataDir, 'references', filename), png);
  const db = database();
  assert.deepEqual(await migrateReferences(db, { dataDir, referenceDir }), { changed: true, missing: [] });
  assert.equal(db.projects[0].characters[0].references[0].path, `참고이미지/${filename}`);
  assert.deepEqual(await readFile(path.join(dataDir, 'references', filename)), png);
  const moved = path.join(dir, '새 Mac 폴더 이름', '참고이미지');
  await cp(referenceDir, moved, { recursive: true });
  const result = await resolveProjectReferences(db.projects[0], moved);
  assert.equal(result.characters[0].references[0].path, path.join(moved, filename));
  assert.equal(db.projects[0].characters[0].references[0].path, `참고이미지/${filename}`);
  assert.deepEqual(await migrateReferences(db, { dataDir, referenceDir: moved }), { changed: false, missing: [] });
});

test('migration preserves existing destination images and reports absent references before generation', async t => {
  const dir = await workspace(t);
  const dataDir = path.join(dir, 'data');
  const referenceDir = path.join(dir, '참고이미지');
  await mkdir(path.join(dataDir, 'references'), { recursive: true });
  await mkdir(referenceDir);
  await writeFile(path.join(dataDir, 'references', filename), 'old');
  await writeFile(path.join(referenceDir, filename), png);
  const db = database();
  await migrateReferences(db, { dataDir, referenceDir });
  assert.deepEqual(await readFile(path.join(referenceDir, filename)), png);
  await rm(path.join(referenceDir, filename));
  await rm(path.join(dataDir, 'references', filename));
  assert.deepEqual((await migrateReferences(db, { dataDir, referenceDir })).missing, ['지수.png']);
  await assert.rejects(resolveProjectReferences(db.projects[0], referenceDir), /지수.*참고 이미지.*찾을 수 없습니다/);
});

test('custom style references survive moving the reference folder', async t=>{
  const dir=await workspace(t),dataDir=path.join(dir,'data'),referenceDir=path.join(dir,'참고이미지');
  await mkdir(referenceDir,{recursive:true});
  await writeFile(path.join(referenceDir,filename),png);
  const db={projects:[],presets:[{id:'custom:one',name:'내 스타일',references:[{name:'색감.png',path:`참고이미지/${filename}`,url:`/media/references/${filename}`}]}]};
  assert.deepEqual(await migrateReferences(db,{dataDir,referenceDir}),{changed:false,missing:[]});
  const destination=path.join(dir,'다른 컴퓨터','참고이미지');
  await cp(referenceDir,destination,{recursive:true});
  const resolved=await resolveStyleReferences(db.presets[0],destination);
  assert.equal(resolved.references[0].path,path.join(destination,filename));
  assert.equal(db.presets[0].references[0].path,`참고이미지/${filename}`);
  await rm(path.join(destination,filename));
  await assert.rejects(resolveStyleReferences(db.presets[0],destination),/스타일.*참고 이미지.*찾을 수 없습니다/);
});

test('Codex discovery supports the current app bundle without a configured terminal PATH', async t => {
  const dir = await workspace(t);
  const cli = path.join(dir, 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, '#!/bin/sh\nexit 0\n');
  await chmod(cli, 0o755);
  assert.equal(findCodexBinary({ override: '', searchPath: '', applications: [dir] }), cli);
  assert.equal(findCodexBinary({ override: '/custom/codex', searchPath: '', applications: [] }), '/custom/codex');
});

async function copyApplication(t, dir, name) {
  const root = path.join(dir, name);
  await mkdir(root, { recursive: true });
  await cp(path.join(ROOT, 'server.mjs'), path.join(root, 'server.mjs'));
  await cp(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  await cp(path.join(ROOT, 'public'), path.join(root, 'public'), { recursive: true });
  const running = await startStudio({ root, preferredPort: 47000, openBrowser: false,
    env: { ...process.env, SCENE_DATA_DIR: path.join(root, 'data'), SCENE_REFERENCE_DIR: path.join(root, '참고이미지') } });
  t.after(async () => {
    if (running.child?.exitCode === null && running.child?.signalCode === null) {
      const closed = once(running.child, 'close');
      running.child.kill('SIGTERM');
      await closed;
    }
  });
  return { ...running, root };
}

test('launching two copied folders uses separate ports; the same folder reuses its server', async t => {
  const dir = await workspace(t);
  const first = await copyApplication(t, dir, '첫 번째 Mac 폴더');
  const second = await copyApplication(t, dir, '이동한 Mac 폴더');
  assert.notEqual(first.url, second.url);
  const reused = await startStudio({ root: first.root, preferredPort: 47000, openBrowser: false });
  assert.equal(reused.reused, true);
  assert.equal(reused.url, first.url);
  const page = await fetch(second.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SCENE STUDIO/);
});

test('launcher skips a port used by an unrelated application', async t => {
  const dir = await workspace(t);
  const unrelated = http.createServer((req, res) => { res.end('{"application":"unrelated"}'); });
  unrelated.listen(0, '127.0.0.1');
  await once(unrelated, 'listening');
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  const root = path.join(dir, 'app');
  await mkdir(root);
  await cp(path.join(ROOT, 'server.mjs'), path.join(root, 'server.mjs'));
  await cp(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  const port = unrelated.address().port;
  const running = await startStudio({ root, preferredPort: port, openBrowser: false });
  t.after(async () => { const closed = once(running.child, 'close'); running.child.kill('SIGTERM'); await closed; });
  assert.notEqual(running.url, `http://127.0.0.1:${port}`);
});
