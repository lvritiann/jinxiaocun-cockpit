# 金小存 · 高速延长加油站进销存驾驶舱（无服务器架构）

进销存（进 / 销 / 存 / 盘）四条主线的实时驾驶舱。**无服务器、无常驻进程**——完全对齐「订货工具」项目的架构：

```
金山在线多维表 (Kdocs)  ──真源──▶  GitHub Actions 中继(relay.js)
                                         │  ① 拉数据 + 算指标
                                         │  ② AES-256-GCM 加密
                                         ▼
                                   site/ (index.html + metrics.json加密 + echarts)
                                         │  upload-pages-artifact
                                         ▼
                               GitHub Pages 静态看板（浏览器输口令解密）
```

- **数据库** = 金山在线多维表（唯一真源，靠 `KDOCS_TOKEN` 直连）
- **读链路** = GitHub Actions 每 15 分钟跑 `relay.js` → 拉金山、算指标、AES 加密 → 部署到 Pages（**没有常驻服务器**）
- **看板** = 单文件静态 `index.html`，托管在 GitHub Pages，浏览器端输口令用 Web Crypto 解密
- **写回（v2）** = 网页「立即同步 / 写回」按钮触发 `workflow_dispatch` → Actions 调 AirScript 写回金山（本期只读先行，暂未开放）

> 为什么必须有无 Origin 中继？浏览器直连金山会被 403（无 CORS 头）。所以所有金山读写都走 Actions 服务端（无 Origin 头），浏览器只碰 GitHub。

## 数据保密

- `metrics.json` 在产出时用 `RELAY_PASS` 派生密钥做 **AES-256-GCM** 加密（`iv[12] + authTag[16] + 密文`，base64）。
- 口令不对 → GCM 校验失败 → 解不开，数据不公开。即使 Pages 是公开 URL，看到的也只是密文。
- 金山 token（`KDOCS_TOKEN`）和口令（`RELAY_PASS`）**只存在仓库 Secrets**，绝不进代码 / 不进 git 历史。

## 目录结构

```
server.js                 # 聚合引擎（拉金山多维表 + 算指标）。被 relay.js require 时不会启动 HTTP 服务
relay.js                  # 无服务器中继：复用 server.js 引擎 → 加密 → 产出 site/
index.html                # 静态口令看板（READONLY 模式，隐藏导入 UI）
vendor/echarts.min.js     # 图表库（本地，免 CDN）
.github/workflows/sync.yml# 每 15 分钟 + 手动触发，跑 relay.js 并部署 Pages
package.json              # 仅占位（零第三方依赖）
wps_token.example.txt     # （已删除）旧 PaaS 占位，现改用 Secrets
railway.json / render.yaml# （已删除）旧 PaaS 配置
```

> 本项目**零 npm 依赖**：server.js / relay.js 只用 Node 内置模块，CI 无需 `npm install`。

## 本地运行（调试用，可选）

```bash
export KDOCS_TOKEN=<你的token>
export RELAY_PASS=<看板口令>
node relay.js            # 产出 ./site/，本地用任何静态服务器打开 site/index.html 即可看
```

## 上线步骤（GitHub，需仓库管理员权限 / PAT）

1. 创建**私有**仓库（公开也可，数据已加密），例如 `jinxiaocun-cockpit`。
2. 仓库 **Settings → Secrets and variables → Actions** 添加两个 Secret：
   - `KDOCS_TOKEN` = 金山 WPS access token
   - `RELAY_PASS`  = 看板查看口令（分发给查看者）
3. 推送本仓库到 `main` 分支（含 `.github/workflows/sync.yml`）。
4. 仓库 **Settings → Pages → Build and deployment → Source 选「GitHub Actions」**。
5. 到 **Actions** 页手动跑一次 `同步看板`，成功后拿到 Pages URL（如 `https://<owner>.github.io/jinxiaocun-cockpit/`）。
6. 把 `index.html` 里的 `GH_REPO` 改成 `你的owner/jinxiaocun-cockpit`，重推一次，网页「立即同步」按钮即可触发手动刷新。

## 已知限制（本期只读先行）

- 不开放写回（导入 / 销售写回）— 保留在本机执行（`ingest_orders.py` / `ingest_jituan.py`，非本仓库）。
- 「立即同步」按钮依赖浏览器 GitHub 登录态；若未登录可在 Actions 页手动 Run workflow。
- 定时刷新受 GitHub 调度排队影响，可能比 15 分钟略晚，属正常。
