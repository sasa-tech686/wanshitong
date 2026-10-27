// All network calls: chat (streaming), images, speech-to-text, text-to-speech, key info.
import { getSettings } from './store.js';
import { parseRef } from './models.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function endpointFor(ref) {
  const s = getSettings();
  const r = parseRef(ref);
  if (r.kind === 'custom') {
    if (!r.provider) throw new ApiError('找不到这个自定义服务（可能已删除），请换一个模型。', { code: 'noprovider' });
    return {
      base: String(r.provider.baseUrl || '').replace(/\/+$/, ''),
      key: r.provider.apiKey || '',
      model: r.model,
      isOR: false,
      name: r.provider.name || '自定义服务',
    };
  }
  if (!s.orKey) throw new ApiError('还没填 OpenRouter 钥匙，请到「设置」填入。', { code: 'nokey' });
  return { base: s.orBase.replace(/\/+$/, ''), key: s.orKey.trim(), model: r.id, isOR: true, name: 'OpenRouter' };
}

// No app-attribution headers and no referrer: this is a private app, so nothing about it is announced to the AI service.
function headers(ep, json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (ep.key) h['Authorization'] = 'Bearer ' + ep.key;
  return h;
}
const NOREF = { referrerPolicy: 'no-referrer' };

export function friendlyError(status, msg, ep) {
  const m = (msg || '').trim();
  const who = ep && ep.isOR === false ? ep.name : 'OpenRouter';
  switch (status) {
    case 400:
      return '请求有问题：' + (m || '格式不对');
    case 401:
      return `${who} 钥匙不对或已失效，请到「设置」检查。`;
    case 402:
      return '余额不足，请到 OpenRouter 充值（openrouter.ai/credits）。';
    case 403:
      return '请求被拒绝了（可能是内容审核）' + (m ? '：' + m : '');
    case 404:
      return '找不到这个模型或服务' + (m ? '：' + m : '');
    case 408:
    case 504:
    case 524:
      return '对方服务器超时，请再试一次。';
    case 413:
      return '内容太大（图片或文件太多），请少放一些。';
    case 429:
      return '太频繁或模型太忙，等几秒再试。';
    case 500:
    case 502:
    case 503:
      return '模型服务暂时出错，请再试，或换一个模型。' + (m ? `（${m.slice(0, 160)}）` : '');
    default:
      return m || `出错了（${status}）`;
  }
}

async function readError(res, ep) {
  let msg = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      msg = (j && j.error && (j.error.message || j.error)) || j.message || text;
      const raw = j && j.error && j.error.metadata && j.error.metadata.raw;
      if (raw && typeof raw === 'string' && raw.length < 300 && !msg.includes(raw)) msg += ' ' + raw;
    } catch {
      msg = text;
    }
  } catch {}
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  return new ApiError(friendlyError(res.status, msg.slice(0, 300), ep), {
    status: res.status,
    retryable: [408, 429, 500, 502, 503, 504, 524].includes(res.status),
  });
}

function netError(e) {
  if (e && e.name === 'AbortError') return e;
  return new ApiError('连不上网络。请检查网络；如果用的是自定义服务，它可能不允许手机网页直接连接。', {
    code: 'network',
    retryable: true,
  });
}

function blankOut() {
  return {
    content: '',
    reasoning: '',
    reasoningDetails: [],
    toolCalls: [],
    finishReason: null,
    usage: null,
    annotations: [],
    images: [],
    model: null,
    id: null,
  };
}

function partsText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.type === 'text' ? p.text || '' : '')).join('');
  return '';
}

function applyMessage(out, j) {
  out.id = j.id || out.id;
  out.model = j.model || out.model;
  if (j.usage) out.usage = j.usage;
  const ch = j.choices && j.choices[0];
  if (!ch) return;
  const m = ch.message || ch.delta || {};
  out.content += partsText(m.content);
  out.reasoning += m.reasoning || m.reasoning_content || '';
  if (Array.isArray(m.reasoning_details)) out.reasoningDetails.push(...m.reasoning_details);
  if (Array.isArray(m.tool_calls)) out.toolCalls.push(...m.tool_calls);
  if (Array.isArray(m.images)) for (const im of m.images) pushImage(out, im);
  if (Array.isArray(m.annotations)) out.annotations.push(...m.annotations);
  out.finishReason = ch.finish_reason || out.finishReason;
}

function pushImage(out, im) {
  const url = (im && im.image_url && (im.image_url.url || im.image_url)) || (im && im.url) || (typeof im === 'string' ? im : null);
  if (url && typeof url === 'string') out.images.push(url);
}

// Merge streamed reasoning fragments back into whole blocks (same type + index).
export function mergeReasoningDetails(items) {
  const out = [];
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    const last = out[out.length - 1];
    if (last && it.index != null && last.index === it.index && last.type === it.type) {
      for (const k of ['text', 'summary', 'data']) if (typeof it[k] === 'string') last[k] = (last[k] || '') + it[k];
      if (it.signature) last.signature = it.signature;
      if (it.id && !last.id) last.id = it.id;
      if (it.format && !last.format) last.format = it.format;
    } else {
      out.push({ ...it });
    }
  }
  return out;
}

/**
 * Stream a chat completion. Calls onDelta({content, reasoning, tool, images, annotations}) as data arrives.
 * Returns the collected result.
 */
export async function streamChat({ ref, messages, tools, extra = {}, signal, onDelta, onKeepAlive }) {
  const ep = endpointFor(ref);
  const body = { model: ep.model, messages, stream: true, ...extra };
  if (tools && tools.length) body.tools = tools;
  let res;
  try {
    res = await fetch(ep.base + '/chat/completions', {
      method: 'POST',
      headers: headers(ep),
      body: JSON.stringify(body),
      signal,
      ...NOREF,
    });
  } catch (e) {
    throw netError(e);
  }
  if (!res.ok) throw await readError(res, ep);

  const out = blankOut();
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    const j = await res.json().catch(() => ({}));
    if (j.error) throw new ApiError(friendlyError(Number(j.error.code) || 500, j.error.message, ep), { retryable: true });
    applyMessage(out, j);
    out.reasoningDetails = mergeReasoningDetails(out.reasoningDetails);
    if (out.content || out.reasoning) onDelta && onDelta({ content: out.content, reasoning: out.reasoning });
    if (out.images.length) onDelta && onDelta({ images: true });
    return finishToolCalls(out, new Map(out.toolCalls.map((t, i) => [i, t])));
  }

  const tcMap = new Map();
  let finished = false;

  const handle = (payload) => {
    if (payload === '[DONE]') {
      finished = true;
      return;
    }
    let j;
    try {
      j = JSON.parse(payload);
    } catch {
      return false; // incomplete; caller may retry with more data lines
    }
    if (j.error) {
      const code = Number(j.error.code) || 500;
      throw new ApiError(friendlyError(code, j.error.message || '模型中途出错了', ep), { status: code, retryable: true });
    }
    out.id = out.id || j.id;
    out.model = out.model || j.model;
    if (j.usage) out.usage = j.usage;
    const ch = j.choices && j.choices[0];
    if (!ch) return true;
    const d = ch.delta || ch.message || {};
    const delta = {};
    const txt = partsText(d.content);
    if (txt) {
      out.content += txt;
      delta.content = txt;
    }
    const r = d.reasoning || d.reasoning_content;
    if (r) {
      out.reasoning += r;
      delta.reasoning = r;
    }
    if (Array.isArray(d.reasoning_details)) out.reasoningDetails.push(...d.reasoning_details);
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index != null ? tc.index : tcMap.size;
        let cur = tcMap.get(idx);
        if (!cur) {
          cur = { id: '', type: 'function', function: { name: '', arguments: '' } };
          tcMap.set(idx, cur);
        }
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        const fn = tc.function || {};
        if (fn.name) {
          if (!cur.function.name) cur.function.name = fn.name;
          else if (cur.function.name !== fn.name) cur.function.name += fn.name;
        }
        if (fn.arguments) cur.function.arguments += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
      }
      delta.tool = true;
    }
    if (Array.isArray(d.images)) {
      for (const im of d.images) pushImage(out, im);
      delta.images = true;
    }
    const ann = d.annotations || (ch.message && ch.message.annotations);
    if (Array.isArray(ann)) {
      out.annotations.push(...ann);
      delta.annotations = true;
    }
    if (ch.finish_reason) out.finishReason = ch.finish_reason;
    if (Object.keys(delta).length && onDelta) onDelta(delta);
    return true;
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pending = [];
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (pending.length) {
            const p = pending.join('\n');
            pending = [];
            handle(p);
          }
          continue;
        }
        if (line.startsWith(':')) {
          onKeepAlive && onKeepAlive(line);
          continue;
        }
        if (line.startsWith('data:')) {
          const data = line.slice(5).replace(/^ /, '');
          if (pending.length) pending.push(data);
          else if (handle(data) === false) pending.push(data);
        }
        if (finished) break;
      }
    }
    if (!finished) {
      if (buf.trim().startsWith('data:')) pending.push(buf.trim().slice(5).trim());
      if (pending.length) handle(pending.join('\n'));
    }
  } catch (e) {
    try {
      reader.cancel();
    } catch {}
    if (e && (e.name === 'AbortError' || e instanceof ApiError)) throw e;
    throw netError(e);
  }
  out.reasoningDetails = mergeReasoningDetails(out.reasoningDetails);
  return finishToolCalls(out, tcMap);
}

function finishToolCalls(out, tcMap) {
  out.toolCalls = Array.from(tcMap.values())
    .filter((t) => t && t.function && t.function.name)
    .map((t, i) => ({ ...t, id: t.id || `call_${Date.now().toString(36)}_${i}` }));
  return out;
}

export async function chatOnce({ ref, messages, extra = {}, signal }) {
  const ep = endpointFor(ref);
  const body = { model: ep.model, messages, stream: false, ...extra };
  let res;
  try {
    res = await fetch(ep.base + '/chat/completions', { method: 'POST', headers: headers(ep), body: JSON.stringify(body), signal, ...NOREF });
  } catch (e) {
    throw netError(e);
  }
  if (!res.ok) throw await readError(res, ep);
  const j = await res.json().catch(() => ({}));
  if (j.error) throw new ApiError(friendlyError(Number(j.error.code) || 500, j.error.message, ep), { retryable: true });
  const out = blankOut();
  applyMessage(out, j);
  out.reasoningDetails = mergeReasoningDetails(out.reasoningDetails);
  return finishToolCalls(out, new Map(out.toolCalls.map((t, i) => [i, t])));
}

/** Create or edit an image with the image model chosen in settings. refs = data URLs to edit from. */
export async function generateImage({ prompt, aspect = '1:1', refs = [], signal }) {
  const s = getSettings();
  const content = [{ type: 'text', text: prompt }];
  for (const u of refs) content.push({ type: 'image_url', image_url: { url: u } });
  const extra = { modalities: ['image', 'text'] };
  if (aspect) extra.image_config = { aspect_ratio: aspect };
  let out;
  try {
    out = await chatOnce({ ref: s.imageModel, messages: [{ role: 'user', content }], extra, signal });
  } catch (e) {
    // Some image models don't take the aspect-ratio option; try once without it.
    if (!(e instanceof ApiError) || e.status !== 400 || !extra.image_config) throw e;
    delete extra.image_config;
    out = await chatOnce({ ref: s.imageModel, messages: [{ role: 'user', content }], extra, signal });
  }
  if (!out.images.length) {
    const why = out.content ? '：' + out.content.slice(0, 160) : '，请换个说法再试。';
    throw new ApiError('画图模型没有给出图片' + why, { code: 'noimage' });
  }
  return out;
}

/** Speech to text. base64 = raw audio bytes (no data: prefix). */
export async function transcribe({ base64, format = 'wav', language, signal }) {
  const s = getSettings();
  const ep = endpointFor(s.sttModel);
  const body = { model: s.sttModel, input_audio: { data: base64, format } };
  if (language) body.language = language;
  let res;
  try {
    res = await fetch(ep.base + '/audio/transcriptions', { method: 'POST', headers: headers(ep), body: JSON.stringify(body), signal, ...NOREF });
  } catch (e) {
    throw netError(e);
  }
  if (!res.ok) throw await readError(res, ep);
  const j = await res.json().catch(() => ({}));
  return { text: String(j.text || '').trim(), usage: j.usage || null };
}

/** Text to speech. Returns an audio Blob. */
export async function speak({ text, signal }) {
  const s = getSettings();
  const ep = endpointFor(s.ttsModel);
  const body = { model: s.ttsModel, input: text, voice: s.ttsVoice, response_format: 'mp3' };
  if (s.ttsRate && Number(s.ttsRate) !== 1) body.speed = Number(s.ttsRate);
  let res;
  try {
    res = await fetch(ep.base + '/audio/speech', { method: 'POST', headers: headers(ep), body: JSON.stringify(body), signal, ...NOREF });
  } catch (e) {
    throw netError(e);
  }
  if (!res.ok) throw await readError(res, ep);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const buf = await res.arrayBuffer();
  if (ct.includes('pcm') || ct.includes('l16')) return pcm16ToWav(buf, 24000);
  return new Blob([buf], { type: ct.startsWith('audio/') ? ct.split(';')[0] : 'audio/mpeg' });
}

function pcm16ToWav(buf, rate) {
  const data = new Uint8Array(buf);
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + data.length, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, data.length, true);
  return new Blob([header, data], { type: 'audio/wav' });
}

/** Key balance/usage from OpenRouter. */
export async function keyInfo(signal) {
  const ep = endpointFor('openrouter/auto');
  let res;
  try {
    res = await fetch(ep.base + '/key', { headers: headers(ep, false), signal, ...NOREF });
  } catch (e) {
    throw netError(e);
  }
  if (!res.ok) throw await readError(res, ep);
  const j = await res.json();
  return j.data || j;
}

/** Quick connectivity test for a custom OpenAI-compatible service. */
export async function testCustom(provider, model) {
  const ep = { base: String(provider.baseUrl || '').replace(/\/+$/, ''), key: provider.apiKey || '', isOR: false, name: provider.name };
  const body = { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, stream: false };
  let res;
  try {
    res = await fetch(ep.base + '/chat/completions', { method: 'POST', headers: headers(ep), body: JSON.stringify(body), ...NOREF });
  } catch (e) {
    throw netError(e);
  }
  if (!res.ok) throw await readError(res, ep);
  return true;
}
