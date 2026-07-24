// OCR 適配層
// - 雲端後台模式：call /api/ocr（騰訊雲，最準）。需設 ocrUrl。
// - 瀏覽器模式：Tesseract.js 喺電話本地跑，免後台/免 key（auto fallback 用）。
const OCR = (() => {
  function getUrl() { return localStorage.getItem('ocrUrl') || ''; }

  // ---- 文字解析：由 OCR 全文抽出 金額 / 供應商 ----
  function parse(text) {
    const t = (text || '').replace(/,/g, '');
    let amount = null, best = -1;
    const kw = ['總計', '總數', '總', '合計', '合共', '合收', '合', '應付', '應找', '找續', 'Amount', 'TOTAL', 'Total', 'total', '小計', '合結'];
    for (const k of kw) {
      const i = t.indexOf(k);
      if (i >= 0) {
        const sub = t.slice(i, i + 50);
        const mm = sub.match(/([0-9]+(?:\.[0-9]+)?)/);
        if (mm) { const v = parseFloat(mm[1]); if (v > best) { best = v; amount = v; } }
      }
    }
    if (amount === null) {
      const nums = [];
      const re = /(?:MOP|HKD|RMB|港幣|澳門元|澳門幣|人民幣|圓|元|\$)\s*([0-9]+(?:\.[0-9]+)?)/gi;
      let m; while ((m = re.exec(t))) nums.push(parseFloat(m[1]));
      if (nums.length) amount = Math.max(...nums);
    }
    let supplier = null;
    let sups = [];
    try { sups = JSON.parse(localStorage.getItem('suppliers') || 'null') || []; } catch (e) {}
    if (!sups.length) sups = ['康怡美食', '美心', '百佳', '惠康', '源記', '榮記', '新昌', '南光', '其他'];
    for (const s of sups) { if (t.includes(s)) { supplier = s; break; } }
    return { amount, supplier };
  }

  // ---- 瀏覽器 OCR（Tesseract.js，電話本地） ----
  async function scanBrowser(dataUrl) {
    if (typeof Tesseract === 'undefined') return null;
    try {
      const { data } = await Tesseract.recognize(dataUrl, 'chi_tra+chi_sim+eng');
      return parse(data.text);
    } catch (e) { return null; }
  }

  // ---- 雲端後台 OCR（騰訊雲） ----
  async function scanCloud(dataUrl) {
    const url = getUrl();
    if (!url) return null;
    try {
      const r = await fetch(url.replace(/\/$/, '') + '/api/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl.split(',')[1] })
      });
      if (!r.ok) return null;
      const d = await r.json();
      return { amount: d.amount || null, supplier: d.supplier || null };
    } catch (e) { return null; }
  }

  // ---- 主入口：auto = 雲端優先，失敗自動降級瀏覽器 ----
  async function scan(dataUrl) {
    const mode = localStorage.getItem('ocrMode') || 'auto';
    if (mode === 'browser') return await scanBrowser(dataUrl);
    if (mode === 'cloud') return await scanCloud(dataUrl);
    const cloud = await scanCloud(dataUrl);
    if (cloud) return cloud;
    return await scanBrowser(dataUrl);
  }

  function browserReady() { return typeof Tesseract !== 'undefined'; }

  return { getUrl, scan, browserReady, parse };
})();
