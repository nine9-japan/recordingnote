# RecordingNote — ローカル文字起こし版

講義の音声を文字起こしし、学習ノートにまとめる日本語のツールです。文字起こしは**ブラウザ内のWebGPU**か、**このPCで動く Haas-ja-v1.0** を選べます。ノート生成は**Gemini API**をサーバー経由で使います。Colab、トンネル、バックエンドURL、APIキーの入力はありません。

ページとAPIは1つのPythonサーバーが同じオリジン（`http://127.0.0.1:8000`）で配信します。ビルドやDBは不要です。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `index.html` | 設定・音声入力・文字起こし・ノート・履歴・使い方ガイド |
| `styles.css` | 白と青を基調にしたレスポンシブ表示 |
| `app.js` | 録音、音声のデコード、Worker管理、API通信、Markdown表示、ブラウザ内保存 |
| `asr-worker.js` | Transformers.js v4によるブラウザ推論（Workerとメインスレッドで共用） |
| `server.py` | ページ配信、文字起こしジョブ、ノート生成API |
| `asr_backend.py` | Haas-ja の読み込み、ffmpeg変換、long-form文字起こし |
| `notes.py` | ノート生成プロンプトとGeminiプロバイダ |
| `requirements.txt` | Pythonの依存関係 |
| `start.sh` | 初回セットアップと起動をまとめて行うスクリプト |
| `.env.example` | 設定のひな形（`.env` にコピーして使う） |
| `README.md` | この説明書 |

## 必要なもの

- **Linux と NVIDIA GPU（CUDA）**。Haas-ja-v1.0 は CPU と macOS では動きません。
- Python 3.11 以上。
- CUDA対応のPyTorch。`python -c "import torch; print(torch.cuda.is_available())"` が `True` になることを確認してください。
- ffmpeg。システムにない場合は `imageio-ffmpeg` の同梱バイナリを使います。

ブラウザ方式だけを使う場合はGPUは不要です。ただし、その場合もページの配信にはローカルサーバーを使います。

## セットアップ

いちばん簡単なのは `start.sh` です。初回だけ仮想環境の作成と依存関係の導入を行い、`.env` を用意してサーバーを起動します。

```sh
git clone https://github.com/nine9-japan/recordingnote.git
cd recordingnote
./start.sh
```

ブラウザで `http://127.0.0.1:8000` を開きます。

手動で行う場合は次のとおりです。

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python server.py
```

- 初回起動時、Haas-ja のモデル（約1.2GB）をHugging Faceから取得します。モデルはバックグラウンドで読み込むため、ページ自体はすぐ開きます。準備できるまで「状態を再確認」で状態を確認してください。
- 2回目以降はローカルのキャッシュから読み込みます。
- ポートを変える場合は `.env` の `PORT` を変更します。`HOST` は認証がないため `127.0.0.1` のままにしてください。

## 使い方

1. 「録音開始」→「停止」で録音するか、音声ファイルを選びます。プレビューで内容を確認できます。
2. 文字起こしエンジンを選び、「文字起こし開始」を押します。
3. 完了した本文を確認し、必要なら編集します。履歴は完了時に自動作成され、以後の編集は約0.4秒後に自動保存されます。
4. 「AIノートを生成」を押します。Gemini APIキーが設定されていれば、文字起こし全文からMarkdownのノートを作ります。
5. 「Markdownをコピー」または「.mdでダウンロード」で取り出せます。
6. 履歴の項目を押すと、本文とノートを復元します。「削除」はこのブラウザ内の履歴だけを消します。

文字起こし欄に本文を直接貼り付けてノートを生成することもできます。この場合は「日時 ｜ テキスト入力」の履歴を作ります。

## 文字起こしエンジン

### ブラウザ方式（推奨）

- `@huggingface/transformers` v4 をCDNから動的importし、モデルはHugging Faceから取得します。初回はモデルのダウンロード（約1GB前後）が必要で、2回目以降はブラウザのキャッシュを使います。
- `device: 'webgpu'` を優先し、利用できない場合は `device: 'wasm'` で再試行します。WebGPUには対応ブラウザとHTTPSまたはlocalhostが必要です。
- 録音Blobとファイルは `AudioContext({ sampleRate: 16000 })` でデコードし、モノラルの `Float32Array` をWorkerへ渡します。音声は端末の外へ出ません。
- モデルの既定値は `onnx-community/whisper-large-v3-turbo-ONNX` です。日本語特化の `onnx-community/kotoba-whisper-v2.2-ONNX` も選べます。
- 推論は `language: 'japanese'`, `task: 'transcribe'`, `chunk_length_s: 30`, `stride_length_s: 5`。長尺音声の分割はpipeline内部に任せます。
- Workerが使えない場合はメインスレッドで実行します。中止の反映が遅れる場合があります。

### このPCのHaas-ja

- サーバーが音声を受け取り、ffmpegで16kHzモノラルWAVに変換してから `haas_asr.transcribe_longform` で処理します。ブラウザ録音のWebMやM4Aもそのまま送れます。
- GPUは1ジョブずつ直列に使います。長い講義は時間がかかります。
- `HAAS_BATCH_SIZE`（既定 `8`）でバッチサイズを変更できます。GPUメモリが足りない場合は小さくしてください。
- 固有名詞を登録する場合は `.env` の `HAAS_VOCABULARY_JSON` を使います。

  ```sh
  HAAS_VOCABULARY_JSON={"考古学概説II": ["こうこがくがいせつ"]}
  ```

- 音声はこのPCの外へ出ません。ジョブの一時ファイルは処理後に削除します。

## ノート生成（Gemini）

`.env` にAPIキーを設定してサーバーを再起動すると有効になります。

```sh
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-2.5-flash
```

- キーはサーバー側だけで使い、ブラウザへは返しません。localStorageにも保存しません。
- `POST /notes` に文字起こし全文を渡し、サーバーが `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` へ送ります。タイムアウトは180秒です。
- プロンプトは `notes.py` の `NOTE_PROMPT` に1か所だけ定義しています。文字起こしにない事実を足さない、見出しと箇条書きで構成する、末尾に「重要語句」と「復習ポイント」を付ける、といった指示です。
- キーが未設定の場合、ノート生成は「Gemini APIキーが未設定です」と案内します。文字起こしはそのまま使えます。
- 将来ほかの生成先を追加する場合は、`notes.py` の `GeminiProvider` と同じ `generate(transcript)` を持つクラスを作り、`load_provider()` で返すようにします。フロントエンドとAPIの変更は不要です。
- Geminiを使うときだけ、文字起こし全文をGoogleへ送ります。

## API

サーバーは `127.0.0.1` でのみ待ち受け、認証はありません。外部へ公開しないでください。

| メソッド | パス | 内容 |
| --- | --- | --- |
| `GET` | `/health` | モデルの読み込み状態とノート生成の設定状態 |
| `POST` | `/jobs` | `multipart/form-data` の `file` に音声を入れて送信 |
| `GET` | `/jobs/{job_id}` | `queued` / `running` / `done` / `error` と本文 |
| `POST` | `/notes` | `{"transcript": "...", "title": "..."}` → `{"note": "Markdown"}` |

`/health` の例:

```json
{
  "ok": true,
  "engine": "third-intelligence/Haas-ja-v1.0",
  "model_loaded": true,
  "model_loading": false,
  "model_error": null,
  "notes": { "ready": true, "provider": "gemini" }
}
```

- 文字起こしジョブはメモリ上に最大20件保持します。サーバーを再起動すると消えます。
- アップロードの上限は `MAX_UPLOAD_MB`（既定2048MB）です。
- 文字起こしの待機中は3秒間隔で `/jobs/{job_id}` を確認します。中止しても、サーバー側の処理は継続する場合があります。

## 保存とプライバシー

| localStorageキー | 保存するもの |
| --- | --- |
| `rn_asr_engine` | 文字起こしエンジン（`browser` / `local`、既定は `browser`） |
| `rn_browser_asr_model` | ブラウザ文字起こしのモデルID |
| `rn_history` | `id, createdAt, title, transcript, note` を持つオブジェクトの配列 |

- 旧版の `rn_backend_url`・`rn_backend_key`・`rn_gemini_key`・`rn_gemini_model` は起動時に削除します。
- 音声ファイル自体は保存しません。履歴はこのブラウザ・このプロファイルだけのものです。
- サイトにアカウント登録、アクセス解析、キーや本文の収集はありません。
- localStorageは暗号化されません。共用端末ではサイトデータを消してください。
- 大切なノートは `.md` でダウンロードしてください。ブラウザのサイトデータ削除で履歴と設定も消えます。

## GitHub Pages で使う場合

`index.html`・`styles.css`・`app.js`・`asr-worker.js` は静的ファイルなので、GitHub Pagesでもブラウザ方式だけは動きます。ただし、HTTPSのページから `http://127.0.0.1` のローカルAPIへは接続できないため、Haas-ja とノート生成は使えません。全機能を使う場合はローカルサーバーから開いてください。

## トラブルシューティング

- **「NVIDIA GPU（CUDA）を利用できません」**: CUDA対応のPyTorchが入っているか確認してください。`nvidia-smi` と `python -c "import torch; print(torch.cuda.is_available())"` を実行します。
- **モデルの読み込みが終わらない**: 初回は約1.2GBの取得があります。ターミナルの表示と `http://127.0.0.1:8000/health` を確認してください。
- **ポートが使用中**: `.env` の `PORT` を `8001` などに変更し、表示されたURLを開きます。
- **音声を変換できない**: ffmpeg を導入するか、`pip install imageio-ffmpeg` を実行してください。WAV・MP3への変換でも回避できます。
- **ブラウザ方式が動かない**: WebGPU対応ブラウザとlocalhostで開いているか確認してください。「このPCのHaas-ja」へ切り替えることもできます。

## 確認用コマンド

```sh
node --check app.js
node --check asr-worker.js
python3 -m py_compile server.py asr_backend.py notes.py
python3 server.py
```

別のターミナルで配信とAPIを確認できます。

```sh
curl -I http://127.0.0.1:8000/index.html
curl -s http://127.0.0.1:8000/health
```
