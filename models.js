// Model catalog: curated picks plus the live OpenRouter list.
import { getSettings } from './store.js';

// Hand-picked chat models (checked against OpenRouter's list on 27 Oct 2026).
export const QUICK = [
  { id: 'meta/muse-spark-1.3', name: 'Muse Spark 1.3', by: 'Meta', blurb: '像 Muse：看图、看视频、读文件，均衡好用' },
  { id: 'meta/muse-wonder', name: 'Muse Wonder', by: 'Meta', blurb: 'Meta 最强的 Muse，适合复杂任务，较贵' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', by: 'Anthropic', blurb: '写作、分析、办事最稳' },
  { id: 'openai/gpt-6.1-terra', name: 'GPT-6.1 Terra', by: 'OpenAI', blurb: 'OpenAI 最新的全能型' },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', by: 'Google', blurb: '快，能看视频、听录音' },
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', by: 'Anthropic', blurb: '便宜又快的 Claude' },
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', by: 'OpenAI', blurb: '便宜又快的 GPT' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', by: 'DeepSeek', blurb: '超便宜，中文好' },
  { id: 'qwen/qwen3.8-flash', name: '通义千问 3.8 Flash', by: 'Alibaba', blurb: '中文好，便宜' },
];

export const IMAGE_MODELS = [
  { id: 'google/gemini-nano-banana-2.1', name: 'Nano Banana 2.1', blurb: 'Google 最新画图模型，也会改照片' },
  { id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2', blurb: '画质好，也会改照片，较贵' },
  { id: 'openai/gpt-5-image-mini', name: 'GPT Image Mini', blurb: '最省钱' },
  { id: 'openai/gpt-5.4-image-2', name: 'GPT Image 2', blurb: '图里的文字排得最准，最贵' },
];

export const STT_MODELS = [
  { id: 'qwen/qwen3-asr-1.7b', name: '通义 ASR', blurb: '普通话、粤语等方言都听得懂，最便宜' },
  { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe', blurb: '中英夹杂讲得准' },
  { id: 'meta/muse-voice-transcribe-1.0', name: 'Muse Voice', blurb: 'Meta 的语音转文字' },
  { id: 'openai/whisper-large-v3-turbo', name: 'Whisper Turbo', blurb: '快，99 种语言' },
];

export const TTS_MODELS = [
  {
    id: 'google/gemini-3.8-flash-lite-tts',
    name: 'Gemini 声音',
    blurb: '自然，会讲中文、英文',
    voices: ['Kore', 'Leda', 'Aoede', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'],
  },
  {
    id: 'google/gemini-3.8-flash-tts',
    name: 'Gemini 高音质',
    blurb: '更自然，稍贵',
    voices: ['Kore', 'Leda', 'Aoede', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'],
  },
  { id: 'qwen/qwen-audio-3.0-tts-flash', name: '通义声音', blurb: '中文更地道', voices: ['longanhuan_v3.6', 'loongjohn'] },
];

export const VOICE_LABELS = {
  Kore: 'Kore（女，稳重）',
  Leda: 'Leda（女，年轻）',
  Aoede: 'Aoede（女，轻快）',
  Zephyr: 'Zephyr（女，明亮）',
  Puck: 'Puck（男，活泼）',
  Charon: 'Charon（男，沉稳）',
  Fenrir: 'Fenrir（男，有力）',
  Orus: 'Orus（男，厚实）',
  'longanhuan_v3.6': '龙安欢（女）',
  loongjohn: 'John（男）',
};

// ---------- live catalog ----------
const CAT_KEY = 'wst.catalog.v1';
const CAT_TTL = 12 * 3600 * 1000;
let catalog = null; // Map id -> slim model

function slim(m) {
  const per = (v) => (v == null || v === '' ? null : Number(v) * 1e6);
  const sp = m.supported_parameters || [];
  const a = m.architecture || {};
  return {
    id: m.id,
    name: m.name || m.id,
    ctx: m.context_length || 0,
    in: a.input_modalities || ['text'],
    out: a.output_modalities || ['text'],
    p: per(m.pricing && m.pricing.prompt),
    c: per(m.pricing && m.pricing.completion),
    img: m.pricing && m.pricing.image_output ? Number(m.pricing.image_output) * 1e6 : null,
    ws: m.pricing && m.pricing.web_search ? Number(m.pricing.web_search) : null,
    tools: sp.includes('tools'),
    reasoning: sp.includes('reasoning') || sp.includes('include_reasoning'),
    created: m.created || 0,
    desc: (m.description || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAT_KEY) || 'null');
    if (raw && Array.isArray(raw.models)) return raw;
  } catch {}
  return null;
}

export function getCatalog() {
  if (catalog) return catalog;
  const raw = readCache();
  if (raw) catalog = new Map(raw.models.map((m) => [m.id, m]));
  return catalog || new Map();
}

export async function loadCatalog({ force = false } = {}) {
  const raw = readCache();
  if (!force && raw && Date.now() - raw.ts < CAT_TTL) {
    catalog = new Map(raw.models.map((m) => [m.id, m]));
    return catalog;
  }
  const base = getSettings().orBase.replace(/\/+$/, '');
  const res = await fetch(base + '/models', { referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error('拿不到模型列表（' + res.status + '）');
  const json = await res.json();
  const models = (json.data || []).map(slim);
  catalog = new Map(models.map((m) => [m.id, m]));
  try {
    localStorage.setItem(CAT_KEY, JSON.stringify({ ts: Date.now(), models }));
  } catch {}
  return catalog;
}

// ---------- model references ----------
// OpenRouter models use their id ("meta/muse-spark-1.3").
// Custom services use "@<providerId>:<model>".
export function parseRef(ref) {
  if (ref && ref.startsWith('@')) {
    const i = ref.indexOf(':');
    const providerId = ref.slice(1, i);
    const model = ref.slice(i + 1);
    const provider = (getSettings().customProviders || []).find((p) => p.id === providerId) || null;
    return { kind: 'custom', providerId, model, provider };
  }
  return { kind: 'or', id: ref };
}

export function customRefs() {
  const out = [];
  for (const p of getSettings().customProviders || []) {
    for (const m of String(p.models || '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      out.push({ ref: `@${p.id}:${m}`, name: m, provider: p });
    }
  }
  return out;
}

export function displayName(ref) {
  if (!ref) return '';
  const r = parseRef(ref);
  if (r.kind === 'custom') return r.model + (r.provider ? ' · ' + r.provider.name : '');
  const q = QUICK.find((x) => x.id === ref) || IMAGE_MODELS.find((x) => x.id === ref);
  if (q) return q.name;
  const m = getCatalog().get(ref);
  if (m) return m.name.replace(/^[^:]{1,30}:\s*/, '');
  return ref.split('/').pop();
}

export function caps(ref) {
  const r = parseRef(ref);
  if (r.kind === 'custom') {
    return { vision: true, audio: false, file: false, tools: !!(r.provider && r.provider.tools), reasoning: false, imageOut: false, known: true, custom: true };
  }
  const m = getCatalog().get(ref);
  if (!m) return { vision: true, audio: false, file: false, tools: true, reasoning: false, imageOut: false, known: false };
  return {
    vision: m.in.includes('image'),
    audio: m.in.includes('audio'),
    video: m.in.includes('video'),
    file: m.in.includes('file'),
    tools: m.tools,
    reasoning: m.reasoning,
    imageOut: m.out.includes('image'),
    known: true,
  };
}

export function priceLine(m) {
  if (!m) return '';
  if (m.p == null && m.c == null) return '';
  if (m.p < 0 || m.c < 0) return '价格看情况';
  if (m.p === 0 && m.c === 0) return '免费';
  const f = (v) => String(Number(v >= 10 ? v.toFixed(1) : v.toFixed(2)));
  return `入 $${f(m.p)} · 出 $${f(m.c)} /百万`;
}

export function costTier(m) {
  if (!m || m.c == null || m.c < 0) return '';
  const blended = (m.p || 0) * 0.7 + (m.c || 0) * 0.3;
  if (blended === 0) return '免费';
  if (blended < 0.5) return '$';
  if (blended < 3) return '$$';
  if (blended < 8) return '$$$';
  return '$$$$';
}

export function badges(m) {
  if (!m) return [];
  const b = [];
  if (m.in.includes('image')) b.push('看图');
  if (m.in.includes('audio')) b.push('听音');
  if (m.in.includes('video')) b.push('看视频');
  if (m.out.includes('image')) b.push('画图');
  if (m.tools) b.push('能上网');
  return b;
}

export function searchCatalog(q, limit = 80) {
  const all = Array.from(getCatalog().values()).filter((m) => m.out.includes('text') && !m.id.endsWith(':batch'));
  const s = (q || '').trim().toLowerCase();
  let list = all;
  if (s) {
    const terms = s.split(/\s+/);
    list = all.filter((m) => terms.every((t) => (m.id + ' ' + m.name).toLowerCase().includes(t)));
  }
  list.sort((a, b) => b.created - a.created);
  return list.slice(0, limit);
}
