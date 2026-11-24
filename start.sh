#!/usr/bin/env bash
# RecordingNote をセットアップして起動する（macOS / Linux 用）
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "エラー: python3 が見つかりません。Python 3.10 以上をインストールしてから再実行してください。" >&2
  exit 1
fi

if ! python3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"; then
  echo "エラー: Python 3.10 以上が必要です（現在: $(python3 --version 2>&1)）。" >&2
  exit 1
fi

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [ ! -f .venv/.rn-installed ] || [ requirements.txt -nt .venv/.rn-installed ]; then
  python -m pip install -r requirements.txt
  touch .venv/.rn-installed
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env を作成しました。Gemini でノートを作る場合は後から GEMINI_API_KEY を設定できます。"
fi

device_pref="${HAAS_DEVICE:-}"
if [ -z "$device_pref" ] && [ -f .env ]; then
  device_pref="$(python -c '
from dotenv import dotenv_values
print((dotenv_values(".env").get("HAAS_DEVICE") or "auto").strip().lower())
' 2>/dev/null || echo "auto")"
fi
device_pref="$(printf '%s' "${device_pref:-auto}" | tr '[:upper:]' '[:lower:]')"

if [ "$(uname -s)" = "Linux" ] && [ "$device_pref" != "cpu" ] && command -v nvidia-smi >/dev/null 2>&1; then
  if python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"; then
    cap_major="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader --id=0 2>/dev/null | head -n1 | cut -d. -f1 | tr -dc '0-9')"
    if [ -n "$cap_major" ] && [ "$cap_major" -ge 8 ]; then
      if [ ! -f .venv/.rn-gpu-installed ] || [ requirements-gpu.txt -nt .venv/.rn-gpu-installed ]; then
        echo "NVIDIA GPU（Ampere 以降）を検出しました。公式 Haas-ja GPU 依存を導入します…"
        if python -m pip install -r requirements-gpu.txt; then
          touch .venv/.rn-gpu-installed
        else
          echo "警告: GPU 依存の導入に失敗したため、CPU（ONNX）モードで起動します。" >&2
        fi
      fi
    fi
  fi
fi

exec python server.py --open
