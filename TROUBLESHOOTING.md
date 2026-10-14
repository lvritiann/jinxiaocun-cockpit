# 金小存看板 · 排错手册（TROUBLESHOOTING）

> 目标：不找 AI，3 分钟内自助定位。按「现象」对号入座。
> 架构速记：金山多维表(真源) → GitHub Actions 每15分钟跑 `relay.js` → AES加密成 `metrics.json` → GitHub Pages 托管 → 浏览器输口令解密显示。

---

## 1. 网页打不开 / 404

| 现象 | 原因 | 处理 |
|---|---|---|
| 刚上线就 404 | Pages 还在首次部署 | 等 1–2 分钟，刷新 |
| 一直 404 | Pages 的 Source 没设成「GitHub Actions」 | 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions** → Save |
| 域名对但空白页 | `index.html` 没部署成功 | 看仓库 Actions 页最近一次 `同步看板` 是否绿色通过 |
| 想改网址 | 默认 `https://lvritiann.github.io/jinxiaocun-cockpit/` | Settings → Pages → Custom domain 可绑自有域名 |

**自检**：打开 `https://github.com/lvritiann/jinxiaocun-cockpit/actions`，最近一次运行应为绿色 ✓。

---

## 2. 输口令进不去 / 一直转圈 / 提示解密失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 提示「口令不正确/解密失败」 | 口令打错，或**改过口令但站点没重部署** | 用当前 `RELAY_PASS` Secret 的值；改过口令必须重跑一次 sync（见下） |
| 能进但数据是旧的 | 浏览器缓存 | 强制刷新（Ctrl+F5）；脚本已用 `cache:'no-store'` |
| 想带口令直达（免每次输） | 支持 URL 片段注入 | 打开 `看板地址#k=你的口令`，会记住在浏览器本地 |

> **改口令的正确顺序**：仓库 Settings → Secrets → 改 `RELAY_PASS` → 去 Actions 手动 Run 一次 `同步看板`。因为站点上的 `metrics.json` 是用**旧口令**加密的，不重跑就解不开。

---

## 3. 数据和金山对不上 / 数字不动

| 现象 | 原因 | 处理 |
|---|---|---|
| 数字好几分钟不变 | 正常，定时每 15 分钟同步一次（GitHub 可能延迟数分钟） | 点网页「立即同步」或去 Actions 手动 Run |
| 「立即同步」点了没反应 | 浏览器没登录 GitHub，或 `GH_REPO` 没改对 | 去 Actions 页手动 Run workflow（最稳） |
| Actions 运行**红色失败** | 多半是 `KDOCS_TOKEN` 过期/失效 | 用新 token 更新 Secret `KDOCS_TOKEN`，再 Run |
| 某个站/某个品一直没有 | 金山表里就没这条数据 | 去多维表补；或站名写法不一致（见项目记忆的站名归一规则） |

**看失败原因**：Actions → 点红色那一次 → 展开 `运行中继` 步骤，红色日志即原因（常见：token 失效、金山接口超时）。

---

## 4. 没有浏览器 / 想在本机命令行看

```bash
cd deploy_cloud
# 方式A：直接跑中继，本地产出 site/
KDOCS_TOKEN=<你的token> RELAY_PASS=<口令> node relay.js
# 然后用任意静态服务器打开 site/index.html，例如：
npx serve site         # 或 python -m http.server -d site 8000
```
本机看的是同一套加密数据，输同样口令即可。

---

## 5. 加新站点 / 新商品 / 改统计口径

- **新站点/新商品**：在金山多维表（sheet9/10/11/31/36）补数据即可，下个同步周期自动进看板，**不用改代码**。
- **改站点名映射**：编辑 `server.js` 里的站点归一/解析逻辑，`git commit & push` 即随下次 sync 生效。
- **改指标算法**：编辑 `server.js` 的 `buildMetrics()`，本地 `node relay.js` 验证无误后 push。

---

## 6. 样式 / 告警阈值自定义

都在 `index.html` 顶部 `<script>` 的配置区：
- `var GH_REPO`：仓库地址（同步按钮用）
- `var READONLY`：`true`=只读看板；改 `false` 会显示导入入口（需后端，Pages 模式下无后端，慎改）
- 配色/阈值：在 `<style>` 的 `:root{}` 与看板参数处改数字，保存后 push。

---

## 7. 数据回滚

- **以金山为准回滚**：看板只是金山的镜像。改回金山表里的数据 → 手动 Run 一次 sync，看板即恢复。
- **撤销某次代码改动**：`git log` 找到提交 → `git revert <commit>` → push。
- **整个站点回到昨天**：Actions 页对应运行 → Re-run（会按当时代码重算，但数据以当前金山为准）。

---

## 8. 重新部署 / 换仓库 / 换口令（重打包等价物）

一条命令重跑（幂等，可反复执行）：
```bash
cd deploy_cloud
NODE_PATH="C:/Users/DELL/.workbuddy/binaries/node/workspace/node_modules" \
  GH_TOKEN=<classic令牌 repo+workflow> \
  RELAY_PASS=<新口令> \
  node deploy_gh.js
```
会依次：改 GH_REPO → 建/复用仓库 → 推 main → 设 Secrets → 开 Pages → 触发一次同步。

| 场景 | 做法 |
|---|---|
| 只更新数据 | 等自动同步，或 Actions 手动 Run |
| 改了口令 | 改 Secret `RELAY_PASS` + 手动 Run 一次 sync |
| 换了金山 token | 改 Secret `KDOCS_TOKEN` + 手动 Run 一次 |
| 改了前端/算法 | 改代码 → `git push` →（若涉及 index.html）会自动随下次 sync 进 site；若改了 server.js 需等 sync 重算 |
| 想下线 | 仓库 Settings → Pages → Source 选 None，或删仓库 |

---

## 9. 安全红线（务必遵守）

- `KDOCS_TOKEN`、`RELAY_PASS` **只存在 GitHub Secrets**，绝不写进代码、绝不提交、**绝不再抄进会分发的 .bat**（订货工具那次就是把令牌发得到处都是，别再犯）。
- 本机 `wps_token.txt`、`看板口令.txt` 已被 `.gitignore` 排除，不会上传；换机时单独保管。
- 怀疑泄漏：GitHub → Settings → Developer settings → 用到的令牌 → **Revoke**，换新令牌走第 8 节重部署。

---

## 10. 按日趋势图是「断的」/ 只有零星几天

**这是数据源现状，不是程序坏了。** 实测（2026-10-14）流水表真实分布：

| 月份 | 入库 | 出库 | 有记录天数 |
|---|---|---|---|
| 2026-07 | 58,839 件 | 74,997 件 | 1 天（整月累计导出） |
| 2026-08 | 0 | 0 | **整月无流水** |
| 2026-09 | 5,175 件 | 240 件 | 进货 5 天 / 出库 7 天 |

原因：7 月流水是**整月累计一次性导出**，日期全落在同一天，且已包含在 7/31 盘点锚点里；8 月至今没人补录，9 月只有零星补录。

**怎么处理**：
- 看板上「流水数据覆盖度」卡片会直接显示上述事实 + 「最新流水停在 YYYY-MM-DD，已 N 天无补录」，不用再猜。
- `M.daily` 里 `< 2026-08-01` 的记录带 `partial: true`，图表和表格只画不画的都不含它——因为按日粒度本身不可信。
- 缺口日期前端会自动补 0，**不会**把「没记录」误画成「连续」。

**要让它变准，唯一办法是补录流水**：把 8 月、9 月、10 月的进货/出库明细补进 sheet10/sheet11，下次 sync 趋势图自动变密。

## 11. 趋势图金额是 0 或偏小

金额 = 数量 × 字典价。取价规则：销售用 sheet7 售价列、进货/盘亏用进价列（W）。
按日行里的 `noPrice` 字段 = 该行没查到价的行数。若 `noPrice` 明显偏大，说明条码在 sheet7 里对不上（字典缺该条码或条码带空格），趋势图会自动降级为画「件数」而非「金额」。

## 12. 常见编码坑（自己改代码时注意）

- `site/metrics.json` 是 **base64 字符串**（`iv[12]+tag[16]+密文` 再整体 base64），验签要 `Buffer.from(file,'utf8'),'base64'`，直接按二进制读会解不开、报 `Unsupported state or unable to authenticate data`——**这通常只是你读法错了，不是口令错**。
- `parseDate` / `fmtD` 是 `const`，声明顺序有 TDZ 约束（我在加按日趋势时踩过）。新增聚合块若要用，放到「日期工具」之后或提到它前面，别在下方重复声明。
- 改完 `server.js` 一定 `node --check server.js`；改完 `index.html` 要把内联 `<script>`抠出来 `node --check` 一遍。

---

## 13. 上线实战踩过的三个坑（2026-10-14 已修，勿重犯）

**① `git push` 报 `remote: invalid credentials`，但令牌明明有效**
GitHub 的两套接口认不同的凭据格式：REST API 认 `Authorization: Bearer <token>`，而 **git smart-HTTP 只认 `Authorization: Basic base64("x-access-token:"+token)`**。用 Bearer 推代码必失败，但同一个令牌调API 完全正常 —— 极具迷惑性。
已修：`deploy_gh.js` 用 Basic。

**② 设 Actions Secret 报 422 `does not match /^(?:[A-Za-z0-9+/]{4})*.../`**
`libsodium-wrappers` 的 `from_base64()` / `to_base64()` **默认走 base64url 变体**（输出 `-` `_`、不带 `=` 补位），而 GitHub 只收**标准 base64**（`+` `/` `=`）。另外 GitHub 返回的公钥本身含 `+` `/`，用默认变体解析会抛 `invalid input`。
已修：**两处都要显式传 `sodium.base64_variants.ORIGINAL`**。
另注：Secret 写入成功返回 **201（新建）或 204（覆盖）**，只认 204 会把成功误报成失败。

**③ 开 Pages 报 422 `Your current plan does not support GitHub Pages`**
**GitHub 免费账号的 Pages 只支持公开仓库**，私有仓库必报这句（与账号是否支持 Pages 无关 —— 同账号的`dinghuo-taizhang` 公开仓就正常跑）。
已修：脚本检测该报错时自动把仓库转公开。
安全性说明：仓库内**不含任何明文凭据**（`wps_token.txt`、`看板口令.txt`、`metrics.json`、`site/` 均已 gitignore），对外可见的 `metrics.json` 是 AES-256-GCM 密文，无口令解不开。

## 14. 线上验收：`verify_online.js`

上线后跑一下，直接从公网拉产物 + 口令解密 + 核对关键指标：

```bash
node verify_online.js "<看板口令>"
```

会依次校验：首页可访问 / echarts 加载 / metrics.json 可解密 / 关键指标 / 错口令被拒。
**改完前端或算法后重跑这个脚本，比开浏览器点一遍可靠得多。**

---

## 15. 线上打开是**空白页**（2026-10-14 踩过，最易犯）

**症状**：GitHub Pages 打开一片空白，控制台报 `/api/metrics 404`。

**根因**：项目里有**两份 index.html**，搞混了：

| 位置 | 版本 | 取数方式 | 用在哪 |
|---|---|---|---|
| `项目根目录/index.html` | **本地服务版** | `fetch('/api/metrics')` | 本地 8899 起 Node 服务 |
| `deploy_cloud/index.html` | **静态口令版** | `fetch('./metrics.json')` + Web Crypto 解密 | **Pages 线上** |

把本地服务版传上 Pages → 它去请求 `/api/metrics`，而 Pages 是纯静态托管、没有后端 → 404 → 空白页。

**铁律：这两份文件永远不要互相覆盖。** 要把本地的新功能同步到线上，正确做法是**只移植改动的函数**，而不是整份覆盖。

**自查（部署后必跑）**：
```bash
node verify_online.js "<口令>"
# 再确认线上 HTML 是静态版：
curl -s https://<user>.github.io/<repo>/ | grep -c "metrics.json"   # 应 >0
curl -s https://<user>.github.io/<repo>/ | grep -c "/api/metrics"  # 应为 0
```

**另一个同源坑**：`deploy_cloud/index.html` 里 echarts 必须用**相对路径** `./vendor/echarts.min.js`。
若写成 `/vendor/echarts.min.js`（绝对路径），在 Pages 子路径部署下会跑到 `lvritiann.github.io/vendor/` → 404 → 所有图表空白。

---

## 16. 页面能打开，但「全部没有数据」/ 一片空白（比15 节更隐蔽）

**症状**：页面出得来、解密也成功，但五个页签都是空的（或整个首屏空白）。

**根因（2026-10-14 实际踩到）**：**一个图表的异常冒泡到 `render()`，把整个首屏渲染打断。**
具体是 `new echarts.graphic.LinearGradient(...)` —— echarts 脚本尚未就绪 / CDN 没加载时，
`echarts.graphic` 为 undefined → TypeError → 一路冒泡 → `render()` 中断 →
后续所有页签都没渲染，同时 `refreshData` 里 `M = data` 之后的中断还会让页面卡在锁屏。
**用户观感：什么数据都没有。**

**已落地的三层防护（别删）**：
1. `setChart()` 整段 `try/catch` —— 单个图表失败只在容器内显示提示，**不再向上冒泡**
2. `renderPanel()` 每个页签独立 `try/catch` —— 一页出错不影响其余页
3. `grad(c1,c2)` 助手 —— `echarts.graphic` 缺失时退回纯色，不抛异常

**同类脆弱点（都已包 try，别裸调）**：
- `new URLSearchParams(...)`：旧浏览器 / 部分安卓 WebView 里不存在，裸调会中断自动解锁
- `refreshData` 的失败提示要**区分「口令错」与「取数失败」**，笼统写"口令错误或无网络"会让人反复输错口令

**离线自查（不用开浏览器，推荐）**：
```bash
node verify_online.js "<口令>"    # 线上产物 + 解密 + 错口令拒绝
node verify_tabs.js  "<口令>"    # 逐页签渲染体检；默认故意不给 echarts，验证最坏情况
node debug_render.js "<口令>"    # 输出真实异常栈 + 17 项数据字段体检
```
`verify_tabs.js` 在 echarts 完全缺失下仍应显示「五个页签全部正常渲染」——这就是防护生效的证据。

> 修前端后**务必跑 `verify_tabs.js`**：它能抓到浏览器里看不出来的渲染中断（本例就是靠它抓到的）。
