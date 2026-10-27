// Voice: recording with silence detection, speech-to-text, and read-aloud (text-to-speech).
import { getSettings } from './store.js';
import { transcribe, speak } from './api.js';
import { arrayBufferToBase64 } from './util.js';

let ctx = null;
let audioEl = null;

export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export function audioElement() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.setAttribute('playsinline', '');
  }
  return audioEl;
}

const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

// iPhones only allow sound after a tap. Call this inside a tap handler.
export function unlockAudio() {
  try {
    const c = audioCtx();
    if (c.state === 'suspended') c.resume().catch(() => {});
  } catch {}
  try {
    const a = audioElement();
    if (!a.src || a.paused) {
      a.src = SILENT_WAV;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
  try {
    if (window.speechSynthesis && !unlockAudio.done) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
      unlockAudio.done = true;
    }
  } catch {}
}

export function micSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export function browserSTTSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function pickMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac']) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {}
  }
  return '';
}

export function micErrorMessage(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return '没有麦克风权限。请在手机设置里允许这个 App / 浏览器使用麦克风。';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return '找不到麦克风。';
  if (n === 'NotReadableError') return '麦克风正被别的 App 使用，请先关掉它。';
  return '麦克风打不开：' + ((e && e.message) || '未知原因');
}

export class Recorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.raf = 0;
    this.t0 = 0;
  }

  async start({ vad = false, onLevel, onSpeechStart, onAutoStop, maxMs = 120000, silenceMs = 1300, noSpeechMs = 9000 } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ac = audioCtx();
    if (ac.state === 'suspended') await ac.resume().catch(() => {});
    this.src = ac.createMediaStreamSource(this.stream);
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    this.src.connect(an);
    this.analyser = an;
    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mime = this.rec.mimeType || mime || 'audio/webm';
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(250);
    this.t0 = performance.now();
    this.heard = false;
    this.onAutoStop = onAutoStop;

    const data = new Float32Array(an.fftSize);
    let noise = 0.008;
    let lastVoice = 0;
    const loop = () => {
      if (!this.analyser) return;
      an.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      const el = now - this.t0;
      if (el < 400) noise = Math.max(0.004, noise * 0.85 + rms * 0.15);
      const thr = Math.min(0.06, Math.max(0.016, noise * 2.6));
      const voiced = rms > thr;
      onLevel && onLevel(Math.min(1, rms / 0.16), voiced);
      if (vad && el > 250) {
        if (voiced) {
          lastVoice = now;
          if (!this.heard) {
            this.heard = true;
            onSpeechStart && onSpeechStart();
          }
        }
        if (this.heard && now - lastVoice > silenceMs) return this._auto('silence');
        if (!this.heard && el > noSpeechMs) return this._auto('nospeech');
      } else if (voiced && el > 250) {
        this.heard = true;
      }
      if (el > maxMs) return this._auto('max');
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  elapsed() {
    return this.t0 ? (performance.now() - this.t0) / 1000 : 0;
  }

  _auto(reason) {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.onAutoStop) this.onAutoStop(reason);
  }

  stop() {
    return new Promise((resolve) => {
      cancelAnimationFrame(this.raf);
      const rec = this.rec;
      if (!rec || rec.state === 'inactive') {
        this._cleanup();
        resolve(null);
        return;
      }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime });
        this._cleanup();
        resolve(blob);
      };
      try {
        rec.stop();
      } catch {
        this._cleanup();
        resolve(null);
      }
    });
  }

  cancel() {
    cancelAnimationFrame(this.raf);
    try {
      if (this.rec && this.rec.state !== 'inactive') {
        this.rec.onstop = null;
        this.rec.stop();
      }
    } catch {}
    this._cleanup();
  }

  _cleanup() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    try {
      this.src && this.src.disconnect();
    } catch {}
    this.stream = null;
    this.rec = null;
    this.analyser = null;
    this.src = null;
  }
}

// Convert any recorded clip to 16 kHz mono WAV, which every speech-to-text model accepts.
export async function blobToWav16k(blob) {
  const buf = await blob.arrayBuffer();
  const ac = audioCtx();
  const decoded = await new Promise((resolve, reject) => {
    const p = ac.decodeAudioData(buf.slice(0), resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  let rate = 16000;
  let off;
  const len = (r) => Math.max(1, Math.ceil(decoded.duration * r));
  try {
    off = new OfflineAudioContext(1, len(rate), rate);
  } catch {
    rate = 24000;
    off = new OfflineAudioContext(1, len(rate), rate);
  }
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  out.setUint32(4, 36 + pcm.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return { base64: arrayBufferToBase64(out.buffer), seconds: decoded.duration };
}

export function sttLanguage() {
  const l = getSettings().voiceLang;
  return { zh: 'zh', en: 'en', ms: 'ms' }[l] || undefined; // auto and Cantonese: let the model detect
}

export function browserLang() {
  const l = getSettings().voiceLang;
  if (l === 'zh') return 'zh-CN';
  if (l === 'yue') return 'zh-HK';
  if (l === 'en') return 'en-US';
  if (l === 'ms') return 'ms-MY';
  const n = navigator.language || 'zh-CN';
  return n.toLowerCase().startsWith('zh') ? n : 'zh-CN';
}

export async function transcribeBlob(blob, signal) {
  const { base64, seconds } = await blobToWav16k(blob);
  if (seconds < 0.35) return { text: '', seconds };
  const r = await transcribe({ base64, format: 'wav', language: sttLanguage(), signal });
  return { text: r.text, seconds, usage: r.usage };
}

export class BrowserRecognizer {
  start({ onInterim, onEnd, onError, continuous = false } = {}) {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new R();
    r.lang = browserLang();
    r.interimResults = true;
    r.continuous = continuous;
    r.maxAlternatives = 1;
    let finalText = '';
    let interim = '';
    r.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      onInterim && onInterim(finalText + interim);
    };
    r.onerror = (e) => onError && onError(e.error || 'error');
    r.onend = () => onEnd && onEnd((finalText + interim).trim());
    this.r = r;
    r.start();
  }
  stop() {
    try {
      this.r && this.r.stop();
    } catch {}
  }
  abort() {
    try {
      this.r && this.r.abort();
    } catch {}
  }
}

// ---------- read-aloud ----------
export function cleanForSpeech(t) {
  return String(t || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)、]\s+/gm, '')
    .replace(/\|/g, '，')
    .replace(/[*_~>#]/g, '')
    .replace(/\p{Extended_Pictographic}|️/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const END = /([。！？!?；;\n]+|\.(?=\s)|…+)/g;
function visibleLen(s) {
  return s.replace(/\s+/g, '').length;
}

export function splitSentences(buf, final) {
  const ready = [];
  let last = 0;
  let acc = '';
  let m;
  END.lastIndex = 0;
  while ((m = END.exec(buf))) {
    acc += buf.slice(last, m.index + m[0].length);
    last = m.index + m[0].length;
    if (visibleLen(acc) >= 12) {
      ready.push(acc);
      acc = '';
    }
  }
  let rest = acc + buf.slice(last);
  if (rest.length > 240) {
    const cut = Math.max(rest.lastIndexOf('，', 220), rest.lastIndexOf(',', 220), rest.lastIndexOf('、', 220));
    if (cut > 40) {
      ready.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
  }
  if (final && rest.trim()) {
    ready.push(rest);
    rest = '';
  }
  return { ready, rest };
}

function pickBrowserVoice(text) {
  if (!window.speechSynthesis) return null;
  const s = getSettings();
  const voices = speechSynthesis.getVoices() || [];
  const cjk = /[㐀-鿿]/.test(text);
  if (s.browserVoice) {
    const v = voices.find((x) => x.voiceURI === s.browserVoice);
    if (v && (/^zh|^yue|^cmn/i.test(v.lang) === cjk)) return v;
  }
  const want = cjk
    ? s.voiceLang === 'yue'
      ? ['zh-HK', 'yue', 'zh-TW', 'zh-CN', 'zh']
      : ['zh-CN', 'cmn', 'zh-TW', 'zh-HK', 'zh']
    : s.voiceLang === 'ms'
      ? ['ms-MY', 'ms', 'id-ID', 'en-GB', 'en-US', 'en']
      : ['en-US', 'en-GB', 'en-AU', 'en'];
  for (const w of want) {
    const v = voices.find((x) => (x.lang || '').replace('_', '-').toLowerCase().startsWith(w.toLowerCase()));
    if (v) return v;
  }
  return null;
}

export class Speaker {
  constructor() {
    this.items = [];
    this.idx = 0;
    this.buf = '';
    this.gen = 0;
    this.playing = false;
    this.doneFeeding = true;
    this.finished = true;
    this.onend = null;
    this.onstart = null;
    this.onerror = null;
    this.engineOverride = null;
  }

  get engine() {
    if (this.engineOverride) return this.engineOverride;
    const s = getSettings();
    return s.ttsEngine === 'ai' && s.orKey ? 'ai' : 'browser';
  }

  get active() {
    return !this.finished;
  }

  begin() {
    this.stop();
    this.gen++;
    this.buf = '';
    this.items = [];
    this.idx = 0;
    this.doneFeeding = false;
    this.finished = false;
    this.started = false;
    this.ctrl = new AbortController();
  }

  feed(text) {
    if (this.finished) return;
    this.buf += text;
    this._drain(false);
  }

  end() {
    this.doneFeeding = true;
    this._drain(true);
    this._maybeFinish();
  }

  speakText(text) {
    this.begin();
    this.feed(text);
    this.end();
  }

  _drain(final) {
    const { ready, rest } = splitSentences(this.buf, final);
    this.buf = rest;
    for (const t of ready) {
      const clean = cleanForSpeech(t);
      if (clean && /[\p{L}\p{N}]/u.test(clean)) this.items.push({ text: clean, p: null });
    }
    this._prefetch();
    this._pump();
  }

  _prefetch() {
    if (this.engine !== 'ai') return;
    const gen = this.gen;
    for (let i = this.idx; i < Math.min(this.items.length, this.idx + 3); i++) {
      const it = this.items[i];
      if (!it.p) {
        it.p = speak({ text: it.text, signal: this.ctrl && this.ctrl.signal }).catch((e) => {
          if (gen === this.gen) it.err = e;
          return null;
        });
      }
    }
  }

  async _pump() {
    if (this.playing) return;
    this.playing = true;
    const gen = this.gen;
    while (gen === this.gen && this.idx < this.items.length) {
      const it = this.items[this.idx];
      if (!this.started) {
        this.started = true;
        this.onstart && this.onstart();
      }
      if (this.engine === 'ai') {
        this._prefetch();
        const blob = await it.p;
        if (gen !== this.gen) break;
        if (blob) {
          await this._playBlob(blob, gen);
        } else {
          // AI voice failed: fall back to the phone's own voice for the rest of this answer.
          this.engineOverride = 'browser';
          this.onerror && this.onerror(it.err);
          await this._sayBrowser(it.text, gen);
        }
      } else {
        await this._sayBrowser(it.text, gen);
      }
      if (gen !== this.gen) break;
      this.idx++;
    }
    if (gen === this.gen) {
      this.playing = false;
      this._maybeFinish();
    }
  }

  _playBlob(blob, gen) {
    return new Promise((resolve) => {
      const a = audioElement();
      const url = URL.createObjectURL(blob);
      const done = () => {
        a.onended = a.onerror = null;
        URL.revokeObjectURL(url);
        resolve();
      };
      this._halt = done;
      a.onended = done;
      a.onerror = done;
      a.src = url;
      const p = a.play();
      if (p && p.catch) p.catch(() => done());
      if (gen !== this.gen) done();
    });
  }

  _sayBrowser(text, gen) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || gen !== this.gen) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickBrowserVoice(text);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else {
        u.lang = /[㐀-鿿]/.test(text) ? 'zh-CN' : 'en-US';
      }
      u.rate = Math.max(0.6, Math.min(1.6, Number(getSettings().ttsRate) || 1));
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearInterval(guard);
        resolve();
      };
      this._halt = done;
      u.onend = done;
      u.onerror = done;
      // Some phones never fire onend; poll as a safety net.
      const guard = setInterval(() => {
        if (!speechSynthesis.speaking && !speechSynthesis.pending) done();
      }, 400);
      speechSynthesis.speak(u);
    });
  }

  _maybeFinish() {
    if (this.doneFeeding && !this.playing && this.idx >= this.items.length && !this.finished) {
      this.finished = true;
      this.engineOverride = null;
      this.onend && this.onend();
    }
  }

  stop() {
    this.gen++;
    try {
      this.ctrl && this.ctrl.abort();
    } catch {}
    try {
      const a = audioElement();
      a.pause();
    } catch {}
    try {
      window.speechSynthesis && speechSynthesis.cancel();
    } catch {}
    if (this._halt) this._halt();
    this.items = [];
    this.idx = 0;
    this.buf = '';
    this.playing = false;
    this.doneFeeding = true;
    this.engineOverride = null;
    const wasActive = !this.finished;
    this.finished = true;
    return wasActive;
  }
}

export function browserVoices() {
  if (!window.speechSynthesis) return [];
  return (speechSynthesis.getVoices() || []).filter((v) => /^(zh|yue|cmn|en|ms|id)/i.test(v.lang || ''));
}
