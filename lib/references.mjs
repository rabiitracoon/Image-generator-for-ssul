import { constants } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const REFERENCE_FOLDER = '참고이미지';

export function referenceName(reference) {
  const value = reference.url?.startsWith('/media/references/') ? reference.url : reference.path;
  const name = path.basename(String(value || ''));
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(name)) {
    throw Error('참고 이미지 파일 이름이 올바르지 않습니다. 이미지를 다시 등록해 주세요.');
  }
  return name;
}

export function portableReferencePath(name) {
  return `${REFERENCE_FOLDER}/${referenceName({ path: name })}`;
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function migrateReferences(db, { dataDir, referenceDir }) {
  await mkdir(referenceDir, { recursive: true });
  let changed = false;
  const missing = [];
  const groups = [...db.projects.flatMap(project=>[...project.characters,...(project.locations||[])].map(entity=>entity.references||[])),
    ...(db.presets||[]).map(preset=>preset.references||[])];
  for (const references of groups) {
      for (const reference of references) {
        const name = referenceName(reference);
        const destination = path.join(referenceDir, name);
        if (!await isFile(destination)) {
          // A copied project's local data takes priority over the previous Mac's absolute path.
          const candidates = [path.join(dataDir, 'references', name)];
          if (path.isAbsolute(reference.path || '')) candidates.push(reference.path);
          for (const source of candidates) {
            if (await isFile(source)) {
              await copyFile(source, destination, constants.COPYFILE_EXCL);
              break;
            }
          }
        }
        if (!await isFile(destination)) missing.push(reference.name || name);
        const portable = portableReferencePath(name);
        const url = `/media/references/${name}`;
        if (reference.path !== portable || reference.url !== url) changed = true;
        reference.path = portable;
        reference.url = url;
      }
  }
  return { changed, missing };
}

export async function resolveProjectReferences(project, referenceDir) {
  const resolved = structuredClone(project);
  for (const character of [...resolved.characters,...(resolved.locations||[])]) {
    for (const reference of character.references||[]) {
      const file = path.join(referenceDir, referenceName(reference));
      if (!await isFile(file)) {
        throw Error(`${character.name}의 참고 이미지 “${reference.name || referenceName(reference)}”를 찾을 수 없습니다. 참고이미지 폴더를 함께 옮기거나 이미지를 다시 등록해 주세요.`);
      }
      reference.path = file;
    }
  }
  return resolved;
}

export async function resolveStyleReferences(style, referenceDir) {
  if (!style) return style;
  const resolved = structuredClone(style);
  for (const reference of resolved.references || []) {
    const file = path.join(referenceDir, referenceName(reference));
    if (!await isFile(file)) throw Error(`스타일 “${style.name}”의 참고 이미지 “${reference.name}”를 찾을 수 없습니다. 참고이미지 폴더를 함께 옮기거나 이미지를 다시 등록해 주세요.`);
    reference.path = file;
  }
  return resolved;
}
