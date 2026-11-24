// Mobile Groq Audio Transcriptions API client for RecordingNote.
//
// Later, when deploying a backend proxy (e.g. Cloudflare Workers holding GROQ_API_KEY),
// set GROQ_CONFIG.endpoint to its URL. The UI will automatically hide the Groq API key form.

export const GROQ_CONFIG = {
  // 例: "https://recordingnote-notes.example.workers.dev/transcribe"
  // インターフェース: POST multipart/form-data (file, model, language, response_format, prompt?) -> JSON { text: "..." }
  endpoint: "",
  defaultModel: "whisper-large-v3-turbo",
  language: "ja",
  // Groq 無料枠上限（25 MB）を安全に下回る自動分割の閾値
  maxUploadBytes: 20 * 1024 * 1024,
  // 自動分割時の 1 区間あたりの秒数（8 分 × 16kHz モノラル PCM16 = 約 15.4 MB）
  chunkSeconds: 480,
  // endpoint 未設定時に、利用者自身の Groq API キー入力欄を表示するか
  allowUserApiKey: true,
};

export const GROQ_DIRECT_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

export class GroqApiError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.code = code;
  }
}

export function isGroqEndpointConfigured(config = GROQ_CONFIG) {
  return Boolean(String(config?.endpoint || "").trim());
}

export function isMobileDevice(nav = globalThis.navigator) {
  if (!nav) return false;
  if (nav.userAgentData?.mobile === true) return true;
  if (/Android|iPhone|iPod|iPad|Mobile/i.test(nav.userAgent || "")) return true;
  // iPadOS Safari reports MacIntel platform with multi-touch support.
  if (nav.platform === "MacIntel" && (nav.maxTouchPoints || 0) > 1) return true;
  return false;
}

export function resolveAsrMode({ search = globalThis.location?.search || "", nav = globalThis.navigator } = {}) {
  const override = new URLSearchParams(search).get("asr")?.trim().toLowerCase();
  if (override === "groq" || override === "haas") return override;
  return isMobileDevice(nav) ? "groq" : "haas";
}

export function encodeWav16kMono(samples, sampleRate = 16000) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const pcm = Math.max(-32768, Math.min(32767, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767)));
    view.setInt16(44 + i * 2, pcm, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function fileNameWithExtension(audio) {
  const name = typeof audio?.name === "string" ? audio.name.trim() : "";
  if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const base = name || "recording";
  const type = String(audio?.type || "").toLowerCase();
  const ext = type.includes("mp4") || type.includes("m4a")
    ? ".m4a"
    : type.includes("mpeg") || type.includes("mp3")
      ? ".mp3"
      : type.includes("wav")
        ? ".wav"
        : type.includes("ogg")
          ? ".ogg"
          : type.includes("flac")
            ? ".flac"
            : type.includes("aac")
              ? ".aac"
              : ".webm";
  return `${base}${ext}`;
}

function groqHttpMessage(status, proxyDetail = "") {
  if (status === 400) {
    return "Groqへのリクエストが受け付けられませんでした。音声形式（M4A / MP3 / WAV / WebM など）やモデル名を確認してください。";
  }
  if (status === 401 || status === 403) {
    return "Groqのリクエストが拒否されました。APIキーの有効性・利用権限を確認してください。";
  }
  if (status === 413) {
    return "音声ファイルが上限（25 MB）を超えています。短く分けて再実行してください。";
  }
  if (status === 429) {
    return "Groqの利用上限（レート制限）に達しました。少し時間を置いて再実行してください。";
  }
  if (proxyDetail) return proxyDetail;
  return `Groqでエラーが発生しました（HTTP ${status}）。時間を置いて再実行してください。`;
}

export async function transcribeWithGroq({
  audio,
  apiKey = "",
  model = "",
  signal,
  onProgress = () => {},
  decodeAudioTo16kMono = null,
  config = GROQ_CONFIG,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!audio || !audio.size) {
    throw new GroqApiError("録音するか、音声ファイルを選んでから開始してください。", "empty_audio");
  }

  const proxyMode = isGroqEndpointConfigured(config);
  const endpoint = proxyMode ? String(config.endpoint).trim() : GROQ_DIRECT_ENDPOINT;
  const resolvedModel = String(model || config.defaultModel || "whisper-large-v3-turbo").trim() || "whisper-large-v3-turbo";
  const trimmedKey = String(apiKey || "").trim();

  if (!proxyMode) {
    if (!trimmedKey) {
      throw new GroqApiError(
        "Groq APIキーが未設定です。「Groq APIキーを設定（モバイル用）」からキーを入力して実行してください。",
        "missing_key",
      );
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resolvedModel)) {
      throw new GroqApiError(
        "Groqのモデル名の形式が正しくありません。whisper-large-v3-turbo のようにモデル名だけを入力してください。",
        "invalid_model",
      );
    }
  }

  const redact = (value) => (trimmedKey ? value.replaceAll(trimmedKey, "[APIキー]") : value);

  async function sendOneChunk(blob, filename, promptText = "") {
    if (signal?.aborted) {
      throw new DOMException("文字起こしを中止しました。", "AbortError");
    }

    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", resolvedModel);
    form.append("language", config.language || "ja");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (promptText) form.append("prompt", promptText);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 180000);

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: proxyMode ? undefined : { Authorization: `Bearer ${trimmedKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) {
        throw new DOMException("文字起こしを中止しました。", "AbortError");
      }
      if (timedOut) {
        throw new GroqApiError("Groqからの応答が時間内に届きませんでした。時間を置いて再実行してください。", "timeout");
      }
      throw new GroqApiError("Groqへ接続できませんでした。インターネット接続を確認して再実行してください。", "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw new GroqApiError(groqHttpMessage(response.status), `http_${response.status}`);
      }
      throw new GroqApiError("Groqの応答を読み取れませんでした。時間を置いて再実行してください。", "invalid_json");
    }

    if (!response.ok) {
      const proxyDetail = proxyMode
        ? redact(
            typeof data?.detail === "string" && data.detail.trim()
              ? data.detail.trim()
              : typeof data?.error?.message === "string" && data.error.message.trim()
                ? data.error.message.trim()
                : "",
          )
        : "";
      throw new GroqApiError(groqHttpMessage(response.status, proxyDetail), `http_${response.status}`);
    }

    const rawText = typeof data?.text === "string"
      ? data.text
      : typeof data?.transcript === "string"
        ? data.transcript
        : "";
    return redact(rawText).trim();
  }

  const maxBytes = Number(config.maxUploadBytes) || 20 * 1024 * 1024;
  if (audio.size <= maxBytes) {
    onProgress({ phase: "uploading", index: 1, total: 1 });
    const text = await sendOneChunk(audio, fileNameWithExtension(audio));
    return { text, device: "groq", chunks: 1 };
  }

  if (typeof decodeAudioTo16kMono !== "function") {
    throw new GroqApiError("音声ファイルが 20 MB を超えています。短く分けて送信してください。", "file_too_large");
  }

  onProgress({ phase: "splitting", index: 0, total: 0 });
  let samples;
  try {
    samples = await decodeAudioTo16kMono(audio, signal);
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("文字起こしを中止しました。", "AbortError");
    }
    throw new GroqApiError(
      "音声ファイルが 20 MB を超えており、この端末のメモリでは自動分割できませんでした。20 MB 以下に分けてお試しください。",
      "split_failed",
    );
  }

  const chunkSamples = Math.max(16000, Math.round((config.chunkSeconds || 480) * 16000));
  const total = Math.max(1, Math.ceil(samples.length / chunkSamples));
  const parts = [];

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) {
      throw new DOMException("文字起こしを中止しました。", "AbortError");
    }
    onProgress({ phase: "uploading", index: i + 1, total });
    const start = i * chunkSamples;
    const end = Math.min(samples.length, start + chunkSamples);
    const wavBlob = encodeWav16kMono(samples.subarray(start, end), 16000);
    const prevText = parts.join("");
    const promptText = prevText ? prevText.slice(-150) : "";
    const chunkText = await sendOneChunk(wavBlob, `chunk-${i + 1}.wav`, promptText);
    if (chunkText) parts.push(chunkText);
  }

  return { text: parts.join(""), device: "groq", chunks: total };
}
