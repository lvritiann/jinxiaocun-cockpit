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
