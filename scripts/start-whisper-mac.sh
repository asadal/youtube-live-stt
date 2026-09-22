#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
whisper_directory="$project_directory/vendor/whisper.cpp"
model_name="${WHISPER_MODEL:-large-v3-turbo}"
server_binary="$whisper_directory/build/bin/whisper-server"
model_path="$whisper_directory/models/ggml-$model_name.bin"
server_port="${WHISPER_CPP_PORT:-8080}"

if [[ ! -x "$server_binary" || ! -f "$model_path" ]]; then
  echo "whisper.cpp 또는 모델을 찾을 수 없습니다. npm run whisper:setup:mac 을 먼저 실행해 주세요." >&2
  exit 1
fi

exec "$server_binary" \
  --host 127.0.0.1 \
  --port "$server_port" \
  --model "$model_path" \
  --language ko \
  --flash-attn \
  --suppress-nst
