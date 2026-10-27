// Settings (localStorage) and conversations (IndexedDB). Everything stays on this phone.

const SETTINGS_KEY = 'wst.settings.v1';

export const DEFAULTS = {
  orKey: '',
  orBase: 'https://openrouter.ai/api/v1',
  chatModel: 'meta/muse-spark-1.3',
  imageModel: 'google/gemini-nano-banana-2.1',
  sttEngine: 'ai', // 'ai' = OpenRouter speech-to-text, 'browser' = phone's built-in
  sttModel: 'qwen/qwen3-asr-1.7b',
  ttsEngine: 'ai', // 'ai' = OpenRouter voices, 'browser' = phone's built-in
  ttsModel: 'google/gemini-3.8-flash-lite-tts',
  ttsVoice: 'Kore',
  ttsRate: 1,
  browserVoice: '',
  voiceLang: 'auto', // auto | zh | yue | en | ms
  autoSendDictation: false,
  autoSpeak: false,
  webMode: 'auto', // auto | off
  thinking: 'auto', // auto | low | high
  panelModels: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-terra', 'google/gemini-3.8-flash'],
  aboutMe: '',
  style: '',
  location: '',
  theme: 'system', // system | light | dark
  customProviders: [], // {id, name, baseUrl, apiKey, models: 'a, b', tools: false}
  recentModels: [],
};

let cache = null;
const listeners = new Set();

export function getSettings() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

export function setSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('settings save failed', e);
  }
  listeners.forEach((fn) => {
    try {
      fn(cache, patch);
    } catch (e) {
      console.error(e);
    }
  });
  return cache;
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function rememberModel(id) {
  const s = getSettings();
  const recent = [id, ...s.recentModels.filter((m) => m !== id)].slice(0, 8);
  setSettings({ recentModels: recent });
}

// ---------- IndexedDB ----------
const DB_NAME = 'wanshitong';
const DB_VER = 1;
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('convos')) {
        const s = db.createObjectStore('convos', { keyPath: 'id' });
        s.createIndex('updated', 'updated');
      }
      if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let out;
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('aborted'));
        out = fn(t);
      })
  );
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listConvos() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('convos', 'readonly');
    const req = t.objectStore('convos').getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.updated - a.updated));
    req.onerror = () => reject(req.error);
  });
}

export async function loadConvo(id) {
  const db = await openDB();
  const t = db.transaction(['convos', 'bodies'], 'readonly');
  const [meta, body] = await Promise.all([reqP(t.objectStore('convos').get(id)), reqP(t.objectStore('bodies').get(id))]);
  if (!meta) return null;
  return { ...meta, messages: (body && body.messages) || [] };
}

function metaOf(c) {
  const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
  return {
    id: c.id,
    title: c.title || '新对话',
    created: c.created,
    updated: c.updated,
    model: c.model,
    count: c.messages.length,
    preview: lastUser ? (lastUser.text || '').slice(0, 60) : '',
  };
}

// Strip transient UI-only fields before saving.
function cleanMessages(messages) {
  return messages.map((m) => {
    const { _live, _ctrl, ...rest } = m;
    return rest;
  });
}

export async function saveConvo(c) {
  if (!c || !c.messages.length) return;
  const meta = metaOf(c);
  await tx(['convos', 'bodies'], 'readwrite', (t) => {
    t.objectStore('convos').put(meta);
    t.objectStore('bodies').put({ id: c.id, messages: cleanMessages(c.messages) });
  });
}

export async function deleteConvo(id) {
  await tx(['convos', 'bodies'], 'readwrite', (t) => {
    t.objectStore('convos').delete(id);
    t.objectStore('bodies').delete(id);
  });
}

export async function clearAllConvos() {
  await tx(['convos', 'bodies'], 'readwrite', (t) => {
    t.objectStore('convos').clear();
    t.objectStore('bodies').clear();
  });
}

export async function exportAll({ includeKey = false } = {}) {
  const metas = await listConvos();
  const convos = [];
  for (const m of metas) {
    const c = await loadConvo(m.id);
    if (c) convos.push(c);
  }
  const settings = { ...getSettings() };
  if (!includeKey) {
    settings.orKey = '';
    settings.customProviders = (settings.customProviders || []).map((p) => ({ ...p, apiKey: '' }));
  }
  return { app: 'wanshitong', version: 1, exported: new Date().toISOString(), settings, convos };
}

export async function importAll(data) {
  if (!data || data.app !== 'wanshitong' || !Array.isArray(data.convos)) throw new Error('这不是万事通的备份文件');
  let n = 0;
  for (const c of data.convos) {
    if (c && c.id && Array.isArray(c.messages)) {
      await saveConvo(c);
      n++;
    }
  }
  if (data.settings) {
    const cur = getSettings();
    const incoming = { ...data.settings };
    if (!incoming.orKey) incoming.orKey = cur.orKey;
    if (Array.isArray(incoming.customProviders)) {
      incoming.customProviders = incoming.customProviders.map((p) => {
        const existing = (cur.customProviders || []).find((q) => q.id === p.id);
        return { ...p, apiKey: p.apiKey || (existing && existing.apiKey) || '' };
      });
    }
    setSettings({ ...cur, ...incoming });
  }
  return n;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch {}
  return null;
}

export async function askPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) await navigator.storage.persist();
    }
  } catch {}
}
