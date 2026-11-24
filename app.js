(() => {
  "use strict";

  const POLL_INTERVAL = 3000;
  const api = (path) => new URL(path, document.baseURI).href;
  const $ = (id) => document.getElementById(id);
  const ui = {
    serverBanner: $("server-banner"),
    testConnection: $("test-connection"), connectionStatus: $("connection-status"),
    connectionLabel: $("connection-label"), connectionMessage: $("connection-message"),
    storageWarning: $("storage-warning"),
    recordStart: $("record-start"), recordStop: $("record-stop"),
    recordingTime: $("recording-time"), recordingLabel: $("recording-label"),
    recordingDot: $("recording-dot"), audioFile: $("audio-file"),
    audioMessage: $("audio-message"), audioPreview: $("audio-preview"),
    audioPreviewContainer: $("audio-preview-container"), audioName: $("audio-name"),
    currentTitle: $("current-title"), transcript: $("transcript"),
    transcriptCount: $("transcript-count"), transcribeStart: $("transcribe-start"),
    transcribeCancel: $("transcribe-cancel"), transcribeMessage: $("transcribe-message"),
    transcribeProgress: $("transcribe-progress"),
    noteProviderStatus: $("note-provider-status"),
    generateNote: $("generate-note"), noteCancel: $("note-cancel"),
    noteMessage: $("note-message"), noteProgress: $("note-progress"),
    noteEmpty: $("note-empty"), noteOutput: $("note-output"),
    copyNote: $("copy-note"), downloadNote: $("download-note"),
    historyCount: $("history-count"), historyEmpty: $("history-empty"),
    historyList: $("history-list"), historyMessage: $("history-message"),
    transcriptionSection: $("transcription-section"),
  };
  const state = {
    history: [], historyWritable: true, historyTimer: null, currentId: null,
    note: "", audio: null, audioLabel: "", audioUrl: null,
    recorder: null, stream: null, recording: false, starting: false, stopping: false,
    recordingStarted: 0, recordingTimer: null, checking: false, operation: null,
    notesReady: false, healthTimer: null, modelReady: false, engineLabel: "Haas-ja-v1.0",
  };

  class UserError extends Error {}
  class CancelledError extends UserError {
    constructor(text = "待機を中止しました。ローカルサーバー側の処理は継続する場合があります。") {
      super(text);
    }
  }

  function message(element, text, tone = "neutral") {
    element.textContent = text;
    element.dataset.tone = tone;
  }

  function storageWarning(text) {
    ui.storageWarning.textContent = text;
    ui.storageWarning.hidden = false;
  }

  function readSetting(key, fallback = "") {
    try { return localStorage.getItem(key) ?? fallback; }
    catch {
      storageWarning("ブラウザの保存機能を利用できません。履歴はこのページを閉じると失われます。ブラウザのサイトデータ設定を確認し、ノートはダウンロードしてください。");
      return fallback;
    }
  }

  function loadHistory() {
    const raw = readSetting("rn_history", "[]");
    try {
      const records = JSON.parse(raw);
      if (!Array.isArray(records)) throw new Error();
      const ids = new Set();
      for (const record of records) {
        if (!record || typeof record !== "object"
          || !["id", "createdAt", "title", "transcript", "note"].every((key) => typeof record[key] === "string")
          || !record.id || ids.has(record.id) || Number.isNaN(Date.parse(record.createdAt))) throw new Error();
        ids.add(record.id);
      }
      state.history = records.map(({ id, createdAt, title, transcript, note }) => ({ id, createdAt, title, transcript, note }));
    } catch {
      state.historyWritable = false;
      storageWarning("保存された履歴を読み込めません。既存データを守るため上書きを止めています。新しい結果はこのページ内だけに保持するので、ノートをダウンロードしてください。復旧にはブラウザの開発者ツールで rn_history の内容を確認してください。");
    }
  }

  function persistHistory() {
    clearTimeout(state.historyTimer);
    state.historyTimer = null;
    if (!state.historyWritable) return;
    try { localStorage.setItem("rn_history", JSON.stringify(state.history)); }
    catch {
      storageWarning("履歴をブラウザに保存できませんでした。結果はこのページ内には残っています。不要な履歴を削除するか、保存機能の許可と空き容量を確認し、大切なノートはダウンロードしてください。");
    }
  }

  function currentRecord() {
    return state.history.find((record) => record.id === state.currentId);
  }

  function formatDate(value) {
    return new Date(value).toLocaleString("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
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
    return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
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
      if (listItems.length) output.push(`<${listTag}>${listItems.map((item) => `<li>${inline(item)}</li>`).join("")}</${listTag}>`);
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
    ui.noteProviderStatus.textContent = state.notesReady
      ? "ノート生成：Gemini（設定済み）"
      : "ノート生成：Gemini APIキー未設定（使う場合は .env に GEMINI_API_KEY を設定）";
  }

  function updateControls() {
    const busy = Boolean(state.operation);
    const audioLocked = busy || state.starting || state.recording || state.checking;
    ui.recordStart.disabled = audioLocked;
    ui.recordStop.disabled = !state.recording || state.stopping;
    ui.audioFile.disabled = audioLocked;
    ui.transcribeStart.disabled = audioLocked || !state.audio;
    ui.generateNote.disabled = audioLocked || !ui.transcript.value.trim();
    ui.transcript.readOnly = busy;
    ui.testConnection.disabled = busy || state.checking;
    ui.copyNote.disabled = !state.note.trim();
    ui.downloadNote.disabled = !state.note.trim();
    const transcribing = state.operation?.kind === "transcribe";
    const noting = state.operation?.kind === "note";
    ui.transcribeCancel.hidden = !transcribing;
    ui.noteCancel.hidden = !noting;
    ui.transcribeProgress.hidden = !transcribing;
    ui.noteProgress.hidden = !noting;
    ui.transcribeStart.textContent = transcribing ? "文字起こし中…" : "文字起こし開始 →";
    ui.generateNote.textContent = noting ? "ノート生成中…" : "AIノートを生成 →";
    ui.testConnection.textContent = state.checking ? "状態を確認中…" : "状態を再確認 ↻";
    ui.transcriptCount.textContent = `${ui.transcript.value.length.toLocaleString("ja-JP")}文字`;
    for (const button of ui.historyList.querySelectorAll("button")) button.disabled = audioLocked;
    updateNoteDescription();
  }

  function setConnection(status, text) {
    ui.connectionStatus.dataset.state = status;
    ui.connectionLabel.textContent = text;
  }

  function clearHealthPoll() {
    if (state.healthTimer !== null) {
      clearTimeout(state.healthTimer);
      state.healthTimer = null;
    }
  }

  function scheduleHealthPoll() {
    clearHealthPoll();
    state.healthTimer = setTimeout(() => {
      state.healthTimer = null;
      checkHealth().catch(() => { /* Status banner reflects loading/error state. */ });
    }, POLL_INTERVAL);
  }

  function assertServed() {
    if (location.protocol !== "http:" && location.protocol !== "https:") {
      throw new UserError("このページはローカルサーバーから開く必要があります。start.sh（または start.bat / python server.py）を起動して http://127.0.0.1:8000 を開いてください。");
    }
  }

  function httpError(status, scope) {
    if (scope === "note") {
      if (status === 502) return "Geminiでノートを生成できませんでした。サーバーの表示とGoogle側の利用状況を確認してください。";
      if (status === 503) return "Gemini APIキーが未設定です。プロジェクト直下の .env に GEMINI_API_KEY を設定してから再実行してください。";
    }
    if (status === 503) return "Haas-ja モデルを準備中です。初回はモデルの取得に数分かかります。しばらく待ってから再実行してください。";
    if (scope === "job" && status === 404) return "処理中のジョブが見つかりません。サーバーを再起動した場合は、音声を送り直してください。";
    if (status === 404) return "サーバーのAPIが見つかりません。ローカルサーバーから開いているか確認してください。";
    if (status === 413) return "音声ファイルが大きすぎて送信できません。短い音声ファイルに分けて選び直してください。";
    if (status === 422) return "音声ファイルを読み取れませんでした。WAV・MP3 などに変換して再実行してください。";
    return `ローカルサーバーでエラーが発生しました（HTTP ${status}）。サーバーの画面を確認して再実行してください。`;
  }

  async function responseDetail(response) {
    try {
      const body = await response.json();
      if (typeof body?.detail === "string" && body.detail.trim()) return body.detail;
    } catch { /* The body is not JSON. */ }
    return "";
  }

  async function requestJson(url, options = {}, { signal, scope = "job", timeout = 30000 } = {}) {
    if (signal?.aborted) throw new CancelledError();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      const response = await fetch(url, {
        cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        ...options, signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await responseDetail(response);
        throw new UserError(detail || httpError(response.status, scope));
      }
      let data;
      try { data = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new UserError("ローカルサーバーの応答を読み取れませんでした。サーバーの画面を確認してください。");
      }
      if (signal?.aborted) throw new CancelledError();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new UserError("処理結果の形式が正しくありません。サーバーを再起動して再実行してください。");
      return data;
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      if (timedOut) throw new UserError("ローカルサーバーからの応答が時間内に届きませんでした。処理が続いている場合は、しばらく待ってから再実行してください。");
      if (error instanceof UserError) throw error;
      throw new UserError("ローカルサーバーに接続できません。start.sh（または start.bat）が動いているか確認してください。");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  function applyHealthData(data) {
    state.notesReady = Boolean(data.notes?.ready);
    state.engineLabel = typeof data.engine === "string" && data.engine ? data.engine : "Haas-ja-v1.0";
    updateNoteDescription();
  }

  async function checkHealth(signal) {
    clearHealthPoll();
    assertServed();
    if (!state.modelReady) setConnection("checking", "Haas-ja 確認中");
    let data;
    try {
      data = await requestJson(api("health"), { method: "GET" }, { scope: "health", timeout: 15000, signal });
    } catch (error) {
      state.modelReady = false;
      setConnection("error", "サーバー 未接続");
      ui.serverBanner.hidden = false;
      message(ui.connectionMessage, userMessage(error, "ローカルサーバーに接続できません。"), "error");
      updateControls();
      throw error;
    }
    applyHealthData(data);
    if (data.model_error) {
      state.modelReady = false;
      setConnection("error", "Haas-ja 準備失敗");
      ui.serverBanner.hidden = false;
      message(ui.connectionMessage, data.model_error, "error");
      updateControls();
      throw new UserError(data.model_error);
    }
    if (data.model_loaded !== true) {
      state.modelReady = false;
      setConnection("checking", "Haas-ja 準備中");
      ui.serverBanner.hidden = false;
      message(ui.connectionMessage, "Haas-ja モデルを準備中です。初回はモデルの取得に数分かかります（完了すると自動で切り替わります）。", "working");
      updateControls();
      if (data.model_loading === true && !signal?.aborted) scheduleHealthPoll();
      throw new UserError("Haas-ja モデルを準備中です。初回は数分かかります。準備完了までお待ちください。");
    }
    state.modelReady = true;
    setConnection("connected", `${state.engineLabel} 接続済み`);
    ui.serverBanner.hidden = true;
    message(ui.connectionMessage, state.notesReady
      ? "文字起こしとノート生成を利用できます。"
      : "文字起こしを利用できます。ノート生成は .env に Gemini APIキーを設定すると使えます。", "success");
    updateControls();
    return data;
  }

  async function testConnection() {
    if (state.operation || state.checking) return;
    state.checking = true;
    updateControls();
    ui.serverBanner.hidden = false;
    message(ui.connectionMessage, "ローカルサーバーの状態を確認しています…", "working");
    try { await checkHealth(); }
    catch { /* checkHealth already updated the banner and status pill. */ }
    finally { state.checking = false; updateControls(); }
  }

  function waitForPoll(signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new CancelledError()); return; }
      function cancel() { clearTimeout(timer); reject(new CancelledError()); }
      const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, POLL_INTERVAL);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  function jobIdFrom(data) {
    if ((typeof data.job_id !== "string" && typeof data.job_id !== "number") || !String(data.job_id).trim()) {
      throw new UserError("サーバーからジョブIDが返りませんでした。サーバーを再起動して、もう一度実行してください。");
    }
    return encodeURIComponent(String(data.job_id));
  }

  async function pollJob(jobId, signal, element) {
    message(element, "文字起こしの順番を待っています（queued）。このページを開いたままお待ちください。", "working");
    while (true) {
      await waitForPoll(signal);
      const data = await requestJson(api(`jobs/${jobId}`), { method: "GET" }, { signal, scope: "job" });
      switch (data.status) {
        case "queued":
          ui.transcribeProgress.removeAttribute("value");
          message(element, "文字起こしの順番を待っています（queued）。", "working");
          break;
        case "running":
          if (data.phase === "converting") {
            ui.transcribeProgress.removeAttribute("value");
            message(element, "音声を16kHz・モノラルに変換しています…", "working");
          } else if (typeof data.progress === "number" && Number.isFinite(data.progress)) {
            const percent = Math.min(100, Math.max(0, Math.round(data.progress)));
            ui.transcribeProgress.max = 100;
            ui.transcribeProgress.value = percent;
            message(element, `文字起こしを実行中です（${percent}%）。長い講義は時間がかかります。`, "working");
          } else {
            ui.transcribeProgress.removeAttribute("value");
            message(element, "文字起こしを実行中です（running）。長い講義は時間がかかります。", "working");
          }
          break;
        case "done":
          ui.transcribeProgress.max = 100;
          ui.transcribeProgress.value = 100;
          return data;
        case "error":
          throw new UserError(data.error ? `文字起こしに失敗しました: ${data.error}` : "文字起こしに失敗しました。サーバーの画面を確認してください。");
        default:
          throw new UserError("サーバーから認識できない処理状況が返りました。サーバーを再起動して再実行してください。");
      }
    }
  }

  function resultText(data, fields) {
    for (const field of fields) {
      if (typeof data[field] === "string" && data[field].trim()) return data[field];
    }
    if (data.result && typeof data.result === "object") {
      for (const field of fields) {
        if (typeof data.result[field] === "string" && data.result[field].trim()) return data.result[field];
      }
    }
    return "";
  }

  function userMessage(error, fallback) {
    return error instanceof UserError ? error.message : fallback;
  }

  function beginOperation(kind) {
    if (state.operation || state.recording || state.starting || state.checking) return null;
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

  async function transcribeWithLocal(audio, signal) {
    message(ui.transcribeMessage, "文字起こしの前にサーバーの状態を確認しています…", "working");
    await checkHealth(signal);
    const form = new FormData();
    form.append("file", audio, audio.name || "recording.webm");
    message(ui.transcribeMessage, "音声をこのPCのサーバーへ送信しています…", "working");
    const submitted = await requestJson(api("jobs"), { method: "POST", body: form }, { signal, scope: "upload", timeout: 120000 });
    const data = await pollJob(jobIdFrom(submitted), signal, ui.transcribeMessage);
    return resultText(data, ["transcript", "text"]);
  }

  async function transcribe() {
    if (!state.audio) { message(ui.transcribeMessage, "録音するか、音声ファイルを選んでから開始してください。", "error"); return; }
    const operation = beginOperation("transcribe");
    if (!operation) return;
    const signal = operation.controller.signal;
    const audio = state.audio, label = state.audioLabel;
    ui.transcribeProgress.removeAttribute("value");
    try {
      const transcript = await transcribeWithLocal(audio, signal);
      if (!transcript.trim()) throw new UserError("処理は完了しましたが本文が空です。音声が入っているか再生して確かめ、再実行してください。");
      ui.transcript.value = transcript;
      createRecord(transcript, label);
      showNote("");
      persistHistory(); renderHistory();
      message(ui.transcribeMessage, "文字起こしが完了しました（done）。履歴に追加しました。誤認識を編集して、AIノートを生成できます。", "success");
      message(ui.noteMessage, "文字起こしを確認したら「AIノートを生成」を押してください。");
    } catch (error) {
      message(ui.transcribeMessage, userMessage(error, "文字起こしを完了できませんでした。サーバーと音声の状態を確認し、再実行してください。"), error instanceof CancelledError ? "neutral" : "error");
    } finally { endOperation(operation); }
  }

  async function generateNoteWithServer(transcript, title, signal) {
    message(ui.noteMessage, "サーバーの状態を確認しています…", "working");
    const health = await requestJson(api("health"), { method: "GET" }, { scope: "health", timeout: 15000, signal });
    applyHealthData(health);
    if (!state.notesReady) throw new UserError("Gemini APIキーが未設定です。プロジェクト直下の .env に GEMINI_API_KEY を設定してから再実行してください。");
    message(ui.noteMessage, "Geminiに文字起こし全文を送り、ノートを生成しています…", "working");
    const data = await requestJson(api("notes"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, title }),
    }, { signal, scope: "note", timeout: 180000 });
    if (typeof data.note !== "string" || !data.note.trim()) throw new UserError("ノート生成は完了しましたが本文が空です。もう一度実行してください。");
    return data.note;
  }

  async function generateNote() {
    const transcript = ui.transcript.value;
    if (!transcript.trim()) { message(ui.noteMessage, "文字起こしの本文を用意してからノートを生成してください。", "error"); return; }
    const operation = beginOperation("note");
    if (!operation) return;
    try {
      const title = currentRecord()?.title || `${formatDate(new Date())} ｜ テキスト入力`;
      const note = await generateNoteWithServer(transcript, title, operation.controller.signal);
      const record = currentRecord() || createRecord(transcript, "テキスト入力");
      record.transcript = transcript;
      record.note = note;
      showNote(note);
      persistHistory(); renderHistory();
      message(ui.noteMessage, "Geminiでノートを生成しました（done）。履歴に反映しました。コピーやダウンロードで保存できます。", "success");
    } catch (error) {
      const text = error instanceof CancelledError
        ? "待機を中止しました。Gemini側の処理が継続し、利用枠が消費される場合があります。再実行前にGoogle側の利用状況を確認してください。"
        : userMessage(error, "ノートを生成できませんでした。サーバーの状態を確認して再実行してください。");
      message(ui.noteMessage, text, error instanceof CancelledError ? "neutral" : "error");
    } finally { endOperation(operation); }
  }

  function clearAudio(resetFile = true) {
    ui.audioPreview.pause();
    ui.audioPreview.removeAttribute("src");
    ui.audioPreview.load();
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audio = null; state.audioLabel = ""; state.audioUrl = null;
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
    message(ui.transcribeMessage, "用意した音声を Haas-ja で文字起こしできます。");
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
    ui.recordingTime.textContent = total >= 3600 ? `${String(Math.floor(total / 3600)).padStart(2, "0")}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
  }

  function finishRecordingState() {
    clearInterval(state.recordingTimer);
    state.recordingTimer = null;
    state.recording = false; state.starting = false; state.stopping = false; state.recorder = null;
    stopTracks();
    ui.recordingDot.classList.remove("active");
    ui.recordingLabel.textContent = "録音待機中";
    updateControls();
  }

  async function startRecording() {
    if (state.recording || state.starting || state.operation) return;
    if (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      message(ui.audioMessage, "この環境ではブラウザ録音を使えません。localhostで最新版のブラウザから開くか、音声ファイルを選択してください。", "error");
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
      recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener("error", () => {
        recordingError = true;
        message(ui.audioMessage, "録音中に問題が起きました。停止後に再生で内容を確認し、必要なら録り直してください。", "error");
        if (recorder.state !== "inactive") stopRecording();
      });
      recorder.addEventListener("stop", () => {
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
          if (recordingError) message(ui.audioMessage, "録音に問題があったため、一部だけ保存された可能性があります。再生で確認してから文字起こししてください。", "error");
        } catch {
          message(ui.audioMessage, "録音のプレビューを作れませんでした。端末の空き容量を確認し、録り直すか音声ファイルを選択してください。", "error");
        }
      }, { once: true });
      recorder.start(1000);
      clearAudio();
      state.starting = false; state.recording = true; state.recordingStarted = Date.now();
      updateRecordingTime();
      state.recordingTimer = setInterval(updateRecordingTime, 1000);
      ui.recordingDot.classList.add("active");
      ui.recordingLabel.textContent = "録音中";
      message(ui.audioMessage, "録音中です。終わったら「停止」を押してください。録音中はこのページを開いたままにしてください。", "working");
      for (const track of state.stream.getAudioTracks()) track.addEventListener("ended", () => { if (state.recording) stopRecording(); }, { once: true });
    } catch (error) {
      finishRecordingState();
      const text = error?.name === "NotAllowedError" || error?.name === "SecurityError"
        ? "マイクの使用が許可されていません。ブラウザのサイト設定でマイクを許可して再試行するか、音声ファイルを選んでください。"
        : error?.name === "NotFoundError"
          ? "マイクが見つかりません。端末にマイクを接続するか、音声ファイルを選択してください。"
          : "録音を開始できませんでした。ほかのアプリのマイク使用とブラウザの設定を確認し、再試行するか音声ファイルを選んでください。";
      message(ui.audioMessage, text, "error");
    } finally { state.starting = false; updateControls(); }
  }

  function stopRecording() {
    if (!state.recorder || state.recorder.state === "inactive" || state.stopping) return;
    state.stopping = true;
    ui.recordingLabel.textContent = "録音を保存中";
    updateControls();
    try { state.recorder.stop(); }
    catch {
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
      open.type = "button"; open.className = "history-open";
      open.setAttribute("aria-pressed", String(record.id === state.currentId));
      open.setAttribute("aria-label", `${record.title}を開く`);
      const icon = document.createElement("span");
      icon.className = "history-item-icon"; icon.textContent = "≡"; icon.setAttribute("aria-hidden", "true");
      const details = document.createElement("span"); details.className = "history-item-details";
      const title = document.createElement("span"); title.className = "history-item-title"; title.textContent = record.title;
      const meta = document.createElement("span"); meta.className = "history-item-meta";
      meta.textContent = `${formatDate(record.createdAt)} · ${record.transcript.length.toLocaleString("ja-JP")}文字 · ${record.note ? "ノート作成済み" : "文字起こし"} · 開く`;
      details.append(title, meta); open.append(icon, details);
      open.addEventListener("click", () => openHistory(record.id));
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "button secondary small history-delete"; remove.textContent = "削除";
      remove.setAttribute("aria-label", `${record.title}を削除`);
      remove.addEventListener("click", () => deleteHistory(record.id));
      li.append(open, remove); ui.historyList.append(li);
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
    message(ui.noteMessage, record.note ? "履歴のノートを復元しました。コピー・ダウンロードできます。" : "この文字起こしからAIノートを生成できます。", record.note ? "success" : "neutral");
    message(ui.historyMessage, "履歴を開きました。文字起こしとノートを復元しています。", "success");
    renderHistory();
    ui.transcriptionSection.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
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
    persistHistory(); renderHistory();
    message(ui.historyMessage, "このブラウザの履歴から削除しました。", "success");
  }

  async function copyNote() {
    if (!state.note.trim()) return;
    const note = state.note;
    try {
      try {
        if (!navigator.clipboard?.writeText) throw new Error();
        await navigator.clipboard.writeText(note);
      } catch {
        const previousFocus = document.activeElement;
        const temporary = document.createElement("textarea");
        temporary.value = note; temporary.readOnly = true;
        temporary.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none;";
        document.body.append(temporary);
        try {
          temporary.select();
          if (!document.execCommand?.("copy")) throw new Error();
        } finally { temporary.remove(); previousFocus?.focus({ preventScroll: true }); }
      }
      message(ui.noteMessage, "Markdownをコピーしました。お好きなメモアプリに貼り付けられます。", "success");
    } catch { message(ui.noteMessage, "コピーできませんでした。ブラウザのクリップボード許可を確認するか、「.mdでダウンロード」を使ってください。", "error"); }
  }

  function downloadNote() {
    if (!state.note.trim()) return;
    let url;
    try {
      const fileName = (currentRecord()?.title || "RecordingNote").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 110);
      url = URL.createObjectURL(new Blob([state.note], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `${fileName}.md`;
      document.body.append(link); link.click(); link.remove();
      message(ui.noteMessage, "Markdownのダウンロードを開始しました。ブラウザのダウンロード一覧で確認してください。", "success");
    } catch { message(ui.noteMessage, "ダウンロードを開始できませんでした。ブラウザの保存設定を確認するか、「Markdownをコピー」を使ってください。", "error"); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  // Remove legacy client-side settings from earlier versions.
  for (const key of [
    "rn_backend_url",
    "rn_backend_key",
    "rn_gemini_key",
    "rn_gemini_model",
    "rn_asr_engine",
    "rn_browser_asr_model",
  ]) {
    try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  }

  ui.testConnection.addEventListener("click", testConnection);
  ui.recordStart.addEventListener("click", startRecording);
  ui.recordStop.addEventListener("click", stopRecording);
  ui.audioFile.addEventListener("change", () => {
    if (state.operation || state.recording || state.starting) return;
    const file = ui.audioFile.files?.[0];
    if (!file) return;
    if (!file.size) { message(ui.audioMessage, "選択したファイルが空です。音声の入ったファイルを選び直してください。", "error"); return; }
    try { setAudio(file, file.name); }
    catch { message(ui.audioMessage, "音声ファイルを読み込めませんでした。別のファイルを選び、ブラウザのファイル使用許可を確認してください。", "error"); updateControls(); }
  });
  ui.transcribeStart.addEventListener("click", transcribe);
  ui.generateNote.addEventListener("click", generateNote);
  for (const button of [ui.transcribeCancel, ui.noteCancel]) button.addEventListener("click", () => state.operation?.controller.abort());
  ui.copyNote.addEventListener("click", copyNote);
  ui.downloadNote.addEventListener("click", downloadNote);
  ui.transcript.addEventListener("input", () => {
    if (state.operation) return;
    const record = currentRecord();
    if (record) {
      record.transcript = ui.transcript.value;
      clearTimeout(state.historyTimer);
      state.historyTimer = setTimeout(() => { persistHistory(); renderHistory(); }, 400);
    }
    message(ui.noteMessage, state.note
      ? "文字起こしを編集しました。変更をノートへ反映するには、もう一度生成してください。"
      : ui.transcript.value.trim() ? "この本文からAIノートを生成できます。" : "先に文字起こしを用意してください。");
    updateControls();
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.historyTimer !== null) persistHistory();
    if (state.recording || state.starting || state.operation) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", (event) => {
    if (state.historyTimer !== null) persistHistory();
    if (!event.persisted) {
      clearHealthPoll();
      state.operation?.controller.abort();
      stopTracks();
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    }
  });

  loadHistory();
  setConnection("idle", "Haas-ja 確認中");
  renderHistory();
  if (location.protocol === "http:" || location.protocol === "https:") {
    checkHealth().catch(() => { /* The status banner shows loading/error details. */ });
  } else {
    setConnection("error", "サーバー 未接続");
    ui.serverBanner.hidden = false;
    message(ui.connectionMessage, "このページはローカルサーバーから開いてください。start.sh（または start.bat）を実行し、http://127.0.0.1:8000 を開きます。", "error");
  }
})();
