#!/bin/zsh
cd -- "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
scene_node=''
for scene_candidate in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$scene_candidate" ]] && "$scene_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
    scene_node="$scene_candidate"
    break
  fi
done
if [[ -z "$scene_node" ]]; then
  echo '이 Mac에 Node.js 22 이상을 설치해 주세요: https://nodejs.org'
  read '?Enter를 누르면 종료합니다.'
  exit 1
fi
exec "$scene_node" lib/launcher.mjs
