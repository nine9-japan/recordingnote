import { NOTE_CONFIG, NoteApiError, generateNoteWithGemini, isEndpointConfigured } from "./gemini-note.js";
import {
  GROQ_CONFIG,
  GroqApiError,
  isGroqEndpointConfigured,
  resolveAsrMode,
  transcribeWithGroq,
} from "./groq-asr.js";

const HAAS_WORKER_URL = new URL("./haas-worker.js", import.meta.url).href;
const asrMode = resolveAsrMode();
const $ = (id) => document.getElementById(id);
const ui = {
  modelStatus: $("model-status"),
  modelStatusLabel: $("model-status-label"),
  storageWarning: $("storage-warning"),
  recordStart: $("record-start"),
  recordStop: $("record-stop"),
  recordingTime: $("recording-time"),
  recordingLabel: $("recording-label"),
  recordingDot: $("recording-dot"),
  audioFile: $("audio-file"),
  audioMessage: $("audio-message"),
  audioPreview: $("audio-preview"),
  audioPreviewContainer: $("audio-preview-container"),
  audioName: $("audio-name"),
  audioPrivacyNote: $("audio-privacy-note"),
  currentTitle: $("current-title"),
  transcriptionSubtitle: $("transcription-subtitle"),
  groqProviderStatus: $("groq-provider-status"),
  groqSettings: $("groq-settings"),
  groqKey: $("groq-key"),
  groqModel: $("groq-model"),
  transcript: $("transcript"),
  transcriptCount: $("transcript-count"),
  copyTranscript: $("copy-transcript"),
  transcribeStart: $("transcribe-start"),
  transcribeCancel: $("transcribe-cancel"),
  transcribeMessage: $("transcribe-message"),
  transcribeProgress: $("transcribe-progress"),
  haasNotice: $("haas-notice"),
  noteProviderStatus: $("note-provider-status"),
  geminiSettings: $("gemini-settings"),
  geminiKey: $("gemini-key"),
  geminiModel: $("gemini-model"),
  generateNote: $("generate-note"),
  noteCancel: $("note-cancel"),
  noteMessage: $("note-message"),
  noteProgress: $("note-progress"),
  noteEmpty: $("note-empty"),
  noteOutput: $("note-output"),
  copyNote: $("copy-note"),
  downloadNote: $("download-note"),
  historyCount: $("history-count"),
  historyEmpty: $("history-empty"),
  historyList: $("history-list"),
  historyMessage: $("history-message"),
  transcriptionSection: $("transcription-section"),
};

const haasRuntime = { worker: null, workerUnavailable: false, mainEngine: null, nextId: 0 };
const state = {
  history: [],
  historyWritable: true,
  historyTimer: null,
  currentId: null,
  note: "",
  audio: null,
  audioLabel: "",
  audioUrl: null,
  recorder: null,
  stream: null,
  recording: false,
  starting: false,
  stopping: false,
  recordingStarted: 0,
  recordingTimer: null,
  operation: null,
};

class UserError extends Error {}
class CancelledError extends UserError {
  constructor(text = "処理を中止しました。") {
    super(text);
  }
}
class WorkerUnavailableError extends Error {}

function checkCancelled(signal, cancelledMessage = "ブラウザ内の文字起こしを中止しました。これまでの本文とノートは保持しています。") {
  if (signal?.aborted) {
    throw new CancelledError(cancelledMessage);
  }
}

function message(element, text, tone = "neutral") {
  element.textContent = text;
  element.dataset.tone = tone;
}

function setModelStatus(status, label) {
  ui.modelStatus.dataset.state = status;
  ui.modelStatusLabel.textContent = label;
}

function storageWarning(text) {
  ui.storageWarning.textContent = text;
  ui.storageWarning.hidden = false;
}

function readSetting(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    storageWarning("ブラウザの保存機能を利用できません。設定と履歴はこのページを閉じると失われます。ブラウザのサイトデータ設定を確認し、ノートはダウンロードしてください。");
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    storageWarning("設定を保存できませんでした。このページでは入力した値を使えますが、再読み込みすると失われます。");
  }
}

function loadHistory() {
  const raw = readSetting("rn_history", "[]");
  try {
    const records = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error();
    const ids = new Set();
    for (const record of records) {
      if (
        !record ||
        typeof record !== "object" ||
        !["id", "createdAt", "title", "transcript", "note"].every((key) => typeof record[key] === "string") ||
        !record.id ||
        ids.has(record.id) ||
        Number.isNaN(Date.parse(record.createdAt))
      ) {
        throw new Error();
      }
      ids.add(record.id);
    }
    state.history = records.map(({ id, createdAt, title, transcript, note }) => ({
      id,
      createdAt,
      title,
      transcript,
      note,
    }));
  } catch {
    state.historyWritable = false;
    storageWarning("保存された履歴を読み込めません。既存データを守るため上書きを止めています。新しい結果はこのページ内だけに保持するので、ノートをダウンロードしてください。");
  }
}

function persistHistory() {
  clearTimeout(state.historyTimer);
  state.historyTimer = null;
  if (!state.historyWritable) return;
  try {
    localStorage.setItem("rn_history", JSON.stringify(state.history));
  } catch {
    storageWarning("履歴をブラウザに保存できませんでした。結果はこのページ内には残っています。不要な履歴を削除するか、大切なノートはダウンロードしてください。");
  }
}

function currentRecord() {
  return state.history.find((record) => record.id === state.currentId);
}

function formatDate(value) {
  return new Date(value).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function createRecord(transcript, label, note = "") {
  const createdAt = new Date().toISOString();
  const id = globalThis.crypto?.randomUUID?.() || `rn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const record = { id, createdAt, title: `${formatDate(createdAt)} ｜ ${label}`, transcript, note };
  state.history.unshift(record);
  state.currentId = id;
  ui.currentTitle.textContent = record.title;
  return record;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function renderMarkdown(markdown) {
  // Escape the whole source first. Only fixed safe tags are inserted afterwards.
  const lines = escapeHtml(markdown.replace(/\r\n?/g, "\n")).split("\n");
  const output = [];
  let paragraph = [];
  let listItems = [];
  let listTag = "";
  let quoteLines = [];
  let code = [];
  let inCode = false;
  const inline = (text) => text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  function flushParagraph() {
    if (paragraph.length) output.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  }
  function flushList() {
    if (listItems.length) {
      output.push(`<${listTag}>${listItems.map((item) => `<li>${inline(item)}</li>`).join("")}</${listTag}>`);
    }
    listItems = [];
    listTag = "";
  }
  function flushQuote() {
    if (quoteLines.length) output.push(`<blockquote><p>${quoteLines.map(inline).join("<br>")}</p></blockquote>`);
    quoteLines = [];
  }
  function flushBlocks() {
    flushParagraph();
    flushList();
    flushQuote();
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushBlocks();
      if (inCode) {
        output.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
    } else if (inCode) {
      code.push(line);
    } else if (!line.trim()) {
      flushBlocks();
    } else {
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
      const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
      // '>' was escaped to '&gt;' by escapeHtml above.
      const quote = /^\s*&gt;\s?(.*)$/.exec(line);
      if (heading) {
        flushBlocks();
        const level = heading[1].length;
        output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (unordered) {
        flushParagraph();
        flushQuote();
        if (listTag && listTag !== "ul") flushList();
        listTag = "ul";
        listItems.push(unordered[1]);
      } else if (ordered) {
        flushParagraph();
        flushQuote();
        if (listTag && listTag !== "ol") flushList();
        listTag = "ol";
        listItems.push(ordered[1]);
      } else if (quote) {
        flushParagraph();
        flushList();
        quoteLines.push(quote[1]);
      } else {
        flushList();
        flushQuote();
        paragraph.push(line);
      }
    }
  }
  if (inCode) output.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushBlocks();
  return output.join("\n");
}

function showNote(note) {
  state.note = note;
  ui.noteOutput.innerHTML = renderMarkdown(note);
  ui.noteOutput.hidden = !note.trim();
  ui.noteEmpty.hidden = Boolean(note.trim());
  updateControls();
}

function updateNoteDescription() {
  if (isEndpointConfigured(NOTE_CONFIG)) {
    ui.geminiSettings.hidden = true;
    ui.noteProviderStatus.textContent = "ノート生成：Gemini API（接続済み）";
    return;
  }
  if (!NOTE_CONFIG.allowUserApiKey) {
    ui.geminiSettings.hidden = true;
    ui.noteProviderStatus.textContent = "ノート生成：準備中（文字起こしのみ利用できます）";
    return;
  }
  ui.geminiSettings.hidden = false;
  ui.noteProviderStatus.textContent = ui.geminiKey.value.trim()
    ? "ノート生成：Gemini API（キー設定済み・このブラウザから直接通信）"
    : "ノート生成：Gemini APIキー未設定（使う場合は下から設定できます）";
}

function syncGroqIdleStatus() {
  if (asrMode !== "groq") return;
  if (isGroqEndpointConfigured(GROQ_CONFIG)) {
    setModelStatus("connected", "Groq API 接続済み");
    return;
  }
  if (!GROQ_CONFIG.allowUserApiKey) {
    setModelStatus("idle", "Groq API 準備中");
    return;
  }
  const hasKey = Boolean(ui.groqKey.value.trim());
  setModelStatus(hasKey ? "connected" : "idle", hasKey ? "Groq API 準備完了" : "Groq API 未設定");
}

function updateAsrModeUI() {
  if (asrMode === "groq") {
    ui.transcriptionSubtitle.textContent = "Groq API（モバイル向け・高速）";
    ui.audioPrivacyNote.textContent =
      "モバイル環境では文字起こしのため、音声を Groq API（または中継サーバー）へ送信します。音声自体は履歴に保存しません。";
    ui.groqProviderStatus.hidden = false;
    if (isGroqEndpointConfigured(GROQ_CONFIG)) {
      ui.groqSettings.hidden = true;
      ui.groqProviderStatus.textContent = "文字起こし：Groq API（接続済み）";
    } else if (!GROQ_CONFIG.allowUserApiKey) {
      ui.groqSettings.hidden = true;
      ui.groqProviderStatus.textContent = "文字起こし：Groq API 準備中";
    } else {
      ui.groqSettings.hidden = false;
      ui.groqProviderStatus.textContent = ui.groqKey.value.trim()
        ? "文字起こし：Groq API（キー設定済み・モバイル用）"
        : "文字起こし：Groq APIキー未設定（使う場合は下から設定できます）";
    }
    return;
  }

  ui.transcriptionSubtitle.textContent = "ブラウザ内 Haas-ja-v1.0（WebGPU / WASM）";
  ui.audioPrivacyNote.textContent = "音声はこのブラウザの中だけで文字起こしします。外部サーバーへ音声を送信しません。";
  ui.groqProviderStatus.hidden = true;
  ui.groqSettings.hidden = true;
}

function updateControls() {
  const busy = Boolean(state.operation);
  const audioLocked = busy || state.starting || state.recording;
  ui.recordStart.disabled = audioLocked;
  ui.recordStop.disabled = !state.recording || state.stopping;
  ui.audioFile.disabled = audioLocked;
  ui.transcribeStart.disabled = audioLocked || !state.audio;
  ui.generateNote.disabled = audioLocked || !ui.transcript.value.trim();
  ui.transcript.readOnly = busy;
  ui.copyTranscript.disabled = !ui.transcript.value.trim();
  ui.copyNote.disabled = !state.note.trim();
  ui.downloadNote.disabled = !state.note.trim();
  ui.groqKey.disabled = busy;
  ui.groqModel.disabled = busy;
  ui.geminiKey.disabled = busy;
  ui.geminiModel.disabled = busy;

  const transcribing = state.operation?.kind === "transcribe";
  const noting = state.operation?.kind === "note";
  ui.transcribeCancel.hidden = !transcribing;
  ui.noteCancel.hidden = !noting;
  ui.transcribeProgress.hidden = !transcribing;
  ui.noteProgress.hidden = !noting;
  ui.transcribeStart.textContent = transcribing ? "文字起こし中…" : "文字起こし開始 →";
  ui.generateNote.textContent = noting ? "ノート生成中…" : "AIノートを生成 →";
  ui.transcriptCount.textContent = `${ui.transcript.value.length.toLocaleString("ja-JP")}文字`;
  for (const button of ui.historyList.querySelectorAll("button")) button.disabled = audioLocked;
  updateAsrModeUI();
  updateNoteDescription();
}

function userMessage(error, fallback) {
  if (error instanceof UserError || error instanceof NoteApiError || error instanceof GroqApiError) return error.message;
  return fallback;
}

function beginOperation(kind) {
  if (state.operation || state.recording || state.starting) return null;
  if (state.historyTimer !== null) persistHistory();
  const operation = { kind, controller: new AbortController() };
  state.operation = operation;
  updateControls();
  return operation;
}

function endOperation(operation) {
  if (state.operation === operation) state.operation = null;
  updateControls();
}

async function decodeAudioTo16kMono(blob, signal) {
  checkCancelled(signal);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new UserError("このブラウザでは音声をデコードできません。最新版の Chrome / Edge / Safari / Firefox で開いてください。");
  }
  let context;
  try {
    try {
      context = new AudioContextClass({ sampleRate: 16000 });
    } catch {
      context = new AudioContextClass();
    }
    const bytes = await blob.arrayBuffer();
    checkCancelled(signal);
    const decoded = await context.decodeAudioData(bytes);
    checkCancelled(signal);
    if (!decoded.length || !decoded.numberOfChannels) {
      throw new UserError("音声データを読み込めませんでした。別の音声ファイルでお試しください。");
    }
    if (decoded.sampleRate === 16000) {
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / decoded.numberOfChannels;
      }
      return mono;
    }

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) {
      throw new UserError("このブラウザでは音声の16kHz変換に対応していません。最新版のブラウザでお試しください。");
    }
    const targetLength = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineCtx(1, targetLength, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    checkCancelled(signal);
    return new Float32Array(rendered.getChannelData(0));
  } catch (error) {
    if (error instanceof CancelledError || error?.name === "AbortError") {
      throw new CancelledError("ブラウザ内の文字起こしを中止しました。これまでの本文とノートは保持しています。");
    }
    if (error instanceof UserError) throw error;
    throw new UserError("音声ファイルを読み込めませんでした。ブラウザ非対応の形式、ファイルの破損、またはメモリ不足の可能性があります。再生を確認し、WAV・MP3などに変換して再試行してください。");
  } finally {
    if (context) {
      try { await context.close(); } catch { /* Already closed. */ }
    }
  }
}

function discardHaasWorker(worker = haasRuntime.worker) {
  worker?.terminate();
  if (haasRuntime.worker === worker) haasRuntime.worker = null;
}

async function getHaasWorker(signal) {
  checkCancelled(signal);
  if (haasRuntime.workerUnavailable || typeof Worker === "undefined") {
    throw new WorkerUnavailableError();
  }
  if (haasRuntime.worker) return haasRuntime.worker;

  let worker;
  try {
    worker = new Worker(HAAS_WORKER_URL, { type: "module" });
  } catch {
    haasRuntime.workerUnavailable = true;
    throw new WorkerUnavailableError();
  }

  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", ready);
        worker.removeEventListener("error", failed);
        worker.removeEventListener("messageerror", failed);
        signal.removeEventListener("abort", cancelled);
      };
      const ready = ({ data }) => {
        if (data?.type === "ready") {
          cleanup();
          resolve();
        }
      };
      const failed = (event) => {
        event?.preventDefault?.();
        cleanup();
        reject(new WorkerUnavailableError());
      };
      const cancelled = () => {
        cleanup();
        reject(new CancelledError("ブラウザ内の文字起こしを中止しました。"));
      };
      const timer = setTimeout(failed, 10000);
      worker.addEventListener("message", ready);
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", failed);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
    });
    checkCancelled(signal);
    haasRuntime.worker = worker;
    return worker;
  } catch (error) {
    discardHaasWorker(worker);
    if (!(error instanceof CancelledError)) haasRuntime.workerUnavailable = true;
    throw error;
  }
}

async function transcribeInWorker(audio, signal, onEvent) {
  const worker = await getHaasWorker(signal);
  checkCancelled(signal);
  const id = ++haasRuntime.nextId;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", failed);
      worker.removeEventListener("messageerror", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const receive = ({ data }) => {
      if (data?.id !== id) return;
      if (data.type === "result") {
        cleanup();
        resolve(data.result);
      } else if (data.type === "error") {
        cleanup();
        reject(new UserError(data.message));
      } else {
        onEvent(data);
      }
    };
    const failed = (event) => {
      event?.preventDefault?.();
      cleanup();
      discardHaasWorker(worker);
      haasRuntime.workerUnavailable = true;
      reject(new WorkerUnavailableError());
    };
    const cancelled = () => {
      cleanup();
      discardHaasWorker(worker);
      reject(new CancelledError("ブラウザ内の文字起こしを中止しました。これまでの本文とノートは保持しています。"));
    };
    worker.addEventListener("message", receive);
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) {
      cancelled();
      return;
    }
    // Keep the decoded buffer intact so a Worker crash can fall back without re-decoding.
    try {
      worker.postMessage({ type: "transcribe", id, audio });
    } catch {
      failed();
    }
  });
}

async function transcribeWithHaas(blob, signal) {
  const notices = new Set();
  const onEvent = (event) => {
    if (signal.aborted) return;
    if (event.type === "notice") {
      notices.add(event.message);
      message(ui.haasNotice, [...notices].join(" "));
      ui.haasNotice.hidden = false;
    } else if (event.type === "loading") {
      ui.transcribeProgress.removeAttribute("value");
      setModelStatus("checking", "Haas-ja 準備中");
      message(ui.transcribeMessage, event.message, "working");
    } else if (event.type === "download") {
      const loadedMb = (event.loaded / (1024 * 1024)).toFixed(1);
      const totalMb = (event.total / (1024 * 1024)).toFixed(0);
      const percent = Math.min(100, Math.max(0, Number(event.percent) || 0));
      ui.transcribeProgress.max = 100;
      ui.transcribeProgress.value = percent;
      setModelStatus("checking", "Haas-ja モデル取得中");
      message(ui.transcribeMessage, `Haas-ja モデルを準備中：${loadedMb} / ${totalMb} MB（${percent}%）`, "working");
    } else if (event.type === "chunk") {
      const deviceLabel = event.device === "webgpu" ? "WebGPU" : "WASM";
      if (event.total > 1) {
        ui.transcribeProgress.max = 100;
        ui.transcribeProgress.value = Math.round(((event.index - 1) / event.total) * 100);
      } else {
        ui.transcribeProgress.removeAttribute("value");
      }
      setModelStatus("checking", `Haas-ja 推論中（${deviceLabel}）`);
      message(ui.transcribeMessage, `Haas-ja（${deviceLabel}）で文字起こし中：区間 ${event.index} / ${event.total}…`, "working");
    }
  };

  message(ui.haasNotice, "");
  ui.haasNotice.hidden = true;
  setModelStatus("checking", "音声を変換中");
  message(ui.transcribeMessage, "音声をブラウザ内で16kHz・モノラルに変換しています…", "working");

  const audio = await decodeAudioTo16kMono(blob, signal);
  checkCancelled(signal);

  try {
    return await transcribeInWorker(audio, signal, onEvent);
  } catch (error) {
    checkCancelled(signal);
    if (!(error instanceof WorkerUnavailableError)) throw error;
    onEvent({
      type: "notice",
      message: "この環境では Web Worker を利用できないため、メインスレッドで処理します。処理中は画面の反応が遅くなる場合があります。",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    checkCancelled(signal);
    if (!haasRuntime.mainEngine) {
      let mod;
      try {
        mod = await import(HAAS_WORKER_URL);
      } catch {
        throw new UserError("ブラウザ用の文字起こし処理（haas-worker.js）を読み込めません。HTTPSまたはlocalhostで開いているか確認してください。");
      }
      haasRuntime.mainEngine = mod.createHaasASR();
    }
    try {
      return await haasRuntime.mainEngine.transcribe(audio, { signal, onEvent });
    } catch (mainError) {
      if (signal.aborted || mainError?.name === "AbortError") {
        throw new CancelledError("ブラウザ内の文字起こしを中止しました。これまでの本文とノートは保持しています。");
      }
      throw new UserError(mainError?.message || "文字起こしに失敗しました。");
    }
  }
}

async function transcribe() {
  if (!state.audio) {
    message(ui.transcribeMessage, "録音するか、音声ファイルを選んでから開始してください。", "error");
    return;
  }
  const operation = beginOperation("transcribe");
  if (!operation) return;
  const signal = operation.controller.signal;
  const audio = state.audio;
  const label = state.audioLabel;
  ui.transcribeProgress.removeAttribute("value");

  try {
    if (asrMode === "groq") {
      message(ui.haasNotice, "");
      ui.haasNotice.hidden = true;
      const result = await transcribeWithGroq({
        audio,
        apiKey: ui.groqKey.value,
        model: ui.groqModel.value,
        signal,
        decodeAudioTo16kMono,
        onProgress: ({ phase, index, total }) => {
          if (signal.aborted) return;
          if (phase === "splitting") {
            ui.transcribeProgress.removeAttribute("value");
            setModelStatus("checking", "音声を分割中");
            message(ui.transcribeMessage, "20 MB を超える音声を Groq 送信用に分割しています…", "working");
          } else if (phase === "uploading") {
            if (total > 1) {
              ui.transcribeProgress.max = 100;
              ui.transcribeProgress.value = Math.round(((index - 1) / total) * 100);
              message(ui.transcribeMessage, `Groq API で文字起こし中：区間 ${index} / ${total}…`, "working");
            } else {
              ui.transcribeProgress.removeAttribute("value");
              message(ui.transcribeMessage, "Groq API へ音声を送り、文字起こししています…", "working");
            }
            setModelStatus("checking", "Groq API 処理中");
          }
        },
      });
      if (signal.aborted) throw new CancelledError("文字起こしを中止しました。これまでの本文とノートは保持しています。");
      const transcript = result?.text || "";
      if (!transcript.trim()) {
        throw new UserError("処理は完了しましたが発話が検出されませんでした。音声が入っているか再生して確かめ、再実行してください。");
      }
      setModelStatus("connected", "Groq API 完了");
      ui.transcribeProgress.max = 100;
      ui.transcribeProgress.value = 100;
      ui.transcript.value = transcript;
      createRecord(transcript, label);
      showNote("");
      persistHistory();
      renderHistory();
      message(ui.transcribeMessage, "Groq API で文字起こしが完了しました。履歴に追加しました。", "success");
      message(ui.noteMessage, "文字起こしを確認したら「AIノートを生成」を押すか、本文をコピーできます。");
      return;
    }

    const result = await transcribeWithHaas(audio, signal);
    checkCancelled(signal);
    const transcript = result?.text || "";
    if (!transcript.trim()) {
      throw new UserError("処理は完了しましたが発話が検出されませんでした。音声が入っているか再生して確かめ、再実行してください。");
    }
    const deviceLabel = result.device === "webgpu" ? "WebGPU" : "WASM";
    setModelStatus("connected", `Haas-ja 準備完了（${deviceLabel}）`);
    ui.transcribeProgress.max = 100;
    ui.transcribeProgress.value = 100;
    ui.transcript.value = transcript;
    createRecord(transcript, label);
    showNote("");
    persistHistory();
    renderHistory();
    message(ui.transcribeMessage, `Haas-ja（${deviceLabel}）で文字起こしが完了しました。履歴に追加しました。`, "success");
    message(ui.noteMessage, "文字起こしを確認したら「AIノートを生成」を押すか、本文をコピーできます。");
  } catch (error) {
    if (error?.name === "AbortError" || error instanceof CancelledError) {
      if (asrMode === "groq") syncGroqIdleStatus();
      else setModelStatus("idle", "Haas-ja 待機中");
      message(
        ui.transcribeMessage,
        error instanceof CancelledError ? error.message : "文字起こしを中止しました。これまでの本文とノートは保持しています。",
        "neutral",
      );
    } else {
      if (error instanceof GroqApiError && error.code === "missing_key" && !ui.groqSettings.hidden) {
        ui.groqSettings.open = true;
        ui.groqKey.focus({ preventScroll: false });
        syncGroqIdleStatus();
      } else {
        setModelStatus("error", asrMode === "groq" ? "Groq API エラー" : "Haas-ja エラー");
      }
      message(ui.transcribeMessage, userMessage(error, "文字起こしを完了できませんでした。通信状態と音声を確認して再実行してください。"), "error");
    }
  } finally {
    endOperation(operation);
  }
}

async function generateNote() {
  const transcript = ui.transcript.value;
  if (!transcript.trim()) {
    message(ui.noteMessage, "文字起こしの本文を用意してからノートを生成してください。", "error");
    return;
  }
  const operation = beginOperation("note");
  if (!operation) return;
  ui.noteProgress.removeAttribute("value");

  try {
    const title = currentRecord()?.title || `${formatDate(new Date())} ｜ テキスト入力`;
    message(ui.noteMessage, "Geminiに文字起こし全文を送り、ノートを生成しています…", "working");
    const note = await generateNoteWithGemini({
      transcript,
      title,
      apiKey: ui.geminiKey.value,
      model: ui.geminiModel.value,
      signal: operation.controller.signal,
    });
    const record = currentRecord() || createRecord(transcript, "テキスト入力");
    record.transcript = transcript;
    record.note = note;
    showNote(note);
    persistHistory();
    renderHistory();
    message(ui.noteMessage, "Geminiでノートを生成しました。履歴に反映しました。コピーやダウンロードで保存できます。", "success");
  } catch (error) {
    if (error?.name === "AbortError" || error instanceof CancelledError) {
      message(
        ui.noteMessage,
        "待機を中止しました。Gemini側の処理が継続し、利用枠が消費される場合があります。再実行前にGoogle側の利用状況を確認してください。",
        "neutral",
      );
    } else {
      if (error instanceof NoteApiError && error.code === "missing_key" && !ui.geminiSettings.hidden) {
        ui.geminiSettings.open = true;
        ui.geminiKey.focus({ preventScroll: false });
      }
      message(ui.noteMessage, userMessage(error, "ノートを生成できませんでした。設定を確認して再実行してください。"), "error");
    }
  } finally {
    endOperation(operation);
  }
}

function clearAudio(resetFile = true) {
  ui.audioPreview.pause();
  ui.audioPreview.removeAttribute("src");
  ui.audioPreview.load();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audio = null;
  state.audioLabel = "";
  state.audioUrl = null;
  if (resetFile) ui.audioFile.value = "";
  ui.audioPreviewContainer.hidden = true;
  ui.audioName.textContent = "";
}

function setAudio(file, label) {
  clearAudio(label === "ブラウザ録音");
  state.audio = file;
  state.audioLabel = label;
  state.audioUrl = URL.createObjectURL(file);
  ui.audioPreview.src = state.audioUrl;
  ui.audioPreviewContainer.hidden = false;
  const size = file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
  ui.audioName.textContent = `${label} · ${size}`;
  message(ui.audioMessage, "音声を用意しました。再生して確認したら「文字起こし開始」を押してください。", "success");
  message(
    ui.transcribeMessage,
    `用意した音声を ${asrMode === "groq" ? "Groq API" : "このブラウザ内の Haas-ja"} で文字起こしできます。`,
  );
  updateControls();
}

function stopTracks() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function updateRecordingTime() {
  const total = Math.floor((Date.now() - state.recordingStarted) / 1000);
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, "0");
  ui.recordingTime.textContent =
    total >= 3600 ? `${String(Math.floor(total / 3600)).padStart(2, "0")}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

function finishRecordingState() {
  clearInterval(state.recordingTimer);
  state.recordingTimer = null;
  state.recording = false;
  state.starting = false;
  state.stopping = false;
  state.recorder = null;
  stopTracks();
  ui.recordingDot.classList.remove("active");
  ui.recordingLabel.textContent = "録音待機中";
  updateControls();
}

async function startRecording() {
  if (state.recording || state.starting || state.operation) return;
  if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    message(ui.audioMessage, "この環境ではブラウザ録音を使えません。HTTPSまたはlocalhostで最新版のブラウザから開くか、音声ファイルを選択してください。", "error");
    return;
  }
  state.starting = true;
  updateControls();
  message(ui.audioMessage, "マイクの使用許可を待っています。ブラウザの確認画面で許可してください。", "working");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
    const mimeType = preferred.find((type) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(type));
    const recorder = mimeType ? new MediaRecorder(state.stream, { mimeType }) : new MediaRecorder(state.stream);
    const chunks = [];
    let recordingError = false;
    state.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      recordingError = true;
      message(ui.audioMessage, "録音中に問題が起きました。停止後に再生で内容を確認し、必要なら録り直してください。", "error");
      if (recorder.state !== "inactive") stopRecording();
    });
    recorder.addEventListener(
      "stop",
      () => {
        const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
        finishRecordingState();
        try {
          const blob = new Blob(chunks, { type });
          if (!blob.size) {
            message(ui.audioMessage, "音声を取得できませんでした。マイクの入力とブラウザの使用許可を確認して、録り直してください。", "error");
            return;
          }
          const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
          setAudio(new File([blob], `recording-${Date.now()}.${extension}`, { type }), "ブラウザ録音");
          if (recordingError) {
            message(ui.audioMessage, "録音に問題があったため、一部だけ保存された可能性があります。再生で確認してから文字起こししてください。", "error");
          }
        } catch {
          message(ui.audioMessage, "録音のプレビューを作れませんでした。端末の空き容量を確認し、録り直すか音声ファイルを選択してください。", "error");
        }
      },
      { once: true },
    );
    recorder.start(1000);
    clearAudio();
    state.starting = false;
    state.recording = true;
    state.recordingStarted = Date.now();
    updateRecordingTime();
    state.recordingTimer = setInterval(updateRecordingTime, 1000);
    ui.recordingDot.classList.add("active");
    ui.recordingLabel.textContent = "録音中";
    message(ui.audioMessage, "録音中です。終わったら「停止」を押してください。録音中はこのページを開いたままにしてください。", "working");
    for (const track of state.stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (state.recording) stopRecording();
      }, { once: true });
    }
  } catch (error) {
    finishRecordingState();
    const text =
      error?.name === "NotAllowedError" || error?.name === "SecurityError"
        ? "マイクの使用が許可されていません。ブラウザのサイト設定でマイクを許可して再試行するか、音声ファイルを選んでください。"
        : error?.name === "NotFoundError"
          ? "マイクが見つかりません。端末にマイクを接続するか、音声ファイルを選択してください。"
          : "録音を開始できませんでした。ほかのアプリのマイク使用とブラウザの設定を確認し、再試行するか音声ファイルを選んでください。";
    message(ui.audioMessage, text, "error");
  } finally {
    state.starting = false;
    updateControls();
  }
}

function stopRecording() {
  if (!state.recorder || state.recorder.state === "inactive" || state.stopping) return;
  state.stopping = true;
  ui.recordingLabel.textContent = "録音を保存中";
  updateControls();
  try {
    state.recorder.stop();
  } catch {
    finishRecordingState();
    message(ui.audioMessage, "録音を停止できませんでした。ブラウザを更新し、録音し直すか音声ファイルを選択してください。", "error");
  }
}

function renderHistory() {
  ui.historyList.replaceChildren();
  ui.historyCount.textContent = `${state.history.length}件`;
  ui.historyEmpty.hidden = state.history.length > 0;
  for (const record of state.history) {
    const li = document.createElement("li");
    if (record.id === state.currentId) li.classList.add("selected");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    open.setAttribute("aria-pressed", String(record.id === state.currentId));
    open.setAttribute("aria-label", `${record.title}を開く`);
    const icon = document.createElement("span");
    icon.className = "history-item-icon";
    icon.textContent = "≡";
    icon.setAttribute("aria-hidden", "true");
    const details = document.createElement("span");
    details.className = "history-item-details";
    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = record.title;
    const meta = document.createElement("span");
    meta.className = "history-item-meta";
    meta.textContent = `${formatDate(record.createdAt)} · ${record.transcript.length.toLocaleString("ja-JP")}文字 · ${record.note ? "ノート作成済み" : "文字起こし"} · 開く`;
    details.append(title, meta);
    open.append(icon, details);
    open.addEventListener("click", () => openHistory(record.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button secondary small history-delete";
    remove.textContent = "削除";
    remove.setAttribute("aria-label", `${record.title}を削除`);
    remove.addEventListener("click", () => deleteHistory(record.id));
    li.append(open, remove);
    ui.historyList.append(li);
  }
  updateControls();
}

function openHistory(id) {
  if (state.operation || state.recording || state.starting) return;
  if (state.historyTimer !== null) persistHistory();
  const record = state.history.find((item) => item.id === id);
  if (!record) return;
  state.currentId = id;
  clearAudio();
  ui.currentTitle.textContent = record.title;
  ui.transcript.value = record.transcript;
  showNote(record.note);
  message(ui.audioMessage, "履歴を開きました。音声自体は保存していません。新しく文字起こしするには、録音またはファイル選択をしてください。");
  message(ui.transcribeMessage, "履歴の文字起こしを復元しました。編集内容は自動保存されます。", "success");
  message(
    ui.noteMessage,
    record.note ? "履歴のノートを復元しました。コピー・ダウンロードできます。" : "この文字起こしからAIノートを生成できます。",
    record.note ? "success" : "neutral",
  );
  message(ui.historyMessage, "履歴を開きました。文字起こしとノートを復元しています。", "success");
  renderHistory();
  ui.transcriptionSection.scrollIntoView({
    behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
  ui.transcript.focus({ preventScroll: true });
}

function deleteHistory(id) {
  if (state.operation || state.recording || state.starting) return;
  if (state.historyTimer !== null) persistHistory();
  state.history = state.history.filter((record) => record.id !== id);
  if (state.currentId === id) {
    state.currentId = null;
    ui.currentTitle.textContent = "新しいノート";
    ui.transcript.value = "";
    showNote("");
    message(ui.transcribeMessage, state.audio ? "用意した音声で文字起こしを開始できます。" : "音声を用意してから開始してください。");
    message(ui.noteMessage, "先に文字起こしを用意してください。");
  }
  persistHistory();
  renderHistory();
  message(ui.historyMessage, "このブラウザの履歴から削除しました。", "success");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Fall back to execCommand below. */
    }
  }
  const previousFocus = document.activeElement;
  const temporary = document.createElement("textarea");
  temporary.value = text;
  temporary.readOnly = true;
  temporary.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none;";
  document.body.append(temporary);
  try {
    temporary.select();
    if (!document.execCommand?.("copy")) throw new Error();
  } finally {
    temporary.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}

async function copyTranscript() {
  const text = ui.transcript.value;
  if (!text.trim()) return;
  try {
    await copyTextToClipboard(text);
    message(ui.transcribeMessage, "文字起こしの本文をコピーしました。", "success");
  } catch {
    message(ui.transcribeMessage, "コピーできませんでした。テキスト欄から直接選択してコピーしてください。", "error");
  }
}

async function copyNote() {
  if (!state.note.trim()) return;
  try {
    await copyTextToClipboard(state.note);
    message(ui.noteMessage, "Markdownをコピーしました。お好きなメモアプリに貼り付けられます。", "success");
  } catch {
    message(ui.noteMessage, "コピーできませんでした。ブラウザのクリップボード許可を確認するか、「.mdでダウンロード」を使ってください。", "error");
  }
}

function downloadNote() {
  if (!state.note.trim()) return;
  let url;
  try {
    const fileName = (currentRecord()?.title || "RecordingNote").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 110);
    url = URL.createObjectURL(new Blob([state.note], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    message(ui.noteMessage, "Markdownのダウンロードを開始しました。ブラウザのダウンロード一覧で確認してください。", "success");
  } catch {
    message(ui.noteMessage, "ダウンロードを開始できませんでした。ブラウザの保存設定を確認するか、「Markdownをコピー」を使ってください。", "error");
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Clean up obsolete client-side settings from earlier versions while preserving history and API keys.
for (const key of ["rn_backend_url", "rn_backend_key", "rn_asr_engine", "rn_browser_asr_model"]) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Storage may be unavailable. */
  }
}

ui.groqKey.value = readSetting("rn_groq_key", "");
ui.groqModel.value = readSetting("rn_groq_model", GROQ_CONFIG.defaultModel) || GROQ_CONFIG.defaultModel;
ui.groqKey.addEventListener("input", () => {
  saveSetting("rn_groq_key", ui.groqKey.value.trim());
  updateAsrModeUI();
  if (!state.operation) syncGroqIdleStatus();
});
ui.groqModel.addEventListener("input", () => {
  saveSetting("rn_groq_model", ui.groqModel.value.trim() || GROQ_CONFIG.defaultModel);
});

ui.geminiKey.value = readSetting("rn_gemini_key", "");
ui.geminiModel.value = readSetting("rn_gemini_model", NOTE_CONFIG.defaultModel) || NOTE_CONFIG.defaultModel;
ui.geminiKey.addEventListener("input", () => {
  saveSetting("rn_gemini_key", ui.geminiKey.value.trim());
  updateNoteDescription();
});
ui.geminiModel.addEventListener("input", () => {
  saveSetting("rn_gemini_model", ui.geminiModel.value.trim() || NOTE_CONFIG.defaultModel);
});

ui.recordStart.addEventListener("click", startRecording);
ui.recordStop.addEventListener("click", stopRecording);
ui.audioFile.addEventListener("change", () => {
  if (state.operation || state.recording || state.starting) return;
  const file = ui.audioFile.files?.[0];
  if (!file) return;
  if (!file.size) {
    message(ui.audioMessage, "選択したファイルが空です。音声の入ったファイルを選び直してください。", "error");
    return;
  }
  try {
    setAudio(file, file.name);
  } catch {
    message(ui.audioMessage, "音声ファイルを読み込めませんでした。別のファイルを選び、ブラウザのファイル使用許可を確認してください。", "error");
    updateControls();
  }
});
ui.transcribeStart.addEventListener("click", transcribe);
ui.copyTranscript.addEventListener("click", copyTranscript);
ui.generateNote.addEventListener("click", generateNote);
for (const button of [ui.transcribeCancel, ui.noteCancel]) {
  button.addEventListener("click", () => state.operation?.controller.abort());
}
ui.copyNote.addEventListener("click", copyNote);
ui.downloadNote.addEventListener("click", downloadNote);
ui.transcript.addEventListener("input", () => {
  if (state.operation) return;
  const record = currentRecord();
  if (record) {
    record.transcript = ui.transcript.value;
    clearTimeout(state.historyTimer);
    state.historyTimer = setTimeout(() => {
      persistHistory();
      renderHistory();
    }, 400);
  }
  message(
    ui.noteMessage,
    state.note
      ? "文字起こしを編集しました。変更をノートへ反映するには、もう一度生成してください。"
      : ui.transcript.value.trim()
        ? "この本文からAIノートを生成できます。"
        : "先に文字起こしを用意してください。",
  );
  updateControls();
});

window.addEventListener("beforeunload", (event) => {
  if (state.historyTimer !== null) persistHistory();
  if (state.recording || state.starting || state.operation) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", (event) => {
  if (state.historyTimer !== null) persistHistory();
  if (!event.persisted) {
    state.operation?.controller.abort();
    discardHaasWorker();
    void haasRuntime.mainEngine?.dispose?.();
    stopTracks();
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  }
});

loadHistory();
if (asrMode === "groq") {
  syncGroqIdleStatus();
} else {
  setModelStatus("idle", "Haas-ja 待機中");
}
renderHistory();
