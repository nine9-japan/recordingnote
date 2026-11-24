# RecordingNote — ブラウザ内 Haas-ja 文字起こし版

アプリのインストールやサーバー設定なしで、**使用者のブラウザ内だけで Haas-ja-v1.0 による日本語文字起こし**を行い、**Gemini API** で学習ノートを作成できる純粋な静的サイトです。GitHub Pages（`https://nine9-japan.github.io/recordingnote/`）でそのまま公開・利用できます。

## 特長

- **インストール不要・純静的サイト**：Python、ローカルサーバー、外部トンネルは一切不要です。ページを開くだけで動きます。
- **ブラウザ内で動く Haas-ja-v1.0**：
  - Web Worker 上で [`onnxruntime-web`](https://onnxruntime.ai/)（WebGPU 優先・WASM 自動フォールバック）を動かし、[`kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX`](https://huggingface.co/kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX)（`int4-onecomp`、約 363 MB）で推論します。
  - 音声データは端末の外へ一切送信されません。
  - 初回だけモデルファイルを Hugging Face から自動取得し、ブラウザの Cache API に保存します。2回目以降はキャッシュから読み込みます。
- **Gemini API ノート生成は後から組み込み可能**：
  - ノート生成の処理は `gemini-note.js` に分離しています。
  - 今すぐ試したい場合はページ内の「Gemini APIキーを設定（任意）」にキーを入れるだけで使え、後からサイト側の設定で中継 API エンドポイントを差し込むとキー入力欄ごと自動で非表示にできます。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `index.html` | 録音・音声入力・文字起こし・ノート生成・履歴・使い方ガイド |
| `styles.css` | 白と青を基調にしたレスポンシブ表示 |
| `app.js` | 録音、16 kHz リサンプリング、Worker 管理、Markdown 表示、履歴保存 |
| `haas-worker.js` | `onnxruntime-web` による Haas-ja-v1.0 のダウンロード・Cache 保存・Log-Mel 前処理・長尺分割・TDT デコード |
| `gemini-note.js` | Gemini API 呼び出しとノート生成プロンプト（プロキシ URL 設定にも対応） |
| `README.md` | この説明書 |

## 使い方

1. GitHub Pages（またはローカルの静的配信）でページを開きます。
2. 「録音開始」→「停止」で録音するか、音声ファイル（M4A / MP3 / WAV / WebM など）を選択します。
3. 「文字起こし開始」を押します（初回のみ約 363 MB のモデルを取得します）。
4. 完了した本文を確認・編集し、必要に応じて「文字起こしをコピー」や「AIノートを生成」を実行します。
5. 生成したノートは「Markdownをコピー」または「.mdでダウンロード」で保存できます。

## 後から Gemini API を組み込む方法（サイト管理者向け）

公開する静的 HTML / JS に `GEMINI_API_KEY` を直書きすると第三者にキーが露出するため、**利用者にキーを入力させずに提供したい場合は、`gemini-note.js` の `NOTE_CONFIG.endpoint` に中継サーバー（Cloudflare Workers 等）の URL を設定してください。**

```js
// gemini-note.js
export const NOTE_CONFIG = {
  endpoint: "https://your-worker.example.workers.dev/notes",
  defaultModel: "gemini-2.5-flash",
  allowUserApiKey: true,
};
```

- `endpoint` に URL を設定すると、ページ上の「Gemini APIキーを設定（任意）」欄は自動で非表示になります。
- 中継サーバーへのリクエスト仕様：`POST JSON { transcript, title, prompt, model }` → `JSON { note: "Markdown文字列" }`。
- `endpoint` が空のままの現在は、`allowUserApiKey: true` により、使いたい人だけが自分の Gemini API キーをブラウザに入力（`localStorage` 保存）して使えます。文字起こしだけを使う場合は入力不要です。

## 動作要件と設計上の配慮

- 対応ブラウザ：WebGPU または WebAssembly（WASM）に対応した最新の Chrome / Edge / Safari / Firefox。
- マイク録音には HTTPS（GitHub Pages）または `localhost` が必要です。
- GitHub Pages ではクロスオリジン分離ヘッダ（COOP / COEP）が付与されないため、`ort.env.wasm.numThreads = 1`・`proxy = false` のシングルスレッド WASM 設定で `SharedArrayBuffer` なしでも確実に動くようにしています。
- 28 秒前後の低音量区間で自動分割しながら処理するため、長時間の講義録音でもメモリ消費を抑えて文字起こしできます。

## ローカルでのプレビュー確認

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

ブラウザで `http://127.0.0.1:8000` を開きます。

## クレジット・ライセンス

- Original model: [third-intelligence/Haas-ja-v1.0](https://huggingface.co/third-intelligence/Haas-ja-v1.0) by Third Intelligence (Apache License 2.0)
- Browser ONNX conversion: [kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX](https://huggingface.co/kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX) (Apache License 2.0)
- Runtime: [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT License)
