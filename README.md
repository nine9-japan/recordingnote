# RecordingNote — ブラウザ内 Haas-ja（PC）＆ Groq API（モバイル）対応版

アプリのインストールやローカルサーバーなしで使える、純粋な静的サイトです。GitHub Pages（`https://nine9-japan.github.io/recordingnote/`）を開くだけで利用でき、**PC ではブラウザ内の Haas-ja-v1.0**、**スマホ・タブレットでは Groq Audio Transcriptions API** へ自動で切り替わります。

## 特長

- **端末に合わせた自動切り替え（選択操作なし）**：
  - **PC ブラウザ**：Web Worker 上で [`onnxruntime-web`](https://onnxruntime.ai/)（WebGPU 優先・WASM 自動フォールバック）を動かし、[`kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX`](https://huggingface.co/kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX)（`int4-onecomp`、約 363 MB）で文字起こしします。音声データは端末の外へ出ません。
  - **モバイル（iPhone / Android / iPad）**：スマホのメモリ制限（約 1 GB 超でのタブ強制終了）を避けるため、Groq API（`whisper-large-v3-turbo`）で文字起こしします。20 MB を超える音声は 8 分単位の 16 kHz モノラル WAV に自動分割して送信します。
- **Gemini API・Groq API は後から中継サーバーに差し替え可能**：
  - ノート生成（`gemini-note.js`）とモバイル文字起こし（`groq-asr.js`）は、それぞれ `endpoint` を 1 行設定するだけで中継 API（Cloudflare Workers 等）経由へ切り替えられます。
  - 中継 API を設定するとページ上の API キー入力欄は自動で非表示になり、利用者は設定ゼロで使えます。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `index.html` | 録音・音声入力・文字起こし・ノート生成・履歴・使い方ガイド |
| `styles.css` | 白と青を基調にしたレスポンシブ表示 |
| `app.js` | 端末判定、録音、16 kHz リサンプリング、Worker / Groq 実行制御、Markdown 表示、履歴保存 |
| `haas-worker.js` | PC ブラウザ用の Haas-ja-v1.0（モデル取得・Cache API 保存・Log-Mel 前処理・長尺分割・TDT デコード） |
| `groq-asr.js` | モバイル用の Groq Audio Transcriptions API クライアント（20 MB 超の WAV 分割・中継 URL 設定対応） |
| `gemini-note.js` | Gemini API による学習ノート生成モジュール（中継 URL 設定対応） |
| `README.md` | この説明書 |

## 使い方

1. GitHub Pages（またはローカルの静的配信）でページを開きます。
2. 「録音開始」→「停止」で録音するか、音声ファイル（M4A / MP3 / WAV / WebM など）を選択します。
3. 「文字起こし開始」を押します（PC は初回のみ約 363 MB を取得・キャッシュ、モバイルは Groq API を使用）。
4. 完了した本文を確認・編集し、「文字起こしをコピー」や「AIノートを生成」を実行します。
5. 生成したノートは「Markdownをコピー」または「.mdでダウンロード」で保存できます。

> デバッグ用パラメータ：PC から Groq モードを試したい場合は `?asr=groq`、モバイルから Haas-ja を試したい場合は `?asr=haas` を URL 末尾に付けて開けます。

## 後から Groq / Gemini API を組み込む方法（サイト管理者向け）

公開中の静的 HTML / JS に秘密の API キーを直書きすると第三者に露出するため、**利用者にキーを入力させずに提供したい場合は、Cloudflare Workers 等の中継サーバーに `GROQ_API_KEY` と `GEMINI_API_KEY` を置き、各設定ファイルの `endpoint` に URL を設定してください。**

1. **モバイル文字起こし用（`groq-asr.js`）**

   ```js
   export const GROQ_CONFIG = {
     endpoint: "https://your-worker.example.workers.dev/transcribe",
     defaultModel: "whisper-large-v3-turbo",
     language: "ja",
     maxUploadBytes: 20 * 1024 * 1024,
     chunkSeconds: 480,
     allowUserApiKey: true,
   };
   ```

   - 中継仕様：`POST multipart/form-data`（`file`, `model`, `language`, `response_format`, `prompt?`）→ `JSON { text: "..." }`

2. **AI ノート生成用（`gemini-note.js`）**

   ```js
   export const NOTE_CONFIG = {
     endpoint: "https://your-worker.example.workers.dev/notes",
     defaultModel: "gemini-2.5-flash",
     allowUserApiKey: true,
   };
   ```

   - 中継仕様：`POST JSON { transcript, title, prompt, model }` → `JSON { note: "Markdown文字列" }`

`endpoint` を設定すると、それぞれの API キー入力欄はページ上で自動的に非表示になります。`endpoint` が空のままの間は、使いたい人が自分の API キーをブラウザに入力（`localStorage` 保存）してすぐ試せます。

## 動作要件と設計上の配慮

- 対応ブラウザ：WebGPU または WebAssembly（WASM）に対応した最新の Chrome / Edge / Safari / Firefox。
- マイク録音には HTTPS（GitHub Pages）または `localhost` が必要です。
- PC 用 `haas-worker.js` は COOP / COEP ヘッダ不要のシングルスレッド WASM 設定（`numThreads = 1`, `proxy = false`）で動作します。
- モバイル用 `groq-asr.js` は 20 MB 以下の音声をデコードせずそのまま `FormData` で送信するため、スマホのメモリ消費を最小限に抑えます。

## ローカルでのプレビュー確認

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

ブラウザで `http://127.0.0.1:8000` を開きます。

## クレジット・ライセンス

- Original model: [third-intelligence/Haas-ja-v1.0](https://huggingface.co/third-intelligence/Haas-ja-v1.0) by Third Intelligence (Apache License 2.0)
- Browser ONNX conversion: [kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX](https://huggingface.co/kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX) (Apache License 2.0)
- Runtime: [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT License)
