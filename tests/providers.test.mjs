import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findClaudeBinary, parseClaudeResult } from '../lib/claude.mjs';
import { generateWithOpenAI, referenceLegend } from '../lib/openai-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=', 'base64');

test('findClaudeBinary prefers CLAUDE_BIN, then PATH, then the newest Claude desktop bundle', async () => {
  assert.equal(findClaudeBinary({ override: '/custom/claude' }), '/custom/claude');
  const home = await mkdtemp(path.join(tmpdir(), 'claude-home-'));
  const bundle = v => path.join(home, 'Library/Application Support/Claude/claude-code', v, 'abc', 'claude.app/Contents/MacOS');
  for (const v of ['2.1.9', '2.1.10']) { await mkdir(bundle(v), { recursive: true }); await writeFile(path.join(bundle(v), 'claude'), ''); await chmod(path.join(bundle(v), 'claude'), 0o755); }
  assert.equal(findClaudeBinary({ override: '', searchPath: '', home }), path.join(bundle('2.1.10'), 'claude'));
  const bin = path.join(home, 'bin'); await mkdir(bin); await writeFile(path.join(bin, 'claude'), ''); await chmod(path.join(bin, 'claude'), 0o755);
  assert.equal(findClaudeBinary({ override: '', searchPath: bin, home }), path.join(bin, 'claude'));
});

test('parseClaudeResult reads structured output and reports login errors', () => {
  assert.deepEqual(parseClaudeResult(JSON.stringify({ type: 'result', is_error: false, structured_output: { scenes: [] } })), { scenes: [] });
  assert.deepEqual(parseClaudeResult(JSON.stringify({ type: 'result', is_error: false, result: '```json\n{"scenes":[1]}\n```' })), { scenes: [1] });
  assert.throws(() => parseClaudeResult(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })), /Claude 로그인 필요/);
});

test('generateWithOpenAI uses generations without references and multipart edits with a reference legend', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 }); };
  const plain = await generateWithOpenAI({ prompt: 'scene', aspectRatio: '9:16', apiKey: 'sk-test', model: 'gpt-image-2.5-sunburst', quality: 'high', baseUrl: 'http://x/v1', fetchImpl });
  assert.equal(plain.ext, 'png');
  assert.equal(calls[0].url, 'http://x/v1/images/generations');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'gpt-image-2.5-sunburst', prompt: 'scene', size: '1152x2048', quality: 'high', n: 1 });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');

  const dir = await mkdtemp(path.join(tmpdir(), 'openai-refs-'));
  const sheet = path.join(dir, 'sheet.png'), styleImage = path.join(dir, 'style.png');
  await writeFile(sheet, PNG); await writeFile(styleImage, PNG);
  const refs = [{ character: '민지', kind: 'character-sheet', path: sheet }, { character: '민지', path: sheet }, { purpose: 'style', style: '수채화', path: styleImage }];
  await generateWithOpenAI({ prompt: 'scene', refs, apiKey: 'sk-test', baseUrl: 'http://x/v1', fetchImpl });
  assert.equal(calls[1].url, 'http://x/v1/images/edits');
  const form = calls[1].init.body;
  assert.equal(form.getAll('image[]').length, 2);
  assert.match(form.get('prompt'), /Image 1: character "민지" \(character-sheet[^\n]*\nImage 2: style reference "수채화"[\s\S]*scene$/);
  assert.equal(form.get('size'), '2048x1152');
  assert.equal(referenceLegend([]).legend, '');
});

test('generateWithOpenAI marks auth and policy failures permanent but keeps rate limits retryable', async () => {
  const failing = status => async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status });
  await assert.rejects(generateWithOpenAI({ prompt: 'x', apiKey: 'k', fetchImpl: failing(401) }), e => e.permanent === true && /401/.test(e.message));
  await assert.rejects(generateWithOpenAI({ prompt: 'x', apiKey: 'k', fetchImpl: failing(429) }), e => !e.permanent);
  await assert.rejects(generateWithOpenAI({ prompt: 'x', apiKey: '' }), e => e.permanent === true);
});

async function unusedPort() {
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); await new Promise(r => probe.close(r)); return port;
}
async function api(base, route, method = 'GET', body) {
  const r = await fetch(`${base}/api/${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const waitFor = async (check, ms = 5000) => { for (let i = 0; i < ms / 50; i++) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } throw Error('timed out'); };

test('Claude analysis and OpenAI API image generation run end to end without leaking the API key', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scene-providers-'));
  const fakeClaude = path.join(dir, 'claude');
  await writeFile(fakeClaude, `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
if(process.env.ANTHROPIC_API_KEY)throw Error('API key leaked into Claude CLI');
let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
  const {script}=JSON.parse(input.slice(input.indexOf('{')));
  require('fs').writeFileSync(process.cwd()+'/args.json',JSON.stringify(args));
  require('fs').writeFileSync(process.cwd()+'/prompt.txt',input);
  console.log(JSON.stringify({type:'result',is_error:false,structured_output:{scenes:[{title:'장면',sourceText:script,continuation:false,camera:'와이드샷',reason:'장소 소개',prompt:'quiet street',characterIds:[]},{title:'단서',sourceText:script,continuation:true,camera:'사물 인서트',reason:'같은 문장에서 단서 강조',prompt:'close up of a door handle',characterIds:[]}]}}));
});
`);
  await chmod(fakeClaude, 0o755);

  const requests = [];
  const openai = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; }).on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    });
  });
  openai.listen(0, '127.0.0.1'); await once(openai, 'listening'); t.after(() => openai.close());

  const port = await unusedPort(), data = path.join(dir, 'data');
  const env = { ...process.env, PORT: String(port), SCENE_DATA_DIR: data, SCENE_REFERENCE_DIR: path.join(dir, 'refs'), CLAUDE_BIN: fakeClaude, ANTHROPIC_API_KEY: 'must-not-pass', OPENAI_BASE_URL: `http://127.0.0.1:${openai.address().port}/v1` };
  delete env.OPENAI_API_KEY;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  await waitFor(() => output.includes('Scene Studio:'));
  const base = `http://127.0.0.1:${port}`;

  const missingKey = await api(base, 'settings', 'PUT', { imageProvider: 'openai' });
  assert.equal(missingKey.status, 400);
  assert.equal((await api(base, 'settings', 'PUT', { imageModel: 'dall-e-2' })).status, 400);
  const key = 'sk-test-0123456789abcdefWXYZ';
  const saved = await api(base, 'settings', 'PUT', { textProvider: 'claude', claudeModel: 'haiku', imageProvider: 'openai', imageModel: 'gpt-image-2.5-sunburst', imageQuality: 'medium', openaiApiKey: key });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.openai, { configured: true, source: 'saved', last4: 'WXYZ' });
  const status = await api(base, 'status');
  assert.equal(status.body.ready, true);
  assert.equal(status.body.text.message, 'Claude 로그인됨 (claude.ai)');

  const project = (await api(base, 'projects', 'POST', { name: 'providers' })).body;
  await api(base, `projects/${project.id}`, 'PUT', { script: '골목은 조용했다.', aspectRatio: '1:1' });
  await api(base,`projects/${project.id}/analysis-prompt`,'PUT',{instructions:'단서 인서트를 늘려주세요.',density:'dense'});
  const expectedPrompt=(await api(base,`projects/${project.id}/analysis-prompt`)).body.prompt;
  assert.equal((await api(base, `projects/${project.id}/analyze`, 'POST', {})).status, 202);
  const analyzed = await waitFor(async () => (await api(base, 'state')).body.projects.find(p => p.id === project.id && !p.analyzing && p.scenes.length));
  assert.equal(analyzed.scenes[0].prompt, 'quiet street');
  assert.equal(analyzed.scenes.length,2);assert.equal(analyzed.scenes[1].continuation,true);assert.equal(analyzed.scenes[1].camera,'사물 인서트');assert.equal(analyzed.analysisRun.prompt,expectedPrompt);
  const {readdir}=await import('node:fs/promises');const jobs=await readdir(path.join(data,'jobs'));
  assert.equal(await readFile(path.join(data,'jobs',jobs[0],'prompt.txt'),'utf8'),expectedPrompt);

  assert.equal((await api(base, `projects/${project.id}/generate`, 'POST', {})).status, 202);
  const done = await waitFor(async () => (await api(base, 'state')).body.projects.find(p => p.id === project.id && p.scenes[0].status === 'done'));
  assert.equal(done.scenes[0].images[0].engine, 'gpt-image-2.5-sunburst');
  assert.equal(requests[0].url, '/v1/images/generations');
  assert.equal(requests[0].auth, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(requests[0].body), { model: 'gpt-image-2.5-sunburst', prompt: JSON.parse(requests[0].body).prompt, size: '1024x1024', quality: 'medium', n: 1 });

  const state = await readFile(path.join(data, 'state.json'), 'utf8');
  assert.ok(!state.includes(key));
  assert.ok(!JSON.stringify((await api(base, 'state')).body).includes(key));
  assert.ok(!JSON.stringify((await api(base, 'settings')).body).includes(key));
  assert.equal(JSON.parse(await readFile(path.join(data, 'secrets.json'), 'utf8')).openaiApiKey, key);

  const cleared = await api(base, 'settings', 'PUT', { imageProvider: 'codex', clearOpenaiKey: true });
  assert.equal(cleared.body.openai.configured, false);
});

test('loginProcess captures the OAuth URL, forwards a pasted code, and reports completion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'login-'));
  const cli = path.join(dir, 'cli');
  await writeFile(cli, `#!${process.execPath}
console.log("If the browser didn't open, visit: https://claude.com/oauth/authorize?code=true");
process.stdin.once('data', d => process.exit(String(d).trim() === 'good-code' ? 0 : 2));
`);
  await chmod(cli, 0o755);
  const { loginProcess } = await import('../lib/codex.mjs');
  const login = loginProcess(cli, [], { label: 'Test' });
  assert.throws(() => login.submitCode('x'), /진행 중인 로그인이 없습니다/);
  assert.equal(login.start().running, true);
  assert.equal(login.start().running, true);
  await waitFor(() => login.state().url);
  assert.equal(login.state().url, 'https://claude.com/oauth/authorize?code=true');
  login.submitCode('  good-code ');
  await waitFor(() => !login.state().running);
  assert.equal(login.state().error, '');

  login.start(); await waitFor(() => login.state().url);
  login.submitCode('bad');
  await waitFor(() => !login.state().running);
  assert.match(login.state().error, /Test 로그인이 완료되지 않았습니다 \(2\)/);
});
