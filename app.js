// ===== 康怡入貨 PWA =====
const $ = s => document.querySelector(s);
const todayStr = () => new Date().toISOString().slice(0, 10);
let curViewDate = todayStr();   // 頂欄日期選擇器：睇邊日就顯示邊日（預設今日）

// 發現新版本 service worker 自動重載（新部署下次開 App 即生效）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js?v=20260726c').catch(() => {});
    navigator.serviceWorker.ready.then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) location.reload();
        });
      });
    });
  });
}

const fmtMop = n => 'MOP ' + (Number(n) || 0).toLocaleString('zh-Hant', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 已知供應商（預設值；實際清單由後台 / 騰訊文檔 同步過嚟）
const DEFAULT_SUP = ['三洋油脂', '平衡', '陳衡記', '新豐涷肉', '成記', '客都來', '富逹貿易行', '萬勝餐飲', '杜騷記', '溫記粉面', '絲姐魚欄', '釗哥魚欄'];
let SUP = null; // 快取嘅供應商清單（嚟自後台）

// 由後台攞供應商清單；後台冇反應就退回本機 localStorage
async function loadSuppliers() {
  if (sharedOn()) {
    try {
      const r = await fetch(apiUrl('/api/suppliers'), { cache: 'no-store' });
      if (r.ok) {
        const list = (await r.json()).list || null;
        if (list) {
          SUP = list;
          // 首次：將本機曾經手動加過嘅供應商搬去後台（避免搬去騰訊文檔之前唔見）
          const local = JSON.parse(localStorage.getItem('suppliers') || 'null');
          if (Array.isArray(local)) {
            for (const s of local) if (!SUP.includes(s)) await pushSupplier('add', s);
            localStorage.removeItem('suppliers');
          }
          return SUP;
        }
      }
    } catch (e) {}
  }
  SUP = JSON.parse(localStorage.getItem('suppliers') || 'null') || DEFAULT_SUP.slice();
  return SUP;
}

// 加 / 刪 供應商 → 共用模式寫去後台（再經自動化同步落騰訊文檔）；單機就寫本機
async function pushSupplier(action, name) {
  if (sharedOn()) {
    try {
      await fetch(apiUrl('/api/suppliers'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name })
      });
    } catch (e) {}
    return await loadSuppliers();
  }
  let arr = JSON.parse(localStorage.getItem('suppliers') || 'null') || DEFAULT_SUP.slice();
  if (action === 'add' && !arr.includes(name)) arr.push(name);
  if (action === 'delete') arr = arr.filter(x => x !== name);
  localStorage.setItem('suppliers', JSON.stringify(arr));
  SUP = arr;
}

// ============================================================
//  共用後台（多人同步）：所有員工睇同一份記錄，可接力拍、互相改
//  - 後台網址存喺 localStorage 'ocrUrl'（App 撳 🍱 logo 填，或固定 named tunnel 網址）
//  - 設咗就走共用模式；離線 / 連唔到就自動降級本機 IndexedDB
//  - 圖片網址：共用模式返 /uploads/xxx.jpg（相對），顯示時補返 apiBase
// ============================================================
const apiBase = () => (localStorage.getItem('ocrUrl') || '').trim();
const apiUrl = p => apiBase().replace(/\/$/, '') + p;
const sharedOn = () => !!apiBase();

// 收據存儲：共用後台優先，失敗降級本機
const Store = {
  // 拎某日全部（共用模式由後台 filter date；離線讀本機 cache）
  async list(date) {
    if (sharedOn()) {
      try {
        const r = await fetch(apiUrl('/api/receipts?date=' + date), { cache: 'no-store' });
        if (r.ok) { const arr = await r.json(); await saveDay(date, arr); return arr; }
      } catch (e) {}
      return await loadDay(date); // 離線降級
    }
    return await loadDay(date);
  },
  // 新增（img 已喺前端加好水印嘅 base64）
  async create(rec) {
    if (sharedOn()) {
      try {
        const r = await fetch(apiUrl('/api/receipts'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rec)
        });
        if (r.ok) return await r.json();
      } catch (e) {}
    }
    const day = await loadDay(rec.date);
    const item = { id: Date.now(), img: rec.img, amount: rec.amount, supplier: rec.supplier, paid: rec.paid, operator: rec.operator, dtime: rec.dtime || '', editor: null, history: [], ts: Date.now() };
    day.push(item); await saveDay(rec.date, day);
    return item;
  },
  // 修改（金額/供應商/已付未付，可附新圖）。共用模式交後台記 history；離線本機計
  async update(id, patch) {
    if (sharedOn()) {
      try {
        const r = await fetch(apiUrl('/api/receipts/' + id), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        });
        if (r.ok) return await r.json();
      } catch (e) {}
    }
    const date = curViewDate;
    const day = await loadDay(date);
    const i = day.findIndex(r => r.id === id);
    if (i < 0) return null;
    const old = day[i];
    const history = old.history || [];
    const changes = [];
    if (old.amount !== patch.amount) changes.push({ field: '金額', old: fmtMop(old.amount), new: fmtMop(patch.amount) });
    if ((old.supplier || '未填') !== (patch.supplier || '未填')) changes.push({ field: '供應商', old: old.supplier || '未填', new: patch.supplier || '未填' });
    if ((old.dtime || '') !== (patch.dtime || '')) changes.push({ field: '送貨日期', old: old.dtime || '—', new: patch.dtime || '—' });
    if (old.paid !== patch.paid) changes.push({ field: '付款', old: old.paid ? '已付' : '未付', new: patch.paid ? '已付' : '未付' });
    changes.forEach(f => history.push({ field: f.field, old: f.old, new: f.new, by: patch.by, at: Date.now() }));
    const updated = { ...old, img: patch.img || old.img, amount: patch.amount, supplier: patch.supplier || '未填', paid: patch.paid, dtime: patch.dtime || '', editor: patch.by, history };
    day[i] = updated; await saveDay(date, day);
    return updated;
  },
  async remove(id) {
    if (sharedOn()) {
      try {
        const r = await fetch(apiUrl('/api/receipts/' + id), { method: 'DELETE' });
        if (r.ok) return true;
      } catch (e) {}
    }
    const date = curViewDate;
    const day = await loadDay(date);
    const i = day.findIndex(r => r.id === id);
    if (i >= 0) { day.splice(i, 1); await saveDay(date, day); }
    return true;
  }
};

// ---- IndexedDB（按日儲） ----
const DB = 'receiptDB', STORE = 'days';
function openDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    rq.onsuccess = e => res(e.target.result);
    rq.onerror = e => rej(e);
  });
}
async function loadDay(date) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(STORE, 'readonly');
    const g = tx.objectStore(STORE).get(date);
    g.onsuccess = () => res(g.result || []);
  });
}
async function saveDay(date, arr) {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(arr, date);
    tx.oncomplete = () => res();
  });
}

// ============================================================
//  混合模式：設咗「後台網址」(ocrUrl) → 共用後台（多人同步）；冇設 → 單機 IndexedDB
//  水印 / 修改者 / 修改記錄 基於本機登入用戶，兩種模式都生效。
//  離線 / 後台連唔到會自動降級單機，重連後下次 refresh 再同步。
// ============================================================
// 圖片網址：單機下直接係 base64 / blob；共用模式返 /uploads/xxx.jpg（相對），補返 apiBase
function imgUrl(r) {
  if (!r || !r.img) return '';
  if (r.img.startsWith('/') && apiBase()) return apiBase().replace(/\/$/, '') + r.img;
  return r.img;
}
// 喺圖片上加水印（拍攝/上傳人 + 日期），畀同事睇到係邊個影
async function addWatermark(dataUrl, name) {
  const im = await imageFromSrc(dataUrl);
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0);
  const fs = Math.max(22, Math.round(c.width / 26));
  x.font = `bold ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
  const txt = `康怡 · 拍攝：${name}　${todayStr()}`;
  const w = x.measureText(txt).width;
  const pad = Math.round(fs * 0.5);
  const hgt = Math.round(fs * 2.2);
  x.fillStyle = 'rgba(0,0,0,0.45)';
  x.fillRect(0, c.height - hgt, w + pad * 2, hgt);
  x.fillStyle = '#fff'; x.textBaseline = 'middle';
  x.fillText(txt, pad, c.height - hgt / 2);
  return c.toDataURL('image/jpeg', 0.9);
}

// ---- 狀態 ----
let cur = null; // {img, amount, supplier, paid}

// ---- 多用户登入（似外賣車手：每人註冊一次，之後點名入密碼）----
let curUser = null;     // 當前登入用戶名
let selUser = null;     // 登入頁點選咗嘅用戶

function getUsers() {
  let arr = JSON.parse(localStorage.getItem('users') || 'null');
  if (!Array.isArray(arr)) {
    const old = localStorage.getItem('pin');
    if (old) { arr = [{ name: '樓面', pin: old }]; localStorage.setItem('users', JSON.stringify(arr)); localStorage.removeItem('pin'); }
    else arr = [];
  }
  return arr;
}
function saveUsers(a) { localStorage.setItem('users', JSON.stringify(a)); }

function renderUserPick() {
  const box = $('#userPick');
  const users = getUsers();
  if (!users.length) { box.innerHTML = ''; return; }
  box.innerHTML = users.map(u =>
    `<button type="button" class="upick${selUser === u.name ? ' on' : ''}" data-n="${u.name}">${u.name}</button>`).join('');
  box.querySelectorAll('.upick').forEach(b => b.onclick = () => {
    selUser = b.dataset.n;
    renderUserPick();
    $('#pin').focus();
  });
}

function tryLogin() {
  const users = getUsers();
  if (!users.length) { toast('請先「＋ 新增用戶」註冊'); return; }
  const name = selUser || (users.length === 1 ? users[0].name : null);
  if (!name) { toast('請點選你個名'); return; }
  const u = users.find(x => x.name === name);
  if (!u) { toast('用戶唔存在'); return; }
  if ($('#pin').value === u.pin) {
    curUser = u.name;
    $('#login').classList.remove('active');
    $('#home').classList.add('active');
    $('#who').textContent = curUser;
    loadSuppliers();
    refresh();
  } else toast('密碼錯');
}
$('#btnLogin').onclick = tryLogin;
$('#pin').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

// 註冊
$('#btnRegToggle').onclick = () => {
  $('#regBox').hidden = !$('#regBox').hidden;
  if (!$('#regBox').hidden) $('#regName').focus();
};
$('#btnReg').onclick = () => {
  const name = $('#regName').value.trim();
  const pin = $('#regPin').value;
  if (!name) { toast('請填入用戶名'); return; }
  if (!pin || pin.length < 4) { toast('密碼至少 4 位'); return; }
  const users = getUsers();
  if (users.some(x => x.name === name)) { toast('呢個名已經有'); return; }
  users.push({ name, pin });
  saveUsers(users);
  selUser = name;
  $('#regName').value = ''; $('#regPin').value = ''; $('#regBox').hidden = true;
  curUser = name;
  $('#login').classList.remove('active');
  $('#home').classList.add('active');
  $('#who').textContent = curUser;
  toast('註冊成功，已登入 ' + name);
  loadSuppliers();
  refresh();
};

// 撳 🍱 logo / ⚙️ 設定掣：設後台網址（named tunnel）/ 改密碼
const openSettings = () => {
  if (!curUser) { toast('請先登入'); return; }
  const cur = localStorage.getItem('ocrUrl') || '';
  const inp = prompt(
    '共用後台網址（Tailscale Funnel / named tunnel 嘅 https 網址）：\n' +
    '留空 = 單機模式（資料只留本機，唔同步）\n' +
    '想改密碼請入「pw」', cur);
  if (inp === null) return;
  const v = inp.trim();
  if (v.toLowerCase() === 'pw') {
    const np = prompt('改「' + curUser + '」嘅密碼（留空唔改）：', '');
    if (np && np.length >= 4) {
      const users = getUsers();
      const u = users.find(x => x.name === curUser);
      if (u) { u.pin = np; saveUsers(users); toast('密碼已改'); }
    }
    return;
  } else if (!v) {
    localStorage.removeItem('ocrUrl'); toast('已切換為單��模式'); refresh(); return;
  }
  localStorage.setItem('ocrUrl', v.replace(/\/$/, ''));
  (async () => {
    try {
      const r = await fetch(apiUrl('/api/health'), { cache: 'no-store' });
      if (r.ok) toast('後台連線成功 ✅ 已切換共用模式');
      else toast('連到後台但回應異常（' + r.status + '）');
    } catch (e) { toast('暫時連唔到後台，已儲存，會自動降級單機'); }
    loadSuppliers();
    refresh();
  })();
};
$('.logo').onclick = openSettings;
document.getElementById('btnSettings')?.addEventListener('click', openSettings);
// 手動刷新：強制從後台拉最新貨單（解決多人之間更新慢）
const btnRefresh = document.getElementById('btnRefresh');
if (btnRefresh) {
  btnRefresh.addEventListener('click', async () => {
    btnRefresh.style.transform = 'rotate(360deg)';
    toast('刷新中…');
    try {
      await refresh();
      toast('已更新到最新貨單');
    } catch (e) {
      toast('刷新失敗，請檢查網絡');
    } finally {
      setTimeout(() => { if (btnRefresh) btnRefresh.style.transform = ''; }, 400);
    }
  });
}

// 開頁即渲染用戶列表（首次無用戶就顯示空白，提示去註冊）
renderUserPick();

// 單機模式：無需後台網址，所有資料存本機。

// ---- 拍攝 / 上傳 ----
// 共用的檔案處理：相機影嘅、相簿揀嘅都走呢度
function handleFile(f) {
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => openReview(rd.result);
  rd.readAsDataURL(f);
}
$('#btnCapture').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => { handleFile(e.target.files[0]); e.target.value = ''; };
// 上傳照片：由相簿揀（唔強制開相機）
$('#btnUpload').onclick = () => $('#uploadInput').click();
$('#uploadInput').onchange = e => { handleFile(e.target.files[0]); e.target.value = ''; };
// 重新拍：直接再開相機，新相會覆蓋目前呢張並重跑 OCR
$('#rvRetake').onclick = () => $('#fileInput').click();

// ---- 編輯：旋轉 / 裁剪 / 原圖（縮細 OCR 範圍，慳資源）----
function imageFromSrc(src){return new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=src;});}
async function rotateImage(dataUrl){
  const im=await imageFromSrc(dataUrl);
  const w=im.naturalWidth,h=im.naturalHeight;
  const c=document.createElement('canvas');
  c.width=h;c.height=w;
  const x=c.getContext('2d');
  x.translate(c.width/2,c.height/2);
  x.rotate(90*Math.PI/180);
  x.drawImage(im,-w/2,-h/2);
  return c.toDataURL('image/jpeg',0.92);
}
async function cropImage(dataUrl,sx,sy,sw,sh){
  const im=await imageFromSrc(dataUrl);
  const c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(sw));c.height=Math.max(1,Math.round(sh));
  const x=c.getContext('2d');
  x.drawImage(im,sx,sy,sw,sh,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',0.92);
}
async function reOcr(){
  $('#rvAmount').textContent='辨識中…';
  $('#rvSup').textContent='辨識中…';
  const r=await OCR.scan(cur.img);
  if(r){
    cur.amount=r.amount;cur.supplier=r.supplier;cur.dtime=r.time||'';
    $('#rvAmount').textContent=r.amount?fmtMop(r.amount):'（掃唔到，請手填）';
    $('#rvSup').textContent=r.supplier||'（掃唔到，請揀）';
    $('#rvTime').textContent=r.time?r.time:'（掃唔到，請手填）';
  }else{
    $('#rvAmount').textContent='（掃唔到，請手填）';
    $('#rvSup').textContent='（掃唔到，請揀）';
    $('#rvTime').textContent='（掃唔到，請手填）';
  }
}
// 圖片改過（旋轉/裁剪/原圖）→ 之前嘅辨識結果作廢，提示撳「辨識」重讀
function markNeedsOcr(){
  $('#rvAmount').textContent='（改過圖，撳「辨識」重讀）';
  $('#rvSup').textContent='（改過圖，撳「辨識」重讀）';
  $('#rvTime').textContent='（改過圖，撳「辨識」重讀）';
}
// 辨識：只對「目前編輯後」嘅圖跑 OCR（用家撳先跑，唔會一開就浪費）
$('#rvOcr').onclick=()=>reOcr();
$('#rvRotate').onclick=async()=>{
  try{ const out=await rotateImage(cur.img); cur.img=out; $('#rvImg').src=out; markNeedsOcr(); cur.imgChanged=true; }
  catch(e){ toast('旋轉失敗'); }
};
$('#rvReset').onclick=async()=>{
  cur.img=cur.orig; $('#rvImg').src=imgUrl(cur); markNeedsOcr(); cur.imgChanged=false;
};
$('#rvCrop').onclick=()=>{
  const img=$('#cropImg');
  $('#cropModal').classList.add('active');
  img.onload=()=>{
    const w=img.clientWidth,h=img.clientHeight;
    const sw=w*0.8,sh=h*0.8;
    const sel=$('#cropSel');
    sel.style.left=((w-sw)/2)+'px';
    sel.style.top=((h-sh)/2)+'px';
    sel.style.width=sw+'px';
    sel.style.height=sh+'px';
  };
  img.src=cur.img;
};
$('#cropCancel').onclick=()=>$('#cropModal').classList.remove('active');
$('#cropApply').onclick=async()=>{
  const sel=$('#cropSel');
  const L=parseFloat(sel.style.left),T=parseFloat(sel.style.top),
        W=parseFloat(sel.style.width),H=parseFloat(sel.style.height);
  const img=$('#cropImg');
  const scale=img.naturalWidth/img.clientWidth;
  const out=await cropImage(cur.img,L*scale,T*scale,W*scale,H*scale);
  cur.img=out; $('#rvImg').src=out;
  $('#cropModal').classList.remove('active');
  markNeedsOcr(); cur.imgChanged=true;
};

// 裁剪選框拖動 / 縮放
let cropDrag=null;
function wrapRect(){return $('#cropWrap').getBoundingClientRect();}
function imgClient(){const i=$('#cropImg');return{w:i.clientWidth,h:i.clientHeight};}
$('#cropSel').addEventListener('pointerdown',e=>{
  if(e.target.classList.contains('h'))return;
  e.preventDefault();
  const r=$('#cropSel').getBoundingClientRect();
  cropDrag={type:'move',offX:e.clientX-r.left,offY:e.clientY-r.top};
});
document.querySelectorAll('#cropSel .h').forEach(h=>{
  h.addEventListener('pointerdown',e=>{
    e.preventDefault();e.stopPropagation();
    const s=$('#cropSel');
    cropDrag={type:'resize',corner:h.dataset.c,
      L:parseFloat(s.style.left),T:parseFloat(s.style.top),
      W:parseFloat(s.style.width),H:parseFloat(s.style.height),
      sx:e.clientX,sy:e.clientY};
  });
});
window.addEventListener('pointermove',e=>{
  if(!cropDrag)return;
  const {w,h}=imgClient();
  const sel=$('#cropSel');
  const min=40;
  if(cropDrag.type==='move'){
    const wr=wrapRect();
    let nl=e.clientX-cropDrag.offX-wr.left;
    let nt=e.clientY-cropDrag.offY-wr.top;
    nl=Math.max(0,Math.min(nl,w-parseFloat(sel.style.width)));
    nt=Math.max(0,Math.min(nt,h-parseFloat(sel.style.height)));
    sel.style.left=nl+'px';sel.style.top=nt+'px';
  }else{
    const d=cropDrag;let dx=e.clientX-d.sx,dy=e.clientY-d.sy;
    let L=d.L,T=d.T,W=d.W,H=d.H;
    if(d.corner==='br'){
      W=Math.max(min,Math.min(d.W+dx,w-d.L));
      H=Math.max(min,Math.min(d.H+dy,h-d.T));
    }else if(d.corner==='tl'){
      dx=Math.max(dx,-d.L);dx=Math.min(dx,d.W-min);
      dy=Math.max(dy,-d.T);dy=Math.min(dy,d.H-min);
      L=d.L+dx;T=d.T+dy;W=d.W-dx;H=d.H-dy;
    }else if(d.corner==='tr'){
      W=Math.max(min,Math.min(d.W+dx,w-d.L));
      dy=Math.max(dy,-d.T);dy=Math.min(dy,d.H-min);
      T=d.T+dy;H=d.H-dy;
    }else if(d.corner==='bl'){
      dx=Math.max(dx,-d.L);dx=Math.min(dx,d.W-min);
      L=d.L+dx;W=d.W-dx;
      H=Math.max(min,Math.min(d.H+dy,h-d.T));
    }
    sel.style.left=L+'px';sel.style.top=T+'px';
    sel.style.width=W+'px';sel.style.height=H+'px';
  }
});
window.addEventListener('pointerup',()=>{cropDrag=null;});

// 模式切換：自動辨識（OCR）/ 手寫單手填（直接手填金額 + 手揀供應商，OCR 掃唔到就唔使浪費）
function setMode(manual) {
  if (!cur) cur = {};
  cur.manual = manual;
  $('#modeAuto').classList.toggle('on', !manual);
  $('#modeManual').classList.toggle('on', manual);
  $('#rvOcr').hidden = manual;
  // 金額區
  $('#amtOk').hidden = manual;
  $('#amtFix').hidden = manual;
  $('#amtInput').hidden = !manual;
  if (manual) {
    $('#rvAmount').textContent = '請手填金額';
    $('#amtInput').value = (cur.amount != null && cur.amount !== 0) ? cur.amount : '';
  } else {
    $('#rvAmount').textContent = '（編輯後撳「辨識」）';
  }
  // 供應商區
  $('#supOk').hidden = manual;
  $('#supFix').hidden = manual;
  $('#supSelect').hidden = !manual;
  if (manual) {
    $('#rvSup').textContent = '請揀供應商';
    const sel = $('#supSelect');
    sel.innerHTML = (SUP || DEFAULT_SUP).map(s => `<option value="${s}">${s}</option>`).join('')
      + '<option value="__add__">➕ 新增供應商…</option>';
    if (cur.supplier && cur.supplier !== '未填' && !(SUP || DEFAULT_SUP).includes(cur.supplier)) {
      const o = document.createElement('option'); o.textContent = cur.supplier; o.value = cur.supplier; sel.prepend(o);
    }
    sel.value = (cur.supplier && cur.supplier !== '未填') ? cur.supplier : '';
    sel.onchange = () => { if (sel.value === '__add__') { renderSuppliers(); $('#supModal').classList.add('active'); } };
  } else {
    $('#rvSup').textContent = '（編輯後撳「辨識」）';
  }
  // 送貨日期區
  $('#timeOk').hidden = manual;
  $('#timeFix').hidden = manual;
  $('#timeInput').hidden = !manual;
  if (manual) {
    $('#rvTime').textContent = '請手填送貨日期';
    $('#timeInput').value = cur.dtime || '';
  } else {
    $('#rvTime').textContent = cur.dtime ? cur.dtime : '（編輯後撳「辨識」）';
  }
}
$('#modeAuto').onclick = () => setMode(false);
$('#modeManual').onclick = () => setMode(true);

async function openReview(img) {
  cur = { id: null, img, orig: img, amount: null, supplier: null, paid: false, operator: curUser || '—', dtime: '', imgChanged: false };
  $('#payUnpaid').classList.add('on'); $('#payPaid').classList.remove('on');
  $('#rvImg').src = imgUrl(cur);
  $('#reviewTitle').textContent = '確認這張貨單';
  $('#rvSave').textContent = '✔ 存呢張，影下一張';
  $('#rvHistory').innerHTML = '';
  $('#rvDelete').hidden = true;
  setMode(false);
  $('#review').classList.add('active');
}

// 回頭改舊單：帶入原有資料（金額 / 供應商 / 已付未付 都可改），存時覆蓋原單
function openEdit(rec) {
  cur = { id: rec.id, img: rec.img, orig: rec.img, amount: rec.amount, supplier: rec.supplier, paid: rec.paid, operator: rec.operator || curUser || '—', dtime: rec.dtime || '', imgChanged: false };
  $('#payPaid').classList.toggle('on', !!rec.paid);
  $('#payUnpaid').classList.toggle('on', !rec.paid);
  $('#rvImg').src = imgUrl(rec);
  $('#reviewTitle').textContent = '修改這張貨單';
  $('#rvSave').textContent = '💾 儲存修改';
  $('#rvDelete').hidden = false;
  renderHistory(rec);
  setMode(rec.amount != null || !!rec.supplier); // 已有值 → 直接手改；無值 → 自動辨識試下
  $('#review').classList.add('active');
}

// 顯示「修改記錄」：邊個、幾時、改咗乜
function renderHistory(rec) {
  const box = $('#rvHistory');
  if (!rec || !rec.history || !rec.history.length) {
    box.innerHTML = rec && rec.editor ? `<div class="hist-line">最後修改者：<b>${rec.editor}</b></div>` : '';
    return;
  }
  const lines = rec.history.slice().reverse().map(h => {
    const t = new Date(h.at || Date.now()).toLocaleString('zh-Hant');
    return `<div class="hist-line">${h.by} 改「${h.field}」：${h.old ?? '—'} → ${h.new ?? '—'}<span class="hist-time">${t}</span></div>`;
  }).join('');
  box.innerHTML = `<div class="hist-title">修改記錄（${rec.history.length} 次）</div>${lines}`;
}

// 金額
$('#amtOk').onclick = () => { $('#amtInput').hidden = true; };
$('#amtFix').onclick = () => {
  $('#amtInput').hidden = false;
  $('#amtInput').value = cur.amount || '';
  $('#amtInput').focus();
};
// 送貨日期
$('#timeOk').onclick = () => { $('#timeInput').hidden = true; };
$('#timeFix').onclick = () => {
  $('#timeInput').hidden = false;
  $('#timeInput').value = cur.dtime || '';
  $('#timeInput').focus();
};
// 供應商
$('#supOk').onclick = () => { $('#supSelect').hidden = true; };
$('#supFix').onclick = () => {
  const sel = $('#supSelect');
  sel.innerHTML = (SUP || DEFAULT_SUP).map(s => `<option value="${s}">${s}</option>`).join('')
    + '<option value="__add__">➕ 新增供應商…</option>';
  if (cur.supplier) { const o = document.createElement('option'); o.textContent = cur.supplier; o.value = cur.supplier; sel.prepend(o); sel.value = cur.supplier; }
  sel.hidden = false;
  sel.onchange = () => { if (sel.value === '__add__') { renderSuppliers(); $('#supModal').classList.add('active'); } };
};

// ---- 供應商管理（增刪，經後台同步落騰訊文檔）----
function renderSuppliers() {
  const list = $('#supList');
  list.innerHTML = (SUP || DEFAULT_SUP).map(s =>
    `<li><span>${s}</span><button class="sup-del" data-s="${s}">✕</button></li>`).join('');
  list.querySelectorAll('.sup-del').forEach(b => b.onclick = async () => {
    const s = b.dataset.s;
    await pushSupplier('delete', s);
    renderSuppliers();
    toast('已刪：' + s);
  });
}
$('#btnSup').onclick = async () => { await loadSuppliers(); renderSuppliers(); $('#supModal').classList.add('active'); };
$('#supClose').onclick = () => $('#supModal').classList.remove('active');
$('#supAdd').onclick = async () => {
  const v = $('#supNew').value.trim();
  if (!v) return;
  await pushSupplier('add', v);
  $('#supNew').value = '';
  renderSuppliers();
  toast('已加：' + v);
};
$('#supNew').addEventListener('keydown', e => { if (e.key === 'Enter') $('#supAdd').click(); });
// 付款
$('#payPaid').onclick = () => { cur.paid = true; $('#payPaid').classList.add('on'); $('#payUnpaid').classList.remove('on'); };
$('#payUnpaid').onclick = () => { cur.paid = false; $('#payUnpaid').classList.add('on'); $('#payPaid').classList.remove('on'); };

// 存檔（共用模式寫去後台並留本機 cache；單機只寫本機 IndexedDB）
$('#rvSave').onclick = async () => {
  const wasEdit = cur.id != null;
  let amt = cur.amount;
  if (!$('#amtInput').hidden) amt = parseFloat($('#amtInput').value) || 0;
  let sup = cur.supplier;
  if (!$('#supSelect').hidden) sup = $('#supSelect').value;
  if (sup === '__add__') sup = null;
  let dtime = cur.dtime || '';
  if (!$('#timeInput').hidden) dtime = $('#timeInput').value.trim() || '';
  const date = curViewDate;   // 存去「頂欄所揀日期」而非硬寫今日，方便補錄舊單
  if (wasEdit) {
    // 編輯：圖改過就連圖一齊 PUT；history 交後台記（離線則本機計）
    const patch = { amount: amt, supplier: sup || '未填', paid: cur.paid, dtime, by: curUser || '—' };
    if (cur.imgChanged) patch.img = cur.img;
    await Store.update(cur.id, patch);
  } else {
    const wm = await addWatermark(cur.img, curUser || '—');
    await Store.create({ img: wm, amount: amt, supplier: sup || '未填', paid: cur.paid, dtime, operator: curUser || '—', date, ts: Date.now() });
  }
  $('#review').classList.remove('active');
  cur = null;
  refresh();
};

// 確認彈層（修改模式）刪除這張單
$('#rvDelete').onclick = async () => {
  if (cur && cur.id != null && confirm('確定刪除這張貨單？此動作不能復原。')) {
    await deleteReceipt(cur.id);
    $('#review').classList.remove('active');
    cur = null;
  }
};

// 刪除一張貨單（共用模式交後台；單機移本機 IndexedDB）
async function deleteReceipt(id) {
  await Store.remove(id);
  refresh();
  toast('已刪除這張單 🗑');
}

// ---- 列表 / 統計 ----
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function refresh() {
  const day = await Store.list(curViewDate);
  $('#today').value = curViewDate;
  $('#cntToday').textContent = day.length;
  const paid = day.filter(r => r.paid).reduce((s, r) => s + (r.amount || 0), 0);
  const unpaid = day.filter(r => !r.paid).reduce((s, r) => s + (r.amount || 0), 0);
  $('#sumPaid').textContent = fmtMop(paid).replace('MOP ', '');
  $('#sumUnpaid').textContent = fmtMop(unpaid).replace('MOP ', '');
  const ul = $('#receiptList');
  ul.innerHTML = '';
  $('#emptyTip').style.display = day.length ? 'none' : 'block';
  day.slice().reverse().forEach(r => {
    const li = document.createElement('li');
    const editLine = (r.editor && r.editor !== r.operator) ? `｜改：${esc(r.editor)}` : '';
    const dLine = r.dtime ? `｜送：${esc(r.dtime)}` : '';
    li.innerHTML = `<img class="thumb" src="${imgUrl(r)}">
      <div class="info"><div class="s">${esc(r.supplier)}</div><div class="m">${fmtMop(r.amount)}</div><div class="op">錄：${esc(r.operator || '')}${editLine}${dLine}</div></div>
      <span class="tag ${r.paid ? 'paid' : 'unpaid'}">${r.paid ? '已付' : '未付'}</span>
      <button class="li-edit" title="修改這張">✎</button>
      <button class="li-del" title="刪除這張">🗑</button>`;
    const thumb = li.querySelector('.thumb');
    attachLongPress(thumb, () => r);
    li.querySelector('.li-edit').onclick = e => { e.stopPropagation(); openEdit(r); };
    li.querySelector('.li-del').onclick = e => { e.stopPropagation(); if (confirm('確定刪除這張貨單？此動作不能復原。')) deleteReceipt(r.id); };
    li.onclick = () => { if (lpJustFired) return; openLightbox(r); };
    ul.appendChild(li);
  });
}

// 頂欄日期選擇器：揀邊日就顯示邊日嘅貨單（可翻睇舊單 + 補錄歷史單）
const selDate = document.getElementById('today');
if (selDate) {
  selDate.value = curViewDate;
  selDate.addEventListener('change', e => {
    curViewDate = e.target.value || todayStr();
    refresh();
  });
}

// ---- 總結圖 ----
function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}
$('#btnSummary').onclick = async () => {
  const day = await loadDay(curViewDate);
  await drawSummary(day);
  $('#summaryModal').classList.add('active');
};
async function drawSummary(day) {
  const c = $('#summaryCanvas'), x = c.getContext('2d');
  const W = 720, rowH = 210, headH = 200, footH = 120;
  const H = headH + day.length * rowH + footH;
  c.width = W; c.height = H;
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#c0392b'; x.fillRect(0, 0, W, 120);
  x.fillStyle = '#fff'; x.textBaseline = 'middle';
  x.font = '40px "宋体", SimSun, serif';
  x.fillText('康怡美食 · 入貨總結', 30, 60);
  x.font = '24px "宋体", SimSun, serif';
  x.fillText(curViewDate, 30, 160);
  x.fillText('共 ' + day.length + ' 張單', 420, 160);

  let y = headH, total = 0;
  for (let i = 0; i < day.length; i++) {
    const r = day[i];
    total += (r.amount || 0);
    // 縮圖
    try {
      const im = await loadImg(imgUrl(r));
      const tw = 170, th = 130, s = Math.min(tw / im.width, th / im.height, 1);
      const dw = im.width * s, dh = im.height * s;
      x.fillStyle = '#f2f2ee'; x.fillRect(30, y + 35, tw, th);
      x.drawImage(im, 30 + (tw - dw) / 2, y + 35 + (th - dh) / 2, dw, dh);
    } catch (e) {
      x.fillStyle = '#eee'; x.fillRect(30, y + 35, 170, 130);
    }
    // 文字
    x.fillStyle = '#222'; x.font = '28px "宋体", SimSun, serif';
    x.fillText(`${i + 1}. ${r.supplier || '未填'}`, 230, y + 60);
    x.fillStyle = '#c0392b'; x.font = '34px "宋体", SimSun, serif';
    x.fillText(fmtMop(r.amount), 230, y + 110);
    x.fillStyle = r.paid ? '#1e7d3a' : '#c0392b'; x.font = '24px "宋体", SimSun, serif';
    x.fillText(r.paid ? '已付' : '未付', 540, y + 110);
    if (r.operator) { x.fillStyle = '#999'; x.font = '20px "宋体", SimSun, serif'; x.fillText('錄：' + r.operator, 230, y + 155); }
    x.strokeStyle = '#eee'; x.beginPath(); x.moveTo(20, y + rowH - 12); x.lineTo(W - 20, y + rowH - 12); x.stroke();
    y += rowH;
  }
  x.fillStyle = '#f5f5f0'; x.fillRect(0, y, W, footH);
  x.fillStyle = '#222'; x.font = '32px "宋体", SimSun, serif';
  x.fillText('總計', 30, y + 62);
  x.fillStyle = '#c0392b'; x.font = '42px "宋体", SimSun, serif';
  x.fillText(fmtMop(total), 300, y + 64);
}
$('#dlImg').onclick = () => {
  const a = document.createElement('a');
  a.download = `入貨總結_${todayStr()}.png`;
  a.href = $('#summaryCanvas').toDataURL('image/png');
  a.click();
};
$('#closeSummary').onclick = () => $('#summaryModal').classList.remove('active');

// 判斷是否喺微信內置瀏覽器開
function isWeChat() { return /MicroMessenger/i.test(navigator.userAgent); }
// 分享降級：微信內彈指引；其餘環境存圖到相簿
function shareFallback(canvas) {
  if (isWeChat()) { $('#wxGuide').classList.add('active'); return; }
  const a = document.createElement('a');
  a.download = `入貨單_${todayStr()}.png`; a.href = canvas.toDataURL('image/png'); a.click();
  toast('已存圖到相簿，請手動分享去微信');
}
$('#wxGuideOk').onclick = () => $('#wxGuide').classList.remove('active');

// 畫一張單嘅分享卡（收據圖 + 供應商 / 金額 / 已付未付 / 錄入人）
async function buildReceiptCard(r) {
  const W = 720, pad = 30, headH = 100, gap = 20;
  const cv = document.createElement('canvas');
  const x = cv.getContext('2d');
  let imgDrawW = 0, imgDrawH = 0;
  try {
    const im = await loadImg(imgUrl(r));
    const maxW = W - pad * 2, maxH = 520;
    const s = Math.min(maxW / im.width, maxH / im.height, 1);
    imgDrawW = im.width * s; imgDrawH = im.height * s;
    cv.width = W; cv.height = headH + gap + imgDrawH + gap + 200;
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, cv.height);
    x.fillStyle = '#c0392b'; x.fillRect(0, 0, W, headH);
    x.fillStyle = '#fff'; x.font = '38px "宋体", SimSun, serif'; x.textBaseline = 'middle';
    x.fillText('康怡美食 · 入貨單', pad, headH / 2);
    const ix = (W - imgDrawW) / 2;
    x.drawImage(im, ix, headH + gap, imgDrawW, imgDrawH);
  } catch (e) {
    cv.width = W; cv.height = headH + 200;
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, cv.height);
    x.fillStyle = '#c0392b'; x.fillRect(0, 0, W, headH);
    x.fillStyle = '#fff'; x.font = '38px "宋体", SimSun, serif'; x.textBaseline = 'middle';
    x.fillText('康怡美食 · 入貨單', pad, headH / 2);
  }
  const iy = headH + gap + imgDrawH + 50;
  x.textBaseline = 'alphabetic';
  x.fillStyle = '#222'; x.font = '30px "宋体", SimSun, serif';
  x.fillText(`供應商：${r.supplier || '未填'}`, pad, iy);
  x.fillStyle = '#c0392b'; x.font = '34px "宋体", SimSun, serif';
  x.fillText(`金額：MOP ${r.amount ? r.amount.toFixed(2) : '—'}`, pad, iy + 50);
  x.fillStyle = r.paid ? '#1e7d3a' : '#c0392b'; x.font = '28px "宋体", SimSun, serif';
  x.fillText(`狀態：${r.paid ? '已付' : '未付'}`, pad, iy + 100);
  x.fillStyle = '#555'; x.font = '24px "宋体", SimSun, serif';
  x.fillText(`錄入：${r.operator || ''}　${todayStr()}`, pad, iy + 145);
  return cv;
}
// ---- 轉發今日貨單（微信 / 手機原生分享）----
$('#btnShare').onclick = async () => {
  const day = await loadDay(curViewDate);
  if (!day.length) { toast(curViewDate + ' 仲未影到單，無嘢轉發'); return; }
  await drawSummary(day);
  const canvas = $('#summaryCanvas');
  let total = 0; day.forEach(r => total += (r.amount || 0));
  const text = `康怡美食 入貨總結 ${curViewDate}\n共 ${day.length} 張單｜總計 MOP ${total.toFixed(2)}\n（詳見附圖）`;
  canvas.toBlob(async (blob) => {
    if (!blob) { toast('製圖失敗，請改用「出今日總結圖」存圖再手發'); return; }
    const file = new File([blob], `入貨總結_${todayStr()}.png`, { type: 'image/png' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try {
        await navigator.share({ files: [file], title: '康怡美食 入貨總結', text });
        toast('已開啟分享，揀微信聯絡人 / 群就得');
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    shareFallback(canvas);
  }, 'image/png');
};

// ---- 推送今日貨單去後台（寫 daily/<日期>.json，畀自動化落騰訊文檔）----
$('#btnPush').onclick = async () => {
  if (!sharedOn()) { toast('請先撳 🍱 填後台網址，先可推送'); return; }
  const day = await Store.list(curViewDate);
  try {
    const r = await fetch(apiUrl('/api/push'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: curViewDate, records: day })
    });
    if (r.ok) toast('已推送 ' + curViewDate + ' ' + day.length + ' 張單去後台 ✅');
    else { const e = await r.json().catch(() => ({})); toast('推送失敗：' + (e.error || r.status)); }
  } catch (e) { toast('推送失敗，連唔到後台'); }
};

// ---- 長按圖片彈選單（似外賣車手 / 微信：長按 → 修改 / 儲存）----
let lpTarget = null, lpJustFired = false;
function showImgMenu(t) {
  lpTarget = t;
  $('#imgMenuEdit').style.display = (t && t._review) ? 'none' : 'flex';
  $('#imgMenu').classList.add('active');
}
function hideImgMenu() { $('#imgMenu').classList.remove('active'); }
// 通用長按偵測：觸屏長按 480ms → 彈選單；同時支持桌面右鍵 / 長按
function attachLongPress(el, getTarget) {
  if (!el) return;
  let timer = null, sx = 0, sy = 0;
  const begin = (x, y) => {
    sx = x; sy = y;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      lpJustFired = true; setTimeout(() => lpJustFired = false, 350);
      showImgMenu(getTarget());
    }, 480);
  };
  const move = (x, y) => { if (Math.abs(x - sx) > 12 || Math.abs(y - sy) > 12) { if (timer) { clearTimeout(timer); timer = null; } } };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', e => { const t = e.touches[0]; begin(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener('touchmove', e => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', e => { e.preventDefault(); lpJustFired = true; setTimeout(() => lpJustFired = false, 350); showImgMenu(getTarget()); });
  el.addEventListener('mousedown', e => { if (e.button !== 0) return; begin(e.clientX, e.clientY); });
  el.addEventListener('mousemove', e => { move(e.clientX, e.clientY); });
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
}
// 確認彈層張圖都支援長按（只儲存，唔使「修改」）
attachLongPress($('#rvImg'), () => ({
  _review: true,
  img: cur ? cur.img : null,
  supplier: cur ? cur.supplier : null,
  amount: cur ? cur.amount : 0,
  paid: cur ? cur.paid : false,
  operator: cur ? cur.operator : null
}));
// 選單項點擊
document.querySelectorAll('#imgMenu .img-menu-item').forEach(b => {
  b.onclick = async () => {
    const act = b.dataset.act;
    if (act === 'cancel') { hideImgMenu(); return; }
    const t = lpTarget; hideImgMenu();
    if (!t) return;
    if (act === 'edit') openEdit(t);
    else if (act === 'save') saveImage(t);
    else if (act === 'del') {
      if (!t || t.id == null) { toast('請喺列表長按圖片刪除'); return; }
      if (confirm('確定刪除這張貨單？此動作不能復原。')) deleteReceipt(t.id);
    }
  };
});
$('#imgMenu').addEventListener('click', e => { if (e.target.id === 'imgMenu') hideImgMenu(); });

// ---- 點圖放大看細節（lightbox：雙指縮放 / 拖動 / 雙擊放大 / 滾輪）----
const zoomModal = $('#imgZoom');
const zoomImg = $('#zoomImg');
const zoomStage = $('#zoomStage');
const ZMAX = 6;
let zScale = 1, zX = 0, zY = 0;
let zDrag = false, zDX = 0, zDY = 0, zOX = 0, zOY = 0;
let zMode = null, zSX = 0, zSY = 0, zStartScale = 1, zStartDist = 0, zMoved = false, zLastTap = 0;
function zApply() {
  zoomImg.style.transform = `translate(${zX}px, ${zY}px) scale(${zScale})`;
  $('#zoomPct').textContent = Math.round(zScale * 100) + '%';
}
function zClamp() {
  const mx = zoomImg.clientWidth * (zScale - 1) / 2;
  const my = zoomImg.clientHeight * (zScale - 1) / 2;
  zX = Math.max(-mx, Math.min(mx, zX));
  zY = Math.max(-my, Math.min(my, zY));
}
function zReset() { zScale = 1; zX = 0; zY = 0; zApply(); }
function openLightbox(r) {
  zoomImg.src = imgUrl(r);
  zoomModal.classList.add('active');
  zReset();
}
function closeLightbox() { zoomModal.classList.remove('active'); }

$('#zoomClose').onclick = closeLightbox;
$('#zoomReset').onclick = zReset;
$('#zoomIn').onclick = () => { zScale = Math.min(ZMAX, zScale + 0.5); zClamp(); zApply(); };
$('#zoomOut').onclick = () => { zScale = Math.max(1, zScale - 0.5); zClamp(); zApply(); };

// 桌面：滑鼠拖動 + 滾輪縮放 + 雙擊
zoomStage.addEventListener('mousedown', e => {
  if (zScale <= 1) return;
  zDrag = true; zDX = e.clientX; zDY = e.clientY; zOX = zX; zOY = zY; e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!zDrag) return;
  zX = zOX + (e.clientX - zDX); zY = zOY + (e.clientY - zDY); zClamp(); zApply();
});
window.addEventListener('mouseup', () => { zDrag = false; });
zoomStage.addEventListener('dblclick', e => {
  e.preventDefault();
  zScale = (zScale > 1.2) ? 1 : 2.5; if (zScale === 1) { zX = 0; zY = 0; } zApply();
});
zoomStage.addEventListener('wheel', e => {
  e.preventDefault();
  zScale = Math.max(1, Math.min(ZMAX, zScale + (e.deltaY < 0 ? 0.3 : -0.3)));
  zClamp(); zApply();
}, { passive: false });

// 觸屏：單指拖動 + 雙指縮放 + 雙擊放大
const zDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
zoomStage.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    zMode = 'single'; zSX = e.touches[0].clientX; zSY = e.touches[0].clientY;
    zOX = zX; zOY = zY; zMoved = false;
  } else if (e.touches.length === 2) {
    zMode = 'pinch'; zStartScale = zScale; zStartDist = zDist(e.touches[0], e.touches[1]); e.preventDefault();
  }
}, { passive: false });
zoomStage.addEventListener('touchmove', e => {
  if (zMode === 'single' && e.touches.length === 1) {
    const dx = e.touches[0].clientX - zSX, dy = e.touches[0].clientY - zSY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) zMoved = true;
    if (zScale > 1) { zX = zOX + dx; zY = zOY + dy; zClamp(); zApply(); }
  } else if (zMode === 'pinch' && e.touches.length === 2) {
    const d = zDist(e.touches[0], e.touches[1]);
    zScale = Math.max(1, Math.min(ZMAX, zStartScale * d / zStartDist)); zClamp(); zApply(); e.preventDefault();
  }
}, { passive: false });
zoomStage.addEventListener('touchend', e => {
  if (zMode === 'single' && !zMoved && e.touches.length === 0) {
    const now = Date.now();
    if (now - zLastTap < 300) { zScale = (zScale > 1.2) ? 1 : 2.5; if (zScale === 1) { zX = 0; zY = 0; } zApply(); zLastTap = 0; }
    else zLastTap = now;
  }
  if (e.touches.length === 0) zMode = null;
});
// 儲存圖片到相簿（微信內仍受限，會走 shareFallback 指引）
function saveImage(rec) {
  if (!rec) { toast('無圖可存'); return; }
  if (!rec.img) { toast('無圖可存'); return; }
  const a = document.createElement('a');
  a.href = rec.img; a.download = `貨單_${todayStr()}.png`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  toast('已存圖片到相簿');
}

// ---- toast ----
let tt;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2200);
}

// 註冊 SW（PWA 離線/加到主畫面）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js?v=20260726c').catch(() => {});
}
