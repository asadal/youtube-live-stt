#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "이 스크립트는 Apple Silicon macOS용입니다." >&2
  exit 1
fi

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_directory="$project_directory/vendor/pyannote-venv"
python_command="${PYANNOTE_BOOTSTRAP_PYTHON:-python3}"

if ! command -v "$python_command" >/dev/null 2>&1; then
  echo "Python 3.10 이상이 필요합니다." >&2
  exit 1
fi

if ! "$python_command" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "pyannote.audio 설치에는 Python 3.10 이상이 필요합니다." >&2
  exit 1
fi

"$python_command" -m venv "$environment_directory"
"$environment_directory/bin/python" -m pip install --upgrade pip wheel
"$environment_directory/bin/python" -m pip install "pyannote.audio>=4,<5"

echo "pyannote.audio 설치가 끝났습니다."
echo "Hugging Face에서 community-1 이용 조건에 동의한 뒤 .env에 HUGGINGFACE_TOKEN을 설정하세요."
echo "PYANNOTE_PYTHON=$environment_directory/bin/python"
