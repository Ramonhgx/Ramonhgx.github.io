// OCR 適配層
// - 雲端後台模式：call /api/ocr（騰訊雲，最準）。需設 ocrUrl。
// - 瀏覽器模式：Tesseract.js 喺電話本地跑，免後台/免 key（auto fallback 用）。
const OCR = (() => {
  function getUrl() { return localStorage.getItem('ocrUrl') || ''; }

  // ---- 送貨時間解析：由 OCR 全文抽出 HH:MM（24h）----
  function parseTime(text) {
    const t = text || '';
    const meridiemOf = p => {
      if (/下午|晚上|傍晚|pm|PM/i.test(p)) return 'pm';
      if (/上午|早上|凌晨|深夜|am|AM/i.test(p)) return 'am';
      return '';
    };
    const to24 = (h, m, mer) => {
      h = parseInt(h, 10); m = parseInt(m || '0', 10);
      if (isNaN(h)) return null;
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
      if (h < 0 || h > 23 || m < 0 || m > 59) return null;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    };
    const matchAt = s => {
      // 先試「X點(X半 / X分)」寫法
      let r = s.match(/(上午|下午|早上|凌晨|晚上|中午|am|pm|AM|PM)?\s*(\d{1,2})\s*點\s*(半|(\d{1,2})\s*分?)?/);
      if (r) {
        let h = r[2], m = '0';
        if (r[3] === '半') m = '30'; else if (r[4]) m = r[4];
        const out = to24(h, m, meridiemOf(r[1] || ''));
        if (out) return out;
      }
      // 再試 HH:MM / HH.MM（避開日期 2026-07-26 / 金額 1,234.56）
      r = s.match(/(?:^|[^\/\-\d])(\d{1,2})[:：.](\d{1,2})/);
      if (r) { const out = to24(r[1], r[2], ''); if (out) return out; }
      return null;
    };
    // 1) 關鍵詞錨定：送貨時間 / 時間 / 到貨 / 時段 附近
    const kw = /(送[貨货]?[時时]間|到[貨货][時时]間|到[貨货]|[時时]間|時段|时段|交[貨货][時时]間|出[貨货][時时]間)/i.exec(t);
    if (kw) {
      const tail = t.slice(kw.index + kw[0].length, kw.index + kw[0].length + 25);
      const tm = matchAt(tail);
      if (tm) return tm;
    }
    // 2) 全篇兜底：第一個似時間嘅
    return matchAt(t);
  }

  // ---- 文字解析：由 OCR 全文抽出 金額 / 供應商 / 送貨時間 ----
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
    return { amount, supplier, time: parseTime(t) };
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
