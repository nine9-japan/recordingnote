# RecordingNote — ブラウザ文字起こし・静的版

講義の音声を**ブラウザ内のWebGPUで文字起こしする方式を標準**とし、Geminiまたは対応するColabバックエンドで学習ノートにまとめる、日本語の静的サイトです。PCが非力な場合などは、既存のGoogle ColabのHaasによる文字起こしへ切り替えられます。HTML・CSS・Vanilla JavaScriptで動作し、ビルド、サーバー側DB、フレームワークは不要です。ブラウザ推論用のライブラリとモデルだけを外部取得し、外部フォント・外部画像・解析タグは使いません。

## ファイルと公開方法

| ファイル | 内容 |
| --- | --- |
| `index.html` | 設定・音声入力・エンジンとモデル選択・ノート・履歴・使い方ガイド |
| `styles.css` | 白と青を基調にしたレスポンシブな表示 |
| `app.js` | 録音、音声のデコード、Worker管理、API通信、Markdown表示、ブラウザ内保存 |
| `asr-worker.js` | Transformers.js v4によるブラウザ推論。Workerとメインスレッド代替実行で共用 |
| `recordingnote-colab-backend.ipynb` | 参照ノートブックを変更せずコピーしたもの |
| `README.md` | この説明書 |

GitHub Pagesの公開対象のルートに、この6ファイルを置いてください。たとえば公開用ブランチのルートに `site/` の中身を配置し、リポジトリの **Settings → Pages** からそのブランチとルートを選びます。サイト内のファイル参照は相対パスで、リポジトリ名のあるURLでも動作します（外部ライブラリ・モデル・APIはHTTPSのURLを使用）。GitHub Pagesは画面の配信だけを担当します。`asr-worker.js` もJavaScriptのMIMEタイプで配信してください。

手元で確認する場合は、プロジェクトのルートから次を実行します。

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory site
```

ブラウザで `http://localhost:8000` を開いてください。録音にはHTTPSまたはlocalhost、マイク使用の許可、MediaRecorder対応ブラウザが必要です。HTMLの直接起動よりHTTPでの配信を使ってください。

## ブラウザ方式（推奨）

Colabの起動・URL・APIキーの設定は不要です。「ブラウザで文字起こし（推奨）」を選び、録音または音声ファイルを用意して「文字起こし開始」を押します。モデルの既定値はWhisper large-v3-turboです。初回は**モデルのダウンロード（約1GB前後）が必要です。2回目以降はキャッシュから読み込みます**。実際の容量はモデルとdtypeによって増減し、fp32での再試行では数GBになる場合があります。モデルを変更した場合やサイトデータの削除、容量不足・ブラウザによるキャッシュ削除の後は再ダウンロードが必要です。

音声は端末の外に出ません。ダウンロードしたモデルを利用者のブラウザで動かします。PCの処理能力・メモリが足りない場合やブラウザが対応していない場合は、「Colabバックエンド」を選び、下の手順で従来の方式を利用できます。ブラウザ方式の失敗からColabへの切り替えは利用者が選択します。自動で音声を外へ送りません。AIノート生成には別途Geminiまたは `/notes` 対応のColabが必要で、文字起こし本文をそのAPIへ送ります。

### ブラウザ推論の構成

- ライブラリは `@huggingface/transformers` v4系。**今回は自己ホストではなくCDN方式です**。実装環境で `npm pack @huggingface/transformers@4 --ignore-scripts` を試しましたが、レジストリへの通信が `EPERM` で拒否され、同梱できませんでした。`site/vendor/` はなく、同梱ファイル・同梱サイズはありません。
- 初めてブラウザ文字起こしを開始したときだけ、`https://cdn.jsdelivr.net/npm/@huggingface/transformers@4/dist/transformers.min.js` を動的importします。ONNX Runtime WebのWASM等は、ライブラリが指定する対応バージョンの既定CDNパスから読み込みます。モデルと設定・トークナイザーはHugging Faceの指定モデルリポジトリから取得します。ライブラリを取得できない場合は日本語で案内します。CDN・モデルの実取得は本環境では未検証です。
- モジュールWorker `asr-worker.js` 内で推論します。Workerが未対応・起動エラー・起動待ち10秒超過の場合やWorkerがクラッシュした場合は、同じモジュールをメインスレッドで実行します。その場合は画面の反応や中止の反映が遅れる可能性を画面に表示します。
- `device: 'webgpu'` を優先し、利用不可または読み込み・推論失敗なら `device: 'wasm'` で再試行します。代替実行の理由を画面に残します。WebGPUには対応ブラウザとHTTPSまたはlocalhostが必要です。
- WebGPUのdtypeは `encoder_model: 'fp16'` / `decoder_model_merged: 'q4'`、WASMは両方 `'q4'` です。各デバイスで量子化モデルを読み込めない場合は `'fp32'` へ自動で再試行し、容量・メモリが増える旨を表示します。fp32エンコーダーの `.onnx_data` にも対応します。選択方法は[公式dtypeガイド](https://huggingface.co/docs/transformers.js/guides/dtypes)、モデルの提供形式は[Whisperファイル一覧](https://huggingface.co/onnx-community/whisper-large-v3-turbo-ONNX/tree/main/onnx)・[Kotobaファイル一覧](https://huggingface.co/onnx-community/kotoba-whisper-v2.2-ONNX/tree/main/onnx)を参照してください。
- 録音Blobとファイルは `AudioContext({ sampleRate: 16000 })` でデコードし、全チャンネルの平均を取ったモノラル `Float32Array` をWorkerへ渡します。ブラウザ非対応の音声形式は変換またはColabの利用を案内します。
- 推論オプションは `language: 'japanese'`, `task: 'transcribe'`, `chunk_length_s: 30`, `stride_length_s: 5`。長尺音声の分割はpipeline内部に任せ、手作業で音声を分割しません。モデルのダウンロード中はファイル名・取得率、推論中は「処理中」と経過時間を表示します。
- 同じモデルのpipelineをページ内で再利用します。モデルの変更・Worker中止時には解放します。GitHub Pages向けにWASMは1スレッドに設定し、SharedArrayBufferやCOOP/COEPヘッダーを必須にしません。

モデル選択肢:

| 表示名 | モデルID |
| --- | --- |
| Whisper large-v3-turbo／高速・推奨（既定） | `onnx-community/whisper-large-v3-turbo-ONNX` |
| Kotoba-Whisper v2.2／日本語特化 | `onnx-community/kotoba-whisper-v2.2-ONNX` |

自己ホストへ変更する場合は、取得可能な環境でv4の配布モジュールと、それが依存する**同じバージョン**の `onnxruntime-web` のWASM・補助モジュールとライセンスを `site/vendor/` に揃えます。`asr-worker.js` の `TRANSFORMERS_URL` を相対ファイルURL（`new URL('./vendor/...', import.meta.url).href`）に変更し、`env.backends.onnx.wasm.wasmPaths` を同梱先へ設定します。単にWASMだけを置いても補助モジュールが不足する場合があります。[公式の配置設定](https://huggingface.co/docs/transformers.js/custom_usage)を確認し、配信時のパス・MIMEタイプも検証してください。

## Colab方式の最初の接続（代替方式）

1. ページ下部の「ノートブックをダウンロード」から `recordingnote-colab-backend.ipynb` を保存します。
2. [Google Colab](https://colab.research.google.com/) でファイルをアップロードし、GPUランタイムを選びます。APIサーバー起動セルのCORS設定を、後述の手順で変更してから「すべて実行」します。
3. 導入セルには**セッション再起動の指示**があります。導入完了後にいったんセッションを再起動し、「GPU確認とDriveマウント」→「モデル読み込み」→「文字起こし関数 + Driveキュー」→「APIサーバー起動」の順で実行してください。導入セルは再実行不要です。Driveへの接続確認にも応答します。
4. Colabに表示されたバックエンドURLとAPIキーを、サイトの「接続・API設定」に貼り付けます。入力すると自動保存されます。ノートブック末尾のペアリングコードは空欄のままEnterで進められます。この静的サイトはペアリング登録を行いません。
5. 「接続テスト」で接続を確認します。`/health` は認証なしなので、APIキーが正しいかどうかは音声送信などの認証付き処理で確認されます。

**無料枠のColabはアイドルで切断されるため、使うたびに実行が必要です。** 切断・再起動後は、表示された最新のURLとキーで設定を更新してください。

### 付属ノートブックの接続許可（必須）

配布ファイルは `ref/recordingnote-colab-backend.ipynb` の完全なコピーです。元ファイルでは `allow_origins` が旧サイトに限定されているため、**そのまま起動するとGitHub Pagesやlocalhostからの通信は許可されません**。

サイトの「Colabの始め方」には、現在のページ用の設定が表示されます。Colab上のAPIサーバー起動セルで、`app.add_middleware(CORSMiddleware, ...)` 内の `allow_origins=[...]` をその表示に置き換え、サーバーを起動してください。

- オリジンは、ページのURLの「プロトコル + ドメイン + 必要ならポート」です。パス、リポジトリ名、末尾の `/` は含めません。
- GitHub Pagesとローカル環境の両方で使う場合は、それぞれのオリジンをリストに列挙します。`localhost` と `127.0.0.1` は異なるオリジンです。
- `allow_methods=['GET','POST']` と `allow_headers=['*']` は元のままで使用できます。CORSのプリフライトはミドルウェアが処理します。
- 起動後に設定を変更した場合は、セッションを再起動し、上記の再起動後の手順でサーバーを起動し直してください。新しいURLとキーもサイトへ貼り直します。

### 付属ノートブックとノート生成

付属ノートブックは**文字起こし専用で、`/notes` は実装されていません**。これをそのまま使う場合、ノート生成用にGemini APIキーを設定してください。Geminiキーがなく自動選択でColabを使った場合や、明示的にColabを選んだ場合、`/notes` の404を「このバックエンドはノート生成に未対応です」と表示します。

Colabでノートを生成したい場合は、後述の `/notes` 仕様に対応するバックエンドを利用者側で用意してください。サイト側で他のエンジンに自動的に切り替えることはありません。

## 普段の使い方

1. 「録音開始」→「停止」で録音し、プレビューで確認します。音声ファイルの選択も使えます。
2. 文字起こしエンジンと、ブラウザ方式の場合はモデルを選び、「文字起こし開始」を押します。ブラウザ方式はColab未設定でも開始できます。Colab方式だけは送信前に必ず接続を確認し、未設定・接続不可なら送信を始めません。
3. 完了した本文を確認し、必要に応じて編集します。履歴は完了時に自動作成され、以後の編集は約0.4秒後に自動保存されます。
4. エンジンを選び、「AIノートを生成」を押します。「自動」は実行開始時にGeminiキーがあればGemini、なければColabを選びます。選択先で失敗した場合も他の経路には切り替えません。
5. 「Markdownをコピー」または「.mdでダウンロード」でノートを取り出せます。ノートは元のMarkdownのままコピー・保存されます。
6. 履歴の項目を押すと本文とノートを復元します。「削除」はこのブラウザ内の履歴だけを削除し、Drive側のファイルは消しません。

文字起こし欄に本文を直接貼り付け、ノートを生成することもできます。この場合はノート生成の完了時に「日時 ｜ テキスト入力」の履歴を作ります。音声の文字起こし完了時のタイトルは「日時 ｜ ファイル名」、録音なら「日時 ｜ ブラウザ録音」です。タイトルの変更機能はありません。

ブラウザ方式の「文字起こしを中止」はWorkerを終了し、結果を履歴へ追加しません。メインスレッド代替実行では実行中の演算を即時停止できない場合があり、処理が戻った後に中止を反映して結果を破棄します。Colab・Geminiの「待機を中止」はブラウザ側の通信・ポーリングを中止します。送信済みのColabジョブやGemini側の処理・利用枠消費を取り消すものではありません。Colabの結果はノートブックやDriveでも確認してください。ページ再読み込み後のジョブへの再接続は行いません。エラーや中止の際も、それまで表示していた本文・ノートは保持します。

## APIとの通信

### Colab方式の文字起こし

- `GET {url}/health`：開始前の接続確認。15秒でタイムアウト。
- `POST {url}/jobs`：`FormData` の `file` フィールドに音声を入れ、`X-API-Key` ヘッダーで認証します。アップロードは120秒でタイムアウト。`Content-Type` とboundaryはブラウザが設定します。
- `GET {url}/jobs/{job_id}`：同じ `X-API-Key` を付け、3秒間隔で状態を確認します。各リクエストのタイムアウトは30秒です。
- `queued`（待機）/ `running`（処理中）/ `done`（完了）/ `error`（失敗）を日本語で表示します。完了時には `transcript` → `result` → `text` の順で空でない本文を取得します。`result` 内のオブジェクトにも対応します。

完了時にDriveのパスなどが返されても、サイトはそれを読み込みません。Driveの構成や保存成功をサイト側の動作条件にしていません。

### Geminiでのノート生成

`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` に、`x-goog-api-key` ヘッダーで認証して送信します。モデルの既定値は `gemini-2.5-flash` です。APIキーをURLへ含めません。

共通プロンプトと文字起こし**全文を1回のリクエスト**で送ります。分割・別モデルへの切り替え・自動再試行はしません。モデルの上限や利用枠を超えた場合は、設定やGoogle側の利用枠を確認してください。応答のタイムアウトは180秒です。

### Colabでのノート生成（対応バックエンド用）

`POST {url}/notes` に `Content-Type: application/json` と `X-API-Key` を付けます。必須の `transcript` と `title` をそのまま渡し、**両経路に同じ指示を渡すため `prompt` フィールドも追加**します。

```json
{
  "transcript": "編集後の文字起こし全文",
  "title": "日時 ｜ 音声ファイル名",
  "prompt": "共通のノート生成プロンプト\n\n文字起こし:\n編集後の文字起こし全文"
}
```

バックエンドでは `prompt` を生成入力として使用してください。これには文字起こしも含まれるため、同じ本文を再度付け加える必要はありません。フロントエンドだけで、バックエンドが指示に従うことまでは保証できません。

- 即時応答 `{ "note": "Markdown本文" }` を表示します。
- `{ "job_id": "..." }` の場合は、文字起こしと同じ `/jobs/{job_id}` を3秒間隔でポーリングします。`done` 時の `note` または `result` を表示します。
- `/notes` の404は未対応として案内します。POSTのタイムアウトは180秒です。

### 共通のノート生成プロンプト

`app.js` の `NOTE_PROMPT` に、次の指示を1か所で定義しています。

> あなたは大学講義の学習ノート作成者です。以下は講義の文字起こしです。この内容だけを使って、日本語で学習ノートを作成してください。ルール: 文字起こしに書かれていない事実・用語・年号を絶対に足さない／見出しで階層化し要点は箇条書き／年号・人名・地名・専門用語は文字起こしの表記をそのまま使う／講義の流れに沿って構成する／冒頭にタイトル行を付ける／末尾に「重要語句」リストと「復習ポイント」を付ける。出力はMarkdownのみ。文字起こしは句読点のない音声認識結果なので、読み取りにくい箇所は無理に補わず趣旨が取れる範囲で整理すること。

Markdownの表示は自前の最小限のレンダラです。まず全体をHTMLエスケープし、`#`〜`###` の見出し、`-` の箇条書き、`**太字**`、段落・改行、バッククォート3つのコードブロックだけを固定のHTMLタグに変換します。任意のHTML・リンク・画像・スクリプトは有効にしません。

## 保存とプライバシー

| localStorageキー | 保存するもの |
| --- | --- |
| `rn_asr_engine` | 文字起こしエンジン（`browser` / `colab`、既定は `browser`） |
| `rn_browser_asr_model` | ブラウザ文字起こしのモデルID |
| `rn_backend_url` | 利用者が入力したColabバックエンドURL |
| `rn_backend_key` | ColabバックエンドのAPIキー |
| `rn_gemini_key` | 任意のGemini APIキー |
| `rn_gemini_model` | Geminiのモデル名（空欄なら既定値を使用） |
| `rn_history` | `id, createdAt, title, transcript, note` を持つオブジェクトの配列 |

- キーの保存先はこのブラウザのlocalStorageだけで、サイトの保存用サーバーはありません。**APIを実行するときには、認証に必要なキーをそれぞれのAPIへ送信します**。Colabのキーは設定したバックエンドだけへ、GeminiのキーはGoogleのGemini APIだけへ送ります。
- ブラウザ方式では音声を端末内に保持し、外部へ送りません。Colab方式を選んだときだけ「文字起こし開始」時に指定したColabへ送ります。ブラウザ方式のライブラリ・モデル取得時には配信元との通信が発生しますが、音声や本文をリクエストへ含めません。Geminiによるノート生成では、文字起こし全文をGoogleへ送ります。Colabによるノート生成では、文字起こし全文とタイトル、プロンプトを設定したバックエンドへ送ります。
- サイトにアカウント登録やGoogleログインはなく、アクセス解析、キー・音声・本文のサイト側への収集もありません。GoogleへのログインやDriveの許可はColab側で行います。GoogleやColabのデータ取り扱いは各サービスの設定・ポリシーに従います。
- localStorageは暗号化保管庫ではありません。このブラウザ・プロファイルを使う人や拡張機能は保存データへアクセスできる場合があります。共用端末ではサイトデータを消し、キーを残さないでください。
- 保存領域はドメインとプロトコル・ポートごとに分かれます。同じGitHub Pagesオリジンの別パスはlocalStorageを共有します。別端末・別ブラウザへの同期はありません。ブラウザのサイトデータ削除で履歴と設定も失われます。
- 音声ファイル自体はlocalStorageへ保存しません。ColabノートブックがDriveに保存する文字起こしや接続情報は、ブラウザの保存とは独立しています。
- localStorageの容量不足・無効化は画面に案内します。自動で古い履歴を捨てることはしません。壊れた履歴JSONを読み込んだ場合は既存データの上書きを止めます。大切なノートはダウンロードしてください。

## 確認用コマンド

```sh
node --check site/app.js
node --check site/asr-worker.js
python3 -m http.server 8000 --bind 127.0.0.1 --directory site
```

別のターミナルで配信結果を確認できます。

```sh
curl -I http://localhost:8000/index.html
curl -I http://localhost:8000/styles.css
curl -I http://localhost:8000/app.js
curl -I http://localhost:8000/asr-worker.js
curl -I http://localhost:8000/recordingnote-colab-backend.ipynb
```

ブラウザ方式は初回のCDN・モデル取得と端末のメモリ・WebGPU/WASM対応が必要です。Colab方式には起動済みColabと正しいCORS設定・URL・キーが必要です。マイクはブラウザで許可して確認してください。**本実装環境ではブラウザ実機での推論は未検証です**。実際のモデル取得、WebGPU/WASMの推論精度・速度・メモリ使用量、初回／キャッシュ済みの動作は利用環境で確認してください。
