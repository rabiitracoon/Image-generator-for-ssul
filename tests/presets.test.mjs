import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePresets, parseRepo, resolvePreviewURL, syncSource } from '../lib/presets.mjs';

test('parseRepo accepts canonical GitHub URLs and strips a .git suffix', () => {
  assert.deepEqual(parseRepo(' https://github.com/acme/styles.git/ '), { owner: 'acme', repo: 'styles' });
  assert.throws(() => parseRepo('http://github.com/acme/styles'), /https:\/\/github\.com/);
  assert.throws(() => parseRepo('https://github.com/acme/styles/tree/main'), /브랜치는 별도 입력/);
});

test('parsePresets extracts JSON aliases and Markdown prompt sections', () => {
  const json = parsePresets(JSON.stringify({ styles: [
    { id: 'oil', name: 'Oil paint', style_prompt: 'visible brushwork' },
    { title: 'Ink', content: 'black lines' },
    { name: 'Ignored', prompt: '   ' },
  ] }), 'presets.json');
  assert.deepEqual(json, [
    { key: 'oil', name: 'Oil paint', prompt: 'visible brushwork' },
    { key: 'Ink', name: 'Ink', prompt: 'black lines' },
  ]);

  const markdown = parsePresets(`# Watercolor\n\n\`\`\`text\nsoft paper\n\`\`\`\n\n# Ink\n**Prompt**: bold black lines\n![sample](image.png)`, 'styles.md');
  assert.equal(markdown.length, 2);
  assert.deepEqual(markdown[0], { key: 'Watercolor', name: 'Watercolor', prompt: 'soft paper' });
  assert.equal(markdown[1].prompt, 'bold black lines');
});

test('parsePresets collects JSON preview fields while excluding referenced images', () => {
  const direct = 'https://cdn.example.test/direct.webp';
  const remote = 'https://cdn.example.test/remote.webp';
  const referenced = 'https://cdn.example.test/reference.webp';
  const [preset] = parsePresets(JSON.stringify({ styles: [{
    id: 'preview-fields',
    name: 'Preview fields',
    prompt: 'a prompt',
    image_url: direct,
    remote_images: [remote, referenced],
    reference_images: [referenced],
  }] }), 'presets.json');

  assert.deepEqual(preset.previewCandidates, [direct, remote]);
});

test('syncSource resolves Markdown relative and GitHub blob preview URLs', async () => {
  const source = { id: 'source-markdown-previews', url: 'https://github.com/acme/styles', ref: 'main' };
  const responses = new Map([
    ['https://api.github.com/repos/acme/styles/commits/main', { sha: 'markdown-sha' }],
    ['https://api.github.com/repos/acme/styles/git/trees/markdown-sha?recursive=1', {
      tree: [{ type: 'blob', path: 'docs/styles.md' }],
    }],
    ['https://raw.githubusercontent.com/acme/styles/markdown-sha/docs/styles.md', [
      '# Hero',
      '',
      '**Prompt**: a hero prompt',
      '',
      '![relative](../assets/relative.webp)',
      '![root](/assets/root.webp)',
      '![blob](https://github.com/acme/styles/blob/main/assets/blob.webp)',
    ].join('\n')],
  ]);
  const fetcher = async url => {
    if (!responses.has(url)) throw Error(`unexpected URL: ${url}`);
    const value = responses.get(url);
    return typeof value === 'string' ? value : structuredClone(value);
  };

  const result = await syncSource(source, [], fetcher);
  assert.deepEqual(result.presets[0].previewUrls, [
    'https://raw.githubusercontent.com/acme/styles/markdown-sha/assets/relative.webp',
    'https://raw.githubusercontent.com/acme/styles/markdown-sha/assets/root.webp',
    'https://raw.githubusercontent.com/acme/styles/main/assets/blob.webp',
  ]);
});

test('resolvePreviewURL rejects unsafe schemes and local network targets', () => {
  const context = { owner: 'acme', repo: 'styles', sha: 'sha', file: 'styles.md' };
  for (const value of [
    'data:image/png;base64,abc',
    'javascript:alert(1)',
    'file:///tmp/image.png',
    'blob:https://example.test/id',
    'http://example.test/image.png',
    'https://localhost/image.png',
    'https://127.0.0.1/image.png',
  ]) {
    assert.equal(resolvePreviewURL(value, context), null, value);
  }
  assert.equal(resolvePreviewURL('https://cdn.example.test/image.png', context), 'https://cdn.example.test/image.png');
});

test('parsePresets uses the non-README filename fallback only for style-like files', () => {
  assert.deepEqual(parsePresets('A long style prompt with no heading.', 'style-guide.md'), [{
    key: 'style-guide.md', name: 'style-guide', prompt: 'A long style prompt with no heading.',
  }]);
  assert.deepEqual(parsePresets('A long style prompt with no heading.', 'README.md'), []);
  assert.deepEqual(parsePresets('A long style prompt with no heading.', 'notes.md'), []);
});

test('syncSource keeps malformed files as stale previous presets while applying valid updates and moved files', async () => {
  const source = { id: 'source-1', url: 'https://github.com/acme/styles', ref: 'main' };
  const previous = [
    { id: 'old-bad', sourceId: source.id, file: 'bad.json', name: 'Old bad', prompt: 'old prompt', sha: 'old' },
    { id: 'old-moved', sourceId: source.id, file: 'old/location.md', name: 'Moved old', prompt: 'old location', sha: 'old' },
    { id: 'old-updated', sourceId: source.id, file: 'updated.md', name: 'Updated old', prompt: 'old prompt', sha: 'old' },
  ];
  const responses = new Map([
    ['https://api.github.com/repos/acme/styles/commits/main', { sha: 'new-sha' }],
    ['https://api.github.com/repos/acme/styles/git/trees/new-sha?recursive=1', {
      tree: [
        { type: 'blob', path: 'bad.json' },
        { type: 'blob', path: 'new/location.md' },
        { type: 'blob', path: 'updated.md' },
      ],
    }],
    ['https://raw.githubusercontent.com/acme/styles/new-sha/bad.json', '{ malformed json'],
    ['https://raw.githubusercontent.com/acme/styles/new-sha/new/location.md', '# New location\n\n```\nnew prompt\n```'],
    ['https://raw.githubusercontent.com/acme/styles/new-sha/updated.md', '# Updated\n\n```\nupdated prompt\n```'],
  ]);
  const fetcher = async (url) => {
    if (!responses.has(url)) throw Error(`unexpected URL: ${url}`);
    const value = responses.get(url);
    return typeof value === 'string' ? value : structuredClone(value);
  };

  const result = await syncSource(source, previous, fetcher);
  assert.equal(result.sha, 'new-sha');
  assert.equal(result.presets.length, 3);
  assert.match(result.warnings.join('\n'), /bad\.json/);

  const stale = result.presets.find(p => p.file === 'bad.json');
  assert.equal(stale.id, 'old-bad');
  assert.equal(stale.stale, true);
  assert.equal(stale.sha, 'old');

  const moved = result.presets.find(p => p.file === 'new/location.md');
  assert.equal(moved.prompt, 'new prompt');
  assert.equal(moved.stale, undefined);
  assert.equal(result.presets.some(p => p.file === 'old/location.md'), false);

  const updated = result.presets.find(p => p.file === 'updated.md');
  assert.equal(updated.prompt, 'updated prompt');
  assert.equal(updated.sha, 'new-sha');
  assert.equal(updated.stale, undefined);
});

test('syncSource rejects truncated trees without discarding the caller\'s existing presets', async () => {
  const source = { id: 'source-2', url: 'https://github.com/acme/huge', ref: 'main' };
  const fetcher = async url => {
    if (url.endsWith('/commits/main')) return { sha: 'sha' };
    return { truncated: true, tree: [] };
  };
  await assert.rejects(() => syncSource(source, [{ file: 'old.md' }], fetcher), /기존 프리셋을 유지합니다/);
});

test('syncSource keeps one canonical representative for JSON and translated Markdown copies', async () => {
  const source = { id: 'source-dedup', url: 'https://github.com/acme/prompts', ref: 'main' };
  const shared = 'a shared prompt body';
  const responses = new Map([
    ['https://api.github.com/repos/acme/prompts/commits/main', { sha: 'dedup-sha' }],
    ['https://api.github.com/repos/acme/prompts/git/trees/dedup-sha?recursive=1', {
      tree: [
        { type: 'blob', path: 'README.md' },
        { type: 'blob', path: 'data/prompts.json' },
        { type: 'blob', path: 'data/prompts_by_locale/ko.json' },
        { type: 'blob', path: 'i18n/README_ko.md' },
        { type: 'blob', path: 'docs/prompting-guide.md' },
      ],
    }],
    ['https://raw.githubusercontent.com/acme/prompts/dedup-sha/README.md', `# Shared\n\n\`\`\`text\n${shared}\n\`\`\``],
    ['https://raw.githubusercontent.com/acme/prompts/dedup-sha/data/prompts.json', JSON.stringify([
      { id: 'shared-001', name: 'Canonical shared prompt', prompt: shared },
    ])],
    ['https://raw.githubusercontent.com/acme/prompts/dedup-sha/data/prompts_by_locale/ko.json', JSON.stringify([
      { id: 'shared-001', name: '공유 프롬프트', prompt: shared },
    ])],
    ['https://raw.githubusercontent.com/acme/prompts/dedup-sha/i18n/README_ko.md', `# Shared\n\n\`\`\`text\n${shared}\n\`\`\``],
    ['https://raw.githubusercontent.com/acme/prompts/dedup-sha/docs/prompting-guide.md', '# Guide\n\n**Prompt**: an editorial-only prompt'],
  ]);
  const fetcher = async (url) => {
    if (!responses.has(url)) throw Error(`unexpected URL: ${url}`);
    const value = responses.get(url);
    return typeof value === 'string' ? value : structuredClone(value);
  };

  const result = await syncSource(source, [], fetcher);
  assert.equal(result.presets.length, 2);
  assert.deepEqual(result.presets.map(p => p.file).sort(), [
    'data/prompts.json',
    'docs/prompting-guide.md',
  ]);
  const canonical = result.presets.find(p => p.prompt === shared);
  assert.equal(canonical.file, 'data/prompts.json');
  assert.equal(canonical.key, 'shared-001');
});

test('syncSource merges duplicate preview metadata into the representative preset', async () => {
  const source = { id: 'source-preview-dedup', url: 'https://github.com/acme/previews', ref: 'main' };
  const shared = 'the same prompt';
  const responses = new Map([
    ['https://api.github.com/repos/acme/previews/commits/main', { sha: 'preview-dedup-sha' }],
    ['https://api.github.com/repos/acme/previews/git/trees/preview-dedup-sha?recursive=1', {
      tree: [
        { type: 'blob', path: 'canonical.json' },
        { type: 'blob', path: 'docs/translated.md' },
        { type: 'blob', path: 'other.json' },
      ],
    }],
    ['https://raw.githubusercontent.com/acme/previews/preview-dedup-sha/canonical.json', JSON.stringify([
      { id: 'canonical', name: 'Canonical', prompt: shared, image_url: 'https://cdn.example.test/canonical.webp' },
    ])],
    ['https://raw.githubusercontent.com/acme/previews/preview-dedup-sha/docs/translated.md', [
      '# Translation', '', '**Prompt**: the same prompt', '', '![translated](translated.webp)',
    ].join('\n')],
    ['https://raw.githubusercontent.com/acme/previews/preview-dedup-sha/other.json', JSON.stringify([
      { id: 'other', name: 'Other', prompt: shared, remote_images: ['other.webp'] },
    ])],
  ]);
  const fetcher = async url => {
    if (!responses.has(url)) throw Error(`unexpected URL: ${url}`);
    const value = responses.get(url);
    return typeof value === 'string' ? value : structuredClone(value);
  };

  const result = await syncSource(source, [], fetcher);
  assert.equal(result.presets.length, 1);
  assert.equal(result.presets[0].key, 'canonical');
  assert.deepEqual(new Set(result.presets[0].previewUrls), new Set([
    'https://cdn.example.test/canonical.webp',
    'https://raw.githubusercontent.com/acme/previews/preview-dedup-sha/docs/translated.webp',
    'https://raw.githubusercontent.com/acme/previews/preview-dedup-sha/other.webp',
  ]));
});
