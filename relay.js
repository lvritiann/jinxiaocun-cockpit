#!/usr/bin/env node
/**
 * 金小存 · 无服务器中继脚本（对齐「订货工具」架构）
 *
 * 职责：
 *   1. 复用 server.js 的聚合引擎（refreshRef/refreshFlow/buildMetrics），从金山在线(Kdocs)拉数据并算出指标
 *   2. 用 RELAY_PASS 派生密钥对指标做 AES-256-GCM 加密（口令不对解不开 = 数据不公开）
 *   3. 把加密后的 metrics.json + 静态看板(index.html) + echarts 产出到 site/ 目录
 *
 * 运行环境：本地可跑（node relay.js），GitHub Actions 亦可跑。
 * 环境变量：
 *   KDOCS_TOKEN  金山 WPS access token（缺省时 server.js 会读同目录 wps_token.txt）
 *   RELAY_PASS   看板口令（必填；用于加密，查看者需输入同一口令解密）
 *   SITE_DIR     产出目录，默认 ./site
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SITE_DIR = process.env.SITE_DIR || path.join(ROOT, 'site');

// ---- 口令（必填）----
const RELAY_PASS = process.env.RELAY_PASS || '';
if (!RELAY_PASS) {
  console.error('❌ 缺少 RELAY_PASS 环境变量（看板口令），无法加密。');
  process.exit(1);
}

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

async function main() {
  fs.mkdirSync(SITE_DIR, { recursive: true });

  console.log('① 拉取引用数据(s7/s8)…');
  await refreshRef();
  console.log('② 拉取出入库流水(s10/s11/s36)…');
  await refreshFlow();
  console.log('③ 聚合计算(s9 实时库存 / s31 月度盘点)…');
  const M = await buildMetrics();
  M.generatedAt = new Date().toISOString();

  console.log('④ AES 加密指标…');
  const cipher = encryptJSON(M, RELAY_PASS);
  fs.writeFileSync(path.join(SITE_DIR, 'metrics.json'), cipher, 'utf8');
  console.log('   ✅ site/metrics.json (' + (cipher.length / 1024).toFixed(1) + ' KB, 已加密)');

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
