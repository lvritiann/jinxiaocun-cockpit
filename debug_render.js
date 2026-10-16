/**
 * 离线复现线上看板的解密 + 渲染流程，抓出真实异常。
 * 不用浏览器：自己实现最小 DOM 桩，跑到 render() 为止。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const PASS = process.argv[2] || '';

// ---- 1. 读取线上加密产物并解密（与前端算法一致）----
function decryptMetrics(b64, pass) {
  const raw = Buffer.from(b64, 'base64');
  const key = crypto.createHash('sha256').update(pass, 'utf8').digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

const enc = fs.readFileSync(path.join(DIR, 'site', 'metrics.json'), 'utf8');
let M;
try {
  // 2026-10-16 起为明文；若仍是密文则回退到口令解密
  M = JSON.parse(enc);
  console.log('✅ 明文读取成功，顶层键', Object.keys(M).length, '个');
} catch (_) {
  try {
    M = decryptMetrics(enc, PASS);
    console.log('✅ 解密成功（仍为密文产物），顶层键', Object.keys(M).length, '个');
  } catch (e) {
    console.log('❌ 读取/解密失败:', e.message);
    process.exit(1);
  }
}

// ---- 2. 装一个最小 DOM 桩，把页面里的 JS 抠出来跑 ----
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = scripts.sort((a, b) => b.length - a.length)[0];
console.log('   主脚本', code.length, '字符\n');

const created = [];
function mkEl(id) {
  const el = {
    id, style: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} },
    dataset: {}, children: [], innerHTML: '', textContent: '', value: '',
    className: '', width: 0, height: 0,
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(){}, getAttribute(){return null;}, removeAttribute(){},
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){},
    getContext(){ return null; }, setAttributeNS(){},
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    insertBefore(){ return null; }, remove(){}, focus(){}, click(){}, closest(){ return null; },
    getBoundingClientRect(){ return {width:800,height:400,top:0,left:0}; }
  };
  created.push(el);
  return el;
}
const registry = new Map();
const document = {
  getElementById(id) {
    if (!registry.has(id)) registry.set(id, mkEl(id));
    return registry.get(id);
  },
  createElement(t) { return mkEl('new-' + t + '-' + created.length); },
  createTextNode(t) { return { nodeType: 3, textContent: t }; },
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  body: mkEl('body'), head: mkEl('head'),
  documentElement: mkEl('html'),
  addEventListener(){}, removeEventListener(){}
};
// select 需要真实 options 才能选站
document.getElementById('stationSel');

const echartsStub = {
  init() {
    return {
      setOption(){}, resize(){}, dispose(){},
      on(){}, off(){}, showLoading(){}, hideLoading(){},
      getOption(){ return {}; }, setOptionSilent(){}, clear(){}
    };
  },
  getInstanceByDom(){ return null; }
};

const localStorageStub = {
  getItem(k) { return k === 'jxc_pass' ? PASS : null; },
  setItem(){}, removeItem(){}
};

// Node 的 WebCrypto 可直接注入，替代浏览器的 crypto.subtle
const nodeCrypto = require('crypto').webcrypto;

const sandbox = {
  window: null, document, echarts: echartsStub, localStorage: localStorageStub,
  sessionStorage: localStorageStub, navigator: { userAgent: 'node', language: 'zh-CN' },
  location: { href: 'https://lvritiann.github.io/jinxiaocun-cockpit/', pathname: '/jinxiaocun-cockpit/', hash: '', search: '', replaceState(){} },
  history: { replaceState(){} },
  fetch: async () => ({ ok: true, status: 200, text: async () => enc, json: async () => ({}) }),
  crypto: nodeCrypto,
  URLSearchParams,                                     // 浏览器原生 API
  TextEncoder, TextDecoder, Uint8Array, Buffer, JSON, Math, Date, Object, Array, String, Number,
  console, setTimeout, clearTimeout, setInterval, clearInterval, parseInt, parseFloat, isNaN, isFinite,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  alert(){}, prompt(){ return null; }, confirm(){ return true; },
  globalThis: null, Intl, NumberFormat: Intl.NumberFormat, DateTimeFormat: Intl.DateTimeFormat
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// 注入真实解密结果（跳过异步 Web Crypto，直接给 M）
sandbox.__M__ = M;

const vm = require('vm');
const ctx = vm.createContext(sandbox);

// 模拟浏览器的自动解锁：URL 片段带 #k=口令
sandbox.location.hash = '#k=' + encodeURIComponent(PASS);

try {
  vm.runInContext(code, ctx, { filename: 'inline.js', timeout: 20000 });
  console.log('✅ 脚本执行完成（无顶层异常）');
} catch (e) {
  console.log('\n❌ 脚本执行异常：');
  console.log('   ' + e.message);
  console.log('   ' + String(e.stack).split('\n').slice(1, 4).join('\n   '));
}

// 等待异步解密+渲染完成
setTimeout(() => {
  console.log('\n---- 自动解锁结果 ----');
  console.log('  currentPass 已设置 :', !!ctx.currentPass ? '✅' : '❌（仍停在锁屏）');
  console.log('  M 已载入        :', !!ctx.M ? '✅ 共 ' + Object.keys(ctx.M).length + ' 个字段' : '❌');
  const ov = ctx.document.getElementById('panel-overview');
  const html = ov.innerHTML || '';
  console.log('  总览面板 HTML 长度:', html.length, html.length > 500 ? '✅ 有内容' : '❌ 基本为空');
  const pe = ctx.document.getElementById('passErr');
  if (pe && pe.textContent) console.log('  锁屏错误提示      :', pe.textContent);
  process.exit(0);
}, 2500);

// ---- 3. 直接检查 M 的关键字段是否满足各渲染函数的要求 ----
console.log('\n---- 数据字段体检（前端各页签依赖）----');
const checks = [
  ['kpi.amount', M.kpi && M.kpi.amount],
  ['kpi.station', M.kpi && M.kpi.station],
  ['byStation[]', (M.byStation || []).length],
  ['stockTotalAmount', M.stockTotalAmount],
  ['ledger[]', (M.ledger || []).length],
  ['ledgerTotal.lossQty', M.ledgerTotal && M.ledgerTotal.lossQty],
  ['stSales[]', (M.stSales || []).length],
  ['dynByStation[]', (M.dynByStation || []).length],
  ['dynTotal.qty', M.dynTotal && M.dynTotal.qty],
  ['flowIn 站数', Object.keys(M.flowIn || {}).length],
  ['flowOut 站数', Object.keys(M.flowOut || {}).length],
  ['flowTotal.outQty', M.flowTotal && M.flowTotal.outQty],
  ['supDist[]', (M.supDist || []).length],
  ['diffType', Object.keys(M.diffType || {}).length],
  ['shelfStoreTotal', !!M.shelfStoreTotal],
  ['daily[]', (M.daily || []).length],
  ['flowCoverage', !!M.flowCoverage]
];
let bad = 0;
for (const [k, v] of checks) {
  const ok = v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== 0;
  if (!ok) bad++;
  console.log((ok ? '  ✅ ' : '  ⚠️  ') + k.padEnd(24) + ' = ' + JSON.stringify(v));
}
console.log(bad === 0 ? '\n所有字段齐全' : '\n⚠️ ' + bad + ' 个字段为空/0 —— 这就是"没有数据"的直接原因');