@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PY_CMD="
py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
if not errorlevel 1 set "PY_CMD=py -3"

if not defined PY_CMD (
  python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
  if not errorlevel 1 set "PY_CMD=python"
)

if not defined PY_CMD (
  echo エラー: Python 3.10 以上が見つかりません。
  echo https://www.python.org/downloads/ から Python をインストールし、
  echo インストール時に "Add python.exe to PATH" にチェックを入れてください。
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo 初回セットアップ: 仮想環境を作成しています...
  %PY_CMD% -m venv .venv
  if errorlevel 1 (
    echo エラー: 仮想環境の作成に失敗しました。
    pause
    exit /b 1
  )
)

".venv\Scripts\python.exe" -c "from pathlib import Path; s = Path('.venv/.rn-installed'); r = Path('requirements.txt'); raise SystemExit(0 if s.exists() and s.stat().st_mtime >= r.stat().st_mtime else 1)" >nul 2>&1
if errorlevel 1 (
  echo 初回セットアップ: 必要なパッケージを導入しています（数分かかる場合があります）...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo エラー: パッケージの導入に失敗しました。インターネット接続を確認してください。
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -c "from pathlib import Path; Path('.venv/.rn-installed').touch()"
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo .env を作成しました。Gemini でノートを作る場合は後から GEMINI_API_KEY を設定できます。
)

".venv\Scripts\python.exe" server.py --open
if errorlevel 1 pause
