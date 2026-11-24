// Gemini API note generation for RecordingNote.
//
// Later, when deploying a backend proxy (e.g. Cloudflare Workers holding GEMINI_API_KEY),
// set NOTE_CONFIG.endpoint to its URL. The UI will automatically hide the user API key form.

export const NOTE_CONFIG = {
  // 例: "https://recordingnote-notes.example.workers.dev/notes"
  // インターフェース: POST JSON { transcript, title, prompt, model } -> JSON { note: "Markdown" }
  endpoint: "",
  defaultModel: "gemini-2.5-flash",
  allowUserApiKey: true,
};

export const NOTE_PROMPT =
  "あなたは大学講義の学習ノート作成者です。以下は講義の文字起こしです。" +
  "この内容だけを使って、日本語で学習ノートを作成してください。" +
  "ルール: 文字起こしに書かれていない事実・用語・年号を絶対に足さない／" +
  "見出しで階層化し要点は箇条書き／年号・人名・地名・専門用語は文字起こしの表記をそのまま使う／" +
  "講義の流れに沿って構成する／冒頭にタイトル行を付ける／" +
  "末尾に「重要語句」リストと「復習ポイント」を付ける。出力はMarkdownのみ。" +
  "文字起こしは句読点のない音声認識結果なので、読み取りにくい箇所は無理に補わず趣旨が取れる範囲で整理すること。";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
const OUTER_FENCE_RE = /^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i;

export class NoteApiError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.code = code;
  }
}

export function buildNotePrompt(transcript) {
  return `${NOTE_PROMPT}\n\n文字起こし:\n${transcript}`;
}

export function isEndpointConfigured(config = NOTE_CONFIG) {
  return Boolean((config?.endpoint || "").trim());
}

function stripOuterFence(markdown) {
  const trimmed = String(markdown || "").trim();
  const matched = OUTER_FENCE_RE.exec(trimmed);
  return matched ? matched[1].trim() : trimmed;
}

function geminiHttpMessage(status) {
  if (status === 400 || status === 401 || status === 403) {
    return "Geminiのリクエストが拒否されました。APIキーの有効性・利用権限・モデル名を確認してください。";
  }
  if (status === 404) {
    return "指定したGeminiモデルが見つかりません。モデル名を確認してください。";
  }
  if (status === 429) {
    return "Geminiの利用上限に達しました。Google側の利用枠を確認し、時間を置いて再実行してください。";
  }
  return `Geminiでエラーが発生しました（HTTP ${status}）。時間を置いて再実行してください。`;
}

async function fetchJsonWithTimeout(url, options, { signal, fetchImpl, timeoutMs = 180000 }) {
  if (signal?.aborted) {
    throw new DOMException("ノート生成を中止しました。", "AbortError");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException("ノート生成を中止しました。", "AbortError");
    }
    if (timedOut) {
      throw new NoteApiError("Geminiからの応答が時間内に届きませんでした。時間を置いて再実行してください。", "timeout");
    }
    throw new NoteApiError("Geminiへ接続できませんでした。インターネット接続を確認して再実行してください。", "network");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) {
      throw new NoteApiError(geminiHttpMessage(response.status), `http_${response.status}`);
    }
    throw new NoteApiError("Geminiの応答を読み取れませんでした。時間を置いて再実行してください。", "invalid_json");
  }

  return { ok: response.ok, status: response.status, data };
}

export async function generateNoteWithGemini({
  transcript,
  title = "",
  apiKey = "",
  model = "",
  signal,
  config = NOTE_CONFIG,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!String(transcript || "").trim()) {
    throw new NoteApiError("文字起こしの本文を用意してからノートを生成してください。", "empty_transcript");
  }

  const resolvedModel = String(model || config.defaultModel || "gemini-2.5-flash").trim() || "gemini-2.5-flash";
  const endpoint = String(config.endpoint || "").trim();

  if (endpoint) {
    const { ok, status, data } = await fetchJsonWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          title,
          prompt: buildNotePrompt(transcript),
          model: resolvedModel,
        }),
      },
      { signal, fetchImpl },
    );

    if (!ok) {
      const detail = typeof data?.detail === "string" && data.detail.trim()
        ? data.detail.trim()
        : geminiHttpMessage(status);
      throw new NoteApiError(detail, `http_${status}`);
    }
    const note = stripOuterFence(data?.note);
    if (!note) {
      throw new NoteApiError("ノート生成は完了しましたが本文が空でした。もう一度実行してください。", "empty_note");
    }
    return note;
  }

  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedKey) {
    throw new NoteApiError(
      "Gemini APIキーが未設定です。「Gemini APIキーを設定（任意）」からキーを入力して実行してください。",
      "missing_key",
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resolvedModel)) {
    throw new NoteApiError(
      "Geminiのモデル名の形式が正しくありません。gemini-2.5-flash のようにモデル名だけを入力してください。",
      "invalid_model",
    );
  }

  const safeTranscript = transcript.replaceAll(trimmedKey, "[APIキー]");
  const url = GEMINI_ENDPOINT.replace("{model}", encodeURIComponent(resolvedModel));
  const { ok, status, data } = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": trimmedKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildNotePrompt(safeTranscript) }] }],
      }),
    },
    { signal, fetchImpl },
  );

  if (!ok) {
    throw new NoteApiError(geminiHttpMessage(status), `http_${status}`);
  }
  if (data?.promptFeedback?.blockReason) {
    throw new NoteApiError(
      "Geminiが入力を制限したため、ノートを生成できませんでした。文字起こしの内容を確認してください。",
      "blocked",
    );
  }
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new NoteApiError(
      "Geminiの出力が途中終了したため、ノートを保存しませんでした。モデルの入力・出力上限を確認して再実行してください。",
      "incomplete",
    );
  }

  const parts = candidate?.content?.parts;
  const rawNote = Array.isArray(parts)
    ? parts
        .filter((part) => part && typeof part === "object" && !part.thought && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
    : "";
  const note = stripOuterFence(rawNote).replaceAll(trimmedKey, "[APIキー]").trim();
  if (!note) {
    throw new NoteApiError(
      "Geminiからノート本文が返りませんでした。入力内容とGoogle側の利用状況を確認して再実行してください。",
      "empty_note",
    );
  }
  return note;
}
