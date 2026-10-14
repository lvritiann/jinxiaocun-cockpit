const http=require('http');
const https=require('https');
const fs=require('fs');
const path=require('path');
const child=require('child_process');
const {execFile}=require('child_process');
const os=require('os');
const {URL}=require('url');

// ---------- 金山文档 API 直连（本地/云端通用，无需 kdocs-cli.exe 与系统密钥链）----------
const KDOCS_API='https://mcp-center.wps.cn/skill_hub/api/v1/tool';
const KDOCS_TOOL='dbsheet.records_list';
const LINK='ckOYsgKoz4nh';
// token 解析优先级：环境变量 KDOCS_TOKEN > 项目根 wps_token.txt
function resolveToken(){
  if(process.env.KDOCS_TOKEN) return process.env.KDOCS_TOKEN.trim();
  try{
    const raw=fs.readFileSync(path.join(__dirname,'wps_token.txt'),'utf8');
    const m=raw.match(/[A-Za-z0-9+/]{80,}={0,2}/);
    if(m) return m[0];
  }catch(e){}
  return '';
}
let KDOCS_TOKEN=resolveToken();
let   PORT=Number(process.env.PORT)||8899;
const REFRESH_MS=60000;        // 动态数据(s9/s31)刷新间隔：后台每 60 秒
const REF_REFRESH_MS=900000;   // 引用数据(s7/s8)刷新间隔：每 15 分钟（几乎不变）
const REF_FLOW_MS=300000;      // 出入库流水(s10/s11)刷新间隔：每 5 分钟（表单录入，非实时）
const CALL_TIMEOUT=20000;      // 单次 kdocs 调用超时（毫秒），防止挂死
const RETRY=2;                 // 失败重试次数

const ROOT=__dirname;
const metricsPath=path.join(ROOT,'metrics.json');

// ---------- 图形化导入（上传 xlsx → 调 python 导入器 --apply）----------
const PYTHON='C:/Users/DELL/.workbuddy/binaries/python/versions/3.13.12/python.exe';
const IMPORT_TMP='C:/Users/DELL/AppData/Local/Temp/kdwork';
const IMPORT_TIMEOUT=300000;                 // 导入超时 5 分钟（拉多维表 + 分批写入较慢）
const MAX_UPLOAD=100*1024*1024;              // 上传体上限 100MB（xlsx 通常几 MB）
// 类型 → [脚本, 源文件参数名]（注意：orders 用 --xlsx，jituan 用 --file）
const IMPORT_KINDS={ orders:['ingest_orders.py','--xlsx'], jituan:['ingest_jituan.py','--file'] };
const JSON_HEAD={'Content-Type':'application/json; charset=utf-8'};

// ---------- 非阻塞 kdocs 调用（HTTP 直连，无本地 CLI/密钥链依赖）----------
// 通用：tool 为 mcp-center 的 API 命令名（如 dbsheet.records_list / dbsheet.create_records / sheet.get_range_data）
function callTool(tool,args){
  if(!KDOCS_TOKEN){ return Promise.resolve({__err:'缺少 KDOCS_TOKEN（环境变量或 wps_token.txt 均未配置）'}); }
  return new Promise((resolve)=>{
    let attempt=0;
    const tryOnce=()=>{
      const payload=JSON.stringify({args, tool});
      let u; try{ u=new URL(KDOCS_API); }catch(e){ resolve({__err:'KDOCS_API 非法'}); return; }
      const req=https.request({
        host:u.hostname, port:u.port||443, path:u.pathname+u.search, method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Content-Length':Buffer.byteLength(payload),
          'Authorization':'Bearer '+KDOCS_TOKEN,
          'Accept':'text/event-stream'
        }
      },res=>{
        let out='';
        res.setEncoding('utf8');
        res.on('data',c=>out+=c);
        res.on('end',()=>{
          // 解析 SSE：取第一个 event:result 的 data: 行 JSON（无论 code 是否为 0，失败要能传播出去）
          let json=null;
          const lines=out.split(/\r?\n/);
          for(const l of lines){
            if(l.indexOf('data:')===0){
              const s=l.slice(5).trim();
              if(s.charAt(0)==='{'){ try{ json=JSON.parse(s); break; }catch(_){} }
            }
          }
          // 兜底：整段找 { 到 } 提取 JSON
          if(!json){
            const s=out.indexOf('{'), e=out.lastIndexOf('}');
            if(s>=0&&e>s){ try{ json=JSON.parse(out.slice(s,e+1)); }catch(_){} }
          }
          if(json){ resolve(json); return; }
          if(attempt<RETRY){ attempt++; tryOnce(); }
          else resolve({__err:'kdocs http no json'});
        });
      });
      req.on('error',err=>{
        if(attempt<RETRY){ attempt++; tryOnce(); }
        else resolve({__err:'kdocs http failed after '+RETRY+' tries: '+(err.message||err)});
      });
      req.setTimeout(CALL_TIMEOUT,()=>{ req.destroy(new Error('timeout')); });
      req.write(payload); req.end();
    };
    tryOnce();
  });
}

// 兼容旧签名：读多维表整表（records_list）
function call(args){ return callTool(KDOCS_TOOL,args); }

async function dumpAll(sheet_id,fields){
  let token='',all=[];
  let j=await call({link_id:LINK,sheet_id,prefer_id:true,fields,text_value:'text',page_size:1000});
  let recs=j.data&&j.data.data&&j.data.data.records;
  if(!recs||!recs.length) return [];
  recs.forEach(r=>{ try{ all.push(JSON.parse(r.fields)); }catch(_){} });
  token=(j.data&&j.data.data&&j.data.data.page_token)||'';
  while(token){
    j=await call({link_id:LINK,sheet_id,prefer_id:true,fields,text_value:'text',page_size:1000,page_token:token});
    const r2=(j.data&&j.data.data&&j.data.data.records)||[];
    if(!r2.length) break;
    r2.forEach(r=>{ try{ all.push(JSON.parse(r.fields)); }catch(_){} });
    token=(j.data&&j.data.data&&j.data.data.page_token)||'';
  }
  return all;
}

// ---------- 引用数据缓存（s7 商品字典 / s8 站点档案，几乎不变）----------
const refCache={s7:null,s8:null,at:0};
async function refreshRef(){
  try{
    const [s7,s8]=await Promise.all([
      dumpAll(7,['V','X','Y','6','7','W']),   // W=进价（按日金额换算需要）
      dumpAll(8,['Z','b'])
    ]);
    if(!s7||!s7.length) throw new Error('s7 拉取为空');
    if(!s8||!s8.length) throw new Error('s8 拉取为空');
    refCache.s7=s7; refCache.s8=s8; refCache.at=Date.now();
    console.log('✅ 引用数据已加载 s7='+s7.length+' s8='+s8.length);
  }catch(e){ console.log('⚠️ 引用数据刷新失败(沿用旧值): '+e.message); }
}

// ---------- 出入库流水缓存（s10/s11 表单录入 + s36 移库流水，5 分钟一刷）----------
const flowCache={s10:null,s11:null,s36:null,at:0};
async function refreshFlow(){
  try{
    const [s10,s11,s36]=await Promise.all([
      dumpAll(10,['Bn','Bo','Bp','Bq','Bg','CC']),   // 日期/入库油站/数量/来源/条码/供货商
      dumpAll(11,['s','u','y','z','B0']),            // 日期/站点/类型/数量/条码
      dumpAll(36,['EE','EF','EG','EH','EK'])         // 移库流水：条码/动作类型/数量/站点/提交时间
    ]);
    if(!s10||!s10.length) throw new Error('入库流水为空');
    if(!s11||!s11.length) throw new Error('出库流水为空');
    flowCache.s10=s10; flowCache.s11=s11; flowCache.s36=s36||[]; flowCache.at=Date.now();
    console.log('✅ 出入库流水已加载 入库='+s10.length+' 出库='+s11.length+' 移库='+(s36||[]).length);
  }catch(e){ console.log('⚠️ 流水刷新失败(沿用旧值): '+e.message); }
}

// ---------- 数值/字符串归一化 ----------
const num=v=>{ if(v===undefined||v===null||v==='')return 0; const s=String(v).replace(/[¥￥,\s]/g,''); const n=parseFloat(s.replace(/[^\d.\-eE]/g,'')); return isNaN(n)?0:n; };
const str=v=>(v===undefined||v===null)?'':String(v).trim();
// Link 字段返回的是 id 数组（或单值字符串），统一取第一个 id
const linkId=v=>{ if(Array.isArray(v)) return v.length?String(v[0]):''; return str(v); };
// 站点名归一：去掉「加油站」「（高速）」与空格 —— 让实时库存与月度盘点能按站对齐
const normStation=v=>str(v).replace(/加油站/g,'').replace(/[（(]\s*高速\s*[）)]/g,'').replace(/\s+/g,'').trim();
// 简称还原：流水表单里有人填「韩城东」「富县西」这类简称 → 匹配到标准站名
const shortName=v=>normStation(v).replace(/服务区|停车区/g,'');
function makeStationResolver(list){
  const set=new Set(list), shorts=list.map(s=>({full:s,short:shortName(s)}));
  return raw=>{
    const k=normStation(raw);
    if(set.has(k)) return k;
    const a=shortName(raw);
    if(!a) return k;
    const hit=shorts.filter(x=>x.short===a||x.short.indexOf(a)===0);
    return hit.length===1 ? hit[0].full : k;   // 命中多个/零个就保持原样
  };
}

// ---------- 聚合（字段对齐 dashboard.html 所需结构）----------
async function buildMetrics(){
  // 动态数据并行拉取：s9 实时库存 + s31 月度盘点
  const [s9,s31]=await Promise.all([
    dumpAll(9,['c','D4','D6','Cn','Cr','C1','C2','C3','C4','C5','D0','D1']),
    dumpAll(31,['C8','C9','C-','DB','DC','DD','DE','DF','DG','DH','DI','DJ','DK','DL','DN','DO','DP','EC','ED'])
  ]);
  if(!s9||!s9.length) throw new Error('s9 拉取为空');
  if(!s31||!s31.length) throw new Error('s31 拉取为空');
  // ⚠️ 跨表站点名归一：实时库存用「富县服务区西站」，月度盘点用「富县服务区加油站西站（高速）」
  //    不做归一两表交集为 0，按站关联会全部失效
  s9.forEach(r=>{ r['c']=normStation(r['c']); });
  s31.forEach(r=>{ r['C8']=normStation(r['C8']); });
  // 引用数据走缓存（每 15 分钟刷新一次）
  if(!refCache.s7||!refCache.s8) await refreshRef();
  const s7=refCache.s7, s8=refCache.s8;
  // 出入库流水走独立缓存（每 5 分钟刷新）
  if(!flowCache.s10||!flowCache.s11) await refreshFlow();
  const s10=flowCache.s10||[], s11=flowCache.s11||[], s36=flowCache.s36||[];
  // 标准站名集合 + 简称还原器
  const stationNames=[...new Set([
    ...s9.map(r=>str(r['c'])), ...s31.map(r=>str(r['C8'])),
    ...(s8||[]).map(r=>normStation(r['Z']))
  ])].filter(Boolean);
  const resolveStation=makeStationResolver(stationNames);
  // 条码 → 商品名（流水表只有条码）
  const nameByBar={}; (s7||[]).forEach(r=>{ const b=str(r['Y']); if(b) nameByBar[b]=str(r['V'])||b; });

  const M={};
  const stations=s8.map(r=>str(r['Z'])).filter(Boolean);
  M.stationCount=stations.length;
  M.stockTotalAmount=s9.reduce((a,r)=>a+num(r['C5']),0);
  M.stockTotalQty=s9.reduce((a,r)=>a+num(r['C3']),0);
  M.stockInCount=s9.reduce((a,r)=>a+num(r['C1']),0);
  M.stockOutCount=s9.reduce((a,r)=>a+num(r['C2']),0);
  // 在架 / 库房 拆分（库房 = 当前库存 − 在架数量，库房库存表已删除，改由仪表盘推导）
  M.shelfQty=s9.reduce((a,r)=>a+num(r['D0']),0);
  M.shelfAmount=s9.reduce((a,r)=>a+num(r['D1']),0);
  M.storeQty=M.stockTotalQty-M.shelfQty;
  M.storeAmount=M.stockTotalAmount-M.shelfAmount;
  M.skuCount=new Set(s9.map(r=>linkId(r['D4'])).filter(Boolean)).size;
  // 缺货（当前库存 ≤ 0）替代原「预警」口径（原预警列 C6 已不存在）
  M.zeroStock=s9.filter(r=>num(r['C3'])<=0).length;
  M.zeroStockQty=Math.abs(s9.filter(r=>num(r['C3'])<0).reduce((a,r)=>a+num(r['C3']),0));
  const byStation={};
  s9.forEach(r=>{
    const st=str(r['c'])||'(空)';
    const o=byStation[st]||(byStation[st]={amount:0,qty:0,count:0,shelf:0,shelfAmt:0,zero:0,inQty:0,outQty:0,sku:{}});
    o.amount+=num(r['C5']); o.qty+=num(r['C3']); o.count++;
    o.shelf+=num(r['D0']); o.shelfAmt+=num(r['D1']);
    o.inQty+=num(r['C1']); o.outQty+=num(r['C2']);
    if(num(r['C3'])<=0) o.zero++;
    const pn=str(r['D4'])||'(未关联商品)';
    o.sku[pn]=(o.sku[pn]||0)+num(r['C5']);   // 该站各商品金额（用于单站图）
  });
  M.byStation=Object.entries(byStation).map(([k,v])=>({station:k,amount:Math.round(v.amount),qty:Math.round(v.qty),count:v.count,
    shelf:Math.round(v.shelf),shelfAmt:Math.round(v.shelfAmt),zero:v.zero,
    inQty:Math.round(v.inQty),outQty:Math.round(v.outQty),skuCount:Object.keys(v.sku).length
  })).map(x=>({...x, storeQty:x.qty-x.shelf, storeAmt:x.amount-x.shelfAmt}))
    .sort((a,b)=>b.amount-a.amount);
  // 在架/库房 金额占比（替代原「库存预警分布」饼图）
  M.holdDist=[{name:'在架库存',value:Math.round(M.shelfAmount)},{name:'库房库存',value:Math.round(M.storeAmount)}];

  // ---------- 分油站下钻：商品 / 供应商 / 缺货清单 / 盘点差异 ----------
  // 注：s9 的商品(D4)、供应商(D6) 在 text_value:'text' 下直接返回名称文本，无需再反查字典
  const stProd={}, stSup={}, stZero={};
  s9.forEach(r=>{
    const st=str(r['c'])||'(空)';
    const pn=str(r['D4'])||'(未关联商品)';
    const sp=str(r['D6'])||'(未指定)';
    const amt=num(r['C5']), qty=num(r['C3']), shAmt=num(r['D1']);
    const P=stProd[st]||(stProd[st]={});
    const p=P[pn]||(P[pn]={amount:0,qty:0,shelfAmt:0});
    p.amount+=amt; p.qty+=qty; p.shelfAmt+=shAmt;
    const S=stSup[st]||(stSup[st]={});
    S[sp]=(S[sp]||0)+1;
    if(qty<=0) (stZero[st]||(stZero[st]=[])).push({name:pn,qty:Math.round(qty),out:Math.round(num(r['C2'])),price:num(r['C4'])});
  });
  M.skuByStation={};
  Object.keys(stProd).forEach(st=>{
    M.skuByStation[st]=Object.entries(stProd[st]).map(([name,v])=>({
      name, amount:Math.round(v.amount), qty:Math.round(v.qty),
      shelfAmt:Math.round(v.shelfAmt), storeAmt:Math.round(v.amount-v.shelfAmt)
    })).sort((a,b)=>b.amount-a.amount).slice(0,12);
  });
  M.supByStation={};
  Object.keys(stSup).forEach(st=>{
    M.supByStation[st]=Object.entries(stSup[st]).map(([supplier,count])=>({supplier,count})).sort((a,b)=>b.count-a.count).slice(0,10);
  });
  M.zeroByStation={};
  Object.keys(stZero).forEach(st=>{
    M.zeroByStation[st]=stZero[st].sort((a,b)=>a.out-b.out);
  });
  const dTS={}, dBS={};
  s31.forEach(r=>{
    const st=str(r['C8'])||'(空)';
    const t=str(r['DJ'])||'(空)';
    const dt=dTS[st]||(dTS[st]={}); dt[t]=(dt[t]||0)+1;
    const pn=str(r['C9'])||'(未关联商品)';
    const A=dBS[st]||(dBS[st]={});
    const o=A[pn]||(A[pn]={diff:0,sales:0});
    o.diff+=num(r['DI']); o.sales+=num(r['DN']);
  });
  M.diffTypeByStation=dTS;
  M.diffByStation={};
  Object.keys(dBS).forEach(st=>{
    M.diffByStation[st]=Object.entries(dBS[st]).map(([name,v])=>({name,diff:Math.round(v.diff),sales:Math.round(v.sales)}))
      .sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff)).slice(0,12);
  });

  // ---------- ★ 进销存流水账（月度盘点 = 期初→入→出→期末 的正式账，方程 4885/4885 验证成立）----------
  const LG={},LGP={};
  s31.forEach(r=>{
    const st=str(r['C8'])||'(空)', pn=str(r['C9'])||'(未关联商品)', tp=str(r['DJ'])||'(空)';
    const o=LG[st]||(LG[st]={rows:0,open:0,adjIn:0,purchase:0,adjOut:0,sold:0,theo:0,actual:0,diff:0,lossQty:0,lossAmt:0});
    o.rows++; o.open+=num(r['DB']); o.adjIn+=num(r['DC']); o.purchase+=num(r['DD']); o.adjOut+=num(r['DE']);
    o.sold+=num(r['DF']); o.theo+=num(r['DH']); o.actual+=num(r['DG']); o.diff+=num(r['DI']);
    if(tp==='盘亏'){ o.lossQty+=num(r['DI']); o.lossAmt+=num(r['DI'])*num(r['DK']); }
    // 只保留有故事的行（盘亏/盘点缺失/期末未扣销售），账实相符的不下发，控制包体
    if(tp!=='账实相符'){
      const A=LGP[st]||(LGP[st]={});
      const p=A[pn]||(A[pn]={name:pn,open:0,purchase:0,sold:0,actual:0,diff:0,type:tp,bar:str(r['C-'])});
      p.open+=num(r['DB']); p.purchase+=num(r['DD']); p.sold+=num(r['DF']);
      p.actual+=num(r['DG']); p.diff+=num(r['DI']); if(p.type!==tp) p.type='多项差异';
    }
  });
  const lgMap=o=>({rows:o.rows,open:Math.round(o.open),adjIn:Math.round(o.adjIn),purchase:Math.round(o.purchase),
    adjOut:Math.round(o.adjOut),sold:Math.round(o.sold),theo:Math.round(o.theo),actual:Math.round(o.actual),
    diff:Math.round(o.diff),lossQty:Math.round(o.lossQty),lossAmt:Math.round(o.lossAmt)});
  M.ledger=Object.entries(LG).map(([k,v])=>({station:k,...lgMap(v)})).sort((a,b)=>b.purchase-a.purchase);
  M.ledgerByStation={};
  Object.keys(LGP).forEach(st=>{
    M.ledgerByStation[st]=Object.values(LGP[st])
      .map(p=>({...p,open:Math.round(p.open),purchase:Math.round(p.purchase),sold:Math.round(p.sold),
                actual:Math.round(p.actual),diff:Math.round(p.diff)}))
      .sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
  });
  // 全公司进销存合计 + 盘亏口径修正（原「盘亏金额」误用了差异列合计）
  const TT={rows:0,open:0,adjIn:0,purchase:0,adjOut:0,sold:0,theo:0,actual:0,diff:0,lossQty:0,lossAmt:0};
  Object.values(LG).forEach(o=>{TT.rows+=o.rows;TT.open+=o.open;TT.adjIn+=o.adjIn;TT.purchase+=o.purchase;TT.adjOut+=o.adjOut;
    TT.sold+=o.sold;TT.theo+=o.theo;TT.actual+=o.actual;TT.diff+=o.diff;TT.lossQty+=o.lossQty;TT.lossAmt+=o.lossAmt;});
  M.ledgerTotal={...TT,open:Math.round(TT.open),adjIn:Math.round(TT.adjIn),purchase:Math.round(TT.purchase),
    adjOut:Math.round(TT.adjOut),sold:Math.round(TT.sold),theo:Math.round(TT.theo),actual:Math.round(TT.actual),
    diff:Math.round(TT.diff),lossQty:Math.round(TT.lossQty),lossAmt:Math.round(TT.lossAmt)};
  M.lossQty=M.ledgerTotal.lossQty;      // 盘亏件数（=出库流水「盘亏」类型数量，已交叉验证相等）
  M.lossAmt=Math.round(M.ledgerTotal.lossAmt);

  // ---------- ★ 盘点在架/库房拆分（EC=在架数量, ED=库房数量，2026-10-10 新增字段） ----------
  // 校验：在架 + 库房 应 = 期末实盘(DG)；gap≠0 表示该站存在漏盘/数错
  const ssBy={}, ssFill=0;
  s31.forEach(r=>{
    const st=str(r['C8'])||'(空)';
    const shelf=num(r['EC']), store=num(r['ED']);
    const o=ssBy[st]||(ssBy[st]={shelf:0,store:0,actual:0,rows:0});
    o.shelf+=shelf; o.store+=store; o.actual+=num(r['DG']); o.rows++;
    if(shelf||store) ssFill++;
  });
  M.shelfStoreByStation=Object.entries(ssBy).map(([station,v])=>({
    station, shelf:Math.round(v.shelf), store:Math.round(v.store), actual:Math.round(v.actual),
    gap:Math.round(v.shelf+v.store-v.actual)
  })).sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap));
  const SST={shelf:0,store:0,actual:0,rows:0};
  Object.values(ssBy).forEach(v=>{SST.shelf+=v.shelf;SST.store+=v.store;SST.actual+=v.actual;SST.rows+=v.rows;});
  M.shelfStoreTotal={shelf:Math.round(SST.shelf),store:Math.round(SST.store),actual:Math.round(SST.actual),
    gap:Math.round(SST.shelf+SST.store-SST.actual),rows:SST.rows,filled:ssFill};

  // ---------- ★ 出入库流水按站（表单台账；站名简称已还原） ----------
  const inSt={},outSt={},inSku={},outSku={};
  s10.forEach(r=>{
    const st=resolveStation(r['Bo'])||'(未填)'; const q=num(r['Bp']);
    const src=str(r['Bq']);
    const o=inSt[st]||(inSt[st]={rows:0,purchase:0,adj:0,other:0,total:0});
    o.rows++; o.total+=q;
    if(src.indexOf('调拨')>=0) o.adj+=q; else if(src.indexOf('进货')>=0||src==='') o.purchase+=q; else o.other+=q;
    const bar=str(r['Bg']); if(bar){ const k=st+'|'+(nameByBar[bar]||bar);
      const p=inSku[k]||(inSku[k]={station:st,name:nameByBar[bar]||('条码'+bar),qty:0,rows:0}); p.qty+=q; p.rows++; }
  });
  s11.forEach(r=>{
    const st=resolveStation(r['u'])||'(未填)'; const q=num(r['z']);
    const tp=str(r['y']);
    const o=outSt[st]||(outSt[st]={rows:0,sold:0,loss:0,adj:0,other:0,total:0});
    o.rows++; o.total+=q;
    if(tp==='销售') o.sold+=q; else if(tp==='盘亏') o.loss+=q;
    else if(tp.indexOf('调拨')>=0) o.adj+=q; else o.other+=q;
    const bar=str(r['B0']); if(bar){ const k=st+'|'+(nameByBar[bar]||bar);
      const p=outSku[k]||(outSku[k]={station:st,name:nameByBar[bar]||('条码'+bar),qty:0,rows:0}); p.qty+=q; p.rows++; }
  });
  const rnd=o=>{const r={};Object.keys(o).forEach(k=>r[k]=(typeof o[k]==='number')?Math.round(o[k]):o[k]);return r;};
  M.flowIn={}; M.flowOut={}; M.flowSkuByStation={};
  Object.keys(inSt).forEach(st=>M.flowIn[st]=rnd(inSt[st]));
  Object.keys(outSt).forEach(st=>M.flowOut[st]=rnd(outSt[st]));
  // 每站出入库商品 TOP（入库/出库合并成一份，便于单站下钻）
  const skuAgg={};
  Object.values(inSku).forEach(p=>{ const a=skuAgg[p.station]||(skuAgg[p.station]={}); 
    const x=a[p.name]||(a[p.name]={name:p.name,inQty:0,outQty:0}); x.inQty+=p.qty; });
  Object.values(outSku).forEach(p=>{ const a=skuAgg[p.station]||(skuAgg[p.station]={}); 
    const x=a[p.name]||(a[p.name]={name:p.name,inQty:0,outQty:0}); x.outQty+=p.qty; });
  Object.keys(skuAgg).forEach(st=>{
    M.flowSkuByStation[st]=Object.values(skuAgg[st])
      .map(x=>({name:x.name,inQty:Math.round(x.inQty),outQty:Math.round(x.outQty),net:Math.round(x.inQty-x.outQty)}))
      .sort((a,b)=>Math.max(b.inQty,b.outQty)-Math.max(a.inQty,a.outQty)).slice(0,15);
  });
  // 流水未识别站点（简称还原失败才会出现）
  const known=new Set(stationNames);
  M.unresolvedStations=[...new Set([...Object.keys(inSt),...Object.keys(outSt)])].filter(st=>!known.has(st));
  // 流水合计
  M.flowTotal={inQty:Math.round(s10.reduce((a,r)=>a+num(r['Bp']),0)), inRows:s10.length,
               outQty:Math.round(s11.reduce((a,r)=>a+num(r['z']),0)), outRows:s11.length};

  // ---------- 日期工具（按日趋势与动态库存共用，必须先声明） ----------
  const parseDate=v=>{ const m=String(v==null?'':v).match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if(!m) return null; const d=new Date(+m[1],+m[2]-1,+m[3]); return isNaN(d.getTime())?null:d; };
  const fmtD=d=>{ if(!d||isNaN(d.getTime())) return ''; return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };

  // ---------- ★ 按日趋势（销售 / 进货 / 出库；金额 = 数量 × 字典价） ----------
  // 口径提示：2026-08-01 之前的流水是「7 月全月累计导出」，日期粒度不可信 → partial=true，前端需淡化展示
  const costByBar={}, sellByBar={};
  (s7||[]).forEach(r=>{ const b=str(r['Y']); if(!b) return;
    const c=num(r['W']); if(c) costByBar[b]=c;
    const p=num(r['7']); if(p) sellByBar[b]=p; });
  const dayAgg={}, dayStAgg={};
  const bumpDay=(d,st,k,q,amt)=>{
    if(!d) return;
    const o=dayAgg[d]||(dayAgg[d]={date:d,inQty:0,inAmt:0,outQty:0,outAmt:0,soldQty:0,soldAmt:0,
      lossQty:0,adjQty:0,inRows:0,outRows:0,stations:new Set(),noPrice:0});
    o[k+'Qty']+=q; o[k+'Amt']+=amt;
    o.stations.add(st);
    if(amt===0) o.noPrice++;
    const S=dayStAgg[d]||(dayStAgg[d]={});
    const so=S[st]||(S[st]={inQty:0,outQty:0,soldQty:0,soldAmt:0,inAmt:0});
    so[k+'Qty']+=q; if(k==='sold') so.soldAmt+=amt; if(k==='in') so.inAmt+=amt;
  };
  s10.forEach(r=>{
    const d=fmtD(parseDate(r['Bn'])); if(!d||d==='null') return;
    const st=resolveStation(r['Bo'])||'(未填)', q=num(r['Bp']), src=str(r['Bq']);
    const o=dayAgg[d]||(dayAgg[d]={date:d,inQty:0,inAmt:0,outQty:0,outAmt:0,soldQty:0,soldAmt:0,
      lossQty:0,adjQty:0,inRows:0,outRows:0,stations:new Set(),noPrice:0});
    o.inRows++;
    const c=costByBar[str(r['Bg'])]||0;
    bumpDay(d,st,'in',q,q*c);
    if(src.indexOf('调拨')>=0) o.adjQty+=q;
  });
  s11.forEach(r=>{
    const d=fmtD(parseDate(r['s'])); if(!d||d==='null') return;
    const st=resolveStation(r['u'])||'(未填)', q=num(r['z']), tp=str(r['y']);
    const o=dayAgg[d]||(dayAgg[d]={date:d,inQty:0,inAmt:0,outQty:0,outAmt:0,soldQty:0,soldAmt:0,
      lossQty:0,adjQty:0,inRows:0,outRows:0,stations:new Set(),noPrice:0});
    o.outRows++;
    const bar=str(r['B0']);
    if(tp==='销售'||tp===''||tp===undefined){
      o.outQty+=q; const p=sellByBar[bar]||0; bumpDay(d,st,'sold',q,q*p); o.outAmt+=q*p;
    }else if(tp==='盘亏'){ o.outQty+=q; o.lossQty+=q; const p=costByBar[bar]||0; bumpDay(d,st,'out',q,q*p); }
    else if(tp.indexOf('调拨')>=0){ o.outQty+=q; o.adjQty+=q; bumpDay(d,st,'out',q,0); }
    else { o.outQty+=q; bumpDay(d,st,'out',q,0); }
  });
  const dayList=Object.values(dayAgg).sort((a,b)=>a.date<b.date?-1:1).map(o=>{
    const {stations,...rest}=o;
    return {...rest, inQty:Math.round(rest.inQty),inAmt:Math.round(rest.inAmt),outQty:Math.round(rest.outQty),
      outAmt:Math.round(rest.outAmt),soldQty:Math.round(rest.soldQty),soldAmt:Math.round(rest.soldAmt),
      lossQty:Math.round(rest.lossQty),adjQty:Math.round(rest.adjQty),stationCount:stations.size,
      partial:rest.date<'2026-08-01'};
  });
  M.daily=dayList;
  M.dailyRange={from:dayList.length?dayList[0].date:'', to:dayList.length?dayList[dayList.length-1].date:'', days:dayList.length};

  // ---------- ★ 流水覆盖度体检：按月数量 + 锚后活跃天数（前端提示用，避免对着空图猜） ----------
  // 实测结论（2026-10-14）：7月 133,836 件为整月累计导出（已含在盘点锚点内），
  //   8 月整月 0 流水、9 月仅零星补录 5,415 件 → 按日趋势天然稀疏，是数据源现状而非程序缺陷。
  const monthIn={}, monthOut={}, monthDaysIn={}, monthDaysOut={};
  s10.forEach(r=>{ const d=parseDate(r['Bn']); if(!d) return; const m=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    monthIn[m]=(monthIn[m]||0)+num(r['Bp']); (monthDaysIn[m]||(monthDaysIn[m]=new Set())).add(fmtD(d)); });
  s11.forEach(r=>{ const d=parseDate(r['s']); if(!d) return; const m=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    monthOut[m]=(monthOut[m]||0)+num(r['z']); (monthDaysOut[m]||(monthDaysOut[m]=new Set())).add(fmtD(d)); });
  const monthList=[...new Set([...Object.keys(monthIn),...Object.keys(monthOut)])].sort().map(m=>({
    month:m, inQty:Math.round(monthIn[m]||0), outQty:Math.round(monthOut[m]||0),
    inDays:(monthDaysIn[m]?monthDaysIn[m].size:0), outDays:(monthDaysOut[m]?monthDaysOut[m].size:0),
    preAnchor:m<'2026-08'
  }));
  // 锚点后有流水的「日历天」跨度 vs 实际有记录的天数 → 覆盖率
  const postDays=new Set(dayList.filter(o=>!o.partial).map(o=>o.date));
  const postSpan=postDays.size?(()=>{ const ds=[...postDays].sort();
    const daysBetween=Math.round((new Date(ds[ds.length-1])-new Date(ds[0]))/864e5)+1; return daysBetween; })():0;
  // 最新流水日期就地计算（此刻 M.dynTotal 尚未赋值，不能引用）
  let lastFlowDate='';
  [s10,s11].forEach(arr=>arr.forEach(r=>{ const d=parseDate(arr===s10?r['Bn']:r['s']); if(!d) return;
    const f=fmtD(d); if(!lastFlowDate||f>lastFlowDate) lastFlowDate=f; }));
  M.flowCoverage={ months:monthList, postAnchorDays:postDays.size, postAnchorSpan:postSpan,
    postAnchorRate:postSpan?Math.round(postDays.size/postSpan*100):0,
    emptyMonths:monthList.filter(m=>m.preAnchor===false&&m.inQty===0&&m.outQty===0).map(m=>m.month),
    lastFlowDate,
    staleDays:(()=>{ const d=parseDate(lastFlowDate); if(!d) return -1;
      return Math.round((new Date(new Date().toDateString())-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/864e5); })(),
    note:'7月为整月累计导出（已含盘点锚点），按日粒度不可信；8月无流水、9月零星补录属数据源现状' };
  // 近 30 天按站序列（控包体：每天每站一行，Top20 站）
  const recentDays=dayList.filter(o=>!o.partial).slice(-30).map(o=>o.date);
  const topStObj={};
  const stTot={};
  Object.entries(dayStAgg).forEach(([d,m])=>{ if(recentDays.indexOf(d)<0) return;
    Object.entries(m).forEach(([st,v])=>{ stTot[st]=(stTot[st]||0)+v.soldAmt+v.inAmt; }); });
  const keepSt=new Set(Object.entries(stTot).sort((a,b)=>b[1]-a[1]).slice(0,20).map(x=>x[0]));
  M.dailyByStation={};
  recentDays.forEach(d=>{
    const m=dayStAgg[d]||{};
    Object.entries(m).forEach(([st,v])=>{
      if(!keepSt.has(st)) return;
      (M.dailyByStation[st]||(M.dailyByStation[st]=[])).push({date:d,
        inQty:Math.round(v.inQty),inAmt:Math.round(v.inAmt),outQty:Math.round(v.outQty),
        soldQty:Math.round(v.soldQty),soldAmt:Math.round(v.soldAmt)});
    });
  });
  M.dailyStationList=[...keepSt];

  // ---------- ★ 流水驱动动态库存（锚点 = s31 期末实盘 2026-07-31，增量 = 8/1 起出入库流水） ----------
  // 口径：7/31 及以前的流水是 7 月全月累计导出、已含在 DG 期末实盘内，必须排除，否则重复扣减
  const ANCHOR_TS=new Date(2026,7,1).getTime();            // 2026-08-01 00:00 之前的流水全部排除
  // parseDate / fmtD 已在上方「日期工具」处声明
  // 锚点：(站|条码) → 期末实盘数量 + 进货价（金额 = 数量 × DK）
  const dynAnchor={}; let anchorRows=0;
  s31.forEach(r=>{
    const st=str(r['C8']), bar=str(r['C-']);
    if(!st||!bar) return;
    anchorRows++;
    const k=st+'|'+bar;
    const o=dynAnchor[k]||(dynAnchor[k]={qty:0,price:0,name:str(r['C9'])||bar});
    o.qty+=num(r['DG']);
    const p=num(r['DK']); if(p) o.price=p;
    if(o.name===bar&&str(r['C9'])) o.name=str(r['C9']);
  });
  // 增量：锚点之后的全类型流水（s10 全部 +Bp，s11 全部 −z；y 缺失按销售计并计数）
  const dynDelta={};
  let inFlowRows=0,outFlowRows=0,unresolvedFlowRows=0,s11UndefinedRows=0,inQty9=0,outQty9=0,todayFlowRows=0;
  let lastFlow=null;
  const todayStr=fmtD(new Date());
  const bump=(st,bar,sign,q)=>{ const k=st+'|'+bar; const o=dynDelta[k]||(dynDelta[k]={in:0,out:0}); if(sign>0)o.in+=q; else o.out+=q; };
  s10.forEach(r=>{
    const d=parseDate(r['Bn']); if(!d) return;
    if(!lastFlow||d>lastFlow) lastFlow=d;
    if(fmtD(d)===todayStr) todayFlowRows++;
    if(d.getTime()<ANCHOR_TS) return;
    inFlowRows++;
    const st=resolveStation(r['Bo']), bar=str(r['Bg']), q=num(r['Bp']);
    if(!st||!bar||!known.has(st)){ unresolvedFlowRows++; return; }   // 归属不明：不静默丢弃，计数上报
    inQty9+=q; bump(st,bar,1,q);
  });
  s11.forEach(r=>{
    const d=parseDate(r['s']); if(!d) return;
    if(!lastFlow||d>lastFlow) lastFlow=d;
    if(fmtD(d)===todayStr) todayFlowRows++;
    if(d.getTime()<ANCHOR_TS) return;
    outFlowRows++;
    if(r['y']===undefined||r['y']===null||str(r['y'])==='') s11UndefinedRows++;
    const st=resolveStation(r['u']), bar=str(r['B0']), q=num(r['z']);
    if(!st||!bar||!known.has(st)){ unresolvedFlowRows++; return; }
    outQty9+=q; bump(st,bar,-1,q);
  });
  // 合成：动态库存 = DG + Σ入 − Σ出（可为负 = 超卖）
  const dynMap={};
  Object.entries(dynAnchor).forEach(([k,v])=>{ const i=k.indexOf('|');
    dynMap[k]={station:k.slice(0,i),bar:k.slice(i+1),name:v.name,qty:v.qty,price:v.price}; });
  Object.entries(dynDelta).forEach(([k,v])=>{ const i=k.indexOf('|');
    const st=k.slice(0,i), bar=k.slice(i+1);
    const o=dynMap[k]||(dynMap[k]={station:st,bar:bar,name:nameByBar[bar]||('条码'+bar),qty:0,price:0});
    o.qty+=v.in-v.out; });
  const dynRows=Object.values(dynMap).map(o=>({station:o.station,bar:o.bar,name:o.name,
    qty:Math.round(o.qty),price:o.price,amt:Math.round(o.qty*o.price)}));
  const dynStAgg={};
  dynRows.forEach(r=>{
    const o=dynStAgg[r.station]||(dynStAgg[r.station]={qty:0,amt:0,bars:new Set(),low:0});
    o.qty+=r.qty; o.amt+=r.amt; o.bars.add(r.bar); if(r.qty<=0) o.low++;
  });
  M.dynTotal={ qty:dynRows.reduce((a,r)=>a+r.qty,0), amt:dynRows.reduce((a,r)=>a+r.amt,0),
    sku:new Set(dynRows.map(r=>r.bar)).size, stations:Object.keys(dynStAgg).length,
    anchorDate:'2026-07-31', lastFlowDate:lastFlow?fmtD(lastFlow):'' };
  M.dynByStation=Object.entries(dynStAgg).map(([st,v])=>({station:st,qty:Math.round(v.qty),amt:Math.round(v.amt),
    sku:v.bars.size,lowCount:v.low})).sort((a,b)=>b.amt-a.amt);
  // 单站视角商品级明细（金额降序，控制包体每站留 150 行）
  const dynSkuTmp={};
  dynRows.forEach(r=>{ (dynSkuTmp[r.station]||(dynSkuTmp[r.station]=[])).push({name:r.name,bar:r.bar,qty:r.qty,amt:r.amt}); });
  M.dynSkuByStation={};
  Object.keys(dynSkuTmp).forEach(st=>{
    M.dynSkuByStation[st]=dynSkuTmp[st].sort((a,b)=>b.amt-a.amt).slice(0,150); });
  M.dynLow=dynRows.filter(r=>r.qty<=0).sort((a,b)=>a.qty-b.qty)
    .map(r=>({station:r.station,name:r.name,bar:r.bar,qty:r.qty,amt:r.amt})).slice(0,300);
  M.dynWarn=dynRows.filter(r=>r.qty>0&&r.qty<=10).sort((a,b)=>a.qty-b.qty)
    .map(r=>({station:r.station,name:r.name,bar:r.bar,qty:r.qty,amt:r.amt})).slice(0,300);

  // ---------- ★ 货架/库房双仓动态账（2026-10-10，移库流水 s36 驱动） ----------
  // 模型：货架 = 期初货架(EC) + 上架 − 下架 − 报损 − 销售 ｜ 库房 = 期初库房(ED) + 进货 − 上架 + 下架
  // 期初基准 = s31 盘点 EC(在架)/ED(库房)；未盘点(全 0)则动态账标 pending，仅展示移库统计
  // 增量口径 = 8/1 后（与 dynTotal 锚点一致），移库/进货/销售均取锚点后流水
  const moveBySt={};
  s36.forEach(r=>{
    const d=parseDate(r['EK']); if(!d||d.getTime()<ANCHOR_TS) return;
    const st=resolveStation(r['EH'])||'(未填)';
    const act=str(r['EF']), q=num(r['EG']);
    const o=moveBySt[st]||(moveBySt[st]={up:0,down:0,loss:0,rows:0});
    o.rows++;
    if(act.indexOf('上架')>=0) o.up+=q;
    else if(act.indexOf('下架')>=0) o.down+=q;
    else if(act.indexOf('报损')>=0) o.loss+=q;
  });
  M.moveByStation=Object.entries(moveBySt).map(([station,v])=>({
    station,up:Math.round(v.up),down:Math.round(v.down),loss:Math.round(v.loss),rows:v.rows
  })).sort((a,b)=>(b.up+b.down+b.loss)-(a.up+a.down+a.loss));
  // 期初货架/库房基准（按站，盘点 EC/ED）
  const shelfBase={}, storeBase={};
  s31.forEach(r=>{ const st=str(r['C8'])||'(空)';
    shelfBase[st]=(shelfBase[st]||0)+num(r['EC']); storeBase[st]=(storeBase[st]||0)+num(r['ED']); });
  const s31Filled=Object.values(shelfBase).reduce((a,v)=>a+v,0)+Object.values(storeBase).reduce((a,v)=>a+v,0);
  // 锚点后 进货(进库房)/销售(出货架) 增量
  const inBySt={}, saleBySt={};
  s10.forEach(r=>{ const d=parseDate(r['Bn']); if(!d||d.getTime()<ANCHOR_TS) return;
    const st=resolveStation(r['Bo']); if(st&&known.has(st)) inBySt[st]=(inBySt[st]||0)+num(r['Bp']); });
  s11.forEach(r=>{ const d=parseDate(r['s']); if(!d||d.getTime()<ANCHOR_TS) return;
    const st=resolveStation(r['u']); if(!st||!known.has(st)) return;
    const tp=str(r['y']);
    if(tp==='销售'||tp==='出库上架销售'||tp==='') saleBySt[st]=(saleBySt[st]||0)+num(r['z']); });
  const ssDyn={};
  stationNames.forEach(st=>{
    const bs=shelfBase[st]||0, bt=storeBase[st]||0;
    const mv=moveBySt[st]||{up:0,down:0,loss:0};
    const shelf=bs+mv.up-mv.down-mv.loss-(saleBySt[st]||0);
    const store=bt+(inBySt[st]||0)-mv.up+mv.down;
    ssDyn[st]={shelf:Math.round(shelf),store:Math.round(store),baseShelf:Math.round(bs),baseStore:Math.round(bt),
      up:Math.round(mv.up),down:Math.round(mv.down),loss:Math.round(mv.loss),
      saleIn:Math.round(saleBySt[st]||0),purchaseIn:Math.round(inBySt[st]||0)};
  });
  M.shelfStoreDynByStation=Object.entries(ssDyn).map(([station,v])=>({station,...v}))
    .sort((a,b)=>(b.shelf+b.store)-(a.shelf+a.store));
  const SDT={shelf:0,store:0,up:0,down:0,loss:0,purchaseIn:0,saleIn:0};
  Object.values(ssDyn).forEach(v=>{SDT.shelf+=v.shelf;SDT.store+=v.store;SDT.up+=v.up;SDT.down+=v.down;
    SDT.loss+=v.loss;SDT.purchaseIn+=v.purchaseIn;SDT.saleIn+=v.saleIn;});
  M.shelfStoreDynTotal={pending:s31Filled===0, shelf:Math.round(SDT.shelf),store:Math.round(SDT.store),
    up:Math.round(SDT.up),down:Math.round(SDT.down),loss:Math.round(SDT.loss),
    purchaseIn:Math.round(SDT.purchaseIn),saleIn:Math.round(SDT.saleIn),
    moveRows:s36.length, baseSource:s31Filled>0?'盘点EC/ED':'待期初盘点'};

  // 数据链健康：三个数据源状态 + 未识别行计数 + 订货台账导入状态
  let ordersState=null;
  try{ ordersState=JSON.parse(fs.readFileSync(path.join(ROOT,'ingest_state.json'),'utf8')); }catch(e){}
  M.dynHealth={ anchorRows, inFlowRows, outFlowRows,
    inQty9:Math.round(inQty9), outQty9:Math.round(outQty9),
    unresolvedFlowRows, s11UndefinedRows,
    flowLastDate:M.dynTotal.lastFlowDate, flowTodayRows:todayFlowRows,
    ordersState, jituanSeen:false };

  M.purchaseQty=s31.reduce((a,r)=>a+num(r['DD']),0);
  M.salesQty=s31.reduce((a,r)=>a+num(r['DF']),0);
  M.diffTotal=Math.round(s31.reduce((a,r)=>a+num(r['DI']),0));
  M.diffLoss=s31.filter(r=>num(r['DI'])<0).reduce((a,r)=>a+num(r['DI']),0);
  M.diffGain=s31.filter(r=>num(r['DI'])>0).reduce((a,r)=>a+num(r['DI']),0);
  const diffType={};
  s31.forEach(r=>{ const t=str(r['DJ'])||'(空)'; diffType[t]=(diffType[t]||0)+1; });
  M.diffType=diffType;
  const stSales={};
  s31.forEach(r=>{
    const st=str(r['C8'])||'(空)';
    const o=stSales[st]||(stSales[st]={sales:0,diff:0,count:0,purchase:0,sold:0,loss:0,gain:0});
    o.sales+=num(r['DN']); o.diff+=num(r['DI']); o.count++;
    o.purchase+=num(r['DD']); o.sold+=num(r['DF']);
    const d=num(r['DI']); if(d<0) o.loss+=d; else if(d>0) o.gain+=d;
  });
  M.stSales=Object.entries(stSales).map(([k,v])=>({station:k,sales:Math.round(v.sales),diff:Math.round(v.diff),count:v.count,
    purchase:Math.round(v.purchase),sold:Math.round(v.sold),loss:Math.round(Math.abs(v.loss))})).sort((a,b)=>b.sales-a.sales);
  M.stDiff=M.stSales;   // 兼容前端 c4 字段名
  const supDist={};
  s7.forEach(r=>{ const s=str(r['6'])||'(未指定)'; supDist[s]=(supDist[s]||0)+1; });
  M.supDist=Object.entries(supDist).map(([k,v])=>({supplier:k,count:v})).sort((a,b)=>b.count-a.count);
  M.supTop=M.supDist;   // 兼容前端 c5 字段名
  M.skuTotal=s7.length;
  const unitDist={};
  s7.forEach(r=>{ const u=str(r['X'])||'(空)'; unitDist[u]=(unitDist[u]||0)+1; });
  M.unitDist=unitDist;
  M.generatedAt=new Date().toISOString();
  // ⚠️ 盘亏口径：真正的盘亏 = 差异类型「盘亏」的行（件数 × 进货价）。
  //   旧口径 Σ(DI<0) 实为「期末未扣销售」的数量(5,621件)，不是金额，已废弃。
  M.kpi={station:M.stationCount, sku:M.skuTotal, amount:M.stockTotalAmount, qty:M.stockTotalQty,
         shelf:M.shelfAmount, store:M.storeAmount, zero:M.zeroStock, loss:M.lossAmt, lossQty:M.lossQty};
  return M;
}

// ---------- 后台刷新（异步、非阻塞，刷新期间前端照常读缓存）----------
let cache=null,cacheAt=0,isRefreshing=false,lastError=null;
async function refresh(){
  if(isRefreshing) return;
  isRefreshing=true;
  try{
    const data=await buildMetrics();
    cache=data; cacheAt=Date.now(); lastError=null;
    try{ fs.writeFileSync(metricsPath,JSON.stringify(data,null,2)); }catch(e){}
    console.log('✅ 刷新成功 '+new Date().toLocaleTimeString()+' | 库存总额 ¥'+Math.round(data.kpi.amount).toLocaleString()
      +' (在架 ¥'+Math.round(data.kpi.shelf).toLocaleString()+' / 库房 ¥'+Math.round(data.kpi.store).toLocaleString()+')'
      +' | 缺货 '+data.kpi.zero+' | 盘亏 '+data.kpi.lossQty+'件/¥'+Math.round(data.kpi.loss).toLocaleString()
      +' | 流水 入'+data.flowTotal.inQty+'/出'+data.flowTotal.outQty
      +' | 动态库存 '+Math.round(data.dynTotal.qty).toLocaleString()+'件/¥'+Math.round(data.dynTotal.amt).toLocaleString()
      +'（锚后 入'+data.dynHealth.inQty9+'/出'+data.dynHealth.outQty9
      +(data.dynHealth.unresolvedFlowRows?(' ⚠️未归属流水'+data.dynHealth.unresolvedFlowRows+'行'):'')+'）'
      +(data.unresolvedStations.length?(' | ⚠️未识别站点:'+data.unresolvedStations.join(',')):''));
  }catch(e){ lastError=e.message; console.log('⚠️ 刷新失败(保留上一周期数据): '+e.message); }
  finally{ isRefreshing=false; }
}

// ---------- 图形化导入 ----------
function readBody(req,limit){
  return new Promise((resolve,reject)=>{
    const chunks=[]; let size=0;
    req.on('data',c=>{ size+=c.length;
      if(size>limit){ reject(new Error('上传文件过大(>'+Math.round(limit/1024/1024)+'MB)')); req.destroy(); return; }
      chunks.push(c); });
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}

function readImportState(){
  try{ return JSON.parse(fs.readFileSync(path.join(ROOT,'ingest_state.json'),'utf8')); }
  catch(e){ return null; }
}

function handleImport(req,res){
  let kind=null;
  try{ kind=new URL(req.url,'http://localhost').searchParams.get('kind'); }catch(e){}
  const kindCfg=IMPORT_KINDS[kind||''];
  if(!kindCfg){
    res.writeHead(400,JSON_HEAD);
    res.end(JSON.stringify({ok:false,error:'缺少或非法 kind 参数（仅支持 orders | jituan）'}));
    return;
  }
  readBody(req,MAX_UPLOAD).then(buf=>{
    if(!buf||!buf.length){
      res.writeHead(400,JSON_HEAD);
      res.end(JSON.stringify({ok:false,error:'请求体为空，请用 application/octet-stream 上传 xlsx'}));
      return;
    }
    let tmp;
    try{
      fs.mkdirSync(IMPORT_TMP,{recursive:true});
      tmp=path.join(IMPORT_TMP,'upload_'+Date.now()+'.xlsx');
      fs.writeFileSync(tmp,buf);
    }catch(e){
      res.writeHead(500,JSON_HEAD);
      res.end(JSON.stringify({ok:false,error:'写入临时文件失败: '+e.message}));
      return;
    }
    const [script,fileArg]=kindCfg;
    const args=[script,fileArg,tmp,'--apply'];
    execFile(PYTHON,args,{cwd:ROOT,maxBuffer:50*1024*1024,timeout:IMPORT_TIMEOUT},(err,stdout,stderr)=>{
      try{ fs.unlinkSync(tmp); }catch(e){}
      const state=readImportState();
      const imported=state&&state.imported?state.imported:0;
      const skipped=state&&state.skipped?state.skipped:0;
      const unmatched=state&&state.unmatched?state.unmatched:0;
      const log=String(stdout||'')+(stderr&&String(stderr).trim()?('\n--- stderr ---\n'+String(stderr)):'');
      if(err){
        res.writeHead(500,JSON_HEAD);
        res.end(JSON.stringify({ok:false,error:'导入脚本执行失败: '+(err.message||err),imported,skipped,unmatched,log}));
        return;
      }
      res.writeHead(200,JSON_HEAD);
      res.end(JSON.stringify({ok:true,imported,skipped,unmatched,mode:state?state.mode:'',log}));
    });
  }).catch(e=>{
    res.writeHead(413,JSON_HEAD);
    res.end(JSON.stringify({ok:false,error:e.message||String(e)}));
  });
}

// ---------- 销售SKU明细同步（中转表 → sheet11 出库流水，Node 版，云端/本地通用） ----------
const TRANSFER_FID='q8bXx7WFfxMaUtk3ZkSRxxfxTQPoSUMBv';   // 中转表（在线表格）file_id
const TRANSFER_SHEET=1;                                     // 中转表 worksheet_id

function normSite(s){ return String(s||'').replace(/[（(]\s*高速\s*[）)]/g,'').replace(/加油站/g,'').replace(/\s+/g,'').trim(); }
function tightSite(s){ return normSite(s).replace(/服务区/g,'').replace(/停车区/g,'').replace(/站$/,''); }
const AREA_DIR_OVERRIDE={'南/东':'东','北/西':'西','南东':'东','北西':'西','东区':'东','西区':'西','南区':'南','北区':'北'};
function extractDir(a){
  if(!a) return '';
  const s=String(a).replace(/\s+/g,'');
  if(AREA_DIR_OVERRIDE[s]) return AREA_DIR_OVERRIDE[s];
  const dirs=(s.match(/[东南西北]/g)||[]);
  return dirs.length===1?dirs[0]:'';
}
function parseNum(v){ if(v==null||v==='') return 0; const n=parseFloat(String(v).replace(/,/g,'')); return isNaN(n)?0:n; }
function parseDate(v){
  if(!v) return '';
  const s=String(v).trim();
  const m=s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if(m) return (+m[1])+'/'+String(+m[2]).padStart(2,'0')+'/'+String(+m[3]).padStart(2,'0');
  return s;
}
function fmtQty(x){ if(x==null) return 0; const n=Number(x); return Number.isInteger(n)?n:n; }
function cellVal(c,col){
  const ut=(typeof c.understandableType==='object'&&c.understandableType)?c.understandableType:{};
  const utype=ut.type||'';
  if(col===3){ const ov=c.originalCellValue; if(ov!=null&&ov!=='') return String(ov); }
  if(utype==='date'){ const v=ut.value; return (v!=null&&v!=='')?v:(c.cellText||''); }
  if(utype==='number'||utype==='double'||utype==='int'||utype==='float'){ const v=ut.value; return (v!=null)?v:(c.cellText||''); }
  return (c.cellText!=null)?c.cellText:'';
}
// 读中转表 A:K（0..10 列），跳过表头第 0 行，分页
async function readTransferRows(){
  const out=[]; const pageRows=4000; let start=1; const MAX=200000;
  while(start<=MAX){
    const j=await callTool('sheet.get_range_data',{file_id:TRANSFER_FID,worksheet_id:TRANSFER_SHEET,range:{rowFrom:start,rowTo:start+pageRows-1,colFrom:0,colTo:10}});
    const detail=(j.data&&(j.data.detail||j.data))||{};
    const cells=detail.rangeData||[];
    if(!cells.length) break;
    const rows={};
    for(const c of cells){ const r=c.originRow||0, col=c.originCol||0; (rows[r]=rows[r]||{})[col]=cellVal(c,col); }
    Object.keys(rows).map(Number).sort((a,b)=>a-b).forEach(r=>{
      const m=rows[r];
      out.push({date:String(m[0]||''),station:String(m[1]||''),area:String(m[2]||''),barcode:String(m[3]||'').trim(),
        name:String(m[4]||''),spec:String(m[5]||''),qty:parseNum(m[6]),amount:parseNum(m[7]),
        cost:parseNum(m[8]),profit:parseNum(m[9]),bucket:String(m[10]||'')});
    });
    if(cells.length < pageRows*11) break;
    start+=pageRows;
  }
  return out;
}
// 分页读多维表整表；textValue='text' 时 Link 返回名称，undefined 时返回 record id 数组
async function pullRecords(sheetId,fields,textValue){
  const all=[]; let token='';
  while(true){
    const args={link_id:LINK,sheet_id:sheetId,prefer_id:true};
    if(textValue) args.text_value=textValue;
    if(fields) args.fields=fields;
    if(token) args.page_token=token;
    const j=await callTool('dbsheet.records_list',args);
    if(j.code!==0 && j.code!==undefined){ throw new Error('records_list code='+j.code+': '+(j.message||'')); }
    const inner=(j.data&&j.data.data)||{};
    const recs=inner.records||[];
    for(const r of recs){ let f=r.fields; if(typeof f==='string'){ try{f=JSON.parse(f);}catch(e){f={};} } all.push({id:r.id,fields:f||{}}); }
    token=inner.page_token||'';
    if(!token||!recs.length) break;
  }
  return all;
}
// 分批写多维表（fields 键用中文字段名）；返回 {created, ids}
async function createRecords(sheetId,records){
  let created=0; const ids=[]; const BATCH=50;
  for(let i=0;i<records.length;i+=BATCH){
    const batch=records.slice(i,i+BATCH);
    const j=await callTool('dbsheet.create_records',{link_id:LINK,sheet_id:sheetId,records:batch.map(rec=>({fields:rec}))});
    if(j.code!==0 && j.code!==undefined){ throw new Error('create_records code='+j.code+': '+(j.message||'')); }
    const data=j.data||{};
    if(data.result && data.result!=='ok'){ throw new Error('create_records result='+data.result); }
    const recs=((data.detail)||{}).records||[];
    created+=batch.length; recs.forEach(r=>{ if(r.id) ids.push(r.id); });
  }
  return {created,ids};
}
// 主同步：读中转表 → 站点映射 → 归并 → 去重 → 写 sheet11（apply=true 才写）
async function syncSales(apply){
  const rows=await readTransferRows();
  if(!rows.length) return {ok:true,apply,summary:'中转表为空，无需同步',unmatched:[],pendingSample:[]};
  const siteMap={};
  (await pullRecords(8,['Z'],'text')).forEach(r=>{ const t=tightSite((r.fields||{}).Z||''); if(t) siteMap[t]=r.id; });
  const dedup=new Set();
  (await pullRecords(11,['s','u','B0'],undefined)).forEach(r=>{
    const f=r.fields||{}; const u=f.u; const uid=Array.isArray(u)?String(u[0]||''):String(u||'');
    dedup.add([String(f.s||'').trim(),uid,String(f.B0||'').trim()].join('|'));
  });
  const merged={}; const unmatched=[]; let noBarcode=0;
  for(const r of rows){
    const bar=r.barcode;
    if(!bar){ noBarcode++; continue; }
    const sid=siteMap[tightSite(r.station)+extractDir(r.area)];
    if(!sid){ unmatched.push(r); continue; }
    const ds=parseDate(r.date);
    if(!ds){ unmatched.push(r); continue; }
    const key=ds+'|'+sid+'|'+bar;
    const o=merged[key];
    if(o) o.qty+=r.qty; else merged[key]={date:ds,sid,bar,qty:r.qty,name:r.name,station:r.station,area:r.area};
  }
  const pending=[];
  for(const k in merged){ const o=merged[k]; if(!dedup.has(o.date+'|'+o.sid+'|'+o.bar)) pending.push(o); }
  const records=pending.map(o=>({'日期':o.date,'站点':[o.sid],'出库类型':'销售','出库数量':fmtQty(o.qty),'商品编码':o.bar}));
  let res={created:0,ids:[]};
  if(apply && records.length) res=await createRecords(11,records);
  return {ok:true,apply,
    summary:'中转'+rows.length+'行 / 无条码'+noBarcode+' / 未匹配'+unmatched.length+' / 归并'+Object.keys(merged).length+' / 待写'+pending.length+' / 已写'+res.created,
    unmatched:unmatched.slice(0,20).map(r=>({date:r.date,station:r.station,area:r.area,barcode:r.barcode,name:r.name,qty:fmtQty(r.qty)})),
    pendingSample:records.slice(0,5)};
}

function handleSyncSales(req,res){
  let apply=false;
  try{ apply=new URL(req.url,'http://localhost').searchParams.get('apply')==='1'; }catch(e){}
  syncSales(apply).then(r=>{
    res.writeHead(200,JSON_HEAD);
    res.end(JSON.stringify(r));
  }).catch(e=>{
    res.writeHead(500,JSON_HEAD);
    res.end(JSON.stringify({ok:false,error:e.message||String(e)}));
  });
}

// ---------- HTTP 服务 ----------
const server=http.createServer((req,res)=>{
  if(req.method==='POST'&&req.url.indexOf('/api/import')===0){ handleImport(req,res); return; }
  if(req.method==='POST'&&req.url.indexOf('/api/sync-sales')===0){ handleSyncSales(req,res); return; }
  if(req.url==='/api/health'){
    res.writeHead(200,JSON_HEAD);
    res.end(JSON.stringify({ok:true, token: KDOCS_TOKEN?true:false, ts:Date.now()}));
    return;
  }
  if(req.url==='/api/import-state'){
    res.writeHead(200,JSON_HEAD);
    try{ res.end(fs.readFileSync(path.join(ROOT,'ingest_state.json'))); }
    catch(e){ res.end('{}'); }
    return;
  }
  if(req.url==='/api/metrics'){
    if(cache){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(cache)); }
    else { res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'数据初始化中，请稍候'})); }
    return;
  }
  if(req.url==='/metrics.json'){
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
    try{ res.end(fs.readFileSync(metricsPath)); }catch(e){ res.end('{}'); }
    return;
  }
  if(req.url==='/vendor/echarts.min.js'){
    res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});
    try{ res.end(fs.readFileSync(path.join(ROOT,'vendor/echarts.min.js'))); }catch(e){ res.end('/*echarts missing*/'); }
    return;
  }
  if(req.url==='/'||req.url==='/index.html'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    try{ res.end(fs.readFileSync(path.join(ROOT,'index.html'))); }catch(e){ res.end('index.html missing'); }
    return;
  }
  if(req.url==='/dashboard.html'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    try{ res.end(fs.readFileSync(path.join(ROOT,'dashboard.html'))); }catch(e){ res.end('dashboard.html missing'); }
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

server.on('error',function(err){
  if(err.code==='EADDRINUSE'){ PORT++; console.log('端口被占用，尝试 '+PORT); server.listen(PORT,'0.0.0.0'); }
  else { console.error(err); process.exit(1); }
});

if(require.main===module){
server.listen(PORT,'0.0.0.0',()=>{
  console.log('✅ 进销存实时驾驶舱已启动，监听 0.0.0.0:'+PORT);
  console.log('   后台每 '+(REFRESH_MS/1000)+' 秒异步刷新动态数据；前端每30秒读缓存（不再卡顿）');
  // 预先载入本地快照，保证首屏秒开
  try{ const raw=fs.readFileSync(metricsPath,'utf8'); cache=JSON.parse(raw); console.log('📂 已载入本地快照，浏览器可立即开屏'); }catch(e){ console.log('（无本地快照，将等待首次后台拉取）'); }
  // 先加载引用数据，再做首次动态刷新，随后各自按间隔刷新
  refreshRef()
    .then(()=>refreshFlow())
    .catch(()=>{})
    .then(()=>{ refresh(); setInterval(refresh,REFRESH_MS); setInterval(refreshRef,REF_REFRESH_MS); setInterval(refreshFlow,REF_FLOW_MS); });
});
}

/* 导出聚合引擎给中继脚本(relay.mjs)复用；被 require 时不会启动 HTTP 服务 */
if(typeof module!=='undefined' && module.exports){
  module.exports={ buildMetrics, refreshRef, refreshFlow, callTool, call, dumpAll, LINK };
}
