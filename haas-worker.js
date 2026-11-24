// Browser-native Haas-ja-v1.0 engine using onnxruntime-web (WebGPU + WASM fallback).
// Runs in a dedicated module Web Worker or directly on the main thread when Workers are unavailable.

export const ORT_CDN_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
export const ORT_MODULE_URL = `${ORT_CDN_BASE}ort.webgpu.bundle.min.mjs`;
export const MODEL_REPO = "kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX";
export const MODEL_REVISION = "e46a4b107ffba60336eb3de9745da6f628cfae35";
export const MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/`;
export const CACHE_NAME = "recordingnote-haas-ja-v1-e46a4b10";

export const MODEL_FILES = [
  { path: "common/decoding.json", bytes: 122 },
  { path: "common/frontend.json", bytes: 377057 },
  { path: "common/tokens.json", bytes: 36037 },
  { path: "common/joint.onnx", bytes: 7892424 },
  { path: "common/prediction.onnx", bytes: 17155566 },
  { path: "int4-onecomp/encoder.onnx", bytes: 1114166 },
  { path: "int4-onecomp/encoder.onnx.data", bytes: 353733120 },
];
export const TOTAL_MODEL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);

const SAMPLE_RATE = 16000;
const PRED_LAYERS = 2;
const PRED_KDA_HEADS = 5;
const PRED_KDA_DIM = 64;
const PRED_CONV_CH = 320;
const PRED_CONV_W = 4;

function checkCancelled(signal) {
  if (signal?.aborted) {
    throw new DOMException("文字起こしを中止しました。", "AbortError");
  }
}

function disposeTensor(tensor) {
  if (tensor && typeof tensor.dispose === "function") {
    try {
      tensor.dispose();
    } catch {
      /* Ignore disposal failures on already-freed runtime buffers. */
    }
  }
}

function disposeSession(session) {
  if (session && typeof session.release === "function") {
    return session.release().catch(() => {});
  }
  return Promise.resolve();
}

export async function fetchModelBytes(
  relPath,
  expectedBytes = 0,
  { baseUrl = MODEL_BASE_URL, fetchImpl = globalThis.fetch, useCache = true, signal, onBytes } = {},
) {
  checkCancelled(signal);
  const url = new URL(relPath, baseUrl).href;

  let cache = null;
  if (useCache && baseUrl === MODEL_BASE_URL && typeof caches !== "undefined") {
    try {
      cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        const bytes = new Uint8Array(await cached.arrayBuffer());
        checkCancelled(signal);
        onBytes?.(bytes.byteLength || expectedBytes);
        return bytes;
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      cache = null;
    }
  }

  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    checkCancelled(signal);
    throw new Error(`モデルファイル（${relPath}）を取得できませんでした。インターネット接続と通信許可を確認してください。（${error?.message || error}）`);
  }
  if (!response?.ok) {
    throw new Error(`モデルファイル（${relPath}）の取得に失敗しました（HTTP ${response?.status ?? "unknown"}）。`);
  }

  let bytes;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const contentLength = Number(response.headers?.get?.("content-length")) || 0;
    let buffer = contentLength > 0 ? new Uint8Array(contentLength) : null;
    let offset = 0;
    const chunks = [];
    try {
      while (true) {
        checkCancelled(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        onBytes?.(value.byteLength);
        if (buffer) {
          if (offset + value.byteLength <= buffer.byteLength) {
            buffer.set(value, offset);
            offset += value.byteLength;
          } else {
            chunks.push(buffer.subarray(0, offset), value);
            buffer = null;
          }
        } else {
          chunks.push(value);
          offset += value.byteLength;
        }
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* Ignore reader cancel errors. */ }
      throw error;
    }
    if (buffer) {
      bytes = offset === buffer.byteLength ? buffer : buffer.subarray(0, offset);
    } else {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      bytes = new Uint8Array(total);
      let pos = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, pos);
        pos += chunk.byteLength;
      }
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
    checkCancelled(signal);
    onBytes?.(bytes.byteLength || expectedBytes);
  }

  if (cache) {
    try {
      const contentType = relPath.endsWith(".json") ? "application/json" : "application/octet-stream";
      await cache.put(
        url,
        new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(bytes.byteLength),
          },
        }),
      );
    } catch {
      /* Cache storage may be unavailable or over quota; inference still works. */
    }
  }

  return bytes;
}

export function makeFft(n) {
  const bitRev = new Uint16Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let rev = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    bitRev[i] = rev;
  }
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let i = 0; i < (n >> 1); i++) {
    const angle = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  return function rfftPower(frame, outPower) {
    for (let i = 0; i < n; i++) {
      const rev = bitRev[i];
      re[rev] = frame[i];
      im[rev] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const wRe = cos[j * step];
          const wIm = sin[j * step];
          const uRe = re[i + j];
          const uIm = im[i + j];
          const xRe = re[i + j + half];
          const xIm = im[i + j + half];
          const vRe = xRe * wRe - xIm * wIm;
          const vIm = xRe * wIm + xIm * wRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + half] = uRe - vRe;
          im[i + j + half] = uIm - vIm;
        }
      }
    }
    const bins = (n >> 1) + 1;
    for (let k = 0; k < bins; k++) {
      outPower[k] = re[k] * re[k] + im[k] * im[k];
    }
  };
}

export function createLogMelFrontend(cfg) {
  const {
    n_fft: nFft,
    win_length: winLen,
    hop_length: hop,
    preemph,
    log_zero_guard_value: guard,
    pad_to: padTo,
  } = cfg;
  const stdEps = 1e-5;
  const win = new Float64Array(nFft);
  const winStart = (nFft - winLen) >> 1;
  for (let i = 0; i < winLen; i++) {
    win[winStart + i] = cfg.window[i];
  }

  const nMels = cfg.mel_filter.length;
  const nBins = (nFft >> 1) + 1;
  const melRows = cfg.mel_filter.map((row) => {
    const idx = [];
    const val = [];
    for (let k = 0; k < nBins; k++) {
      if (row[k] !== 0) {
        idx.push(k);
        val.push(row[k]);
      }
    }
    return { idx: new Uint16Array(idx), val: new Float32Array(val) };
  });

  const rfftPower = makeFft(nFft);
  const frameBuf = new Float64Array(nFft);
  const powerBuf = new Float32Array(nBins);

  return function computeLogMel(audio) {
    const valid = Math.floor(audio.length / hop);
    if (valid < 2) {
      throw new Error("音声が短すぎます（20ms 未満）。");
    }
    const pre = new Float32Array(audio.length);
    pre[0] = audio[0];
    for (let i = 1; i < audio.length; i++) {
      pre[i] = audio[i] - preemph * audio[i - 1];
    }

    const padHalf = nFft >> 1;
    const totalPadded = pre.length + padHalf * 2;
    const numFrames = Math.floor((totalPadded - nFft) / hop) + 1;
    const paddedFrames = numFrames + ((-numFrames % padTo) + padTo) % padTo;
    const mel = new Float32Array(nMels * paddedFrames);

    for (let t = 0; t < numFrames; t++) {
      const origin = t * hop - padHalf;
      for (let i = 0; i < nFft; i++) {
        const sampleIdx = origin + i;
        frameBuf[i] = (sampleIdx >= 0 && sampleIdx < pre.length ? pre[sampleIdx] : 0) * win[i];
      }
      rfftPower(frameBuf, powerBuf);
      for (let m = 0; m < nMels; m++) {
        const { idx, val } = melRows[m];
        let acc = 0;
        for (let j = 0; j < idx.length; j++) {
          acc += val[j] * powerBuf[idx[j]];
        }
        mel[m * paddedFrames + t] = Math.log(acc + guard);
      }
    }

    for (let m = 0; m < nMels; m++) {
      const rowOffset = m * paddedFrames;
      let sum = 0;
      for (let t = 0; t < valid; t++) {
        sum += mel[rowOffset + t];
      }
      const mean = sum / valid;
      let sq = 0;
      for (let t = 0; t < valid; t++) {
        const diff = mel[rowOffset + t] - mean;
        sq += diff * diff;
      }
      const invStd = 1 / (Math.sqrt(sq / (valid - 1)) + stdEps);
      for (let t = 0; t < valid; t++) {
        mel[rowOffset + t] = (mel[rowOffset + t] - mean) * invStd;
      }
      for (let t = valid; t < paddedFrames; t++) {
        mel[rowOffset + t] = 0;
      }
    }

    return { mel, dims: [1, nMels, paddedFrames], valid };
  };
}

export function splitAtQuietPoints(
  audio,
  { sampleRate = SAMPLE_RATE, chunkSeconds = 28, searchSeconds = 2, windowSeconds = 0.1 } = {},
) {
  const step = Math.trunc(chunkSeconds * sampleRate);
  const search = Math.trunc(searchSeconds * sampleRate);
  const windowSize = Math.trunc(windowSeconds * sampleRate);
  const bounds = [];
  let start = 0;

  while (audio.length - start > step) {
    const target = start + step;
    const low = Math.max(start + Math.floor(step / 2), target - search);
    const high = Math.min(audio.length - windowSize, target + search);
    let cut = target;
    if (high > low) {
      // Prefix sum only over the narrow search region so long recordings use minimal memory.
      const spanLen = high + windowSize - low;
      const prefix = new Float64Array(spanLen + 1);
      for (let i = 0; i < spanLen; i++) {
        const sample = audio[low + i];
        prefix[i + 1] = prefix[i] + sample * sample;
      }
      let bestOffset = 0;
      let bestEnergy = Infinity;
      const limit = high - low;
      for (let offset = 0; offset <= limit; offset++) {
        const energy = prefix[offset + windowSize] - prefix[offset];
        if (energy < bestEnergy) {
          bestEnergy = energy;
          bestOffset = offset;
        }
      }
      cut = low + bestOffset + Math.floor(windowSize / 2);
    }
    bounds.push([start, cut]);
    start = cut;
  }

  if (start < audio.length) {
    bounds.push([start, audio.length]);
  }
  return bounds;
}

export function detokenize(ids, table) {
  const parts = [];
  let pending = [];
  const utf8 = new TextDecoder("utf-8", { fatal: false });
  const flushBytes = () => {
    if (!pending.length) return;
    parts.push(utf8.decode(new Uint8Array(pending)));
    pending = [];
  };

  for (const tokenId of ids) {
    let piece = table.pieces[tokenId];
    if (piece === undefined) continue;
    if (piece.length === 6 && piece.startsWith("<0x") && piece.endsWith(">")) {
      pending.push(parseInt(piece.slice(3, 5), 16));
      continue;
    }
    flushBytes();
    if (tokenId === table.unk_id) {
      parts.push(" ⁇ ");
    } else {
      if (!parts.length && table.add_dummy_prefix && piece.startsWith("▁")) {
        piece = piece.slice(1);
      }
      parts.push(piece.replaceAll("▁", " "));
    }
  }
  flushBytes();
  return parts.join("").trim();
}

function failureReason(error) {
  const detail = String(error?.message || error).toLowerCase();
  if (/out of memory|memory|allocation|buffer size|rangeerror/.test(detail)) {
    return "端末のメモリが不足している可能性があります。ほかのタブやアプリを閉じて再試行してください。";
  }
  if (/fetch|network|download|http 4|http 5|取得/.test(detail)) {
    return "モデルファイルを取得できませんでした。インターネット接続と通信許可を確認してください。";
  }
  if (/webgpu|gpu|adapter|device|shader/.test(detail)) {
    return "WebGPU の初期化または推論に失敗しました。ブラウザの対応状況を確認してください。";
  }
  return error?.message || "このブラウザではモデルの読み込みまたは推論を完了できませんでした。";
}

export function createHaasASR({
  ortUrl = ORT_MODULE_URL,
  wasmPaths = ORT_CDN_BASE,
  modelBaseUrl = MODEL_BASE_URL,
  fetchImpl = globalThis.fetch,
  useCache = true,
  preferredDevices = null,
} = {}) {
  let ortPromise = null;
  let state = null;
  let running = false;

  async function loadOrt() {
    if (!ortPromise) {
      ortPromise = import(ortUrl)
        .then((mod) => {
          const ort = mod.InferenceSession ? mod : mod.default?.InferenceSession ? mod.default : mod;
          ort.env.wasm.wasmPaths = wasmPaths;
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.proxy = false;
          return ort;
        })
        .catch((error) => {
          ortPromise = null;
          throw new Error(`文字起こしランタイム（onnxruntime-web）を読み込めませんでした。通信状態を確認してください。（${error?.message || error}）`);
        });
    }
    return ortPromise;
  }

  async function loadEncoderSession(ort, encBytes, encDataBytes, devices, onEvent) {
    let lastError = null;
    for (const dev of devices) {
      try {
        onEvent?.({
          type: "loading",
          message: `${dev === "webgpu" ? "WebGPU" : "WASM（CPU）"} で Haas-ja エンコーダを初期化しています…`,
        });
        const session = await ort.InferenceSession.create(encBytes, {
          executionProviders: [dev],
          externalData: [{ path: "encoder.onnx.data", data: encDataBytes }],
        });
        return { session, device: dev };
      } catch (error) {
        lastError = error;
        if (dev === "webgpu") {
          onEvent?.({
            type: "notice",
            message: "WebGPUで初期化できなかったため、WASM（CPU）で続行します。",
          });
        }
      }
    }
    throw lastError || new Error("Haas-ja エンコーダを読み込めませんでした。");
  }

  async function dispose() {
    const previous = state;
    state = null;
    if (!previous) return;
    disposeTensor(previous.startPredProj);
    disposeTensor(previous.startKda);
    disposeTensor(previous.startConv);
    await Promise.all([
      disposeSession(previous.encoderSession),
      disposeSession(previous.predSession),
      disposeSession(previous.jointSession),
    ]);
  }

  async function ensureInitialized({ signal, onEvent }) {
    if (state) return state;

    checkCancelled(signal);
    onEvent({ type: "loading", message: "ブラウザ推論ランタイムを準備しています…" });
    const ort = await loadOrt();
    checkCancelled(signal);

    let loadedBytes = 0;
    const reportBytes = (filePath) => (delta) => {
      if (signal?.aborted) return;
      loadedBytes = Math.min(TOTAL_MODEL_BYTES, loadedBytes + delta);
      onEvent({
        type: "download",
        loaded: loadedBytes,
        total: TOTAL_MODEL_BYTES,
        percent: Math.min(100, Math.round((loadedBytes / TOTAL_MODEL_BYTES) * 100)),
        file: filePath,
      });
    };

    const download = (entry) =>
      fetchModelBytes(entry.path, entry.bytes, {
        baseUrl: modelBaseUrl,
        fetchImpl,
        useCache,
        signal,
        onBytes: reportBytes(entry.path),
      });

    const jsonDecoder = new TextDecoder("utf-8");
    const [decodingBytes, frontendBytes, tokensBytes] = await Promise.all([
      download(MODEL_FILES[0]),
      download(MODEL_FILES[1]),
      download(MODEL_FILES[2]),
    ]);
    const decodingCfg = JSON.parse(jsonDecoder.decode(decodingBytes));
    const frontendCfg = JSON.parse(jsonDecoder.decode(frontendBytes));
    const tokensCfg = JSON.parse(jsonDecoder.decode(tokensBytes));
    const computeMel = createLogMelFrontend(frontendCfg);

    let jointBytes = await download(MODEL_FILES[3]);
    let predBytes = await download(MODEL_FILES[4]);
    let encBytes = await download(MODEL_FILES[5]);
    let encDataBytes = await download(MODEL_FILES[6]);
    checkCancelled(signal);

    onEvent({ type: "loading", message: "Haas-ja デコーダを初期化しています…" });
    const [jointSession, predSession] = await Promise.all([
      ort.InferenceSession.create(jointBytes, { executionProviders: ["wasm"] }),
      ort.InferenceSession.create(predBytes, { executionProviders: ["wasm"] }),
    ]);
    jointBytes = null;
    predBytes = null;
    checkCancelled(signal);

    const initTok = new ort.Tensor("int64", BigInt64Array.from([BigInt(decodingCfg.blank_id)]), [1]);
    const initKda = new ort.Tensor(
      "float32",
      new Float32Array(PRED_LAYERS * 1 * PRED_KDA_HEADS * PRED_KDA_DIM * PRED_KDA_DIM),
      [PRED_LAYERS, 1, PRED_KDA_HEADS, PRED_KDA_DIM, PRED_KDA_DIM],
    );
    const initConv = new ort.Tensor(
      "float32",
      new Float32Array(PRED_LAYERS * 1 * 3 * PRED_CONV_CH * PRED_CONV_W),
      [PRED_LAYERS, 1, 3, PRED_CONV_CH, PRED_CONV_W],
    );
    let startOut;
    try {
      startOut = await predSession.run({
        token: initTok,
        kda_state: initKda,
        conv_state: initConv,
      });
    } finally {
      disposeTensor(initTok);
      disposeTensor(initKda);
      disposeTensor(initConv);
    }

    const devices = preferredDevices || (globalThis.navigator?.gpu ? ["webgpu", "wasm"] : ["wasm"]);
    let encoderSession = null;
    let encoderDevice = "wasm";
    try {
      ({ session: encoderSession, device: encoderDevice } = await loadEncoderSession(
        ort,
        encBytes,
        encDataBytes,
        devices,
        onEvent,
      ));
    } catch (error) {
      disposeTensor(startOut.pred_proj);
      disposeTensor(startOut.kda_state_out);
      disposeTensor(startOut.conv_state_out);
      await Promise.all([disposeSession(jointSession), disposeSession(predSession)]);
      throw error;
    } finally {
      encBytes = null;
      encDataBytes = null;
    }

    state = {
      ort,
      decodingCfg,
      tokensCfg,
      computeMel,
      jointSession,
      predSession,
      encoderSession,
      encoderDevice,
      startPredProj: startOut.pred_proj,
      startKda: startOut.kda_state_out,
      startConv: startOut.conv_state_out,
    };
    return state;
  }

  async function fallbackEncoderToWasm(current, { signal, onEvent }) {
    onEvent({ type: "notice", message: "WebGPUで処理できなかったため、WASM（CPU）に切り替えて続行します。" });
    await disposeSession(current.encoderSession);
    current.encoderSession = null;

    let encBytes = await fetchModelBytes(MODEL_FILES[5].path, MODEL_FILES[5].bytes, {
      baseUrl: modelBaseUrl,
      fetchImpl,
      useCache,
      signal,
    });
    let encDataBytes = await fetchModelBytes(MODEL_FILES[6].path, MODEL_FILES[6].bytes, {
      baseUrl: modelBaseUrl,
      fetchImpl,
      useCache,
      signal,
    });
    try {
      const loaded = await loadEncoderSession(current.ort, encBytes, encDataBytes, ["wasm"], onEvent);
      current.encoderSession = loaded.session;
      current.encoderDevice = loaded.device;
    } finally {
      encBytes = null;
      encDataBytes = null;
    }
  }

  async function encodeChunk(current, mel, dims, valid, { signal, onEvent }) {
    const { ort } = current;
    const runOnce = async () => {
      const melTensor = new ort.Tensor("float32", mel, dims);
      const melLenTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(valid)]), [1]);
      try {
        return await current.encoderSession.run({
          mel: melTensor,
          mel_length: melLenTensor,
        });
      } finally {
        disposeTensor(melTensor);
        disposeTensor(melLenTensor);
      }
    };

    try {
      return await runOnce();
    } catch (error) {
      checkCancelled(signal);
      if (current.encoderDevice !== "webgpu") throw error;
      await fallbackEncoderToWasm(current, { signal, onEvent });
      checkCancelled(signal);
      return await runOnce();
    }
  }

  async function decodeChunk(current, chunkAudio, { signal, onEvent }) {
    const { ort, decodingCfg, tokensCfg, computeMel, jointSession, predSession } = current;
    const { mel, dims, valid } = computeMel(chunkAudio);
    const encOut = await encodeChunk(current, mel, dims, valid, { signal, onEvent });

    let predProj = current.startPredProj;
    let kda = current.startKda;
    let conv = current.startConv;
    let ownsPredState = false;

    try {
      const numFrames = Number(encOut.enc_length.data[0]);
      const encDim = encOut.enc_proj.dims[2];
      const encData = encOut.enc_proj.data;
      const nTok = decodingCfg.num_tokens + 1;
      const outIds = [];

      let t = 0;
      let lastTs = -1;
      let lasts = 0;
      while (t < numFrames) {
        checkCancelled(signal);
        let token = decodingCfg.blank_id;
        let tLabel = t;
        while (true) {
          tLabel = t;
          const frameSlice = encData.subarray(t * encDim, (t + 1) * encDim);
          const encFrameTensor = new ort.Tensor("float32", frameSlice, [1, encDim]);
          let jOut;
          try {
            jOut = await jointSession.run({
              enc_frame: encFrameTensor,
              pred_proj: predProj,
            });
          } finally {
            disposeTensor(encFrameTensor);
          }

          let bestTok = 0;
          let bestTokVal = -Infinity;
          let bestDurIdx = 0;
          let bestDurVal = -Infinity;
          try {
            const logits = jOut.logits.data;
            for (let i = 0; i < nTok; i++) {
              if (logits[i] > bestTokVal) {
                bestTokVal = logits[i];
                bestTok = i;
              }
            }
            for (let i = nTok; i < logits.length; i++) {
              if (logits[i] > bestDurVal) {
                bestDurVal = logits[i];
                bestDurIdx = i - nTok;
              }
            }
          } finally {
            disposeTensor(jOut.logits);
          }

          token = bestTok;
          let dur = decodingCfg.durations[bestDurIdx] ?? 1;
          if (token === decodingCfg.blank_id && dur === 0) dur = 1;
          t += dur;
          if (token !== decodingCfg.blank_id || t >= numFrames) break;
        }
        if (token === decodingCfg.blank_id) break;

        outIds.push(token);
        lasts = lastTs === tLabel ? lasts + 1 : 1;
        lastTs = tLabel;

        const tokTensor = new ort.Tensor("int64", BigInt64Array.from([BigInt(token)]), [1]);
        let nextPredOut;
        try {
          nextPredOut = await predSession.run({
            token: tokTensor,
            kda_state: kda,
            conv_state: conv,
          });
        } finally {
          disposeTensor(tokTensor);
        }

        if (ownsPredState) {
          disposeTensor(predProj);
          disposeTensor(kda);
          disposeTensor(conv);
        }
        predProj = nextPredOut.pred_proj;
        kda = nextPredOut.kda_state_out;
        conv = nextPredOut.conv_state_out;
        ownsPredState = true;

        if (t < numFrames && lasts >= decodingCfg.max_symbols && lastTs === t) {
          t += 1;
        }
      }
      return detokenize(outIds, tokensCfg);
    } finally {
      disposeTensor(encOut.enc_proj);
      disposeTensor(encOut.enc_length);
      if (ownsPredState) {
        disposeTensor(predProj);
        disposeTensor(kda);
        disposeTensor(conv);
      }
    }
  }

  async function transcribe(audio, { signal, onEvent = () => {} } = {}) {
    if (running) {
      throw new Error("文字起こしの処理中です。完了または中止してから再実行してください。");
    }
    if (!(audio instanceof Float32Array) || !audio.length) {
      throw new Error("音声データが空です。録音またはファイル選択をやり直してください。");
    }
    if (audio.length < 320) {
      throw new Error("音声が短すぎます（20ms 未満）。もう少し長い音声で再実行してください。");
    }

    running = true;
    try {
      checkCancelled(signal);
      let inputAudio = audio;
      if (inputAudio.length < SAMPLE_RATE) {
        const padded = new Float32Array(SAMPLE_RATE);
        padded.set(inputAudio, Math.floor((SAMPLE_RATE - inputAudio.length) / 2));
        inputAudio = padded;
      }

      const current = await ensureInitialized({ signal, onEvent });
      const bounds = splitAtQuietPoints(inputAudio, {
        sampleRate: SAMPLE_RATE,
        chunkSeconds: 28,
        searchSeconds: 2,
        windowSeconds: 0.1,
      });

      const texts = [];
      for (let i = 0; i < bounds.length; i++) {
        checkCancelled(signal);
        const [start, end] = bounds[i];
        onEvent({
          type: "chunk",
          index: i + 1,
          total: bounds.length,
          device: current.encoderDevice,
        });
        const chunkText = await decodeChunk(current, inputAudio.subarray(start, end), { signal, onEvent });
        if (chunkText) texts.push(chunkText);
      }

      return { text: texts.join(""), device: current.encoderDevice };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (!state?.encoderSession) {
        await dispose();
      }
      throw new Error(`ブラウザ内の文字起こしに失敗しました。${failureReason(error)}`);
    } finally {
      running = false;
    }
  }

  return { transcribe, dispose };
}

if (typeof DedicatedWorkerGlobalScope !== "undefined" && globalThis instanceof DedicatedWorkerGlobalScope) {
  const engine = createHaasASR();
  self.addEventListener("message", async ({ data }) => {
    if (data?.type !== "transcribe") return;
    const { id, audio } = data;
    try {
      const result = await engine.transcribe(audio, {
        onEvent: (event) => self.postMessage({ ...event, id }),
      });
      self.postMessage({ type: "result", id, result });
    } catch (error) {
      self.postMessage({
        type: "error",
        id,
        message: error?.message || "文字起こしに失敗しました。再試行してください。",
      });
    }
  });
  self.postMessage({ type: "ready" });
}
