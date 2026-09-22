#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "이 스크립트는 Apple Silicon macOS용입니다." >&2
  exit 1
fi

for command_name in git cmake; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name 명령이 필요합니다. brew install cmake git 을 실행해 주세요." >&2
    exit 1
  fi
done

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
whisper_directory="$project_directory/vendor/whisper.cpp"
model_name="${WHISPER_MODEL:-large-v3-turbo}"

mkdir -p "$project_directory/vendor"
if [[ ! -d "$whisper_directory/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$whisper_directory"
else
  git -C "$whisper_directory" pull --ff-only
fi

cmake -S "$whisper_directory" -B "$whisper_directory/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$whisper_directory/build" --config Release -j "$(sysctl -n hw.logicalcpu)"
bash "$whisper_directory/models/download-ggml-model.sh" "$model_name"

echo "설치가 끝났습니다. 다음 명령으로 로컬 서버를 실행하세요."
echo "WHISPER_MODEL=$model_name npm run whisper:mac"
