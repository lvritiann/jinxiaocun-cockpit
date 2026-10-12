# 金小存 · 高速延长加油站进销存驾驶舱（云端部署版）

进销存（进/销/存/盘）四条主线的实时驾驶舱。后端 Node.js 直连金山文档 API（mcp-center），
无需本机 kdocs-cli / 系统密钥链；前端为单页看板（ECharts）。

## 目录结构

```
server.js              # 后端：聚合金山多维表 + 托管前端 + 写回 SKU 明细
index.html             # 前端看板
vendor/echarts.min.js  # 图表库（本地，免 CDN）
package.json           # start: node server.js
metrics.json           # 服务端缓存的聚合指标（运行时生成）
wps_token.example.txt  # token 占位说明（真实 token 见 wps_token.txt，已 .gitignore 排除）
railway.json           # Railway 部署配置
render.yaml            # Render 部署配置
```

## 运行依赖

- Node.js（任意 18+ 版本，本项目零第三方依赖，仅用内置模块）
- 一个有效的 WPS / 金山文档 access token（环境变量 `KDOCS_TOKEN` 或项目根 `wps_token.txt`）

## 本地运行

```bash
# 方式一：token 放环境变量
export KDOCS_TOKEN=<你的token>
node server.js

# 方式二：token 放 wps_token.txt（已被 .gitignore 排除，不会入库）
node server.js
```

启动后访问 `http://localhost:8899`（或 `process.env.PORT` 指定端口）。

## 部署到 PaaS（Railway / Render）

1. 把本仓库推到 GitHub（见下方「推送到 GitHub」）。
2. 在 Railway 或 Render 新建 Project，关联该 GitHub 仓库。
3. **必须**在后台设置环境变量 `KDOCS_TOKEN=<你的真实 token>`（token 不会进仓库）。
4. 部署：Railway 读 `railway.json`、Render 读 `render.yaml`，均执行 `node server.js`。
5. 平台分配域名（如 `xxx.railway.app` / `xxx.onrender.com`），即 24/7 在线地址。

> 免费额度提示：Railway 免费层需绑定付款方式、有用量上限；Render 免费层闲置 15 分钟会休眠（下次访问冷启动数秒）。
> 若要求「零休眠、最稳」，建议 Railway 付费档或自有服务器。

## 接口

- `GET  /`                前端看板
- `GET  /api/health`      健康检查（PaaS 健康探针）
- `GET  /api/metrics`     聚合指标 JSON
- `POST /api/sync-sales?apply=1`  把中转表 SKU 明细写回金山「出库流水」

## 已知限制（PaaS 环境）

- `/api/import`（订货台账 / 服务集团导入）依赖本机 Python + 本地 xlsx 源文件，
  在 PaaS 上不可用。该操作为月度人工任务，请保留在本机执行
  （`ingest_orders.py` / `ingest_jituan.py`，位于项目根目录，非本仓库内容）。
- `wps_token.txt` 含密钥，已被 `.gitignore` 排除，**切勿提交到公开仓库**。
