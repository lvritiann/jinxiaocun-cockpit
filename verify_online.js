// 线上端到端验收（2026-10-16 起：无口令，明文）
// 用法：node verify_online.js
const https = require('https');
const crypto = require('crypto');

const PASS = process.argv[2] || '';          // 仅当线上仍是密文时才需要
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
  console.log('  口令输入框已移除:', /id="passInput"|请输入查看口令|decryptMetrics/.test(idx.body) ? '❌ 仍存在（旧版未部署）' : '✅ 已移除');
  console.log('  取数路径为 ./metrics.json:', /metrics\.json/.test(idx.body) ? '✅ 是' : '❌ 否');
  console.log('  （应无 /api/metrics）:', /\/api\/metrics/.test(idx.body) ? '❌ 出现本地接口！' : '✅ 无');

  const ec = await get(BASE + 'vendor/echarts.min.js');
  console.log('echarts:', ec.status, '| 大小', Math.round(ec.body.length / 1024) + 'KB',
    ec.status === 200 ? '✅' : '❌ 图表库没加载到');

  const m = await get(BASE + 'metrics.json');
  console.log('指标文件:', m.status, '| 大小', Math.round(m.body.length / 1024 * 10) / 10, 'KB');
  if (m.status !== 200) return;

  let M = null;
  if (m.body.trim().charAt(0) === '{') {
    M = JSON.parse(m.body);
    console.log('\n✅ 线上明文直读成功（无需口令）');
  } else if (PASS) {
    const raw = Buffer.from(m.body, 'base64');
    const key = crypto.createHash('sha256').update(PASS, 'utf8').digest();
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    M = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    console.log('\nℹ️ 线上仍是密文（口令模式）；已用口令解密');
  } else {
    console.log('\n⚠️ 线上仍是密文：口令取消尚未生效，Actions 可能还没跑完。稍后重试。');
    return;
  }

  console.log('   库存总额¥' + Math.round(M.kpi.amount).toLocaleString(),
    '| 站点', M.kpi.station, '| SKU', M.kpi.sku);
  console.log('   盘亏', M.kpi.lossQty, '件 / ¥' + Math.round(M.kpi.loss).toLocaleString());
  console.log('   动态库存', M.dynTotal.qty.toLocaleString(), '件 / ¥' + Math.round(M.dynTotal.amt).toLocaleString());
  console.log('   按日天数', (M.daily || []).length, '| 锚后覆盖率', M.flowCoverage.postAnchorRate + '%');
  console.log('   生成时间', M.generatedAt);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
