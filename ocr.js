// OCR 適配層
// - 雲端後台模式：call /api/ocr（騰訊雲，最準）。需設 ocrUrl。
// - 瀏覽器模式：Tesseract.js 喺電話本地跑，免後台/免 key（auto fallback 用）。
const OCR = (() => {
  function getUrl() { return localStorage.getItem('ocrUrl') || ''; }

  // ---- 送貨日期解析：由 OCR 全文抽出 YYYY-MM-DD ----
  function parseDate(text) {
    const t = text || '';
    const curYear = new Date().getFullYear();
    const toNorm = (y, m, d) => {
      y = parseInt(y, 10); m = parseInt(m, 10); d = parseInt(d, 10);
      if (isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
      if (isNaN(y)) y = curYear;
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };
    const matchAt = (s, strict) => {
      // 完整年月日：2026-07-26 / 2026/7/26 / 2026.7.26 / 2026年7月26日
      let r = s.match(/(\d{4})\s*[年\-\/\.]\s*(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})/);
      if (r) { const o = toNorm(r[1], r[2], r[3]); if (o) return o; }
      // 月日：7/26 / 7-26 / 7月26日；strict 模式唔接受小數點，防金額 9.30 誤判
      r = strict
        ? s.match(/(^|[^\d.])(\d{1,2})[月\/\- ](\d{1,2})(?!\d)/)
        : s.match(/(^|[^\d])(\d{1,2})[月\/\-\. ](\d{1,2})(?!\d)/);
      if (r) { const o = toNorm(curYear, r[2], r[3]); if (o) return o; }
      return null;
    };
    // 關鍵詞錨定：送貨日期 / 交貨日期 / 到貨日期 / 出貨日期 / 日期 附近
    const kw = /(送[貨货]?日[期]?|交[貨货]?日[期]?|到[貨货]?日[期]?|出[貨货]?日[期]?|日期|Delivery\s*Date|Date)/i.exec(t);
    if (kw) {
      const tail = t.slice(kw.index + kw[0].length, kw.index + kw[0].length + 30);
      const dt = matchAt(tail, false);   // 關鍵詞後寬鬆（接受 7.26）
      if (dt) return dt;
    }
    return matchAt(t, true);             // 全篇兜底嚴格（唔接受 9.30 呢類）
  }

  // ---- 文字解析：由 OCR 全文抽出 金額 / 供應商 / 送貨日期 ----
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
    return { amount, supplier, time: parseDate(t) };
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
      return { amount: d.amount || null, supplier: d.supplier || null, time: d.time || null };
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
