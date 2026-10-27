// Turning messages into DOM: markdown, pictures, sources, errors.
import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';
import { esc, fmtUSD, fmtDuration } from './util.js';
import { displayName } from './models.js';
import { attSummary } from './files.js';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (!/^(https:|data:image\/)/i.test(src)) node.removeAttribute('src');
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'no-referrer');
  }
});

const PURIFY = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'textarea', 'select'], FORBID_ATTR: ['style'] };

export function mdToHtml(text) {
  try {
    return DOMPurify.sanitize(marked.parse(text || ''), PURIFY);
  } catch {
    return esc(text).replace(/\n/g, '<br>');
  }
}

function enhance(node) {
  node.querySelectorAll('table').forEach((t) => {
    if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.appendChild(t);
  });
  node.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-code';
    b.dataset.action = 'copy-code';
    b.textContent = '复制';
    pre.appendChild(b);
  });
}

const ICON = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  speak: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3.5L12 18V6L7.5 10z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
};
export { ICON };

// ---------- user ----------
export function userEl(m) {
  const el = document.createElement('article');
  el.className = 'msg user';
  el.dataset.id = m.id;
  const atts = (m.atts || [])
    .map((a) => {
      if (a.kind === 'image')
        return `<button type="button" class="u-thumb" data-action="view" data-src-id="${esc(a.id)}"><img src="${a.dataUrl}" alt="${esc(a.name)}"></button>`;
      return `<div class="u-doc">${ICON.file}<div><b>${esc(a.name)}</b><span>${esc(attSummary(a))}</span></div></div>`;
    })
    .join('');
  const modeTag = m.mode && m.mode.draw ? '<span class="u-tag">画图</span>' : m.mode && m.mode.consult ? '<span class="u-tag">多AI会诊</span>' : m.mode && m.mode.web ? '<span class="u-tag">上网</span>' : '';
  el.innerHTML = `
    <div class="bubble">
      ${atts ? `<div class="u-atts">${atts}</div>` : ''}
      ${m.text ? `<div class="u-text">${esc(m.text)}</div>` : ''}
      ${modeTag}
    </div>
    <div class="msg-actions">
      <button type="button" class="act" data-action="copy" aria-label="复制">${ICON.copy}</button>
      <button type="button" class="act" data-action="edit" aria-label="改了再发">${ICON.edit}</button>
    </div>`;
  return el;
}

// ---------- assistant ----------
export function assistantEl(m) {
  const el = document.createElement('article');
  el.className = 'msg assistant';
  el.dataset.id = m.id;
  el.innerHTML = `
    <details class="reasoning" hidden><summary>思考过程</summary><div class="reasoning-body"></div></details>
    <details class="panel" hidden><summary></summary><div class="panel-body"></div></details>
    <div class="thinking" hidden><span class="dots"><i></i><i></i><i></i></span><span class="thinking-label">思考中</span></div>
    <div class="parts"></div>
    <div class="sources" hidden></div>
    <div class="err" hidden></div>
    <footer class="a-foot" hidden>
      <span class="meta"></span>
      <span class="a-acts">
        <button type="button" class="act" data-action="copy" aria-label="复制">${ICON.copy}</button>
        <button type="button" class="act" data-action="speak" aria-label="朗读">${ICON.speak}</button>
        <button type="button" class="act" data-action="regen" aria-label="重新回答">${ICON.redo}</button>
      </span>
    </footer>`;
  updateAssistant(el, m, { isLast: true });
  return el;
}

function imgKey(src) {
  return (src || '').length + ':' + (src || '').slice(-40);
}

function partNode(p) {
  const d = document.createElement('div');
  d.dataset.t = p.t;
  if (p.t === 'text') d.className = 'md';
  if (p.t === 'img') {
    d.className = 'gen';
    d.dataset.src = imgKey(p.src);
    d.innerHTML = `
      <button type="button" class="gen-img" data-action="view-gen"><img src="${p.src}" alt="${esc((p.prompt || 'AI 生成的图片').slice(0, 120))}"></button>
      <div class="gen-bar">
        <button type="button" class="chip-btn" data-action="save-img">${ICON.save}<span>保存</span></button>
        <button type="button" class="chip-btn" data-action="edit-img">${ICON.edit}<span>再改</span></button>
      </div>`;
  }
  if (p.t === 'tool') d.className = 'tool';
  return d;
}

function aspectStyle(aspect) {
  const [w, h] = String(aspect || '1:1').split(':').map(Number);
  return w && h ? `aspect-ratio:${w}/${h}` : 'aspect-ratio:1/1';
}

function syncParts(box, parts, streaming) {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    let node = box.children[i];
    const stale = !node || node.dataset.t !== p.t || (p.t === 'img' && node.dataset.src !== imgKey(p.src));
    if (stale) {
      const fresh = partNode(p);
      if (node) box.replaceChild(fresh, node);
      else box.appendChild(fresh);
      node = fresh;
    }
    if (p.t === 'text') {
      const live = streaming && i === parts.length - 1;
      const key = p.v + (live ? '\u0001' : '');
      if (node._k !== key) {
        node.innerHTML = mdToHtml(p.v);
        enhance(node);
        if (live) {
          const c = document.createElement('span');
          c.className = 'caret';
          (node.lastElementChild || node).appendChild(c);
        }
        node._k = key;
      }
    } else if (p.t === 'tool') {
      const key = p.state + '|' + p.label;
      if (node._k !== key) {
        node.className = 'tool ' + p.state;
        if (p.state === 'run') {
          node.innerHTML = `<div class="tool-canvas" style="${aspectStyle(p.aspect)}"><div class="shimmer"></div><span>${esc(p.label)}<br><small>一般要 10–40 秒</small></span></div>`;
        } else {
          node.innerHTML = `<div class="tool-line">${p.state === 'err' ? '⚠︎' : '■'} ${esc(p.state === 'stop' ? '已停止画图' : p.label)}</div>`;
        }
        node._k = key;
      }
    }
  }
  while (box.children.length > parts.length) box.lastElementChild.remove();
}

export function updateAssistant(el, m, { isLast = false } = {}) {
  const streaming = m.status === 'streaming';
  el.classList.toggle('streaming', streaming);
  el.classList.toggle('is-last', !!isLast);

  // reasoning
  const rs = el.querySelector('.reasoning');
  if (m.reasoning && m.reasoning.trim()) {
    rs.hidden = false;
    const body = rs.querySelector('.reasoning-body');
    if (body._k !== m.reasoning.length) {
      body.textContent = m.reasoning.trim();
      body._k = m.reasoning.length;
    }
    rs.querySelector('summary').textContent = streaming && !hasContent(m) ? '思考中…（点开看）' : '思考过程';
  } else rs.hidden = true;

  // consult panel
  const pn = el.querySelector('.panel');
  if (m.panel && m.panel.length) {
    pn.hidden = false;
    const done = m.panel.filter((p) => p.state !== 'run').length;
    pn.querySelector('summary').innerHTML = `多 AI 会诊 · ${m.panel
      .map((p) => `<span class="pchip ${p.state}">${esc(displayName(p.model))}</span>`)
      .join('')}${done < m.panel.length ? '' : ''}`;
    const body = pn.querySelector('.panel-body');
    const key = m.panel.map((p) => p.state + p.text.length).join('|');
    if (body._k !== key) {
      body.innerHTML = m.panel
        .map(
          (p) => `<section class="expert ${p.state}"><h4>${esc(displayName(p.model))}${p.state === 'run' ? ' · 回答中…' : p.state === 'err' ? ' · 失败' : ''}</h4>${
            p.state === 'err' ? `<p class="muted">${esc(p.error || '')}</p>` : `<div class="md">${mdToHtml(p.text)}</div>`
          }</section>`
        )
        .join('');
      body._k = key;
    }
    if (streaming && !hasContent(m) && !pn._userToggled) pn.open = true;
    if (!streaming && !pn._closedOnce) {
      pn.open = false;
      pn._closedOnce = true;
    }
  } else pn.hidden = true;

  // waiting indicator
  const th = el.querySelector('.thinking');
  const waiting = streaming && !hasContent(m) && !(m.panel && m.panel.some((p) => p.state === 'run'));
  th.hidden = !waiting;
  if (waiting) th.querySelector('.thinking-label').textContent = m.reasoning ? '思考中' : m._waitLabel || '思考中';

  syncParts(el.querySelector('.parts'), m.parts || [], streaming);

  // sources
  const src = el.querySelector('.sources');
  if (m.sources && m.sources.length) {
    src.hidden = false;
    const key = m.sources.length;
    if (src._k !== key) {
      src.innerHTML =
        '<span class="src-label">来源</span>' +
        m.sources
          .map((s) => {
            let host = '';
            try {
              host = new URL(s.url).hostname.replace(/^www\./, '');
            } catch {}
            return `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><b>${esc((s.title || host).slice(0, 60))}</b><span>${esc(host)}</span></a>`;
          })
          .join('');
      src._k = key;
    }
  } else src.hidden = true;

  // error
  const er = el.querySelector('.err');
  if (m.status === 'error' && m.error) {
    er.hidden = false;
    const btns = [];
    if (m.retryable !== false) btns.push('<button type="button" class="btn small" data-action="retry">重试</button>');
    if (/钥匙|余额|充值/.test(m.error)) btns.push('<button type="button" class="btn small ghost" data-action="open-settings">打开设置</button>');
    if (m.errorCode === 'novision' || /找不到这个模型|换一个模型|看不了/.test(m.error)) btns.push('<button type="button" class="btn small ghost" data-action="open-models">换模型</button>');
    er.innerHTML = `<p>${esc(m.error)}</p><div class="err-btns">${btns.join('')}</div>`;
  } else if (m.status === 'stopped' && !hasContent(m)) {
    er.hidden = false;
    er.innerHTML = '<p class="muted">已停止。</p><div class="err-btns"><button type="button" class="btn small" data-action="retry">重新回答</button></div>';
  } else er.hidden = true;

  // footer
  const ft = el.querySelector('.a-foot');
  const showFoot = !streaming && hasContent(m);
  ft.hidden = !showFoot;
  if (showFoot) {
    const bits = [esc(displayName(m.model))];
    if (m.usage && m.usage.cost) bits.push(fmtUSD(m.usage.cost));
    if (m.usage && m.usage.searches) bits.push(`查了 ${m.usage.searches} 次网`);
    if (m.ms && m.status === 'done') bits.push(fmtDuration(m.ms));
    if (m.status === 'stopped') bits.push('已停止');
    ft.querySelector('.meta').innerHTML = bits.join(' · ');
    ft.querySelector('[data-action="regen"]').hidden = !isLast;
  }
}

function hasContent(m) {
  return (m.parts || []).some((p) => (p.t === 'text' && p.v.trim()) || p.t === 'img' || p.t === 'tool');
}
