// Shared by the module Worker and the main-thread fallback. Loaded only on demand.
// npm pack was blocked in the build environment; see README for CDN/self-hosting notes.
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4/dist/transformers.min.js";
const MODELS = new Set([
  "onnx-community/whisper-large-v3-turbo-ONNX",
  "onnx-community/kotoba-whisper-v2.2-ONNX",
]);

function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException("文字起こしを中止しました。", "AbortError");
}

function failureReason(error) {
  const detail = String(error?.message || error).toLowerCase();
  if (/out of memory|memory|allocation|buffer size/.test(detail)) return "端末のメモリが不足している可能性があります。ほかのタブやアプリを閉じてください。";
  if (/fetch|network|download|404|403|load external/.test(detail)) return "モデルを取得できませんでした。通信状態、サイトの通信許可、ブラウザの空き容量を確認してください。";
  if (/gpu|adapter|device|shader/.test(detail)) return "GPUを利用できないか、対応していない演算があります。最新版のブラウザとHTTPSまたはlocalhostで再試行してください。";
  return "この端末ではモデルの読み込みまたは推論を完了できませんでした。ブラウザの対応状況と端末の空きメモリを確認してください。";
}

export function createBrowserASR() {
  let libraryPromise = null;
  let cached = null;
  let running = false;

  async function dispose() {
    const previous = cached;
    cached = null;
    if (previous) {
      try { await previous.pipe.dispose(); } catch { /* Release what the runtime permits. */ }
    }
  }

  async function loadLibrary() {
    if (!libraryPromise) {
      libraryPromise = import(TRANSFORMERS_URL).then((library) => {
        // Only model files are fetched from the Hub; audio stays in this process.
        library.env.allowLocalModels = false;
        library.env.useBrowserCache = true;
        // GitHub Pages does not supply cross-origin isolation headers.
        // Single-threaded WASM avoids requiring SharedArrayBuffer or extra Workers.
        library.env.backends.onnx.wasm.numThreads = 1;
        library.env.backends.onnx.wasm.proxy = false;
        return library;
      }).catch(() => {
        libraryPromise = null;
        throw new Error("文字起こしライブラリをCDNから読み込めませんでした。インターネット接続と cdn.jsdelivr.net の通信許可を確認して再試行するか、「Colabバックエンド」へ切り替えてください。");
      });
    }
    return libraryPromise;
  }

  async function transcribe(audio, model, { onEvent = () => {}, signal } = {}) {
    if (running) throw new Error("文字起こしの処理中です。完了または中止してから再実行してください。");
    if (!MODELS.has(model)) throw new Error("ブラウザ用のモデルを選び直してください。");
    if (!(audio instanceof Float32Array) || !audio.length) throw new Error("音声データが空です。録音またはファイル選択をやり直してください。");
    running = true;
    try {
      checkCancelled(signal);
      onEvent({ type: "loading", message: "文字起こしライブラリとモデルを準備しています…" });
      const { pipeline } = await loadLibrary();
      checkCancelled(signal);
      if (cached && cached.model !== model) await dispose();
      const devices = cached ? [cached.device, ...(cached.device === "webgpu" ? ["wasm"] : [])] : ["webgpu", "wasm"];
      let lastError;
      for (const device of devices) {
        checkCancelled(signal);
        if (device === "webgpu" && !globalThis.navigator?.gpu) {
          onEvent({ type: "notice", message: "この環境はWebGPUに対応していないため、WASM（CPU）で再試行します。処理に時間がかかる場合があります。" });
          continue;
        }
        if (device === "wasm") onEvent({ type: "notice", message: "WASM（CPU）を使用します。PCの処理能力が足りない場合は「Colabバックエンド」へ切り替えられます。" });
        try {
          if (!cached) {
            // Whisper's encoder benefits from fp16; q4 keeps the decoder smaller.
            // WASM uses q4 without fp16, which is not supported by all CPUs/runtimes.
            const preferred = device === "webgpu"
              ? { encoder_model: "fp16", decoder_model_merged: "q4" }
              : { encoder_model: "q4", decoder_model_merged: "q4" };
            for (const dtype of [preferred, "fp32"]) {
              checkCancelled(signal);
              try {
                onEvent({ type: "loading", message: `${device === "webgpu" ? "WebGPU" : "WASM"}用のモデルを読み込んでいます…` });
                const pipe = await pipeline("automatic-speech-recognition", model, {
                  device, dtype,
                  // Full precision encoders in these repositories use .onnx_data files.
                  use_external_data_format: {
                    encoder_model: dtype === "fp32", decoder_model_merged: false,
                  },
                  progress_callback: (progress) => {
                    if (!signal?.aborted) onEvent({ type: "progress", progress });
                  },
                });
                cached = { pipe, model, device };
                checkCancelled(signal);
                break;
              } catch (error) {
                if (signal?.aborted) throw error;
                if (dtype === "fp32") throw error;
                onEvent({ type: "notice", message: `${device === "webgpu" ? "WebGPU" : "WASM"}用の量子化モデルを読み込めなかったため、fp32で再試行します。ダウンロード量と必要メモリが増えます。` });
              }
            }
          }
          checkCancelled(signal);
          onEvent({ type: "inference", device });
          const result = await cached.pipe(audio, {
            language: "japanese", task: "transcribe",
            chunk_length_s: 30, stride_length_s: 5,
          });
          checkCancelled(signal);
          return { text: result.text || "", device };
        } catch (error) {
          await dispose();
          if (signal?.aborted) throw error;
          lastError = error;
          if (device === "webgpu") {
            onEvent({ type: "notice", message: `WebGPUで処理できなかったため、WASM（CPU）で再試行します。${failureReason(error)}` });
          }
        }
      }
      throw new Error(`ブラウザ内の文字起こしに失敗しました。${failureReason(lastError)} 再試行しても解決しない場合は「Colabバックエンド」へ切り替えてください。音声は送信していません。`);
    } finally {
      if (signal?.aborted) await dispose();
      running = false;
    }
  }

  return { transcribe, dispose };
}

if (typeof DedicatedWorkerGlobalScope !== "undefined" && globalThis instanceof DedicatedWorkerGlobalScope) {
  const engine = createBrowserASR();
  self.addEventListener("message", async ({ data }) => {
    if (data?.type !== "transcribe") return;
    const { id, audio, model } = data;
    try {
      const result = await engine.transcribe(audio, model, {
        onEvent: (event) => self.postMessage({ ...event, id }),
      });
      self.postMessage({ type: "result", id, result });
    } catch (error) {
      self.postMessage({ type: "error", id, message: error.message || "文字起こしに失敗しました。再試行するかColabへ切り替えてください。" });
    }
  });
  self.postMessage({ type: "ready" });
}
