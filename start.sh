#!/usr/bin/env bash
# RecordingNote をセットアップして起動する（Linux + NVIDIA GPU 用）
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [ ! -f .venv/.rn-installed ] || [ requirements.txt -nt .venv/.rn-installed ]; then
  pip install -r requirements.txt
  touch .venv/.rn-installed
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env を作成しました。Gemini を使う場合は GEMINI_API_KEY を設定してください。"
fi

exec python server.py
