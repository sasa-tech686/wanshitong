// Turn photos and documents into something the AI can read.
import { uid, loadScript } from './util.js';

const MAX_SIDE = 2000; // long edge for photos sent to the AI
const JPEG_Q = 0.85;
const MAX_DOC_CHARS = 120000;
const MAX_PDF_TEXT_PAGES = 80;
const MAX_PDF_PAGE_IMAGES = 6;

const vendor = (p) => new URL('./' + p, import.meta.url).href;

export async function processFile(file, onStatus) {
  const name = file.name || '文件';
  const type = (file.type || '').toLowerCase();
  const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  if (type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp'].includes(ext)) return imageAtt(file);
  if (type === 'application/pdf' || ext === 'pdf') return pdfAtt(file, onStatus);
  if (ext === 'docx') return docxAtt(file);
  if (ext === 'doc') throw new Error('旧版 .doc 读不了，请另存为 .docx 或 PDF 再试。');
  if (['xlsx', 'xls', 'xlsm', 'ods'].includes(ext)) return sheetAtt(file);
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    ['txt', 'md', 'json', 'html', 'htm', 'xml', 'log', 'csv', 'tsv', 'yaml', 'yml', 'js', 'py', 'sql', 'srt', 'vtt'].includes(ext)
  )
    return textAtt(file);
  throw new Error(`「${name}」这种文件暂时读不了。支持：图片、PDF、Word (.docx)、Excel、文字文件。`);
}

async function decodeImage(blob) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

export async function imageToJpeg(blob, maxSide = MAX_SIDE, quality = JPEG_Q) {
  let bmp;
  try {
    bmp = await decodeImage(blob);
  } catch {
    throw new Error('这张图片打不开。如果是 HEIC 格式，请在相机设置改成「兼容性最佳」再拍。');
  }
  const w0 = bmp.width || bmp.naturalWidth;
  const h0 = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return { dataUrl: c.toDataURL('image/jpeg', quality), w, h };
}

async function imageAtt(file) {
  const { dataUrl, w, h } = await imageToJpeg(file);
  return { id: uid('a'), kind: 'image', name: file.name || '照片', dataUrl, w, h };
}

let pdfjsP = null;
function getPdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('./pdf.min.mjs')
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = vendor('pdf.worker.min.mjs');
        return lib;
      })
      .catch((e) => {
        pdfjsP = null;
        throw e;
      });
  }
  return pdfjsP;
}

async function pdfAtt(file, onStatus) {
  onStatus && onStatus('正在读 PDF…');
  const lib = await getPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const base = vendor(''); // everything sits in one folder
  let doc;
  try {
    doc = await lib.getDocument({
      data,
      // Chinese/Japanese/Korean character maps (169 small files) load from the pdf.js package on jsDelivr when a PDF needs them.
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: base,
      wasmUrl: base,
      iccUrl: base,
      isEvalSupported: false,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('这个 PDF 有密码，请先解除密码再发。');
    throw new Error('这个 PDF 打不开：' + (e && e.message ? e.message : '格式有问题'));
  }
  const n = doc.numPages;
  const textPages = Math.min(n, MAX_PDF_TEXT_PAGES);
  let text = '';
  let readPages = 0;
  for (let i = 1; i <= textPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let pageText = '';
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      pageText += it.str;
      if (it.hasEOL) pageText += '\n';
      else if (it.str && !/\s$/.test(it.str)) pageText += ' ';
    }
    text += `\n\n--- 第 ${i} 页 ---\n` + pageText.replace(/[ \t]+\n/g, '\n').trim();
    page.cleanup();
    readPages = i;
    if (text.length > MAX_DOC_CHARS) break;
  }
  const bodyChars = text.replace(/--- 第 \d+ 页 ---/g, '').replace(/\s+/g, '').length;
  // Almost no text layer means a scan or photo: the AI needs page pictures instead.
  const scanned = bodyChars / Math.max(1, readPages) < 12;
  const att = {
    id: uid('a'),
    kind: 'doc',
    name: file.name || '文件.pdf',
    mime: 'application/pdf',
    size: file.size,
    pages: n,
    text: bodyChars ? text.trim().slice(0, MAX_DOC_CHARS) : '',
    pageImages: [],
    note: '',
  };
  // Scanned PDFs have no text layer: send page pictures. Short PDFs (receipts, invoices) get both.
  if (scanned || n <= 2) {
    const count = Math.min(n, MAX_PDF_PAGE_IMAGES);
    for (let i = 1; i <= count; i++) {
      onStatus && onStatus(`正在把第 ${i}/${count} 页转成图片…`);
      att.pageImages.push(await renderPage(doc, i));
    }
    if (scanned && n > count) att.note = `扫描版 PDF 共 ${n} 页，只发了前 ${count} 页。`;
  }
  if (!scanned && readPages < n) att.note = `PDF 共 ${n} 页，只读了前 ${readPages} 页。`;
  try {
    await doc.destroy();
  } catch {}
  return att;
}

async function renderPage(doc, i) {
  const page = await doc.getPage(i);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 1500 / vp1.width);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
  page.cleanup();
  return c.toDataURL('image/jpeg', 0.82);
}

function docFromText(file, text, mime) {
  const clean = (text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) throw new Error(`「${file.name}」里读不到文字。`);
  return {
    id: uid('a'),
    kind: 'doc',
    name: file.name,
    mime,
    size: file.size,
    text: clean.slice(0, MAX_DOC_CHARS),
    pageImages: [],
    note: clean.length > MAX_DOC_CHARS ? '文件很长，只读了前面一部分。' : '',
  };
}

async function docxAtt(file) {
  await loadScript(vendor('mammoth.browser.min.js'));
  const res = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return docFromText(file, res.value, 'docx');
}

async function sheetAtt(file) {
  await loadScript(vendor('xlsx.full.min.js'));
  const XLSX = window.XLSX;
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true });
  let text = '';
  for (const name of wb.SheetNames.slice(0, 12)) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    const lines = csv.split('\n').filter((l) => l.replace(/,/g, '').trim());
    const cut = lines.slice(0, 1500);
    text += `\n\n--- 工作表「${name}」（${lines.length} 行${lines.length > 1500 ? '，只取前 1500 行' : ''}）---\n` + cut.join('\n');
    if (text.length > MAX_DOC_CHARS) break;
  }
  return docFromText(file, text, 'spreadsheet');
}

async function textAtt(file) {
  const text = await file.text();
  return docFromText(file, text, file.type || 'text/plain');
}

export function attSummary(att) {
  if (att.kind === 'image') return '照片';
  const bits = [];
  if (att.pages) bits.push(`${att.pages} 页`);
  if (att.pageImages && att.pageImages.length && !att.text) bits.push('扫描件');
  if (att.text) bits.push(`${att.text.length.toLocaleString()} 字`);
  return bits.join(' · ') || '文件';
}
