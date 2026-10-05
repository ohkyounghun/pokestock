// 포켓몬카드 편의점 재고 조회 (개인용). 의존성 없이 Node 18+ 에서 실행: node server.js
// 세븐일레븐·이마트24의 비공식 공개 웹 엔드포인트를 사용하므로 예고 없이 막힐 수 있다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const STATE_FILE = path.join(DATA, 'state.json');
const PORT = process.env.PORT || 8787;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WEEK = 7 * 24 * 60 * 60 * 1000;
const CHAINS = { seven: '세븐일레븐', emart24: '이마트24' };

fs.mkdirSync(DATA, { recursive: true });
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value));
  fs.renameSync(file + '.tmp', file);
};

const config = {
  center: { name: '공릉역', lat: 37.6256, lng: 127.0730 },
  radiusKm: 20,
  intervalMin: 10,
  selected: [],
  ...readJson(CONFIG_FILE, {}),
};
const saveConfig = () => writeJson(CONFIG_FILE, config);

// qty: "chain:storeCd:barcode" -> { qty, at }  /  seen: 한 번이라도 조회를 마친 "chain:barcode"
const state = { qty: {}, seen: {}, events: [], ...readJson(STATE_FILE, {}) };
const status = { running: false, progress: '', lastRun: null, nextRun: null, errors: {}, storeCounts: {} };
let catalog = [];
let catalogAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const distKm = (lat1, lng1, lat2, lng2) => {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

class Blocked extends Error {}
// 체인별로 요청을 한 줄로 세우고 간격을 둔다. 403을 받으면 30분간 그 체인은 건드리지 않는다.
const lanes = {
  seven: { gap: 400, tail: Promise.resolve(), blockedUntil: 0 },
  emart24: { gap: 1500, tail: Promise.resolve(), blockedUntil: 0 },
};
function getJson(chain, url, init = {}) {
  const lane = lanes[chain];
  const run = lane.tail.then(async () => {
    if (Date.now() < lane.blockedUntil) throw new Blocked(`${CHAINS[chain]}가 요청을 막아 잠시 쉬는 중`);
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...init.headers },
        signal: AbortSignal.timeout(30000),
      });
    } finally {
      await sleep(lane.gap);
    }
    if (res.status === 403 || res.status === 429) {
      lane.blockedUntil = Date.now() + 30 * 60 * 1000;
      throw new Blocked(`${CHAINS[chain]}가 요청을 막음 (HTTP ${res.status}), 30분 뒤 재시도`);
    }
    if (!res.ok) throw new Error(`${CHAINS[chain]} HTTP ${res.status}`);
    return res.json();
  });
  lane.tail = run.then(() => {}, () => {});
  return run;
}
const postJson = (chain, url, body) => getJson(chain, url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------- 세븐일레븐 ----------
const SEVEN = 'https://new.7-elevenapp.co.kr/api/v1/open';
const sevenDocs = (res, id) =>
  (res?.data?.SearchQueryResult?.Collection ?? []).find((c) => c.CollectionId === id)?.Documentset?.Document ?? [];

async function sevenStores() {
  const res = await postJson('seven', `${SEVEN}/search/store`, {
    collection: 'store', query: '', sort: 'Date/desc', listCount: 20000,
  });
  return sevenDocs(res, 'store')
    .map((d) => d.field)
    .filter((f) => f.storeCloseYn !== 'Y')
    .map((f) => ({ code: f.storeCd, name: f.storeNm, addr: `${f.addr1 ?? ''} ${f.addr2 ?? ''}`.trim(), lat: +f.storeLat, lng: +f.storeLon }));
}

async function sevenProducts() {
  const out = new Map();
  for (let page = 0; page < 5; page++) {
    const res = await postJson('seven', `${SEVEN}/search/goods`, {
      collection: 'goods', query: '포켓몬확장팩', sort: 'quantity/desc,itemOnm/asc', startCount: page, listCount: 100,
    });
    const docs = sevenDocs(res, 'offline');
    for (const { field: f } of docs) {
      if (/포켓몬/.test(f.itemOnm) && /확장팩|카드|하이클래스|스타터|덱/.test(f.itemOnm)) {
        out.set(f.itemCd, { code: f.itemCd, name: f.itemOnm, price: +f.itemPrice || +f.onlinePrice || 0 });
      }
    }
    if (docs.length < 100) break;
  }
  return [...out.values()];
}

const sevenMeta = {};
async function sevenStock(code, storeCodes) {
  const m = (sevenMeta[code] ??= await getJson('seven', `${SEVEN}/product/search/stock?itemCd=${code}`));
  if (!m?.smCd) throw new Error('세븐일레븐 상품 정보 없음');
  const qty = new Map();
  for (let i = 0; i < storeCodes.length; i += 300) {
    const res = await postJson('seven', `${SEVEN}/real-stock/multi/01/stocks`, {
      smCd: m.smCd,
      stokMngCd: m.stokMngCd ?? m.smCd,
      stokMngQty: m.stokMngQty ?? 1,
      stockApplicationRate: m.stockApplicationRate ?? '100',
      storeList: storeCodes.slice(i, i + 300),
    });
    for (const s of res?.data?.storeList ?? []) qty.set(s.storeCd, +s.stock || 0);
  }
  return qty;
}

// ---------- 이마트24 ----------
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
async function emart24Stores() {
  const page = (n) => getJson('emart24', `https://emart24.co.kr/api1/store?page=${n}`, { headers: XHR });
  const first = await page(1);
  const rows = [...(first.data ?? [])];
  const pages = Math.ceil(first.count / (rows.length || 40));
  for (let n = 2; n <= pages; n++) {
    status.progress = `이마트24 매장 목록 받는 중 ${n}/${pages}`;
    rows.push(...((await page(n)).data ?? []));
  }
  return rows
    .map((r) => ({ code: r.CODE, name: r.TITLE, addr: r.ADDRESS, lat: +r.LATITUDE, lng: +r.LONGITUDE }))
    .filter((s) => s.code && s.lat && s.lng);
}

async function emart24Products() {
  const res = await getJson('emart24', 'https://everse.emart24.co.kr/stock/stock/search', {
    method: 'POST',
    headers: { ...XHR, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ currentPage: '1', pageCnt: '50', sortType: 'LATEST', saleProductYn: 'N', searchWord: '포켓몬카드' }),
  });
  return (res.productList ?? [])
    .filter((p) => p.goodsNm.includes('포켓몬카드'))
    .map((p) => ({ code: p.pluCd, name: p.goodsNm, price: +p.viewPrice || 0 }));
}

async function emart24Stock(code, storeCodes) {
  const qty = new Map();
  for (let i = 0; i < storeCodes.length; i += 20) {
    const res = await getJson(
      'emart24',
      `https://everse.emart24.co.kr/api/stock/v2/stock-search/store?searchPluCode=${code}&bizNoArr=${storeCodes.slice(i, i + 20).join(',')}`,
      { headers: XHR },
    );
    for (const r of res.storeGoodsQty ?? []) qty.set(r.BIZNO, +r.BIZQTY || 0);
  }
  return qty;
}

const api = {
  seven: { stores: sevenStores, products: sevenProducts, stock: sevenStock },
  emart24: { stores: emart24Stores, products: emart24Products, stock: emart24Stock },
};

// ---------- 매장·상품 목록 ----------
const storesMem = {};
async function allStores(chain) {
  if (storesMem[chain] && Date.now() - storesMem[chain].savedAt < WEEK) return storesMem[chain].stores;
  const file = path.join(DATA, `stores-${chain}.json`);
  let cached = readJson(file, null);
  if (!cached || Date.now() - cached.savedAt > WEEK) {
    status.progress = `${CHAINS[chain]} 매장 목록 받는 중`;
    cached = { savedAt: Date.now(), stores: await api[chain].stores() };
    writeJson(file, cached);
  }
  storesMem[chain] = cached;
  return cached.stores;
}
async function nearStores(chain) {
  const { lat, lng } = config.center;
  return (await allStores(chain))
    .map((s) => ({ ...s, distKm: distKm(lat, lng, s.lat, s.lng) }))
    .filter((s) => s.distKm <= config.radiusKm);
}

// 상품 코드는 바코드라 두 편의점이 같은 값을 쓴다. 바코드로 합친다.
const cleanName = (n) => n.replace(/^[^)]{1,6}\)/, '').replace(/_H$/, '').replace(/^포켓몬(카드|확장팩)\((.+)\)$/, '$2').trim();
async function loadCatalog() {
  if (catalog.length && Date.now() - catalogAt < 6 * 60 * 60 * 1000) return;
  const merged = new Map();
  for (const chain of Object.keys(api)) {
    try {
      for (const p of await api[chain].products()) {
        const cur = merged.get(p.code) ?? { code: p.code, name: cleanName(p.name), price: p.price, chains: [] };
        cur.chains.push(chain);
        merged.set(p.code, cur);
      }
      delete status.errors[`${chain}:catalog`];
    } catch (e) {
      status.errors[`${chain}:catalog`] = `상품 목록: ${e.message}`;
    }
  }
  if (merged.size) {
    catalog = [...merged.values()];
    catalogAt = Date.now();
  }
}

// ---------- 재고 조회 한 바퀴 ----------
function record(chain, store, product, qty) {
  const key = `${chain}:${store.code}:${product.code}`;
  const prev = state.qty[key]?.qty ?? 0;
  if (qty === prev) return;
  if (state.seen[`${chain}:${product.code}`]) {
    state.events.unshift({ at: Date.now(), chain, store: store.name, product: product.name, from: prev, to: qty });
  }
  if (qty > 0) state.qty[key] = { qty, at: Date.now() };
  else delete state.qty[key];
}

let rerun = false;
async function cycle() {
  if (status.running) { rerun = true; return; }
  status.running = true;
  try {
    status.progress = '상품 목록 확인 중';
    await loadCatalog();
    const targets = catalog.filter((p) => config.selected.includes(p.code));
    for (const chain of Object.keys(api)) {
      try {
        const stores = await nearStores(chain);
        status.storeCounts[chain] = stores.length;
        const byCode = new Map(stores.map((s) => [s.code, s]));
        for (const product of targets.filter((p) => p.chains.includes(chain))) {
          status.progress = `${CHAINS[chain]} · ${product.name} 조회 중 (매장 ${stores.length}곳)`;
          const qty = await api[chain].stock(product.code, [...byCode.keys()]);
          // 응답에 없는 매장은 취급하지 않는 곳이므로 0으로 본다.
          for (const s of stores) record(chain, s, product, qty.get(s.code) ?? 0);
          state.seen[`${chain}:${product.code}`] = Date.now();
        }
        delete status.errors[chain];
      } catch (e) {
        status.errors[chain] = e.message;
        console.error(new Date().toLocaleTimeString(), chain, e.message);
      }
    }
    state.events.length = Math.min(state.events.length, 300);
    writeJson(STATE_FILE, state);
    status.lastRun = Date.now();
  } finally {
    status.running = false;
    status.progress = '';
    if (rerun) { rerun = false; setImmediate(cycle); }
  }
}

let timer;
function schedule() {
  clearTimeout(timer);
  status.nextRun = Date.now() + config.intervalMin * 60 * 1000;
  timer = setTimeout(async () => { await cycle().catch(console.error); schedule(); }, config.intervalMin * 60 * 1000);
}

// ---------- HTTP ----------
function snapshot() {
  const storeIdx = {};
  for (const chain of Object.keys(api)) {
    storeIdx[chain] = new Map((storesMem[chain]?.stores ?? []).map((s) => [s.code, s]));
  }
  const names = new Map(catalog.map((p) => [p.code, p.name]));
  const { lat, lng } = config.center;
  const stock = [];
  for (const [key, v] of Object.entries(state.qty)) {
    const [chain, storeCd, code] = key.split(':');
    const s = storeIdx[chain]?.get(storeCd);
    if (!s || !config.selected.includes(code)) continue;
    const d = distKm(lat, lng, s.lat, s.lng);
    if (d > config.radiusKm) continue;
    stock.push({ chain, storeCd, store: s.name, addr: s.addr, lat: s.lat, lng: s.lng, distKm: +d.toFixed(2), code, product: names.get(code) ?? code, qty: v.qty, at: v.at });
  }
  return {
    center: config.center,
    radiusKm: config.radiusKm,
    intervalMin: config.intervalMin,
    chains: CHAINS,
    catalog: catalog.map((p) => ({ ...p, selected: config.selected.includes(p.code) })),
    stock,
    events: state.events.slice(0, 100),
    status,
  };
}

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    return send(200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return send(200, snapshot());
  if (req.method === 'POST' && url.pathname === '/api/select') {
    const { code, on } = await readBody(req);
    if (!catalog.some((p) => p.code === code)) return send(400, { error: '모르는 상품' });
    config.selected = config.selected.filter((c) => c !== code);
    if (on) config.selected.push(code);
    saveConfig();
    if (on) cycle().catch(console.error);
    return send(200, snapshot());
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const b = await readBody(req);
    if (Number.isFinite(b.lat) && Number.isFinite(b.lng)) config.center = { name: String(b.name || '직접 지정').slice(0, 30), lat: b.lat, lng: b.lng };
    if (b.radiusKm >= 1 && b.radiusKm <= 30) config.radiusKm = +b.radiusKm;
    if (b.intervalMin >= 3 && b.intervalMin <= 120) config.intervalMin = +b.intervalMin;
    saveConfig();
    schedule();
    cycle().catch(console.error);
    return send(200, snapshot());
  }
  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    cycle().catch(console.error);
    return send(200, { ok: true });
  }
  send(404, { error: 'not found' });
});

// --once: 한 바퀴만 조회하고 정적 페이지용 data.json을 남긴 뒤 종료한다 (GitHub Actions용).
if (process.argv.includes('--once')) {
  cycle().then(() => {
    writeJson(path.join(__dirname, 'data.json'), snapshot());
    console.log('조회 완료', JSON.stringify(status.errors));
  });
} else {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`이 맥에서:  http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`폰에서(같은 와이파이):  http://${i.address}:${PORT}`);
    }
    cycle().catch(console.error).then(schedule);
  });
}
