import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sameRoot = (a, b) => typeof b === 'string' && path.resolve(a).normalize('NFC') === path.resolve(b).normalize('NFC');

async function portAvailable(port) {
  const probe = net.createServer();
  try {
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise(resolve => probe.close(resolve));
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE') return false;
    throw error;
  }
}

async function health(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(700) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

function openPage(url) {
  const browser = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
  browser.on('error', () => console.log(`브라우저에서 ${url} 주소를 열어 주세요.`));
}

export async function startStudio({ root = ROOT, preferredPort = Number(process.env.PORT || 4317), openBrowser = true, env = process.env } = {}) {
  root = await realpath(root);
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    throw Error('PORT는 1024~65535 사이의 숫자여야 합니다.');
  }
  for (let port = preferredPort; port <= Math.min(preferredPort + 20, 65535); port++) {
    const url = `http://127.0.0.1:${port}`;
    if (!await portAvailable(port)) {
      const existing = await health(url);
      if (existing?.application === 'scene-studio' && sameRoot(root, existing.root)) {
        if (openBrowser) openPage(url);
        return { reused: true, url, child: null };
      }
      continue;
    }
    const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
      cwd: root, env: { ...env, PORT: String(port) }, stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '', spawnError;
    child.stdout.on('data', data => { output = (output + data).slice(-12000); process.stdout.write(data); });
    child.stderr.on('data', data => { output = (output + data).slice(-12000); process.stderr.write(data); });
    child.on('error', error => { spawnError = error; });
    let interrupted = false;
    const stop = () => { interrupted = true; child.kill('SIGTERM'); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        if (interrupted) return { reused: false, url, child };
        throw Error(`실행하지 못했습니다.\n${spawnError?.message || output}`);
      }
      if (output.includes('Scene Studio:')) {
        const status = await health(url);
        if (status?.application === 'scene-studio' && sameRoot(root, status.root)) {
          if (openBrowser) openPage(url);
          if (port !== preferredPort) console.log(`기존 포트가 사용 중이어서 ${port}번으로 실행했습니다.`);
          return { reused: false, url, child };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.kill('SIGTERM');
    throw Error('시작 시간이 초과되었습니다. 터미널의 오류 내용을 확인해 주세요.');
  }
  throw Error('사용 가능한 실행 포트가 없습니다. 다른 앱을 종료하거나 PORT를 변경해 주세요.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { child } = await startStudio();
    if (child && child.exitCode === null && child.signalCode === null) {
      const [code] = await once(child, 'close');
      process.exitCode = code || 0;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    if (process.stdin.isTTY) {
      process.stdout.write('Enter를 누르면 종료합니다.');
      process.stdin.resume();
      await once(process.stdin, 'data');
      process.stdin.pause();
    }
  }
}
