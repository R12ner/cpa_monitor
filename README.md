# CPA Monitor

一个面向 CPA 反代工具的可用额度监测站点，目标是部署到 Cloudflare 上，像探针一样集中查看多个 CPA 实例、认证文件、账号可用性和额度状态。

当前实现使用 Cloudflare Pages + Pages Functions：

- `public/`：静态前端，复用根目录 `index.html` 的 Cyber Terminal 风格。
- `functions/api/[[path]].js`：后端代理 API，负责读取 CPA secrets、拉取认证文件、执行 usage 检测。
- `sample/cpa_auth_manager`：原 Streamlit 检测工具，仅作为 CPA 接口参考。

## 目标能力

- 支持部署到 Cloudflare Pages / Workers。
- 不在浏览器暴露 CPA `access_key`，由 Worker 后端代请求 CPA 管理接口。
- 支持监测单台或多台 CPA 服务器，便于复用到其他服务器。
- 拉取认证文件列表，展示 provider、auth_index、disabled、账号 ID、检测状态。
- 调用 CPA `api-call` 检测 Codex / ChatGPT usage 状态，识别 401 失效、2xx 正常、非 2xx 异常、网络错误。
- 展示整体统计、异常列表、最近检测时间、延迟、失败原因。
- 保留人工刷新能力，并预留 Cloudflare Cron 定时检测能力。

## 推荐架构

```text
Browser
  |
  | Static UI, reused from index.html style
  v
Cloudflare Pages
  |
  | /api/*
  v
Cloudflare Worker
  |
  | Authorization: Bearer <CPA_ACCESS_KEY>
  v
CPA Server(s)
  |
  | /v0/management/auth-files
  | /v0/management/api-call
  v
ChatGPT usage endpoint through CPA auth file
```

## 环境要求

- Node.js 20+
- npm 10+
- Cloudflare 账号
- Wrangler CLI
- 一个或多个 CPA 实例管理地址
- 每个 CPA 实例对应的管理访问密钥

安装依赖：

```bash
npm install
```

本地开发：

```bash
npm run dev
```

部署：

```bash
npm run deploy
```

## 配置方式

本项目优先使用 Cloudflare secrets，避免把 CPA 地址和密钥写入仓库。`wrangler.toml` 不写 `[vars]`，这样 GitHub 连接 Cloudflare Pages 的创建页面不会自动列出一堆变量。

Cloudflare Pages 创建项目时可以先不填环境变量。创建完成后进入 `Settings -> Environment variables`，只添加加密变量：

```bash
CPA_INSTANCES_JSON=[{"id":"main","name":"Main CPA","baseUrl":"https://api.omiku.de","accessKey":"replace-me","enabled":true}]
ADMIN_PASSWORD=change-this-password
```

`MONITOR_TARGET_URL`、`CHECK_TIMEOUT_MS`、`CHECK_CONCURRENCY`、`SKIP_DISABLED`、`PUBLIC_CHECK_CACHE_SECONDS` 代码里有默认值，不配置也能运行。

未登录用户也可以点击页面上的 Codex 额度检测按钮。公开检测只使用 Cloudflare 环境变量/secret 中配置的 CPA，不会发送浏览器本地添加的端点。公开检测默认有 60 秒缓存，短时间重复点击会直接返回缓存结果。需要调整时可配置：

```bash
PUBLIC_CHECK_CACHE_SECONDS=60
```

本地开发时手动创建 `.dev.vars`。这个文件已被 `.gitignore` 忽略，不会上传到 GitHub，也不会被 Cloudflare 创建页面扫描。推荐用分字段配置，最不容易被引号或换行影响：

```bash
CPA_INSTANCE_ID=main
CPA_INSTANCE_NAME=Main CPA
CPA_BASE_URL=https://cpa.example.com
CPA_ACCESS_KEY=replace-me
ADMIN_PASSWORD=change-this-password
MONITOR_TARGET_URL=https://chatgpt.com/backend-api/wham/usage
CHECK_TIMEOUT_MS=30000
CHECK_CONCURRENCY=8
SKIP_DISABLED=true
```

多实例也可以用 `CPA_INSTANCES_JSON`，但在 `.dev.vars` 中建议保持单行：

```bash
CPA_INSTANCES_JSON=[{"id":"main","name":"Main CPA","baseUrl":"https://cpa.example.com","accessKey":"replace-me","enabled":true},{"id":"backup","name":"Backup CPA","baseUrl":"https://cpa2.example.com","accessKey":"replace-me","enabled":true}]
```

如果想保留格式化 JSON，可以先把 JSON 做 base64，然后配置 `CPA_INSTANCES_JSON_B64`。

Cloudflare：

page部署
加密变量：
CPA_INSTANCE_ID=main
CPA_INSTANCE_NAME=Main CPA
CPA_BASE_URL=https://你的-cpa地址
CPA_ACCESS_KEY=你的CPA管理密钥
ADMIN_PASSWORD=你的后台密码

## API

前端只请求同域 `/api/*`，不会直接访问 CPA 管理接口。

- `GET /api/health`：Worker 自检。
- `GET /api/config`：返回脱敏配置和实例列表。
- `GET /api/instances`：返回脱敏实例列表。
- `GET /api/auth-files?instance=<id>`：拉取认证文件列表。
- `POST /api/check`：检测单个文件，请求体 `{ "instanceId": "main", "fileId": "xxx" }`。
- `POST /api/check-all`：检测全部或指定实例，请求体 `{ "instanceId": "main" }`，空值表示全部。
- `GET /api/snapshot?mode=list|check`：返回列表快照，`mode=check` 会执行检测。

统一响应：

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "meta": {
    "requestId": "uuid",
    "checkedAt": "2026-05-31T00:00:00.000Z",
    "durationMs": 123
  }
}
```

## 文档

- [需求分析](docs/requirements-analysis.md)

## sample 参考

`sample/cpa_auth_manager` 是 Streamlit 版失效认证文件检测与清理面板，已验证的连接逻辑包括：

- `GET /v0/management/auth-files`
- `POST /v0/management/api-call`
- `PATCH /v0/management/auth-files/status`
- `DELETE /v0/management/auth-files?name=<file_id>`

本监测站第一阶段只做只读监测，不默认提供禁用或删除能力。危险操作后续如需加入，应单独做权限、确认和审计。

## 开发原则

- 前端复用现有 `index.html` 的布局、配色、面板和终端风格。
- Worker 作为后端代理层，集中处理密钥、超时、错误归一化和跨实例配置。
- API 返回结构保持稳定，前端不直接依赖 CPA 原始字段。
- 所有网络请求设置超时，单实例失败不能拖垮整页。
- 默认只读，避免监测站误触发破坏性操作。

## 检测状态

- `ok`：usage 请求返回 2xx。
- `invalid_401`：usage 请求返回 401。
- `limited_or_forbidden`：usage 请求返回 403 或 429。
- `upstream_error`：usage 请求返回 5xx。
- `check_error`：超时、响应字段缺失、JSON 异常或其他错误。
- `skipped`：disabled 文件被配置跳过。

## 本地浏览器缓存

前端会把最近一次文件列表和检测结果保存到浏览器 `localStorage`：

- 缓存 key：`cpa-monitor:snapshot:v2`
- 筛选项 key：`cpa-monitor:filters:v2`
- 页面刷新时优先使用本地缓存，10 分钟内不会自动重新请求 CPA。
- 点击检测图标会强制检测 Codex 额度，并更新缓存。
- 实例、状态、disabled、搜索、只看异常、额度展示模式会在页面刷新后保留。

如果需要清空缓存，在浏览器控制台执行：

```js
localStorage.removeItem("cpa-monitor:snapshot:v2")
localStorage.removeItem("cpa-monitor:filters:v2")
```

## 额度进度条

检测接口会从 Codex usage 真实响应中提取额度字段并返回 `quotaBars`。支持常见结构：

- `percent` / `percentage` / `used_percent`
- `used` + `limit`
- `remaining` + `limit`
- `reset_at` / `resetAt` / `resets_at`

如果 CPA 或 ChatGPT usage 返回体中没有明确额度字段，页面会显示检测状态，但不会强造进度条。

## 跨浏览器持久化后台设置

后台里的显示组件、窗口顺序、最小化状态、后台添加的 CPA 端点默认会先保存在浏览器本地。要让不同浏览器、不同设备登录后台后看到同一套设置，需要在 Cloudflare 绑定 KV。

Cloudflare Pages 网页端操作：

如果 Pages 项目提示“此项目的绑定通过 wrangler.toml 进行管理”，网页端的添加按钮会被锁住。这时不要在网页端绑定，按下面流程走 Git 配置：

1. 进入 `Workers & Pages -> KV`，创建一个 KV namespace，例如 `cpa-monitor-settings`。
2. 打开这个 KV namespace，复制它的 Namespace ID。
3. 在本地项目运行：`npm run kv:bind -- <KV_NAMESPACE_ID>`。
4. 提交并推送更新后的 `wrangler.toml` 到 GitHub。
5. Cloudflare Pages 重新部署后会自动应用 `CPA_MONITOR_KV` 绑定。

也可以用 Wrangler 创建 KV：

```bash
npm run kv:create
npm run kv:bind -- <上一步输出的 id>
```

绑定后，管理员在设置里修改显示组件、窗口状态或端点配置，会保存到 KV。未登录用户只能读取公开显示设置，不会拿到端点密钥；端点密钥只会在管理员登录后通过 `/api/settings` 返回。
