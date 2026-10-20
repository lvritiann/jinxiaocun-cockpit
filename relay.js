#!/usr/bin/env node
/**
 * 金小存 · 无服务器中继脚本（对齐「订货工具」架构）
 *
 * 职责：
 *   1. 复用 server.js 的聚合引擎（refreshRef/refreshFlow/buildMetrics），从金山在线(Kdocs)拉数据并算出指标
 *   2. 产出指标文件 metrics.json（**默认明文**；2026-10-16 起看板已取消口令）
 *      —— 如需恢复口令保护，设 RELAY_PLAINTEXT=0 + RELAY_PASS，则走 AES-256-GCM 加密
 *   3. 把 metrics.json + 静态看板(index.html) + echarts 产出到 site/ 目录
 *
 * 运行环境：本地可跑（node relay.js），GitHub Actions 亦可跑。
 * 环境变量：
 *   KDOCS_TOKEN      金山 WPS access token（缺省时 server.js 会读同目录 wps_token.txt）
 *   RELAY_PLAINTEXT  '1'（默认）=明文发布；'0'=加密
 *   RELAY_PASS       仅加密模式必填（看板口令）
 *   SITE_DIR         产出目录，默认 ./site
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SITE_DIR = process.env.SITE_DIR || path.join(ROOT, 'site');

// ---- 口令 / 明文模式（2026-10-16 起已取消口令，默认明文发布）----
// 想恢复口令保护：把环境变量 RELAY_PLAINTEXT 设为 0，并配置 RELAY_PASS。
const RELAY_PASS = process.env.RELAY_PASS || '';
const PLAINTEXT = String(process.env.RELAY_PLAINTEXT || '1') !== '0';
if (!PLAINTEXT && !RELAY_PASS) {
  console.error('❌ 加密模式缺少 RELAY_PASS 环境变量（看板口令）。若想取消口令，设 RELAY_PLAINTEXT=1。');
  process.exit(1);
}
console.log('🔓 发布模式：' + (PLAINTEXT ? '明文（无口令，人人可看）' : 'AES-256-GCM 加密（需口令）'));

// ---- 复用已验证的聚合引擎（require 时 server.js 不会启动 HTTP）----
const engine = require('./server.js');
const { refreshRef, refreshFlow, buildMetrics } = engine;

// ---- AES-256-GCM 加密（iv[12] + authTag[16] + ciphertext，base64）----
function encryptJSON(obj, pass) {
  const key = Buffer.from(crypto.createHash('sha256').update(pass, 'utf8').digest()); // 32 字节
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function copyFileIfExists(relSrc, relDst) {
  const src = path.join(ROOT, relSrc);
  const dst = path.join(SITE_DIR, relDst);
  if (!fs.existsSync(src)) { console.log('⚠️ 跳过（源不存在）: ' + relSrc); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('📄 已复制 ' + relSrc + ' → ' + relDst);
}

// ---- 订货台账聚合（金小存 10_订货台账，sheet 37）----
// 订货是服务区级（台账"门店"列写"白河""韩城"），与站级库存不是一张表，单独成一页签。
// 「待分站」= 已到货但 分站结果 结尾不是方向字（东/西/南/北），即还没分到具体站。
async function buildOrders() {
  const ORDER_SHEET = 37;
  const recs = [];
  let token = '';
  let pages = 0;
  do {
    const args = { file_id: engine.LINK, sheet_id: ORDER_SHEET, page_size: 1000 };
    if (token) args.page_token = token;
    const j = await engine.callTool('dbsheet.records_list', args);
    if (!j || j.code !== 0) break;
    const d = (j.data && j.data.data) ? j.data.data : (j.data || {});
    for (const r of (d.records || [])) {
      try { recs.push(JSON.parse(r.fields || '{}')); } catch (e) { }
    }
    token = d.page_token || '';
    pages++;
  } while (token && pages < 10);

  const n = v => { const x = Number(v); return isNaN(x) ? 0 : x; };
  const t = v => (v === undefined || v === null) ? '' : String(v);

  let qty = 0, amount = 0;
  const byStatus = {}, bySupplier = {}, byArea = {}, pend = {};
  for (const f of recs) {
    qty += n(f['数量']);
    amount += n(f['金额']);
    const st = t(f['状态']) || '(空)';
    byStatus[st] = (byStatus[st] || 0) + 1;

    const sup = t(f['供货商']) || '(未知)';
    if (!bySupplier[sup]) bySupplier[sup] = { supplier: sup, count: 0, qty: 0, amount: 0 };
    bySupplier[sup].count++;
    bySupplier[sup].qty += n(f['数量']);
    bySupplier[sup].amount += n(f['金额']);

    const area = t(f['服务区']) || '(未知)';
    if (!byArea[area]) byArea[area] = { area: area, count: 0, qty: 0, amount: 0 };
    byArea[area].count++;
    byArea[area].qty += n(f['数量']);
    byArea[area].amount += n(f['金额']);

    const res = t(f['分站结果']);
    if (st === '已到货' && res && !/[东南西北]$/.test(res)) pend[res] = (pend[res] || 0) + 1;
  }

  const pendingStation = Object.keys(pend)
    .map(k => ({ area: k, count: pend[k] }))
    .sort((a, b) => b.count - a.count);

  const recent = recs.slice().reverse().slice(0, 80).map(f => ({
    date: t(f['日期']), supplier: t(f['供货商']), area: t(f['服务区']),
    goods: t(f['商品名称']), spec: t(f['规格']), unit: t(f['单位']),
    qty: n(f['数量']), price: n(f['单价']), amount: n(f['金额']),
    status: t(f['状态']), arrivedQty: n(f['到货数量']), arrivedDate: t(f['到货日期']),
    station: t(f['分站结果'])
  }));

  return {
    total: recs.length,
    qty: +qty.toFixed(2),
    amount: +amount.toFixed(2),
    byStatus: byStatus,
    bySupplier: Object.values(bySupplier).sort((a, b) => b.amount - a.amount),
    byArea: Object.values(byArea).sort((a, b) => b.amount - a.amount),
    pendingStation: pendingStation,
    pendingStationTotal: pendingStation.reduce((s, x) => s + x.count, 0),
    recent: recent
  };
}

async function main() {
  fs.mkdirSync(SITE_DIR, { recursive: true });

  console.log('① 拉取引用数据(s7/s8)…');
  await refreshRef();
  console.log('② 拉取出入库流水(s10/s11/s36)…');
  await refreshFlow();
  console.log('③ 聚合计算(s9 实时库存 / s31 月度盘点)…');
  const M = await buildMetrics();
  console.log('③b 聚合订货台账(s37)…');
  try {
    M.orders = await buildOrders();
    console.log('   ✅ 订货 ' + M.orders.total + ' 条 / ¥' + M.orders.amount.toLocaleString()
      + ' / 待分站 ' + M.orders.pendingStationTotal + ' 条');
  } catch (e) {
    console.log('   ⚠️ 订货聚合失败（看板订货页签将显示为空）: ' + (e && e.message ? e.message : e));
    M.orders = { total: 0, qty: 0, amount: 0, byStatus: {}, bySupplier: [], byArea: [], pendingStation: [], pendingStationTotal: 0, recent: [], error: String(e && e.message || e) };
  }
  M.generatedAt = new Date().toISOString();

  if (PLAINTEXT) {
    console.log('④ 产出明文指标（口令已取消）…');
    const plain = JSON.stringify(M);
    fs.writeFileSync(path.join(SITE_DIR, 'metrics.json'), plain, 'utf8');
    console.log('   ✅ site/metrics.json (' + (plain.length / 1024).toFixed(1) + ' KB, 明文)');
  } else {
    console.log('④ AES 加密指标…');
    const cipher = encryptJSON(M, RELAY_PASS);
    fs.writeFileSync(path.join(SITE_DIR, 'metrics.json'), cipher, 'utf8');
    console.log('   ✅ site/metrics.json (' + (cipher.length / 1024).toFixed(1) + ' KB, 已加密)');
  }

  console.log('⑤ 产出静态看板资源…');
  copyFileIfExists('index.html', 'index.html');
  copyFileIfExists(path.join('vendor', 'echarts.min.js'), path.join('vendor', 'echarts.min.js'));
  fs.writeFileSync(path.join(SITE_DIR, '.nojekyll'), '');
  console.log('   ✅ site/ 产出完成');

  console.log('— 指标摘要 —');
  console.log('   库存总额 ¥' + Math.round(M.kpi.amount).toLocaleString()
    + ' (在架 ¥' + Math.round(M.kpi.shelf).toLocaleString() + ' / 库房 ¥' + Math.round(M.kpi.store).toLocaleString() + ')');
  console.log('   缺货 ' + M.kpi.zero + ' | 盘亏 ' + M.kpi.lossQty + '件/¥' + Math.round(M.kpi.loss).toLocaleString());
  console.log('   动态库存 ' + Math.round(M.dynTotal.qty).toLocaleString() + '件/¥' + Math.round(M.dynTotal.amt).toLocaleString());
  console.log('✅ relay 完成，下一步把 site/ 提交并由 GitHub Pages 托管。');
}

main().catch(e => { console.error('❌ relay 失败:', e && e.message || e); process.exit(1); });
