// One "turn": send the conversation to the chosen model, let it search the web or draw, stream the answer back.
import { getSettings } from './store.js';
import { caps, parseRef, displayName } from './models.js';
import { streamChat, generateImage, ApiError } from './api.js';
import { safeJSON } from './util.js';

export const ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'];

const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      'Create a new image or edit an existing one (posters, illustrations, logos, product shots, photo edits). The finished image is shown to the user automatically.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Detailed English description: subject, style, composition, lighting, colours. Any words that must appear in the image go in double quotes, in their original language.',
        },
        aspect_ratio: {
          type: 'string',
          enum: ASPECTS,
          description: 'Default 1:1. Phone wallpaper or story: 9:16. Poster: 3:4 or 2:3. Banner or slide: 16:9.',
        },
        reference: {
          type: 'string',
          enum: ['none', 'last_photo', 'last_generated'],
          description: 'Start from an existing image: the photo the user sent most recently, or the image you generated most recently.',
        },
      },
      required: ['prompt'],
    },
  },
};

const SERVER_TOOLS = [
  { type: 'openrouter:web_search', parameters: { max_results: 5 } },
  { type: 'openrouter:web_fetch', parameters: { engine: 'openrouter' } },
];

// ---------- message helpers ----------
export function textOf(m) {
  if (!m) return '';
  if (m.role === 'user') return m.text || '';
  return (m.parts || [])
    .filter((p) => p.t === 'text')
    .map((p) => p.v)
    .join('');
}

export function appendText(asst, s) {
  const last = asst.parts[asst.parts.length - 1];
  if (last && last.t === 'text') last.v += s;
  else asst.parts.push({ t: 'text', v: s });
}

function addUsage(asst, u) {
  if (!u) return;
  asst.usage = asst.usage || { cost: 0, inTok: 0, outTok: 0, searches: 0 };
  asst.usage.cost += Number(u.cost) || 0;
  asst.usage.inTok += Number(u.prompt_tokens || u.input_tokens) || 0;
  asst.usage.outTok += Number(u.completion_tokens || u.output_tokens) || 0;
  const st = u.server_tool_use || {};
  asst.usage.searches += Number(st.web_search_requests) || 0;
}

function addSources(asst, annotations) {
  if (!annotations || !annotations.length) return;
  asst.sources = asst.sources || [];
  for (const a of annotations) {
    const c = (a && (a.url_citation || a)) || {};
    if (!c.url || !/^https?:/i.test(c.url)) continue;
    if (asst.sources.some((s) => s.url === c.url)) continue;
    let title = c.title || '';
    if (!title) {
      try {
        title = new URL(c.url).hostname.replace(/^www\./, '');
      } catch {
        title = c.url;
      }
    }
    asst.sources.push({ url: c.url, title });
  }
  asst.sources = asst.sources.slice(0, 10);
}

function userImages(m) {
  const out = [];
  for (const a of m.atts || []) {
    if (a.kind === 'image' && a.dataUrl) out.push(a.dataUrl);
    if (a.kind === 'doc' && a.pageImages) out.push(...a.pageImages);
  }
  return out;
}

function lastUserPhoto(messages, beforeIdx) {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      const imgs = (m.atts || []).filter((a) => a.kind === 'image');
      if (imgs.length) return imgs[imgs.length - 1].dataUrl;
    }
  }
  return null;
}

function lastGenerated(messages, asst) {
  const own = (asst.parts || []).filter((p) => p.t === 'img');
  if (own.length) return own[own.length - 1].src;
  for (let i = messages.indexOf(asst) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const imgs = (m.parts || []).filter((p) => p.t === 'img');
      if (imgs.length) return imgs[imgs.length - 1].src;
    }
  }
  return null;
}

export function buildSystemPrompt({ voice = false, forceWeb = false, imageTool = false, webTool = false } = {}) {
  const s = getSettings();
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const L = [
    '你是「万事通」，用户手机上的全能私人助理。',
    `现在是 ${now}（时区 ${tz}）。`,
  ];
  if ((s.location || '').trim()) L.push(`用户所在地：${s.location.trim()}。查本地资讯时以此为准。`);
  L.push(
    '',
    '回答方式：',
    '- 用用户用的语言回答：中文用简体；用户讲英文就用英文，讲马来文就用马来文，讲粤语就用粤语口语。',
    '- 手机屏幕小：先给结论，段落短，需要时才用列表；不要用很宽的表格。',
    '- 不确定就直说，不要编造。'
  );
  if (webTool)
    L.push(
      '- 需要最新资讯（新闻、价格、天气、营业时间、汇率、政策、人物近况等）时，先用 web_search 上网查，回答里附上来源链接。用户给网址时可以用 web_fetch 读取。'
    );
  if (forceWeb) L.push('- 这一题请先上网搜索，再根据搜索结果回答，并附上来源链接。');
  if (imageTool)
    L.push(
      '- 用户要画图、做海报、做图标或修改照片时，调用 generate_image 工具，不要只用文字描述。prompt 用英文写具体：主体、风格、构图、光线、颜色；图里要出现的文字照原文写进 prompt 并加引号。要改用户刚发的照片，reference 设为 last_photo；要在你上一张图的基础上改，设为 last_generated。图片生成后会自动显示，你只需简短说明，再问要不要调整。'
    );
  L.push('- 用户发来的照片、PDF、Word、Excel 内容已经附在消息里，可以直接读。');
  if (voice)
    L.push(
      '',
      '现在是语音对话，你的回答会被朗读出来：用自然口语，简短（一般一到三句），不要用 Markdown、列表、表情符号或网址。'
    );
  if ((s.aboutMe || '').trim()) L.push('', '关于用户：', s.aboutMe.trim());
  if ((s.style || '').trim()) L.push('', '用户希望的回答风格：', s.style.trim());
  return L.join('\n');
}

/** Convert stored messages into API messages for the given model. */
export function toApiMessages(history, { ref, voice = false, forceWeb = false, imageTool = false, webTool = false } = {}) {
  const c = caps(ref);
  const out = [{ role: 'system', content: buildSystemPrompt({ voice, forceWeb, imageTool, webTool }) }];
  // Leave out exchanges that failed without any answer; they only confuse the model.
  const failed = new Set();
  history.forEach((m, i) => {
    if (m.role !== 'assistant') return;
    const empty = !textOf(m).trim() && !(m.parts || []).some((p) => p.t === 'img');
    if (empty && (m.status === 'error' || m.status === 'stopped')) {
      failed.add(m);
      if (history[i - 1] && history[i - 1].role === 'user') failed.add(history[i - 1]);
    }
  });
  const recent = history.filter((m) => !failed.has(m)).slice(-40);
  // Only the 4 most recent user messages keep their pictures, to save cost.
  const withImg = recent.filter((m) => m.role === 'user' && userImages(m).length).slice(-4);
  for (const m of recent) {
    if (m.role === 'user') {
      let text = m.text || '';
      for (const a of m.atts || []) {
        if (a.kind !== 'doc') continue;
        text += `\n\n<附件 名称="${a.name}">\n${a.text || '（扫描件，内容见图片）'}\n</附件>`;
        if (a.note) text += `\n（${a.note}）`;
      }
      const imgs = userImages(m);
      if (!text.trim()) text = imgs.length ? '（见图片）' : '…';
      if (imgs.length && c.vision && withImg.includes(m)) {
        const parts = [{ type: 'text', text }];
        for (const u of imgs) parts.push({ type: 'image_url', image_url: { url: u } });
        out.push({ role: 'user', content: parts });
      } else {
        if (imgs.length) text += c.vision ? `\n（这里原本附有 ${imgs.length} 张图片，已省略）` : `\n（附有 ${imgs.length} 张图片，但这个模型看不了图）`;
        out.push({ role: 'user', content: text });
      }
    } else if (m.role === 'assistant') {
      let t = textOf(m).trim();
      const imgs = (m.parts || []).filter((p) => p.t === 'img');
      if (imgs.length) {
        const p = imgs[imgs.length - 1].prompt;
        t += `\n\n[已为用户生成 ${imgs.length} 张图片${p ? '，提示词：' + p.slice(0, 300) : ''}]`;
      }
      if (!t.trim()) continue;
      out.push({ role: 'assistant', content: t.trim() });
    }
  }
  // Keep user/assistant alternating: merge neighbours with the same role.
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') {
      const toParts = (x) => (typeof x === 'string' ? [{ type: 'text', text: x }] : x);
      if (typeof prev.content === 'string' && typeof m.content === 'string') prev.content += '\n\n' + m.content;
      else prev.content = [...toParts(prev.content), ...toParts(m.content)];
    } else merged.push({ ...m });
  }
  return merged;
}

function appendToLastUser(msgs, extraText) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const m = msgs[i];
    if (typeof m.content === 'string') m.content += extraText;
    else {
      const t = m.content.find((p) => p.type === 'text');
      if (t) t.text += extraText;
      else m.content.unshift({ type: 'text', text: extraText });
    }
    return;
  }
}

// ---------- the turn ----------
export async function runTurn({ convo, asst, mode = {}, signal, onUpdate }) {
  const t0 = performance.now();
  asst.status = 'streaming';
  asst.error = '';
  try {
    if (mode.draw) await drawOnly({ convo, asst, mode, signal, onUpdate });
    else if (mode.consult) await consult({ convo, asst, mode, signal, onUpdate });
    else await chatWithTools({ convo, asst, mode, signal, onUpdate });
    asst.status = 'done';
  } catch (e) {
    if (e && e.name === 'AbortError') asst.status = 'stopped';
    else {
      console.error(e);
      asst.status = 'error';
      asst.error = (e && e.message) || String(e);
      asst.retryable = !(e && e.retryable === false);
      asst.errorCode = (e && e.code) || '';
    }
  } finally {
    asst.ms = Math.round(performance.now() - t0);
    for (const p of asst.parts) if (p.t === 'tool' && p.state === 'run') p.state = asst.status === 'stopped' ? 'stop' : 'err';
    for (const p of asst.panel || []) if (p.state === 'run') p.state = 'stop';
    onUpdate({ final: true });
  }
}

async function chatWithTools({ convo, asst, mode, signal, onUpdate }) {
  const s = getSettings();
  const ref = asst.model;
  const c = caps(ref);
  const isOR = parseRef(ref).kind === 'or';
  const idx = convo.messages.indexOf(asst);
  const history = convo.messages.slice(0, idx);
  const user = history[history.length - 1];
  if (user && userImages(user).length && !c.vision) {
    throw new ApiError(`「${displayName(ref)}」看不了图片。请点上方模型名，换一个能看图的模型（例如 Muse Spark 1.3）。`, { retryable: false, code: 'novision' });
  }
  let imageTool = c.tools && !!s.orKey && !!s.imageModel;
  let webTool = isOR && c.tools && s.webMode !== 'off';
  const extra = {};
  if (isOR) extra.usage = { include: true };
  const effort = mode.voice ? 'low' : s.thinking === 'auto' ? null : s.thinking;
  if (effort && c.reasoning) extra.reasoning = { effort };
  if (mode.web && isOR && !webTool) extra.plugins = [{ id: 'web', max_results: 5 }];

  let msgs = toApiMessages(history, { ref, voice: mode.voice, forceWeb: mode.web, imageTool, webTool });
  const toolList = () => [...(imageTool ? [IMAGE_TOOL] : []), ...(webTool ? SERVER_TOOLS : [])];

  for (let step = 0; step < 6; step++) {
    let res;
    try {
      res = await streamChat({
        ref,
        messages: msgs,
        tools: toolList(),
        extra,
        signal,
        onDelta: (d) => {
          if (d.content) appendText(asst, d.content);
          if (d.reasoning) asst.reasoning = (asst.reasoning || '') + d.reasoning;
          onUpdate({ delta: d });
        },
        onKeepAlive: () => onUpdate({ keepalive: true }),
      });
    } catch (e) {
      // Some providers reject tools. Fall back once: first drop web tools, then all tools.
      const nothingYet = !textOf(asst) && !asst.parts.some((p) => p.t === 'img');
      if (e instanceof ApiError && e.status === 400 && step === 0 && nothingYet && (webTool || imageTool)) {
        if (webTool) webTool = false;
        else imageTool = false;
        msgs = toApiMessages(history, { ref, voice: mode.voice, forceWeb: mode.web, imageTool, webTool });
        step = -1;
        continue;
      }
      throw e;
    }
    addUsage(asst, res.usage);
    addSources(asst, res.annotations);
    for (const u of res.images || []) asst.parts.push({ t: 'img', src: u, prompt: '' });
    const calls = (res.toolCalls || []).filter((tc) => tc.function && tc.function.name === 'generate_image');
    if (!calls.length || !imageTool) break;
    const assistantMsg = {
      role: 'assistant',
      content: res.content || null,
      tool_calls: calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: 'generate_image', arguments: tc.function.arguments || '{}' } })),
    };
    if (res.reasoningDetails && res.reasoningDetails.length) assistantMsg.reasoning_details = res.reasoningDetails;
    msgs.push(assistantMsg);
    for (const tc of calls) {
      const args = safeJSON(tc.function.arguments, {});
      const result = await runImageTool({ convo, asst, args, signal, onUpdate });
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    const last = asst.parts[asst.parts.length - 1];
    if (last && last.t === 'text' && last.v && !/\n$/.test(last.v)) last.v += '\n\n';
  }
  if (!textOf(asst).trim() && !asst.parts.some((p) => p.t === 'img')) {
    throw new ApiError('模型没有给出回答，请再试一次，或换一个模型。', { retryable: true, code: 'empty' });
  }
}

async function runImageTool({ convo, asst, args, signal, onUpdate }) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return 'Error: the prompt was empty. Ask the user what to draw.';
  const aspect = ASPECTS.includes(args.aspect_ratio) ? args.aspect_ratio : '1:1';
  const refs = [];
  if (args.reference === 'last_photo') {
    const u = lastUserPhoto(convo.messages, convo.messages.indexOf(asst));
    if (u) refs.push(u);
  } else if (args.reference === 'last_generated') {
    const u = lastGenerated(convo.messages, asst);
    if (u) refs.push(u);
  }
  const part = { t: 'tool', name: 'image', state: 'run', label: refs.length ? '正在改图…' : '正在画图…', detail: prompt, aspect };
  asst.parts.push(part);
  onUpdate({});
  try {
    const out = await generateImage({ prompt, aspect, refs, signal });
    const i = asst.parts.indexOf(part);
    const imgs = out.images.map((src) => ({ t: 'img', src, prompt, aspect }));
    asst.parts.splice(i, 1, ...imgs);
    addUsage(asst, out.usage);
    onUpdate({});
    return `Done: ${imgs.length} image(s) ${refs.length ? 'edited' : 'generated'} and already shown to the user. Reply briefly in the user's language and offer to adjust. Do not paste links, markdown images or base64.`;
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    part.state = 'err';
    part.label = '画图失败：' + ((e && e.message) || e);
    onUpdate({});
    return 'Image generation failed: ' + ((e && e.message) || String(e)) + '. Tell the user briefly in their language.';
  }
}

async function drawOnly({ convo, asst, mode, signal, onUpdate }) {
  const idx = convo.messages.indexOf(asst);
  const user = convo.messages[idx - 1];
  const refs = (user.atts || []).filter((a) => a.kind === 'image').map((a) => a.dataUrl);
  const prompt = (user.text || '').trim() || (refs.length ? 'Enhance this photo: better lighting, sharper, natural colours.' : '');
  if (!prompt) throw new ApiError('请写下想画什么。', { retryable: false });
  const aspect = ASPECTS.includes(mode.aspect) ? mode.aspect : '1:1';
  const part = { t: 'tool', name: 'image', state: 'run', label: refs.length ? '正在改图…' : '正在画图…', detail: prompt, aspect };
  asst.parts.push(part);
  onUpdate({});
  const out = await generateImage({ prompt, aspect, refs, signal });
  const i = asst.parts.indexOf(part);
  asst.parts.splice(i, 1, ...out.images.map((src) => ({ t: 'img', src, prompt, aspect })));
  const caption = (out.content || '').trim();
  if (caption) appendText(asst, caption);
  addUsage(asst, out.usage);
  onUpdate({});
}

async function consult({ convo, asst, mode, signal, onUpdate }) {
  const s = getSettings();
  const idx = convo.messages.indexOf(asst);
  const history = convo.messages.slice(0, idx);
  const panelRefs = (s.panelModels || []).filter(Boolean).slice(0, 4);
  if (!panelRefs.length) throw new ApiError('还没选会诊的模型，请到「设置」选几个。', { retryable: false });
  asst.panel = panelRefs.map((m) => ({ model: m, text: '', state: 'run', error: '' }));
  onUpdate({});
  await Promise.all(
    asst.panel.map(async (p) => {
      try {
        const msgs = toApiMessages(history, { ref: p.model });
        const extra = parseRef(p.model).kind === 'or' ? { usage: { include: true } } : {};
        const res = await streamChat({
          ref: p.model,
          messages: msgs,
          extra,
          signal,
          onDelta: (d) => {
            if (d.content) {
              p.text += d.content;
              onUpdate({ panel: true });
            }
          },
        });
        addUsage(asst, res.usage);
        p.state = p.text.trim() ? 'ok' : 'err';
        if (!p.text.trim()) p.error = '没有回答';
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        p.state = 'err';
        p.error = (e && e.message) || String(e);
      }
      onUpdate({});
    })
  );
  const good = asst.panel.filter((p) => p.state === 'ok');
  if (!good.length) throw new ApiError('几个 AI 都没有回答成功：' + (asst.panel[0].error || ''), { retryable: true });
  const brief = good.map((p, i) => `【专家 ${i + 1}：${displayName(p.model)}】\n${p.text.trim()}`).join('\n\n');
  const ref = asst.model;
  const c = caps(ref);
  const msgs = toApiMessages(history, { ref });
  appendToLastUser(
    msgs,
    '\n\n---\n以下是几位 AI 专家对上面问题的回答。请综合他们：保留对的，纠正错的，点出分歧，然后给出你自己最好的完整答案。不要逐个复述专家的话。\n\n' +
      brief
  );
  const extra = parseRef(ref).kind === 'or' ? { usage: { include: true } } : {};
  if (s.thinking !== 'auto' && c.reasoning) extra.reasoning = { effort: s.thinking };
  const res = await streamChat({
    ref,
    messages: msgs,
    extra,
    signal,
    onDelta: (d) => {
      if (d.content) appendText(asst, d.content);
      if (d.reasoning) asst.reasoning = (asst.reasoning || '') + d.reasoning;
      onUpdate({ delta: d });
    },
  });
  addUsage(asst, res.usage);
  if (!textOf(asst).trim()) throw new ApiError('总结的模型没有给出回答，请再试。', { retryable: true });
}
