# RecordingNote — ローカル文字起こし版

講義の音声を**自分の PC 上の Haas-ja-v1.0** で文字起こしし、**Gemini API**（サーバー経由）で学習ノートにまとめる日本語ツールです。クラウドトンネルやブラウザへのAPIキー入力は不要で、録音からノート出力までを1つのローカル画面で行えます。

## 特長

- **どの PC でも動く Haas-ja-v1.0**：
  - **macOS / Windows / Linux（CPU）**：コミュニティ製の量子化 ONNX 版（[`oboroge0/Haas-ja-v1.0-onnx-quantized`](https://huggingface.co/oboroge0/Haas-ja-v1.0-onnx-quantized) + `sherpa-onnx`）を自動で使い、GPU なしでも約 1 GB のメモリで高速に動作します。
  - **Linux + NVIDIA GPU（Ampere 以降）**：公式の [`third-intelligence/Haas-ja-v1.0`](https://huggingface.co/third-intelligence/Haas-ja-v1.0)（`haas-asr`, bf16）を自動選択します。
- **かんたん起動**：macOS / Linux は `./start.sh`、Windows は `start.bat` を実行するだけで仮想環境の作成からサーバー起動、ブラウザの自動表示まで完了します。
- **Gemini ノート生成は後から有効化可能**：文字起こしだけなら API キー不要です。後から `.env` の `GEMINI_API_KEY` を埋めて保存すれば、サーバー再起動なしですぐに「AIノートを生成」が使えるようになります。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `start.sh` | macOS / Linux 用ワンステップ起動スクリプト（初回セットアップ＋自動ブラウザ表示） |
| `start.bat` | Windows 用ワンクリック起動スクリプト（初回セットアップ＋自動ブラウザ表示） |
| `server.py` | ページ配信、文字起こしジョブ API、Gemini ノート生成 API |
| `asr_backend.py` | Haas-ja-v1.0 の自動判定・読み込み（GPU / CPU ONNX）、ffmpeg 変換、長尺分割 |
| `notes.py` | ノート生成プロンプトと Gemini API プロバイダ（`.env` を都度参照） |
| `index.html` | 録音・音声選択・文字起こし・ノート表示・履歴・ガイドの画面 |
| `app.js` | 録音、API 通信、進捗表示、Markdown 描画、ブラウザ内履歴管理 |
| `styles.css` | 白と青を基調にしたレスポンシブ表示 |
| `requirements.txt` | 基本の Python 依存関係（macOS / Windows / Linux 共通） |
| `requirements-gpu.txt` | Linux + NVIDIA Ampere 以降の GPU 向け追加依存関係 |
| `.env.example` | 設定のひな形（初回起動時に `.env` へ自動コピー） |
| `README.md` | この説明書 |

## 必要なもの

- **Python 3.10 以上**（Windows はインストール時に「Add python.exe to PATH」を有効にしてください）
- インターネット接続（初回のみパッケージとモデルを取得します）
- **Linux + NVIDIA GPU（Ampere 以降）で公式 GPU 版を使う場合**：Python 3.11 以上、CUDA 対応の PyTorch

## クイックスタート

### macOS / Linux

```sh
git clone https://github.com/nine9-japan/recordingnote.git
cd recordingnote
./start.sh
```

初回のみ仮想環境（`.venv`）と必要なパッケージ、`.env` を自動で作成し、`http://127.0.0.1:8000` をブラウザで開きます。

### Windows

1. リポジトリを取得します（Zip ダウンロードして展開、または `git clone`）。
2. フォルダ内の **`start.bat`** をダブルクリックします。
3. 初回セットアップ後、自動でブラウザに画面が開きます。

### 手動で起動する場合

```sh
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python server.py --open
```

- 初回起動時、Haas-ja モデルをバックグラウンドで取得します（CPU / ONNX 版は約 460 MB、GPU 版は約 1.2 GB）。画面は先に開き、準備が完了すると右上の状態表示が自動で「接続済み」に切り替わります。
- 2回目以降はローカルのキャッシュから読み込みます。

## 使い方

1. **音声を用意**：ブラウザで「録音開始」→「停止」で録音するか、手元の音声ファイル（M4A / MP3 / WAV / WebM など）を選びます。
2. **文字起こし**：「文字起こし開始」を押すと、この PC 上の Haas-ja-v1.0 が文字起こしを行います（音声は外部へ送信しません）。
3. **確認・編集**：完了した本文はそのまま編集でき、約 0.4 秒後にブラウザ内の履歴へ自動保存されます。
4. **AIノート生成（任意）**：「AIノートを生成」を押すと、Gemini API を使って見出し・重要語句・復習ポイント付きの Markdown ノートを作成します。「Markdownをコピー」または「.mdでダウンロード」で取り出せます。

文字起こし欄にテキストを直接貼り付けてノートだけを生成することもできます。

## Haas-ja-v1.0 の動作方式

サーバーは `HAAS_DEVICE`（既定 `auto`）に従ってローカルで文字起こしを行います。

- **CPU / ONNX モード（macOS / Windows / GPU 非搭載 Linux）**：
  - `ffmpeg`（システムにない場合は `imageio-ffmpeg` 同梱バイナリ）で 16 kHz モノラル WAV に変換し、20〜25 秒単位の低音量区間で分割しながら `sherpa-onnx` で順番に推論します。
  - 使用モデル：`oboroge0/Haas-ja-v1.0-onnx-quantized`（Apache 2.0）
- **NVIDIA GPU モード（Linux + NVIDIA Ampere 以降 + CUDA）**：
  - `start.sh` が NVIDIA Ampere 以降（Compute Capability 8.0 以上）を検出すると `requirements-gpu.txt` を導入し、公式の `third-intelligence/Haas-ja-v1.0`（bf16、`haas_asr.transcribe_longform`）で文字起こしします。
  - `.env` の `HAAS_BATCH_SIZE`（既定 `8`）や `HAAS_VOCABULARY_JSON`（固有名詞の読み登録）が利用できます。

どちらのモードでも、音声ファイルは推論後すぐに削除され、PC の外へ送信されません。

## ノート生成（Gemini API・後から設定）

文字起こし機能だけを使う場合、API キーは不要です。AIノート生成を有効にするには、フォルダ内の `.env` を開いて `GEMINI_API_KEY` を入力して保存してください。

```sh
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash
```

- サーバーが `/health` や `/notes` の処理時に `.env` を参照するため、キーを書き込んだあと**サーバーを再起動しなくても**そのまま「AIノートを生成」を押せます。
- キーはサーバー側だけで扱い、ブラウザの `localStorage` や画面へは返しません。
- ノート生成を実行したときだけ、文字起こしテキストを `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` へ送信します（タイムアウト 180 秒）。
- 将来ほかの LLM プロバイダ（例：ローカル LLM）へ切り替える場合は、`notes.py` の `NoteProvider` プロトコル（`generate(transcript, title="")`）を満たすクラスを追加して `load_provider()` で返すだけで対応できます。

## API

サーバーは原則 `127.0.0.1` でのみ待ち受けます（認証なし）。外部へ公開しないでください。

| メソッド | パス | 内容 |
| --- | --- | --- |
| `GET` | `/health` | モデルの読み込み状態（GPU / CPU）とノート生成の設定状態 |
| `POST` | `/jobs` | `multipart/form-data` の `file` に音声を入れて文字起こし開始 |
| `GET` | `/jobs/{job_id}` | `queued` / `running`（`phase`, `progress` 付き） / `done` / `error` と本文 |
| `POST` | `/notes` | `{"transcript": "...", "title": "..."}` → `{"note": "Markdown"}` |

- 文字起こしジョブはメモリ上に最大 20 件保持します。
- アップロード上限は `.env` の `MAX_UPLOAD_MB`（既定 `2048` MB）です。

## 保存とプライバシー

- 履歴はブラウザの `localStorage`（キー `rn_history`）に `{ id, createdAt, title, transcript, note }` の配列として保存されます。
- 音声ファイル自体はブラウザにもサーバーにも保存しません。
- 起動時に、旧バージョンのクライアント側設定キー（`rn_backend_url`・`rn_backend_key`・`rn_gemini_key`・`rn_gemini_model`・`rn_asr_engine`・`rn_browser_asr_model`）は自動で削除します。
- 大切なノートは「.mdでダウンロード」で手元に保存してください。

## トラブルシューティング

- **「Haas-ja モデルを準備中です」のまま進まない**：初回はモデルのダウンロード（約 460 MB、GPU 版は約 1.2 GB）が行われます。ターミナルのログ表示を確認してください。
- **ポートが使用中**：`.env` の `PORT` を `8001` などに変更して再起動してください。
- **音声を変換できない**：システムに `ffmpeg` を導入するか、`pip install imageio-ffmpeg` が入っているか確認してください。
- **GPU があるのに CPU モードになる**：`nvidia-smi` と `python -c "import torch; print(torch.cuda.is_available())"` を確認してください。公式 GPU 版は Linux + NVIDIA Ampere（RTX 30 シリーズ等）以降が必要です。

## クレジット・ライセンス

- Speech recognition model: [third-intelligence/Haas-ja-v1.0](https://huggingface.co/third-intelligence/Haas-ja-v1.0) by Third Intelligence (Apache License 2.0).
- CPU / ONNX conversion: [oboroge0/Haas-ja-v1.0-onnx-quantized](https://huggingface.co/oboroge0/Haas-ja-v1.0-onnx-quantized) running via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache License 2.0).
