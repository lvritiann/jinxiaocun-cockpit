// 线上端到端验收：拉取 Pages 产物 → 用口令解密 → 核对关键指标
const https = require('https');
const crypto = require('crypto');

const PASS = process.argv[2];
const BASE = 'https://lvritiann.github.io/jinxiaocun-cockpit/';

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let o = '';
      r.setEncoding('utf8');
      r.on('data', d => o += d);
      r.on('end', () => res({ status: r.statusCode, body: o }));
    }).on('error', rej);
  });
}

(async () => {
  const idx = await get(BASE);
  console.log('看板首页:', idx.status, '| 大小', idx.body.length, '字节');
  console.log('  含金小存标识:', /金小存|进销存/.test(idx.body) ? '✅ 是' : '❌ 否');

  const ec = await get(BASE + 'vendor/echarts.min.js');
  console.log('echarts:', ec.status, '| 大小', Math.round(ec.body.length / 1024) + 'KB',
    ec.status === 200 ? '✅' : '❌ 图表库没加载到');

  const m = await get(BASE + 'metrics.json');
  console.log('加密数据:', m.status, '| 大小', Math.round(m.body.length / 1024 * 10) / 10, 'KB');
  if (m.status !== 200) return;

  // 产物是 base64 字符串（整体 base64），必须按 base64 解码后再拆 iv/tag/密文
  const raw = Buffer.from(m.body, 'base64');
  const key = crypto.createHash('sha256').update(PASS, 'utf8').digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  const M = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));

  console.log('\n✅ 线上数据用口令解密成功');
  console.log('   库存总额¥' + Math.round(M.kpi.amount).toLocaleString(),
    '| 站点', M.kpi.station, '| SKU', M.kpi.sku);
  console.log('   盘亏', M.kpi.lossQty, '件 / ¥' + Math.round(M.kpi.loss).toLocaleString());
  console.log('   动态库存', M.dynTotal.qty.toLocaleString(), '件 / ¥' + Math.round(M.dynTotal.amt).toLocaleString());
  console.log('   按日天数', (M.daily || []).length, '| 锚后覆盖率', M.flowCoverage.postAnchorRate + '%');
  console.log('   生成时间', M.generatedAt);

  // 错口令必须解不开
  try {
    const raw2 = Buffer.from(m.body, 'base64');
    const k2 = crypto.createHash('sha256').update('wrong-pass', 'utf8').digest();
    const d2 = crypto.createDecipheriv('aes-256-gcm', k2, raw2.subarray(0, 12));
    d2.setAuthTag(raw2.subarray(12, 28));
    Buffer.concat([d2.update(raw2.subarray(28)), d2.final()]);
    console.log('\n❌ 错口令竟然解开了 —— 安全有问题！');
  } catch (e) {
    console.log('\n✅ 错口令被正确拒绝（公网上拿不到数据）');
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });