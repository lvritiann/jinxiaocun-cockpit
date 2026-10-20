/**
 * 逐页签渲染验证：在最坏情况（echarts 缺失）下，五个页签是否都能渲染出内容。
 * 修复前：renderStockTopChart 里的 echarts.graphic.LinearGradient 抛错
 *        → render() 中断 → 所有页签空白（用户看到的"全部没数据"）。
 */
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto').webcrypto;

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const code = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).sort((a, b) => b.length - a.length)[0];
const enc = fs.readFileSync(__dirname + '/site/metrics.json', 'utf8');
if (enc.trim().charAt(0) !== '{') {
  console.log('❌ site/metrics.json 不是明文 JSON。口令已取消，请先跑 `node relay.js` 重新产出一份明文。');
  process.exit(1);
}

const PASS = process.argv[2] || '';

// 故意不提供 echarts —— 模拟库没加载/加载失败的最坏情况
const ECHARTS = process.argv[3] === 'with-echarts' ? {
  init: () => ({
    setOption(){}, resize(){}, dispose(){}, on(){}, off(){},
    showLoading(){}, hideLoading(){}, clear(){}, setOptionSilent(){}, getOption(){return{}}
  }),
  getInstanceByDom: () => null
} : undefined;

const mk = id => ({
  id, style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', value: '', className: '',
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
  appendChild(c){ return c; }, setAttribute(){}, getAttribute(){ return null; }, removeAttribute(){},
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){},
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  remove(){}, focus(){}, click(){}, closest(){ return null; },
  getContext(){ return null; }, setAttributeNS(){},
  getBoundingClientRect(){ return { width: 800, height: 400, top: 0, left: 0 }; }
});
const reg = new Map();
const document = {
  getElementById(id){ if(!reg.has(id)) reg.set(id, mk(id)); return reg.get(id); },
  createElement(){ return mk('n' + reg.size); },
  createTextNode(t){ return { nodeType: 3, textContent: t }; },
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  body: mk('body'), head: mk('head'), documentElement: mk('html'),
  addEventListener(){}, removeEventListener(){}
};

const sandbox = {
  document, echarts: ECHARTS,
  localStorage: { getItem: k => (k === 'jxc_pass' ? PASS : null), setItem(){}, removeItem(){} },
  sessionStorage: { getItem(){ return null; }, setItem(){} },
  navigator: { userAgent: 'node', language: 'zh-CN' },
  location: { href: 'https://x/', pathname: '/', hash: '', search: '', replaceState(){} },
  history: { replaceState(){} },
  fetch: async () => ({ ok: true, status: 200, text: async () => enc, json: async () => ({}) }),
  crypto: nodeCrypto, URLSearchParams,
  TextEncoder, TextDecoder, Uint8Array, Buffer, JSON, Math, Date, Object, Array, String, Number,
  console, setTimeout, clearTimeout, setInterval, clearInterval, parseInt, parseFloat, isNaN, isFinite,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  alert(){}, prompt(){ return null; }, confirm(){ return true; }, Intl
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);

console.log('场景：' + (ECHARTS ? 'echarts 正常' : 'echarts 缺失（最坏情况）'));
try {
  vm.runInContext(code, ctx, { filename: 'inline.js', timeout: 20000 });
  console.log('脚本顶层执行 ✅\n');
} catch (e) {
  console.log('❌ 脚本顶层异常:', e.message, '\n');
}

// 等异步解密 + 首屏渲染
setTimeout(() => {
  const tabs = ['overview', 'purchase', 'sales', 'orders', 'inventory', 'reconcile'];
  const names = { overview:'总览', purchase:'进货', sales:'销售', orders:'订货', inventory:'库存', reconcile:'盘点' };
  let bad = 0;
  for (const t of tabs) {
    let err = null;
    try { vm.runInContext('setTab("' + t + '")', ctx, { timeout: 8000 }); }
    catch (e) { err = e.message; }
    const htmlLen = (ctx.document.getElementById('panel-' + t).innerHTML || '').length;
    const ok = !err && htmlLen > 200;
    if (!ok) bad++;
    console.log((ok ? '  ✅ ' : '  ❌ ') + names[t].padEnd(4) +
      ' 面板内容 ' + String(htmlLen).padStart(6) + ' 字符' + (err ? '  错误: ' + err : ''));
  }
  console.log(bad ? '\n❌ ' + bad + ' 个页签未正常渲染' : '\n✅ 五个页签全部正常渲染');
  process.exit(bad ? 1 : 0);
}, 2500);