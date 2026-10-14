#!/usr/bin/env node
/**
 * 金小存看板 · 一键上线到 GitHub（无服务器架构）
 *
 * 一条命令把 deploy_cloud/ 推到 GitHub 并开好 Pages：
 *   1) 取 owner（GET /user）
 *   2) 把 index.html 的 GH_REPO 占位改成 owner/repo（先改后推，保证部署即用）
 *   3) 建私有仓库（幂等：已存在则复用）
 *   4) 推 main 分支（token 只走 http.extraHeader，不落 .git/config）
 *   5) 设 Actions Secrets：KDOCS_TOKEN + RELAY_PASS（libsodium 封装加密；缺库则打印手动步骤）
 *   6) 开启 Pages，Source = GitHub Actions
 *   7) 手动触发一次 sync.yml
 *
 * 运行：
 *   GH_TOKEN=<classic令牌,勾repo+workflow> node deploy_gh.js
 *   # 可选：RELAY_PASS=<看板口令>（不给则自动生成强口令并打印/存档）
 *   # 可选：KDOCS_TOKEN=<金山token>（不给则读同目录 wps_token.txt）
 *   # 可选：REPO_NAME=jinxiaocun-cockpit
 *
 * ⚠️ 需要 libsodium-wrappers 才能自动设 Secret。已安装在隔离工作区时：
 *   NODE_PATH="C:/Users/DELL/.workbuddy/binaries/node/workspace/node_modules" GH_TOKEN=... node deploy_gh.js
 *   未装也能跑——会自动跳过自动设 Secret，改为打印网页手动填法。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const REPO_NAME = process.env.REPO_NAME || 'jinxiaocun-cockpit';
const GH_TOKEN = (process.env.GH_TOKEN || '').trim();
const DESC = 'JinXiaoCun inventory cockpit (Kdocs + Actions relay + Pages passcode board)';

// ---------- 小工具 ----------
function log(s){ console.log(s); }
function ok(s){ console.log('  ✅ ' + s); }
function warn(s){ console.log('  ⚠️  ' + s); }
function fail(s){ console.log('  ❌ ' + s); }

function ghApi(method, urlPath, body){
  return new Promise((resolve, reject)=>{
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host:'api.github.com', port:443, path:urlPath, method,
      headers:{
        'Authorization':'Bearer '+GH_TOKEN,
        'Accept':'application/vnd.github+json',
        'User-Agent':'jinxiaocun-deploy',
        ...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})
      }
    }, res=>{
      let out=''; res.setEncoding('utf8');
      res.on('data',c=>out+=c);
      res.on('end',()=>{
        let json=null; try{ json=out?JSON.parse(out):null; }catch(_){}
        resolve({status:res.statusCode, json, raw:out});
      });
    });
    req.on('error',reject);
    req.setTimeout(30000, ()=>req.destroy(new Error('timeout')));
    if(payload) req.write(payload);
    req.end();
  });
}

function git(args, opts){
  return execFileSync('git', args, {cwd:ROOT, encoding:'utf8', stdio:['ignore','pipe','pipe'], ...(opts||{})});
}

function readKdocsToken(){
  if(process.env.KDOCS_TOKEN) return process.env.KDOCS_TOKEN.trim();
  try{
    const raw=fs.readFileSync(path.join(ROOT,'wps_token.txt'),'utf8');
    const m=raw.match(/[A-Za-z0-9+/]{80,}={0,2}/);
    if(m) return m[0];
  }catch(_){}
  return '';
}

function genPass(){
  // 16 位强口令：大小写+数字，去掉易混字符
  const abc='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b=crypto.randomBytes(16);
  let s=''; for(let i=0;i<16;i++) s+=abc[b[i]%abc.length];
  return s;
}

// libsodium 可选加载
let sodium=null;
try{ sodium=require('libsodium-wrappers'); }catch(_){ sodium=null; }

async function setSecret(owner, repo, name, plaintext){
  const pk=await ghApi('GET',`/repos/${owner}/${repo}/actions/secrets/public-key`);
  if(pk.status!==200||!pk.json||!pk.json.key){ throw new Error('取公钥失败: '+pk.status+' '+pk.raw.slice(0,120)); }
  await sodium.ready;
  const binsec=sodium.from_string(plaintext);
  // ⚠️ 两处都必须显式指定 base64_variants.ORIGINAL：
  //   1) from_base64 —— GitHub 公钥含 '+' '/'，libsodium 默认变体解析会抛 "invalid input"
  //   2) to_base64   —— 默认输出的是 base64url（'-' '_'），而 GitHub 只收标准 base64（'+' '/' '='补位），
  //      用默认值会以 422 "does not match /^(?:[A-Za-z0-9+/]{4})*.../" 被拒
  const enc=sodium.crypto_box_seal(binsec, sodium.from_base64(pk.json.key, sodium.base64_variants.ORIGINAL));
  const encrypted_value=sodium.to_base64(enc, sodium.base64_variants.ORIGINAL);
  const r=await ghApi('PUT',`/repos/${owner}/${repo}/actions/secrets/${name}`,{encrypted_value, key_id:pk.json.key_id});
  // GitHub 建新 Secret 返 201，覆盖已有返 204，两者都算成功
  if(r.status===201||r.status===204) return r.status;
  throw new Error('写入返回 '+r.status+' '+r.raw.slice(0,160));
}

async function main(){
  log('=== 金小存看板 · 一键上线 ===');
  if(!GH_TOKEN){ fail('缺少 GH_TOKEN（classic 令牌，需 repo + workflow 权限）'); process.exit(1); }
  const tkind = GH_TOKEN.startsWith('ghp_') ? 'classic' : (GH_TOKEN.startsWith('github_pat_') ? 'fine-grained' : 'unknown');
  log('令牌类型：'+tkind+'（前缀 '+GH_TOKEN.slice(0,7)+'…）');
  if(tkind==='fine-grained'){ warn('这是细粒度令牌，多半建不了仓库/设不了 Secret；建议用 classic（勾 repo+workflow）。仍将继续尝试…'); }

  const kdocs=readKdocsToken();
  if(!kdocs){ fail('取不到 KDOCS_TOKEN（环境变量或 wps_token.txt 都没有）'); process.exit(1); }
  ok('KDOCS_TOKEN 就绪（'+kdocs.length+' 字符）');

  let relayPass=process.env.RELAY_PASS||'';
  let passGenerated=false;
  if(!relayPass){ relayPass=genPass(); passGenerated=true; ok('未提供口令，已自动生成强口令'); }

  // 1) owner
  log('\n[1/7] 取账号信息…');
  const me=await ghApi('GET','/user');
  if(me.status!==200||!me.json||!me.json.login){ fail('GH_TOKEN 无效或无权限：'+me.status+' '+me.raw.slice(0,160)); process.exit(1); }
  const owner=me.json.login;
  ok('属主 = '+owner+'，目标仓库 = '+owner+'/'+REPO_NAME);

  // 2) 先改 GH_REPO 再推
  log('\n[2/7] 写死 index.html 的 GH_REPO…');
  const idxPath=path.join(ROOT,'index.html');
  let idx=fs.readFileSync(idxPath,'utf8');
  const target=owner+'/'+REPO_NAME;
  const before=idx;
  idx=idx.replace(/var GH_REPO\s*=\s*'[^']*'/, "var GH_REPO = '"+target+"'");
  if(idx!==before){ fs.writeFileSync(idxPath, idx, 'utf8'); ok('GH_REPO → '+target); }
  else ok('GH_REPO 已是 '+target+'（无需改）');

  // 3) 建仓（幂等）
  log('\n[3/7] 建私有仓库…');
  let repo=await ghApi('GET','/repos/'+owner+'/'+REPO_NAME);
  if(repo.status===200){ ok('仓库已存在，复用'); }
  else{
    const cr=await ghApi('POST','/user/repos',{name:REPO_NAME, private:true, description:DESC, auto_init:false});
    if(cr.status===201){ ok('已建私有仓库 '+owner+'/'+REPO_NAME); }
    else if(cr.status===422){ warn('仓库可能已存在(422)，继续'); }
    else if(cr.status===403){ fail('无权建仓库(403)：令牌缺 Administration/建仓权限。请换 classic 令牌(勾 repo+workflow)后重试。'+cr.raw.slice(0,160)); process.exit(1); }
    else{ fail('建仓失败 '+cr.status+' '+cr.raw.slice(0,200)); process.exit(1); }
  }

  // 4) 推 main
  log('\n[4/7] 推送 main 分支…');
  try{
    try{ git(['remote','remove','origin']); }catch(_){}
    git(['remote','add','origin','https://github.com/'+owner+'/'+REPO_NAME+'.git']);
    git(['branch','-M','main']);
    // ⚠️ 必须用 Basic 而不是 Bearer：GitHub 的 REST API 认 Bearer，但 git smart-HTTP 只认 Basic，
    //    用 Bearer 会报 "remote: invalid credentials"。token 只走 extraHeader，不落 .git/config。
    const basic=Buffer.from('x-access-token:'+GH_TOKEN,'utf8').toString('base64');
    git(['-c','http.extraHeader=Authorization: Basic '+basic,'push','-u','origin','main','--force']);
    ok('已推送到 '+owner+'/'+REPO_NAME+' (main)');
  }catch(e){
    fail('git push 失败：'+(e.stderr?e.stderr.toString():(e.message||e)));
    fail('常见原因：令牌缺 workflow 权限时推 .github/workflows 会被拒；或凭据方案不对——'
      +'GitHub git 接口只认 Authorization: Basic base64(x-access-token:令牌)，用 Bearer 必报 invalid credentials。');
    process.exit(1);
  }

  // 5) Secrets
  log('\n[5/7] 设置 Actions Secrets…');
  if(sodium){
    try{
      let s1=await setSecret(owner,REPO_NAME,'KDOCS_TOKEN',kdocs); ok('KDOCS_TOKEN 已设置 ('+s1+')');
      let s2=await setSecret(owner,REPO_NAME,'RELAY_PASS',relayPass); ok('RELAY_PASS 已设置 ('+s2+')');
    }catch(e){
      warn('自动设 Secret 失败：'+(e.message||e)+' → 请按下方手动填');
      printManualSecrets(owner,REPO_NAME,kdocs,relayPass);
    }
  }else{
    warn('未装 libsodium-wrappers，无法自动设 Secret → 请按下方手动填');
    printManualSecrets(owner,REPO_NAME,kdocs,relayPass);
  }

  // 6) 开 Pages（Source = GitHub Actions）
  log('\n[6/7] 开启 GitHub Pages…');
  const pg=await ghApi('POST','/repos/'+owner+'/'+REPO_NAME+'/pages',{build_type:'workflow'});
  if(pg.status===201||pg.status===200||pg.status===409){ ok('Pages 已配置为「GitHub Actions」部署 ('+pg.status+')'); }
  else if(pg.status===422&&/plan does not support/i.test(pg.raw||'')){
    // 免费账号的 Pages 只支持**公开仓库**，私有库会 422。此时把仓库转公开再开 Pages。
    // 安全性：仓库里不含明文凭据（wps_token.txt/看板口令.txt 均已 gitignore），
    //   且真正的数据 metrics.json 是 AES-256-GCM 加密的，没有口令解不开。
    warn('Pages 报 422：GitHub 免费账号不支持「私有仓库 + Pages」→ 自动把仓库转为公开');
    const vis=await ghApi('PATCH','/repos/'+owner+'/'+REPO_NAME,{private:false});
    if(vis.status===200){ ok('仓库已转为公开（代码可见，数据仍为密文）'); }
    else{ fail('转公开失败 '+vis.status+' '+vis.raw.slice(0,160)+' → 请到 Settings→General→Danger Zone 手动改，或忽略 Pages 只用本地看板'); return; }
    const pg2=await ghApi('POST','/repos/'+owner+'/'+REPO_NAME+'/pages',{build_type:'workflow'});
    if(pg2.status===201||pg2.status===200||pg2.status===409){ ok('Pages 已配置为「GitHub Actions」部署 ('+pg2.status+')'); }
    else warn('转公开后仍失败 '+pg2.status+' '+pg2.raw.slice(0,160)+'（可去 Settings→Pages 手动把 Source 设为 GitHub Actions）');
  }
  else{ warn('Pages 设置返回 '+pg.status+' '+pg.raw.slice(0,160)+'（可能需在 Settings→Pages 手动把 Source 设为 GitHub Actions）'); }

  // 7) 触发一次同步
  log('\n[7/7] 手动触发一次 sync 工作流…');
  const disp=await ghApi('POST','/repos/'+owner+'/'+REPO_NAME+'/actions/workflows/sync.yml/dispatches',{ref:'main'});
  if(disp.status===204){ ok('已触发，Actions 正在拉金山并部署（约 1-2 分钟）'); }
  else{ warn('触发返回 '+disp.status+' '+disp.raw.slice(0,160)+'（可在 Actions 页手动 Run workflow）'); }

  // 汇总
  const pageUrl='https://'+owner+'.github.io/'+REPO_NAME+'/';
  log('\n================ 上线完成 ================');
  log('看板地址：'+pageUrl);
  log('仓库地址：https://github.com/'+owner+'/'+REPO_NAME);
  if(passGenerated){
    log('\n★ 自动生成的查看口令（请抄走，勿外泄）：');
    log('   '+relayPass);
    try{ fs.writeFileSync(path.join(ROOT,'看板口令.txt'),
      '金小存看板查看口令：'+relayPass+'\n看板地址：'+pageUrl+'\n（此文件已被 .gitignore 排除，不会上传；改口令=改仓库 Secret RELAY_PASS 后重跑 sync）\n','utf8');
      log('   （已存到 deploy_cloud/看板口令.txt，已设 gitignore 不入库）');
    }catch(_){}
  }
  log('\n提示：首次打开若 404，等 1-2 分钟 Pages 部署完成即可；输口令才能看到数据（AES 加密）。');
}

function printManualSecrets(owner,repo,kdocs,relayPass){
  log('  —— 手动设置（网页）——');
  log('  打开 https://github.com/'+owner+'/'+repo+'/settings/secrets/actions');
  log('  New repository secret，加两条：');
  log('    Name=KDOCS_TOKEN   Value='+kdocs);
  log('    Name=RELAY_PASS    Value='+relayPass);
}

main().catch(e=>{ console.error('❌ 部署异常:', e&&e.message||e); process.exit(1); });
