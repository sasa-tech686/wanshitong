// 万事通 — app controller: chat screen, composer, drawer, sheets, settings, voice conversation.
import { $, $$, uid, esc, toast, copyText, relTime, debounce, saveImage, fmtClock, fmtUSD, isIOS, isStandalone } from './util.js';
import {
  getSettings,
  setSettings,
  rememberModel,
  listConvos,
  loadConvo,
  saveConvo,
  deleteConvo,
  clearAllConvos,
  exportAll,
  importAll,
  askPersistentStorage,
  storageEstimate,
} from './store.js';
import {
  QUICK,
  IMAGE_MODELS,
  STT_MODELS,
  TTS_MODELS,
  VOICE_LABELS,
  loadCatalog,
  getCatalog,
  displayName,
  priceLine,
  badges,
  searchCatalog,
  customRefs,
  parseRef,
} from './models.js';
import { keyInfo, testCustom } from './api.js';
import { processFile, attSummary } from './files.js';
import { runTurn, textOf, ASPECTS } from './agent.js';
import { userEl, assistantEl, updateAssistant, ICON } from './render.js';
import {
  Recorder,
  transcribeBlob,
  BrowserRecognizer,
  browserSTTSupported,
  micSupported,
  micErrorMessage,
  Speaker,
  unlockAudio,
  browserVoices,
} from './voice.js';

const APP_VERSION = '1.0.0';
const MAX_ATTS = 10;

const state = {
  convo: null,
  busy: false,
  ctrl: null,
  pendingAtts: [],
  mode: { draw: false, web: false, consult: false, aspect: '1:1' },
  els: new Map(),
  stickBottom: true,
  onTurnUpdate: null,
};
const speaker = new Speaker();

// ---------------------------------------------------------------- helpers
const curModel = () => (state.convo && state.convo.model) || getSettings().chatModel;
const lastAssistant = () => [...state.convo.messages].reverse().find((m) => m.role === 'assistant');
const findMsg = (id) => state.convo.messages.find((m) => m.id === id);

function newConvo() {
  const now = Date.now();
  return { id: uid('c'), title: '', created: now, updated: now, model: getSettings().chatModel, messages: [] };
}

function makeTitle(text, atts) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 28);
  if (atts && atts[0]) return atts[0].kind === 'image' ? '看图' : atts[0].name;
  return '新对话';
}

// ---------------------------------------------------------------- layout
function setupViewport() {
  const vv = window.visualViewport;
  const app = $('#app');
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
    app.style.transform = vv && vv.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : '';
    document.body.classList.toggle('kb-open', !!vv && window.innerHeight - vv.height > 140);
    if (state.stickBottom && state.convo && state.convo.messages.length) scrollToBottom(false);
  };
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('resize', apply);
  apply();
  const wrap = $('.composer-wrap');
  const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', wrap.offsetHeight + 'px'));
  ro.observe(wrap);
}

function scrollToBottom(smooth = true) {
  const c = $('#chat');
  c.scrollTo({ top: c.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function onChatScroll() {
  const c = $('#chat');
  const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
  state.stickBottom = dist < 80;
  $('#btnScrollDown').hidden = dist < 240 || !(state.convo && state.convo.messages.length);
  $('.topbar').classList.toggle('scrolled', c.scrollTop > 4);
}

function applyTheme() {
  const t = getSettings().theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
}

// ---------------------------------------------------------------- rendering
function isLastAssistant(m) {
  return lastAssistant() === m;
}

function makeEl(m) {
  const el = m.role === 'user' ? userEl(m) : assistantEl(m);
  if (m.role === 'assistant') updateAssistant(el, m, { isLast: isLastAssistant(m) });
  state.els.set(m.id, el);
  return el;
}

function renderAll() {
  const box = $('#msgs');
  box.innerHTML = '';
  state.els.clear();
  const frag = document.createDocumentFragment();
  for (const m of state.convo.messages) frag.appendChild(makeEl(m));
  box.appendChild(frag);
  updateEmpty();
  refreshModelChip();
  state.stickBottom = true;
  requestAnimationFrame(() => {
    if (state.convo.messages.length) scrollToBottom(false);
    else $('#chat').scrollTop = 0;
    onChatScroll();
  });
}

function refreshLastFlags() {
  for (const m of state.convo.messages) {
    if (m.role !== 'assistant') continue;
    const el = state.els.get(m.id);
    if (el) el.classList.toggle('is-last', isLastAssistant(m));
    const regen = el && el.querySelector('[data-action="regen"]');
    if (regen) regen.hidden = !isLastAssistant(m);
  }
}

function updateEmpty() {
  const empty = !state.convo.messages.length;
  $('#empty').hidden = !empty;
  $('#setupCard').hidden = !!getSettings().orKey;
}

let rafPending = false;
function scheduleUpdate(asst) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const el = state.els.get(asst.id);
    if (el) updateAssistant(el, asst, { isLast: true });
    if (state.stickBottom) scrollToBottom(false);
  });
}

function refreshModelChip() {
  const name = state.mode.draw ? '🎨 ' + displayName(getSettings().imageModel) : displayName(curModel());
  $('#modelName').textContent = name || '选择模型';
}

function renderSuggestions() {
  const items = [
    { k: '上网', b: '今天有什么科技新闻？', s: '它会自己上网查，附上来源', act: 'send' },
    { k: '画图', b: '画一张咖啡店开张海报', s: '海报上写「开张大吉」', act: 'send', text: '画一张咖啡店开张海报，竖版，海报上写「开张大吉」' },
    { k: '拍照', b: '拍张单据，整理成表格', s: '打开相机', act: 'camera', text: '帮我把这张单据整理成表格，列出日期、项目、金额和总数。' },
    { k: '写作', b: '用英文回复客户', s: '贴上客户的话，语气礼貌简短', act: 'fill', text: '用英文帮我回复这段客户消息，语气礼貌、简短：\n' },
  ];
  $('#suggest').innerHTML = items
    .map(
      (it, i) => `<button type="button" class="sugg" data-sugg="${i}"><span class="k">${esc(it.k)}</span><b>${esc(it.b)}</b><small>${esc(it.s)}</small></button>`
    )
    .join('');
  $('#suggest').onclick = (e) => {
    const b = e.target.closest('[data-sugg]');
    if (!b) return;
    const it = items[Number(b.dataset.sugg)];
    if (!getSettings().orKey) {
      $('#setupKey').focus();
      toast('先填 OpenRouter 钥匙');
      return;
    }
    if (it.act === 'send') send(it.text || it.b);
    else if (it.act === 'fill') {
      setInput(it.text);
      $('#input').focus();
    } else if (it.act === 'camera') {
      setInput(it.text);
      $('#fileCamera').click();
    }
  };
}

// ---------------------------------------------------------------- composer
function setInput(v) {
  const ta = $('#input');
  ta.value = v;
  autosize();
  updateSendState();
}

function autosize() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}

function updateSendState() {
  const has = $('#input').value.trim().length > 0 || state.pendingAtts.length > 0;
  $('#btnSend').hidden = state.busy || !has;
  $('#btnStop').hidden = !state.busy;
  $('#btnMic').hidden = state.busy || has;
  $('#btnVoice').hidden = state.busy || has;
}

function setBusyUI(b) {
  state.busy = b;
  updateSendState();
}

function renderModeChips() {
  const m = state.mode;
  const chips = [];
  const x = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  if (m.draw)
    chips.push(
      `<span class="mchip">🎨 画图 <select id="aspectSel" aria-label="比例">${ASPECTS.map(
        (a) => `<option value="${a}" ${a === m.aspect ? 'selected' : ''}>${a === '1:1' ? '方形 1:1' : a === '9:16' ? '竖屏 9:16' : a === '16:9' ? '横幅 16:9' : a === '3:4' ? '海报 3:4' : a}</option>`
      ).join('')}</select><button type="button" class="x" data-mode-off="draw" aria-label="关闭画图模式">${x}</button></span>`
    );
  if (m.web) chips.push(`<span class="mchip">🌐 一定上网<button type="button" class="x" data-mode-off="web" aria-label="关闭">${x}</button></span>`);
  if (m.consult) chips.push(`<span class="mchip">🧠 多 AI 会诊<button type="button" class="x" data-mode-off="consult" aria-label="关闭">${x}</button></span>`);
  const box = $('#modeChips');
  box.innerHTML = chips.join('');
  box.hidden = !chips.length;
  const sel = $('#aspectSel');
  if (sel) sel.onchange = () => (state.mode.aspect = sel.value);
  $('#input').placeholder = m.draw ? '想画什么？' : m.consult ? '想问大家什么？' : '问万事通…';
  $$('#sheetPlus .mode-item').forEach((b) => b.classList.toggle('on', !!m[b.dataset.mode]));
  refreshModelChip();
}

function toggleMode(name, on) {
  const m = state.mode;
  m[name] = on === undefined ? !m[name] : on;
  if (name === 'draw' && m.draw) m.consult = false;
  if (name === 'consult' && m.consult) m.draw = false;
  renderModeChips();
}

function renderAtts() {
  const row = $('#attRow');
  const x = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  row.innerHTML = state.pendingAtts
    .map((a) => {
      const rm = `<button type="button" class="rm" data-rm="${a.id}" aria-label="移除">${x}</button>`;
      if (a.busy) return `<div class="att busy ${a.kind === 'doc' ? 'doc' : ''}">${rm}<span class="spin">${esc(a.status || '处理中…')}</span></div>`;
      if (a.kind === 'image') return `<div class="att">${rm}<img src="${a.dataUrl}" alt="${esc(a.name)}"></div>`;
      return `<div class="att doc">${rm}${ICON.file}<div><b>${esc(a.name)}</b><span>${esc(attSummary(a))}</span></div></div>`;
    })
    .join('');
  row.hidden = !state.pendingAtts.length;
  updateSendState();
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const f of files) {
    if (state.pendingAtts.length >= MAX_ATTS) {
      toast(`一次最多 ${MAX_ATTS} 个附件`);
      break;
    }
    const tmp = { id: uid('a'), busy: true, name: f.name, kind: (f.type || '').startsWith('image/') ? 'image' : 'doc', status: '处理中…' };
    state.pendingAtts.push(tmp);
    renderAtts();
    try {
      const att = await processFile(f, (st) => {
        tmp.status = st;
        renderAtts();
      });
      if (!state.pendingAtts.includes(tmp)) continue; // removed meanwhile
      Object.assign(tmp, att, { id: tmp.id, busy: false, status: '' });
    } catch (e) {
      console.error(e);
      state.pendingAtts = state.pendingAtts.filter((a) => a !== tmp);
      toast((e && e.message) || '文件处理失败', 4200);
    }
    renderAtts();
  }
}

function stripAtt(a) {
  const { busy, status, ...rest } = a;
  return rest;
}

// ---------------------------------------------------------------- sending
async function send(textOverride, { voice = false } = {}) {
  if (state.busy) return;
  const s = getSettings();
  const ta = $('#input');
  const text = (textOverride != null ? String(textOverride) : ta.value).trim();
  if (state.pendingAtts.some((a) => a.busy)) {
    toast('文件还在处理，请稍等');
    return;
  }
  const atts = state.pendingAtts.map(stripAtt);
  if (!text && !atts.length) return;
  const mode = { ...state.mode, voice };
  const modelRef = mode.draw ? s.imageModel : curModel();
  if (!s.orKey && (mode.draw || parseRef(modelRef).kind === 'or')) {
    showSetup();
    toast('请先填入 OpenRouter 钥匙');
    return;
  }
  unlockAudio();
  const user = { id: uid('m'), role: 'user', text, atts, created: Date.now() };
  if (mode.draw || mode.consult || mode.web) user.mode = { draw: mode.draw, consult: mode.consult, web: mode.web, aspect: mode.aspect };
  const asst = { id: uid('m'), role: 'assistant', parts: [], model: modelRef, created: Date.now(), status: 'streaming' };
  if (!state.convo.title) state.convo.title = makeTitle(text, atts);
  state.convo.messages.push(user, asst);
  if (textOverride == null) setInput('');
  state.pendingAtts = [];
  renderAtts();
  const box = $('#msgs');
  box.appendChild(makeEl(user));
  box.appendChild(makeEl(asst));
  refreshLastFlags();
  updateEmpty();
  state.stickBottom = true;
  scrollToBottom(false);
  await runAssistant(asst, mode);
}

async function runAssistant(asst, mode) {
  setBusyUI(true);
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  const s = getSettings();
  const speakIt = mode.voice || (s.autoSpeak && !mode.draw);
  if (!mode.voice) {
    speaker.onend = null;
    speaker.onstart = null;
  }
  if (speakIt) speaker.begin();
  try {
    await runTurn({
      convo: state.convo,
      asst,
      mode,
      signal: ctrl.signal,
      onUpdate: (info) => {
        if (speakIt && info.delta && info.delta.content) speaker.feed(info.delta.content);
        if (state.onTurnUpdate) state.onTurnUpdate(asst, info);
        scheduleUpdate(asst);
      },
    });
  } finally {
    state.ctrl = null;
    setBusyUI(false);
    if (speakIt) speaker.end();
    state.convo.updated = Date.now();
    try {
      await saveConvo(state.convo);
      localStorage.setItem('wst.lastConvo', state.convo.id);
    } catch (e) {
      console.warn(e);
      if (e && e.name === 'QuotaExceededError') toast('手机空间不够，对话可能没存到。可以在设置里清掉旧对话。', 5000);
    }
    const el = state.els.get(asst.id);
    if (el) updateAssistant(el, asst, { isLast: isLastAssistant(asst) });
    if (asst.usage && asst.usage.cost) balanceStale = true;
    if (!$('#drawer').hidden) renderConvoList();
  }
}

function stopTurn() {
  if (state.ctrl) state.ctrl.abort();
  speaker.stop();
}

async function rerun(asstId) {
  if (state.busy) return;
  const msgs = state.convo.messages;
  const i = msgs.findIndex((m) => m.id === asstId);
  if (i < 1) return;
  const user = msgs[i - 1];
  const mode = user.mode ? { ...user.mode } : {};
  const s = getSettings();
  const fresh = {
    id: uid('m'),
    role: 'assistant',
    parts: [],
    model: mode.draw ? s.imageModel : curModel(),
    created: Date.now(),
    status: 'streaming',
  };
  msgs.splice(i, 1, fresh);
  const oldEl = state.els.get(asstId);
  state.els.delete(asstId);
  const el = makeEl(fresh);
  if (oldEl) oldEl.replaceWith(el);
  else $('#msgs').appendChild(el);
  refreshLastFlags();
  await runAssistant(fresh, mode);
}

// ---------------------------------------------------------------- conversations
async function openLastOrNew() {
  const id = localStorage.getItem('wst.lastConvo');
  let c = null;
  if (id) c = await loadConvo(id).catch(() => null);
  // Pick up where you left off if it was recent; otherwise start fresh.
  if (c && Date.now() - c.updated < 45 * 60 * 1000) {
    for (const m of c.messages) if (m.status === 'streaming') m.status = 'stopped';
    state.convo = c;
  } else state.convo = newConvo();
  renderAll();
}

async function switchConvo(id) {
  if (state.busy) stopTurn();
  const c = await loadConvo(id);
  if (!c) return toast('找不到这个对话');
  for (const m of c.messages) if (m.status === 'streaming') m.status = 'stopped';
  state.convo = c;
  localStorage.setItem('wst.lastConvo', id);
  renderAll();
  closeLayer('drawer');
}

function startNew() {
  if (state.busy) stopTurn();
  state.convo = newConvo();
  state.pendingAtts = [];
  renderAtts();
  renderAll();
  closeLayer('drawer');
  setTimeout(() => {
    if (!isIOS()) $('#input').focus();
  }, 50);
}

async function renderConvoList() {
  const q = ($('#convoSearch').value || '').trim().toLowerCase();
  let list = [];
  try {
    list = await listConvos();
  } catch {}
  if (q) list = list.filter((c) => (c.title + ' ' + (c.preview || '')).toLowerCase().includes(q));
  const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
  $('#convoList').innerHTML = list.length
    ? list
        .map(
          (c) => `<div class="convo ${state.convo && c.id === state.convo.id ? 'active' : ''}">
        <button type="button" class="convo-open" data-open="${esc(c.id)}"><b>${esc(c.title || '新对话')}</b><span>${esc(relTime(c.updated))}${c.preview ? ' · ' + esc(c.preview) : ''}</span></button>
        <button type="button" class="convo-del" data-del="${esc(c.id)}" aria-label="删除这个对话">${trash}</button></div>`
        )
        .join('')
    : `<p class="empty-list">${q ? '没找到相关对话。' : '还没有对话。'}</p>`;
}

// ---------------------------------------------------------------- layers (drawer, sheets)
function openLayer(id) {
  const el = document.getElementById(id);
  el.hidden = false;
  document.body.classList.add('layer-open');
}
function closeLayer(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
  if (!$$('.drawer:not([hidden]), .sheet:not([hidden])').length) document.body.classList.remove('layer-open');
}

let balanceStale = true;
let balanceAt = 0;
async function refreshBalance(force = false) {
  const el = $('#balance');
  if (!getSettings().orKey) {
    el.textContent = '';
    return null;
  }
  if (!force && !balanceStale && Date.now() - balanceAt < 5 * 60 * 1000) return null;
  try {
    const k = await keyInfo();
    balanceStale = false;
    balanceAt = Date.now();
    if (k.limit_remaining != null) el.textContent = '剩 ' + fmtUSD(k.limit_remaining);
    else if (k.usage != null) el.textContent = '已用 ' + fmtUSD(k.usage);
    return k;
  } catch (e) {
    el.textContent = '';
    if (force) throw e;
    return null;
  }
}

// ---------------------------------------------------------------- model picker
function renderModelList(q = '') {
  const cur = curModel();
  const cat = getCatalog();
  const s = getSettings();
  const item = (id, name, by, blurb, m) => {
    const tags = [];
    if (m) {
      badges(m).forEach((b) => tags.push(`<span class="tag">${esc(b)}</span>`));
      const pl = priceLine(m);
      if (pl) tags.push(`<span class="price">${esc(pl)}</span>`);
    }
    if (/contributor/i.test(id)) tags.push('<span class="tag warn">Meta 会拿对话去训练</span>');
    return `<button type="button" class="ml-item ${id === cur ? 'sel' : ''}" data-model="${esc(id)}"><span class="ml-radio"></span><span class="ml-main"><span class="ml-name">${esc(name)}${
      by ? ` <em>${esc(by)}</em>` : ''
    }</span>${blurb ? `<span class="ml-blurb ${q.trim() ? 'clamp' : ''}">${esc(blurb)}</span>` : ''}${tags.length ? `<span class="ml-meta">${tags.join('')}</span>` : ''}</span></button>`;
  };
  let html = '';
  if (!q.trim()) {
    html += '<div class="ml-group">常用</div>';
    for (const qm of QUICK) {
      const m = cat.get(qm.id);
      if (cat.size && !m) continue;
      html += item(qm.id, qm.name, qm.by, qm.blurb, m);
    }
    const recents = (s.recentModels || []).filter((id) => !QUICK.some((x) => x.id === id) && (cat.get(id) || id.startsWith('@')));
    if (recents.length) {
      html += '<div class="ml-group">最近用过</div>';
      recents.forEach((id) => {
        const m = cat.get(id);
        html += item(id, displayName(id), m ? id.split('/')[0] : '', '', m);
      });
    }
    const custom = customRefs();
    if (custom.length) {
      html += '<div class="ml-group">我的其他服务</div>';
      custom.forEach((c) => (html += item(c.ref, c.name, c.provider.name, '自定义服务', null)));
    }
    html += `<p class="help">想用别的？在上面搜，例如「claude」「gemini」「deepseek」「muse」。${cat.size ? `共 ${cat.size} 个模型。` : ''}</p>`;
  } else {
    const list = searchCatalog(q, 120);
    html += `<div class="ml-group">搜到 ${list.length}${list.length >= 120 ? '+' : ''} 个</div>`;
    list.forEach((m) => (html += item(m.id, m.name.replace(/^[^:]{1,30}:\s*/, ''), m.id.split('/')[0], m.desc, m)));
    if (!list.length) html += `<p class="help">${cat.size ? '没有符合的模型。' : '模型列表还没载入，请检查网络。'}</p>`;
  }
  $('#modelList').innerHTML = html;
}

let modelPickTarget = 'chat'; // chat | panel:<index>
function openModelSheet(target = 'chat') {
  modelPickTarget = target;
  $('#modelSearch').value = '';
  renderModelList('');
  openLayer('sheetModel');
  if (!getCatalog().size)
    loadCatalog()
      .then(() => renderModelList($('#modelSearch').value))
      .catch(() => toast('拿不到模型列表，请检查网络'));
}

function pickModel(id) {
  if (modelPickTarget.startsWith('panel:')) {
    const i = Number(modelPickTarget.split(':')[1]);
    const arr = [...(getSettings().panelModels || [])];
    arr[i] = id;
    setSettings({ panelModels: arr });
    closeLayer('sheetModel');
    renderSettings();
    return;
  }
  state.convo.model = id;
  setSettings({ chatModel: id });
  rememberModel(id);
  if (state.mode.draw) toggleMode('draw', false);
  refreshModelChip();
  closeLayer('sheetModel');
  if (!$('#sheetSettings').hidden) renderSettings();
  toast('已换成 ' + displayName(id));
}

// ---------------------------------------------------------------- settings
function seg(name, value, options) {
  return `<div class="seg" data-seg="${name}">${options
    .map(([v, label]) => `<button type="button" data-v="${esc(v)}" class="${String(value) === String(v) ? 'on' : ''}">${esc(label)}</button>`)
    .join('')}</div>`;
}
function sel(name, value, options) {
  return `<select data-set="${name}">${options.map(([v, label]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function renderSettings() {
  const s = getSettings();
  const tts = TTS_MODELS.find((t) => t.id === s.ttsModel) || TTS_MODELS[0];
  const bVoices = browserVoices();
  const providers = s.customProviders || [];
  const installHelp = isStandalone()
    ? '已经装在主屏幕了。'
    : isIOS()
      ? '用 Safari 打开这个网址 → 点下方「分享」→「加入主画面」。'
      : '用 Chrome 打开 → 右上角 ⋮ →「安装应用」或「加到主屏幕」。';
  $('#settingsBody').innerHTML = `
  <section class="set-group"><h3>OPENROUTER 钥匙</h3>
    <div class="set-card">
      <div class="key-row"><input id="keyInput" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…" value="${esc(s.orKey)}" aria-label="OpenRouter 钥匙"><button type="button" class="btn small" id="keySave">保存</button></div>
      <div class="row" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button type="button" class="btn small ghost" id="keyShow">显示</button>
        <button type="button" class="btn small ghost" id="keyTest">测试并看用量</button>
        <a class="btn small ghost" href="https://openrouter.ai/credits" target="_blank" rel="noopener noreferrer">充值</a>
      </div>
      <p id="keyMsg" class="help">钥匙只存在这部手机里，不会上传到别的地方（除了 OpenRouter 本身）。</p>
    </div>
  </section>

  <section class="set-group"><h3>AI 大脑</h3>
    <div class="set-card">
      <div class="set-row"><span class="lbl"><b>默认模型</b><small>${esc(displayName(s.chatModel))}</small></span><button type="button" class="btn small ghost" data-open-models="chat">换</button></div>
      <div class="set-row"><span class="lbl"><b>思考深度</b><small>想得深更准，但更慢、更贵</small></span>${seg('thinking', s.thinking, [['auto', '自动'], ['low', '快'], ['high', '深']])}</div>
      <div class="set-row"><span class="lbl"><b>上网查资料</b><small>自动：它自己判断要不要查（每次约 1–6 仙）</small></span>${seg('webMode', s.webMode, [['auto', '自动'], ['off', '关']])}</div>
      <label class="field" style="margin:12px 0 0"><span>所在城市（查本地资讯用，可不填）</span><input data-set="location" value="${esc(s.location)}" placeholder="例如：城市，国家"></label>
    </div>
  </section>

  <section class="set-group"><h3>画图</h3>
    <div class="set-card">
      <div class="set-row"><span class="lbl"><b>画图模型</b><small>${esc((IMAGE_MODELS.find((m) => m.id === s.imageModel) || {}).blurb || s.imageModel)}</small></span>${sel(
        'imageModel',
        s.imageModel,
        IMAGE_MODELS.map((m) => [m.id, m.name])
      )}</div>
    </div>
  </section>

  <section class="set-group"><h3>语音</h3>
    <div class="set-card">
      <div class="set-row"><span class="lbl"><b>听写</b><small>${s.sttEngine === 'ai' ? '录音交给 AI 转文字，准、支持方言' : '用手机自带的听写（免费）'}</small></span>${seg('sttEngine', s.sttEngine, [['ai', 'AI 听写'], ['browser', '手机自带']])}</div>
      ${s.sttEngine === 'ai' ? `<div class="set-row"><span class="lbl"><b>听写模型</b><small>${esc((STT_MODELS.find((m) => m.id === s.sttModel) || {}).blurb || '')}</small></span>${sel('sttModel', s.sttModel, STT_MODELS.map((m) => [m.id, m.name]))}</div>` : ''}
      ${s.sttEngine === 'browser' && !browserSTTSupported() ? '<p class="help" style="color:var(--danger)">这个浏览器不支持手机自带听写，请用「AI 听写」。</p>' : ''}
      <div class="set-row"><span class="lbl"><b>我讲的语言</b><small>混着讲就选「自动」</small></span>${sel('voiceLang', s.voiceLang, [['auto', '自动'], ['zh', '普通话'], ['yue', '粤语'], ['en', 'English'], ['ms', 'Bahasa Melayu']])}</div>
      <div class="set-row"><span class="lbl"><b>听写完直接发送</b><small>关掉就先放进输入框给你改</small></span><button type="button" class="switch ${s.autoSendDictation ? 'on' : ''}" data-toggle="autoSendDictation" aria-label="听写完直接发送"></button></div>
    </div>
    <div class="set-card">
      <div class="set-row"><span class="lbl"><b>朗读声音</b><small>${s.ttsEngine === 'ai' ? 'AI 真人声（每分钟约 1–4 仙）' : '手机自带声音（免费）'}</small></span>${seg('ttsEngine', s.ttsEngine, [['ai', 'AI 声音'], ['browser', '手机自带']])}</div>
      ${
        s.ttsEngine === 'ai'
          ? `<div class="set-row"><span class="lbl"><b>声音模型</b><small>${esc(tts.blurb)}</small></span>${sel('ttsModel', s.ttsModel, TTS_MODELS.map((m) => [m.id, m.name]))}</div>
      <div class="set-row"><span class="lbl"><b>声音</b></span>${sel('ttsVoice', tts.voices.includes(s.ttsVoice) ? s.ttsVoice : tts.voices[0], tts.voices.map((v) => [v, VOICE_LABELS[v] || v]))}</div>`
          : bVoices.length
            ? `<div class="set-row"><span class="lbl"><b>声音</b><small>自动会按中文/英文换声音</small></span>${sel('browserVoice', s.browserVoice, [['', '自动'], ...bVoices.map((v) => [v.voiceURI, `${v.name} (${v.lang})`])])}</div>`
            : ''
      }
      <div class="set-row"><span class="lbl"><b>语速</b></span>${seg('ttsRate', s.ttsRate, [[0.85, '慢'], [1, '正常'], [1.2, '快'], [1.4, '很快']])}</div>
      <div class="set-row"><span class="lbl"><b>回答自动朗读</b><small>打字聊天时也读出来</small></span><button type="button" class="switch ${s.autoSpeak ? 'on' : ''}" data-toggle="autoSpeak" aria-label="回答自动朗读"></button></div>
      <div class="set-row"><span class="lbl"><b>试听</b></span><button type="button" class="btn small ghost" id="ttsTest">播放一句</button></div>
    </div>
  </section>

  <section class="set-group"><h3>多 AI 会诊</h3>
    <div class="set-card">
      <p class="help" style="margin:0 0 10px">开了会诊，问题会同时交给下面几个 AI，再由当前模型综合。</p>
      <div class="panel-picks">${[0, 1, 2]
        .map(
          (i) => `<div class="set-row"><span class="lbl"><b>第 ${i + 1} 位</b><small>${esc(displayName((s.panelModels || [])[i] || '') || '未选')}</small></span><button type="button" class="btn small ghost" data-open-models="panel:${i}">换</button></div>`
        )
        .join('')}</div>
    </div>
  </section>

  <section class="set-group"><h3>让它更懂你</h3>
    <div class="set-card">
      <label class="field"><span>关于我（职业、生意、常用语言等）</span><textarea data-set="aboutMe" placeholder="例如：我是做生意的，常用中文和英文。">${esc(s.aboutMe)}</textarea></label>
      <label class="field" style="margin:0"><span>回答风格</span><textarea data-set="style" placeholder="例如：直接给结论，少客套；需要时给步骤。">${esc(s.style)}</textarea></label>
    </div>
  </section>

  <section class="set-group"><h3>其他 AI 服务（进阶）</h3>
    <div class="set-card">
      <p class="help" style="margin:0 0 10px">接 OpenAI 兼容的服务，例如你自己电脑上的本地模型（Ollama）、OpenAI、Gemini、DeepSeek。这些只支持聊天和看图；画图、上网、语音仍然走 OpenRouter。</p>
      <div id="providerList">${providers
        .map(
          (p, i) => `<div class="provider" data-pi="${i}">
          <label class="field"><span>名字</span><input data-p="name" value="${esc(p.name)}"></label>
          <label class="field"><span>接口地址（Base URL）</span><input data-p="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://…/v1" inputmode="url" autocapitalize="off" spellcheck="false"></label>
          <label class="field"><span>钥匙（没有就留空）</span><input data-p="apiKey" type="password" value="${esc(p.apiKey)}" autocomplete="off"></label>
          <label class="field"><span>模型名字（多个用逗号分开）</span><input data-p="models" value="${esc(p.models)}" placeholder="例如：qwen3:8b" autocapitalize="off" spellcheck="false"></label>
          <label class="check"><input type="checkbox" data-p="tools" ${p.tools ? 'checked' : ''}> 这个模型会用工具（能叫它画图）</label>
          <div class="row"><button type="button" class="btn small ghost" data-ptest="${i}">测试连接</button><button type="button" class="btn small danger" data-pdel="${i}">删除</button></div>
          <p class="help" data-pmsg="${i}"></p>
        </div>`
        )
        .join('')}</div>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
        <select id="presetSel" aria-label="选择服务类型">
          <option value="ollama">本地模型（Ollama）</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Google Gemini</option>
          <option value="deepseek">DeepSeek</option>
          <option value="custom">其他</option>
        </select>
        <button type="button" class="btn small" id="addProvider">＋ 添加</button>
      </div>
    </div>
  </section>

  <section class="set-group"><h3>外观</h3>
    <div class="set-card"><div class="set-row"><span class="lbl"><b>颜色</b></span>${seg('theme', s.theme, [['system', '跟手机'], ['light', '浅色'], ['dark', '深色']])}</div></div>
  </section>

  <section class="set-group"><h3>资料</h3>
    <div class="set-card">
      <p class="stat-line" id="storageLine">对话都存在这部手机里。</p>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button type="button" class="btn small ghost" id="exportBtn">导出备份</button>
        <button type="button" class="btn small ghost" id="importBtn">导入备份</button>
        <button type="button" class="btn small danger" id="wipeBtn">清除所有对话</button>
      </div>
      <p class="help">备份文件不含钥匙。换手机时，先在旧手机导出，再在新手机导入。</p>
    </div>
  </section>

  <section class="set-group"><h3>安装到主屏幕</h3>
    <div class="set-card"><p class="help" style="margin:0">${esc(installHelp)}</p></div>
  </section>

  <section class="set-group"><h3>进阶</h3>
    <div class="set-card">
      <label class="field" style="margin:0"><span>OpenRouter 接口地址</span><input data-set="orBase" value="${esc(s.orBase)}" inputmode="url" autocapitalize="off" spellcheck="false"></label>
      <p class="help">一般不用改。万事通 ${APP_VERSION}</p>
    </div>
  </section>`;
  storageEstimate().then((e) => {
    const line = $('#storageLine');
    if (e && line && e.usage != null) line.textContent = `对话都存在这部手机里，目前用了约 ${(e.usage / 1048576).toFixed(1)} MB。`;
  });
}

const PRESETS = {
  ollama: { name: '本地模型', baseUrl: 'http://localhost:11434/v1', models: '', tools: false },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: 'gpt-6.1-terra', tools: true },
  gemini: { name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: 'gemini-3.8-flash', tools: true },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: 'deepseek-chat', tools: true },
  custom: { name: '我的服务', baseUrl: '', models: '', tools: false },
};

function bindSettings() {
  const body = $('#settingsBody');
  body.addEventListener('click', async (e) => {
    const t = e.target;
    const segBtn = t.closest('.seg button');
    if (segBtn) {
      const name = segBtn.parentElement.dataset.seg;
      let v = segBtn.dataset.v;
      if (name === 'ttsRate') v = Number(v);
      setSettings({ [name]: v });
      if (name === 'theme') applyTheme();
      renderSettings();
      return;
    }
    const tg = t.closest('[data-toggle]');
    if (tg) {
      const k = tg.dataset.toggle;
      setSettings({ [k]: !getSettings()[k] });
      tg.classList.toggle('on', !!getSettings()[k]);
      return;
    }
    const om = t.closest('[data-open-models]');
    if (om) return openModelSheet(om.dataset.openModels);
    if (t.id === 'keySave') return saveKey($('#keyInput').value, $('#keyMsg'));
    if (t.id === 'keyShow') {
      const i = $('#keyInput');
      i.type = i.type === 'password' ? 'text' : 'password';
      t.textContent = i.type === 'password' ? '显示' : '隐藏';
      return;
    }
    if (t.id === 'keyTest') return testKey($('#keyMsg'));
    if (t.id === 'ttsTest') {
      unlockAudio();
      speaker.onend = null;
      speaker.onstart = null;
      speaker.onerror = (err) => toast('AI 声音出错，改用手机声音：' + ((err && err.message) || ''), 4000);
      speaker.speakText('你好，我是万事通。Hello, nice to meet you. 有什么可以帮你？');
      return;
    }
    if (t.id === 'addProvider') {
      const preset = PRESETS[$('#presetSel').value] || PRESETS.custom;
      const list = [...(getSettings().customProviders || []), { id: uid('p'), apiKey: '', ...preset }];
      setSettings({ customProviders: list });
      renderSettings();
      return;
    }
    const pdel = t.closest('[data-pdel]');
    if (pdel) {
      if (pdel.dataset.confirm !== '1') {
        pdel.dataset.confirm = '1';
        pdel.textContent = '确定删除？';
        setTimeout(() => {
          if (pdel.isConnected) {
            pdel.dataset.confirm = '';
            pdel.textContent = '删除';
          }
        }, 3000);
        return;
      }
      const list = [...getSettings().customProviders];
      list.splice(Number(pdel.dataset.pdel), 1);
      setSettings({ customProviders: list });
      renderSettings();
      return;
    }
    const ptest = t.closest('[data-ptest]');
    if (ptest) {
      const i = Number(ptest.dataset.ptest);
      const p = getSettings().customProviders[i];
      const msg = body.querySelector(`[data-pmsg="${i}"]`);
      const model = String(p.models || '').split(',')[0].trim();
      if (!p.baseUrl || !model) {
        msg.textContent = '请先填接口地址和至少一个模型名字。';
        return;
      }
      msg.textContent = '测试中…';
      try {
        await testCustom(p, model);
        msg.textContent = '连上了 ✓ 现在可以在上方模型列表里选它。';
      } catch (err) {
        msg.textContent = err.message + (location.protocol === 'https:' && p.baseUrl.startsWith('http:') ? '（这个网址是 https，不能连 http 的服务；本地模型要用 https，例如 Tailscale Serve。）' : '');
      }
      return;
    }
    if (t.id === 'exportBtn') return doExport();
    if (t.id === 'importBtn') return $('#fileImport').click();
    if (t.id === 'wipeBtn') {
      if (t.dataset.confirm !== '1') {
        t.dataset.confirm = '1';
        t.textContent = '再点一次，全部删除';
        setTimeout(() => {
          if (t.isConnected) {
            t.dataset.confirm = '';
            t.textContent = '清除所有对话';
          }
        }, 3500);
        return;
      }
      await clearAllConvos();
      localStorage.removeItem('wst.lastConvo');
      toast('所有对话已删除');
      startNew();
      renderSettings();
    }
  });
  body.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.set) {
      const k = t.dataset.set;
      let v = t.value;
      const patch = { [k]: v };
      if (k === 'ttsModel') {
        const m = TTS_MODELS.find((x) => x.id === v);
        if (m && !m.voices.includes(getSettings().ttsVoice)) patch.ttsVoice = m.voices[0];
      }
      if (k === 'orBase') patch.orBase = v.trim().replace(/\/+$/, '') || 'https://openrouter.ai/api/v1';
      setSettings(patch);
      if (['ttsModel', 'imageModel', 'sttModel', 'sttEngine'].includes(k)) renderSettings();
      if (k === 'imageModel') refreshModelChip();
      return;
    }
    const pi = t.closest('[data-pi]');
    if (pi && t.dataset.p) {
      const i = Number(pi.dataset.pi);
      const list = [...getSettings().customProviders];
      const v = t.type === 'checkbox' ? t.checked : t.value.trim();
      list[i] = { ...list[i], [t.dataset.p]: t.dataset.p === 'baseUrl' ? String(v).replace(/\/+$/, '') : v };
      setSettings({ customProviders: list });
    }
  });
  body.addEventListener(
    'input',
    debounce((e) => {
      const t = e.target;
      if (t.dataset.set && t.tagName === 'TEXTAREA') setSettings({ [t.dataset.set]: t.value });
      if (t.dataset.set === 'location') setSettings({ location: t.value });
    }, 400)
  );
}

async function saveKey(raw, msgEl) {
  const key = String(raw || '').trim();
  setSettings({ orKey: key });
  updateEmpty();
  if (!key) {
    if (msgEl) msgEl.textContent = '已清除钥匙。';
    return false;
  }
  if (!/^sk-or-/.test(key) && msgEl) msgEl.textContent = '已保存。提醒：OpenRouter 的钥匙一般是 sk-or- 开头。';
  return testKey(msgEl);
}

async function testKey(msgEl) {
  if (msgEl) {
    msgEl.className = msgEl.className.replace(/\b(ok|bad)\b/g, '');
    msgEl.hidden = false;
    msgEl.textContent = '测试中…';
  }
  try {
    const k = await refreshBalance(true);
    const bits = ['钥匙可以用 ✓'];
    if (k) {
      if (k.limit_remaining != null) bits.push('剩余 ' + fmtUSD(k.limit_remaining));
      if (k.usage != null) bits.push('总共已用 ' + fmtUSD(k.usage));
      if (k.usage_daily != null) bits.push('今天 ' + fmtUSD(k.usage_daily));
      if (k.is_free_tier) bits.push('（还没充值过，付费模型可能用不了）');
    }
    if (msgEl) {
      msgEl.textContent = bits.join(' · ');
      msgEl.classList.add('ok');
    }
    return true;
  } catch (e) {
    if (msgEl) {
      msgEl.textContent = e.message;
      msgEl.classList.add('bad');
    }
    return false;
  }
}

async function doExport() {
  try {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const name = `万事通备份-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    toast('导出失败：' + e.message);
  }
}

// ---------------------------------------------------------------- setup card
function showSetup() {
  if (state.convo.messages.length) startNew();
  updateEmpty();
  setTimeout(() => $('#setupKey').focus(), 80);
}

// ---------------------------------------------------------------- dictation (mic button)
const dict = { rec: null, brs: null, timer: 0, levels: [] };

function drawWave() {
  const c = $('#recWave');
  const w = c.clientWidth;
  if (c.width !== w * 2) c.width = w * 2;
  c.height = 72;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0e6e57';
  g.fillStyle = color;
  const bars = Math.floor(c.width / 10);
  const lv = dict.levels.slice(-bars);
  for (let i = 0; i < lv.length; i++) {
    const h = Math.max(4, lv[i] * 64);
    const x = c.width - (lv.length - i) * 10;
    g.fillRect(x, (c.height - h) / 2, 5, h);
  }
}

async function startDictation() {
  if (state.busy) return;
  const s = getSettings();
  const useBrowser = s.sttEngine === 'browser' && browserSTTSupported();
  if (!useBrowser && !s.orKey) {
    showSetup();
    toast('AI 听写需要 OpenRouter 钥匙；也可以在设置改用手机自带听写');
    return;
  }
  if (!useBrowser && !micSupported()) {
    toast('这个浏览器不能录音，可以用键盘上的麦克风讲话');
    return;
  }
  unlockAudio();
  dict.levels = [];
  $('#composer').hidden = true;
  $('#recBar').hidden = false;
  const label = $('#recLabel');
  label.textContent = '在听…讲完点 ✓';
  label.classList.remove('live');
  const t0 = Date.now();
  $('#recTime').textContent = '0:00';
  dict.timer = setInterval(() => ($('#recTime').textContent = fmtClock((Date.now() - t0) / 1000)), 500);
  if (useBrowser) {
    const br = new BrowserRecognizer();
    dict.brs = br;
    dict.browserText = '';
    br.start({
      continuous: true,
      onInterim: (t) => {
        dict.browserText = t;
        label.textContent = t || '在听…';
        label.classList.toggle('live', !!t);
      },
      onError: (err) => {
        if (err === 'not-allowed') toast('没有麦克风权限');
        else if (err !== 'no-speech' && err !== 'aborted') toast('听写出错：' + err);
      },
      onEnd: (t) => {
        if (dict.brs !== br) return;
        finishDictation(t || dict.browserText || '');
      },
    });
    return;
  }
  const rec = new Recorder();
  dict.rec = rec;
  try {
    await rec.start({
      vad: false,
      maxMs: 180000,
      onLevel: (l) => {
        dict.levels.push(l);
        if (dict.levels.length > 400) dict.levels.splice(0, 100);
        drawWave();
      },
      onAutoStop: () => dictationDone(),
    });
  } catch (e) {
    resetDictationUI();
    toast(micErrorMessage(e), 5000);
  }
}

function resetDictationUI() {
  clearInterval(dict.timer);
  dict.rec = null;
  dict.brs = null;
  $('#recBar').hidden = true;
  $('#composer').hidden = false;
}

async function dictationDone() {
  if (dict.brs) {
    dict.brs.stop();
    return; // onEnd finishes
  }
  const rec = dict.rec;
  if (!rec) return;
  dict.rec = null;
  const label = $('#recLabel');
  label.textContent = '转文字中…';
  label.classList.remove('live');
  clearInterval(dict.timer);
  const blob = await rec.stop();
  if (!blob) return resetDictationUI();
  try {
    const { text } = await transcribeBlob(blob);
    finishDictation(text);
  } catch (e) {
    resetDictationUI();
    toast(e && e.message ? '听写失败：' + e.message : '听写失败', 5000);
  }
}

function finishDictation(text) {
  resetDictationUI();
  text = (text || '').trim();
  if (!text) {
    toast('没听到内容，再试一次');
    return;
  }
  const ta = $('#input');
  const cur = ta.value.trim();
  setInput(cur ? cur + (/[，。！？,.!?]$/.test(cur) ? '' : ' ') + text : text);
  if (getSettings().autoSendDictation) send();
  else if (!isIOS()) ta.focus();
}

function cancelDictation() {
  if (dict.rec) dict.rec.cancel();
  if (dict.brs) {
    const b = dict.brs;
    dict.brs = null;
    b.abort();
  }
  resetDictationUI();
}

// ---------------------------------------------------------------- voice conversation
const vc = { active: false, paused: false, rec: null, sttCtrl: null, brs: null, misses: 0 };

function setVState(st, label) {
  $('#voiceOverlay').dataset.state = st;
  $('#voiceState').textContent = label;
  $('#voiceMute').textContent = st === 'paused' ? '继续听' : '暂停听';
}

function orbLevel(l) {
  $('.orb-core').style.setProperty('--lvl', String(1 + Math.min(1, l) * 0.22));
}

function openVoice() {
  const s = getSettings();
  if (!s.orKey) {
    showSetup();
    toast('请先填入 OpenRouter 钥匙');
    return;
  }
  if (state.busy) stopTurn();
  unlockAudio();
  vc.active = true;
  vc.paused = false;
  vc.misses = 0;
  $('#voiceOverlay').hidden = false;
  $('#voiceModel').textContent = displayName(curModel());
  $('#voiceHeard').textContent = '';
  $('#voiceReply').textContent = '';
  state.onTurnUpdate = (asst) => {
    if (vc.active) $('#voiceReply').textContent = textOf(asst).slice(-500);
  };
  vcListen();
}

function vcStopInputs() {
  if (vc.rec) {
    vc.rec.cancel();
    vc.rec = null;
  }
  if (vc.brs) {
    const b = vc.brs;
    vc.brs = null;
    b.abort();
  }
  if (vc.sttCtrl) {
    vc.sttCtrl.abort();
    vc.sttCtrl = null;
  }
  orbLevel(0);
}

function vcPause(msg) {
  vcStopInputs();
  vc.paused = true;
  setVState('paused', msg || '暂停了，点圆球继续');
}

async function vcListen() {
  if (!vc.active || vc.paused) return;
  vcStopInputs();
  setVState('listening', '请讲…');
  const s = getSettings();
  if (s.sttEngine === 'browser' && browserSTTSupported()) {
    const br = new BrowserRecognizer();
    vc.brs = br;
    br.start({
      continuous: false,
      onInterim: (t) => ($('#voiceHeard').textContent = '你：' + t),
      onError: (err) => {
        if (err === 'not-allowed') vcPause('没有麦克风权限');
      },
      onEnd: (t) => {
        if (vc.brs !== br || !vc.active) return;
        vc.brs = null;
        if (t) {
          vc.misses = 0;
          $('#voiceHeard').textContent = '你：' + t;
          vcSend(t);
        } else if (++vc.misses >= 2) vcPause('没听到声音，点圆球继续');
        else vcListen();
      },
    });
    return;
  }
  if (!micSupported()) return vcPause('这个浏览器不能录音');
  const rec = new Recorder();
  vc.rec = rec;
  try {
    await rec.start({
      vad: true,
      silenceMs: 1200,
      noSpeechMs: 10000,
      maxMs: 90000,
      onLevel: (l) => orbLevel(l),
      onSpeechStart: () => setVState('listening', '在听…'),
      onAutoStop: (reason) => vcGotAudio(rec, reason),
    });
  } catch (e) {
    vc.rec = null;
    vcPause(micErrorMessage(e));
  }
}

async function vcGotAudio(rec, reason) {
  if (vc.rec !== rec) return;
  vc.rec = null;
  const heard = rec.heard;
  const blob = await rec.stop();
  orbLevel(0);
  if (!vc.active || vc.paused) return;
  if (!blob || (!heard && reason !== 'manual')) {
    if (++vc.misses >= 2) return vcPause('没听到声音，点圆球继续');
    return vcListen();
  }
  vc.misses = 0;
  setVState('transcribing', '听写中…');
  const ctrl = new AbortController();
  vc.sttCtrl = ctrl;
  try {
    const { text } = await transcribeBlob(blob, ctrl.signal);
    if (vc.sttCtrl !== ctrl || !vc.active) return;
    vc.sttCtrl = null;
    if (!text) return vcListen();
    $('#voiceHeard').textContent = '你：' + text;
    vcSend(text);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    vcPause('听写失败：' + ((e && e.message) || ''));
  }
}

async function vcSend(text) {
  setVState('thinking', '想一下…');
  $('#voiceReply').textContent = '';
  speaker.onstart = () => {
    if (vc.active) setVState('speaking', '在讲…点圆球可以打断');
  };
  speaker.onend = () => {
    if (vc.active && !vc.paused) vcListen();
  };
  speaker.onerror = () => {};
  await send(text, { voice: true });
  const last = lastAssistant();
  if (vc.active && last && last.status === 'error') {
    $('#voiceReply').textContent = last.error;
    vcPause('出错了，点圆球再试');
  }
}

function vcOrbTap() {
  unlockAudio();
  const st = $('#voiceOverlay').dataset.state;
  if (st === 'speaking') {
    speaker.stop();
    vcListen();
  } else if (st === 'listening') {
    if (vc.rec) {
      const r = vc.rec;
      r._auto('manual');
    } else if (vc.brs) vc.brs.stop();
  } else if (st === 'thinking') {
    stopTurn();
    vcListen();
  } else if (st === 'paused') {
    vc.paused = false;
    vc.misses = 0;
    vcListen();
  }
}

function closeVoice() {
  vc.active = false;
  vc.paused = false;
  vcStopInputs();
  speaker.onend = null;
  speaker.onstart = null;
  speaker.stop();
  if (state.busy) stopTurn();
  state.onTurnUpdate = null;
  $('#voiceOverlay').hidden = true;
}

// ---------------------------------------------------------------- message actions
async function onMessageAction(btn) {
  const act = btn.dataset.action;
  const art = btn.closest('.msg');
  const m = art ? findMsg(art.dataset.id) : null;
  if (act === 'copy-code') {
    const code = btn.parentElement.querySelector('code');
    const ok = await copyText((code ? code.innerText : btn.parentElement.innerText.replace(/复制$/, '')).trim());
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => (btn.textContent = '复制'), 1500);
    return;
  }
  if (!m) return;
  if (act === 'copy') {
    const ok = await copyText(m.role === 'user' ? m.text || '' : textOf(m));
    toast(ok ? '已复制' : '复制失败');
  } else if (act === 'edit') {
    setInput(m.text || '');
    if (!isIOS()) $('#input').focus();
    toast('改好再发送');
  } else if (act === 'speak') {
    unlockAudio();
    if (speaker.active) {
      speaker.stop();
      return;
    }
    speaker.onend = null;
    speaker.onstart = null;
    speaker.onerror = (err) => toast('AI 声音出错，改用手机声音：' + ((err && err.message) || ''), 4000);
    speaker.speakText(textOf(m));
  } else if (act === 'regen' || act === 'retry') {
    rerun(m.id);
  } else if (act === 'open-settings') {
    openSettings();
  } else if (act === 'open-models') {
    openModelSheet('chat');
  } else if (act === 'view') {
    const a = (m.atts || []).find((x) => x.id === btn.dataset.srcId);
    if (a) openViewer(a.dataUrl);
  } else if (act === 'view-gen') {
    const img = btn.querySelector('img');
    if (img) openViewer(img.src);
  } else if (act === 'save-img') {
    const img = btn.closest('.gen').querySelector('img');
    if (img) {
      const r = await saveImage(img.src);
      if (r === 'downloaded') toast('已下载');
    }
  } else if (act === 'edit-img') {
    const img = btn.closest('.gen').querySelector('img');
    if (!img) return;
    state.pendingAtts.push({ id: uid('a'), kind: 'image', name: '要修改的图', dataUrl: img.src });
    renderAtts();
    setInput('把这张图改成：');
    if (!isIOS()) $('#input').focus();
  }
}

let viewerSrc = '';
function openViewer(src) {
  viewerSrc = src;
  $('#viewerImg').src = src;
  $('#viewer').hidden = false;
}

function openSettings() {
  renderSettings();
  closeLayer('drawer');
  openLayer('sheetSettings');
}

// ---------------------------------------------------------------- wiring
function bindUI() {
  const ta = $('#input');
  ta.addEventListener('input', () => {
    autosize();
    updateSendState();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      const touch = window.matchMedia('(pointer: coarse)').matches;
      if (touch && !e.ctrlKey && !e.metaKey && ta.value.includes('\n')) return; // long text on phones: let Enter add lines
      e.preventDefault();
      send();
    }
  });
  ta.addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  $('#btnSend').onclick = () => send();
  $('#btnStop').onclick = () => stopTurn();
  $('#btnMic').onclick = () => startDictation();
  $('#recDone').onclick = () => dictationDone();
  $('#recCancel').onclick = () => cancelDictation();
  $('#btnVoice').onclick = () => openVoice();
  $('#btnPlus').onclick = () => openLayer('sheetPlus');
  $('#btnMenu').onclick = () => {
    renderConvoList();
    openLayer('drawer');
    refreshBalance();
  };
  $('#btnNew').onclick = () => startNew();
  $('#drawerNew').onclick = () => startNew();
  $('#btnModel').onclick = () => {
    if (state.mode.draw) {
      openSettings();
      return;
    }
    openModelSheet('chat');
  };
  $('#btnSettings').onclick = () => openSettings();
  $('#btnScrollDown').onclick = () => scrollToBottom(true);
  $('#chat').addEventListener('scroll', onChatScroll, { passive: true });
  $('#convoSearch').addEventListener('input', debounce(renderConvoList, 200));
  $('#modelSearch').addEventListener('input', debounce((e) => renderModelList(e.target.value), 150));

  // close buttons / scrims
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) {
      const id = c.dataset.close;
      if (id === 'viewer') $('#viewer').hidden = true;
      else closeLayer(id);
    }
  });

  // conversation list
  $('#convoList').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) return switchConvo(open.dataset.open);
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = '删除？';
        setTimeout(() => del.isConnected && renderConvoList(), 3000);
        return;
      }
      const id = del.dataset.del;
      await deleteConvo(id);
      if (state.convo && state.convo.id === id) {
        state.convo = newConvo();
        renderAll();
      }
      renderConvoList();
    }
  });

  // model list
  $('#modelList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]');
    if (b) pickModel(b.dataset.model);
  });

  // plus sheet
  $('#sheetPlus').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      closeLayer('sheetPlus');
      const id = { camera: 'fileCamera', photos: 'filePhotos', docs: 'fileDocs' }[pick.dataset.pick];
      $('#' + id).click();
      return;
    }
    const md = e.target.closest('[data-mode]');
    if (md) {
      toggleMode(md.dataset.mode);
      setTimeout(() => closeLayer('sheetPlus'), 180);
    }
  });
  $('#modeChips').addEventListener('click', (e) => {
    const off = e.target.closest('[data-mode-off]');
    if (off) toggleMode(off.dataset.modeOff, false);
  });
  $('#attRow').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      state.pendingAtts = state.pendingAtts.filter((a) => a.id !== rm.dataset.rm);
      renderAtts();
    }
  });
  for (const id of ['fileCamera', 'filePhotos', 'fileDocs']) {
    $('#' + id).addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
  }
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const n = await importAll(JSON.parse(await f.text()));
      toast(`导入了 ${n} 个对话`);
      applyTheme();
      renderSettings();
    } catch (err) {
      toast('导入失败：' + err.message, 4000);
    }
  });

  // messages
  $('#msgs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b) onMessageAction(b);
  });
  $('#msgs').addEventListener('toggle', (e) => {
    if (e.target.classList && e.target.classList.contains('panel')) e.target._userToggled = true;
  }, true);

  // setup card
  $('#setupSave').onclick = async () => {
    const msg = $('#setupMsg');
    const ok = await saveKey($('#setupKey').value, msg);
    if (ok) {
      setTimeout(() => {
        updateEmpty();
        toast('好了，可以开始问了');
      }, 900);
    }
  };

  // voice overlay
  $('#voiceOrb').onclick = () => vcOrbTap();
  $('#voiceClose').onclick = () => closeVoice();
  $('#voiceEnd').onclick = () => closeVoice();
  $('#voiceMute').onclick = () => {
    if (vc.paused) {
      vc.paused = false;
      vc.misses = 0;
      vcListen();
    } else {
      speaker.stop();
      if (state.busy) stopTurn();
      vcPause('暂停了，点圆球继续');
    }
  };

  // viewer
  $('#viewerSave').onclick = async () => {
    if (!viewerSrc) return;
    const r = await saveImage(viewerSrc);
    if (r === 'downloaded') toast('已下载');
  };

  // drag & drop on desktop
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // save when the app goes to background
  const persist = () => {
    if (state.convo && state.convo.messages.length) saveConvo(state.convo).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });
  window.addEventListener('pagehide', persist);

  // Android back button closes layers first
  window.addEventListener('popstate', () => {
    for (const id of ['viewer', 'voiceOverlay', 'sheetSettings', 'sheetModel', 'sheetPlus', 'drawer']) {
      const el = document.getElementById(id);
      if (el && !el.hidden) {
        if (id === 'voiceOverlay') closeVoice();
        else if (id === 'viewer') el.hidden = true;
        else closeLayer(id);
        history.pushState({ wst: 1 }, '');
        return;
      }
    }
  });
  history.replaceState({ wst: 0 }, '');
  history.pushState({ wst: 1 }, '');

  bindSettings();
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};
}

function registerSW() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

async function boot() {
  applyTheme();
  setupViewport();
  bindUI();
  renderSuggestions();
  renderModeChips();
  updateSendState();
  try {
    await openLastOrNew();
  } catch (e) {
    console.error(e);
    state.convo = newConvo();
    renderAll();
  }
  refreshModelChip();
  loadCatalog()
    .then(() => {
      refreshModelChip();
      if (!$('#sheetModel').hidden) renderModelList($('#modelSearch').value);
    })
    .catch(() => {});
  registerSW();
  askPersistentStorage();
}

boot();
