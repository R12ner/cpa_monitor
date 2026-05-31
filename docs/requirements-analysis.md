# CPA 可用额度监测网站需求分析

## 1. 背景

当前仓库中已有两个关键输入：

- `index.html`：已有前端页面样式，整体是浅色 Cyber Terminal / 探针风格，包括侧边栏、面板、状态卡片、日志表格、进度条和终端化视觉元素。
- `sample/cpa_auth_manager`：已有 CPA 认证文件失效检测工具，使用 Streamlit 实现，包含 CPA 管理接口连接、认证文件拉取、并发检测、401 判断、禁用、删除和导出能力。

新项目目标是把这些能力整理成一个可部署到 Cloudflare 的监测网站，用于查看 CPA 反代工具中认证文件和账号额度的可用状态。

## 2. 项目目标

### 2.1 核心目标

- 构建一个类似探针的 CPA 可用额度监测站点。
- 能部署到 Cloudflare，优先支持 Cloudflare Pages + Workers。
- 页面视觉复用根目录 `index.html` 的样式体系。
- 检测逻辑参考 `sample/cpa_auth_manager`，但产品形态改为网页监测面板。
- 能复用到其他服务器，通过配置切换或新增 CPA 实例。
- 具备较强健壮性：超时、错误隔离、字段兼容、密钥保护、空数据降级。

### 2.2 非目标

- 第一阶段不做认证文件删除、禁用等破坏性操作。
- 第一阶段不做用户注册、多租户权限系统。
- 第一阶段不直接在前端保存 CPA access key。
- 第一阶段不追求完整历史时序数据库，可先展示实时检测结果和最近一次检测状态。

## 3. 用户角色

- 站点维护者：部署 Cloudflare 项目、配置 CPA 实例和密钥。
- 日常观察者：打开页面查看 CPA 服务器、账号额度、失效情况和异常原因。
- 运维处理者：根据监测结果去 CPA 后台或已有 Streamlit 工具中执行禁用、删除、替换认证文件等操作。

## 4. 功能需求

### 4.1 实例配置

系统应支持配置一个或多个 CPA 实例。

每个实例字段：

- `id`：实例唯一标识，例如 `main`、`la-01`。
- `name`：前端显示名称。
- `baseUrl`：CPA 管理接口地址，例如 `https://api.example.com`。
- `accessKey`：CPA 管理访问密钥，只能存在于 Worker 环境变量或 secret。
- `enabled`：是否启用该实例，默认启用。

配置推荐使用环境变量 `CPA_INSTANCES_JSON`：

```json
[
  {
    "id": "main",
    "name": "Main CPA",
    "baseUrl": "https://cpa.example.com",
    "accessKey": "replace-me",
    "enabled": true
  }
]
```

### 4.2 认证文件拉取

参考 sample 中的接口：

```http
GET <baseUrl>/v0/management/auth-files
Authorization: Bearer <accessKey>
```

期望响应中包含 `files` 字段。

字段解析需要兼容：

- 文件 ID：`id` 或 `name`
- provider：`provider`、`provider_name` 或 `type`
- auth index：`auth_index` 或 `authIndex`
- disabled：`disabled`
- ChatGPT account id：`id_token.chatgpt_account_id` 或 `chatgpt_account_id`

无法识别的原始字段应保留到 `raw`，便于后续排查。

### 4.3 可用额度检测

参考 sample 中的检测方式：

```http
POST <baseUrl>/v0/management/api-call
Authorization: Bearer <accessKey>
Content-Type: application/json
```

payload：

```json
{
  "authIndex": "<auth_index>",
  "method": "GET",
  "url": "https://chatgpt.com/backend-api/wham/usage",
  "header": {
    "Authorization": "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
    "Chatgpt-Account-Id": "<chatgpt_account_id>"
  }
}
```

检测结果分类：

- `ok`：返回 `status_code` 为 2xx。
- `invalid_401`：返回 `status_code` 为 401，说明认证文件失效或 token 不可用。
- `limited_or_forbidden`：返回 403、429 或 usage 体内可识别额度不足信息。
- `upstream_error`：CPA、OpenAI 或网络上游 5xx。
- `check_error`：响应格式异常、超时、字段缺失或其他检测错误。
- `skipped`：文件 disabled 且配置为跳过。

额度字段需要先以兼容解析为主。若 usage 响应体中存在明确的限额、剩余量、重置时间字段，则前端展示；若没有，则展示 HTTP 状态与摘要。

### 4.4 前端仪表盘

前端应复用 `index.html` 风格，保留：

- 左侧导航栏
- Mac 风格面板标题栏
- 状态卡片
- 进度条
- 日志/表格区域
- 终端化字体和颜色变量
- 响应式布局

首页应展示：

- 总实例数
- 在线/异常实例数
- 总认证文件数
- 正常账号数
- 401 失效数
- 额度异常/受限数
- disabled 文件数
- 最近检测时间

主表格应展示：

- 实例
- 文件 ID
- provider
- auth index
- disabled
- ChatGPT account id
- 检测状态
- HTTP 状态码
- 额度摘要
- 延迟
- 最近检测时间
- 错误摘要

筛选能力：

- 按实例筛选
- 按 provider 筛选
- 按 disabled 筛选
- 按检测状态筛选
- 搜索文件 ID / auth index / account id
- 只看异常

操作能力：

- 手动刷新实例列表
- 手动检测全部
- 手动检测当前筛选结果
- 导出当前结果 JSON

### 4.5 Worker API

建议设计以下内部 API：

```http
GET /api/health
GET /api/config
GET /api/instances
GET /api/auth-files?instance=<id>
POST /api/check
POST /api/check-all
GET /api/snapshot
```

接口职责：

- `/api/health`：Worker 自检。
- `/api/config`：返回脱敏后的前端配置，例如刷新间隔、实例名称，不返回密钥。
- `/api/instances`：返回 CPA 实例健康状态。
- `/api/auth-files`：拉取并归一化认证文件列表。
- `/api/check`：检测指定实例的指定文件。
- `/api/check-all`：检测某个实例或全部实例。
- `/api/snapshot`：返回聚合后的仪表盘数据。

所有接口响应建议统一结构：

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "meta": {
    "requestId": "string",
    "checkedAt": "2026-05-31T00:00:00.000Z",
    "durationMs": 123
  }
}
```

错误响应：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "CPA_TIMEOUT",
    "message": "CPA request timed out",
    "detail": "main / auth-files"
  },
  "meta": {
    "requestId": "string",
    "durationMs": 30000
  }
}
```

## 5. 非功能需求

### 5.1 安全性

- CPA access key 不得写入前端代码。
- API 返回不得包含 access key。
- 前端不能直接请求 CPA 管理接口，除非用户明确选择本地模式。
- `.env.local`、`.dev.vars`、Cloudflare 构建产物不得提交。
- 管理类危险操作默认不开放。

### 5.2 健壮性

- 所有外部请求必须有超时。
- 单个实例失败不能影响其他实例。
- 单个认证文件检测失败不能中断整个批次。
- CPA 响应字段缺失时应降级展示原始摘要。
- 并发数可配置，默认不超过 8。
- 检测结果应包含错误类型、错误摘要和检测时间。

### 5.3 可移植性

- 新增服务器只需要增加一条实例配置。
- `baseUrl` 自动去除末尾 `/`。
- 支持不同 CPA 响应字段命名差异。
- 前端不绑定固定域名。

### 5.4 可维护性

- CPA API 访问、字段归一化、检测逻辑、前端渲染分层。
- 类型定义集中维护。
- README 包含本地开发、部署、配置和排障说明。
- `.gitignore` 排除 secrets、依赖、构建产物和缓存。

## 6. 当前目录结构

```text
cpa_monitor/
  index.html
  README.md
  docs/
    requirements-analysis.md
  functions/
    api/
      [[path]].js
  sample/
    cpa_auth_manager/
  public/
    index.html
    app.js
    style.css
  package.json
  wrangler.toml
  .env.example
  .gitignore
```

根目录 `index.html` 保留为原始样式参考，部署入口使用 `public/index.html`。

## 7. Cloudflare 部署方案

### 7.1 第一阶段：Pages + Functions

适合静态前端和轻量 API：

- 前端放在 `public/`
- API 放在 `functions/api/*`
- 使用 Pages 环境变量配置 CPA 实例

### 7.2 第二阶段：Workers + KV / D1

如需定时检测和历史记录：

- Worker 处理 API
- Cron Trigger 定时检查
- KV 保存最近快照
- D1 保存历史检测记录

## 8. 验收标准

第一阶段验收：

- 可以在本地启动页面。
- 可以在 Cloudflare 部署。
- 可以通过 Worker 配置连接至少一个 CPA 实例。
- 页面不暴露 access key。
- 可以拉取认证文件并展示统计。
- 可以手动触发检测。
- 可以识别 2xx、401、非 2xx、超时和响应异常。
- 一个实例失败时，其他实例仍正常展示。
- README 能指导新服务器复用部署。

第二阶段验收：

- 支持多个 CPA 实例。
- 支持定时检测。
- 支持保存最近一次快照。
- 支持异常高亮和导出。
- 支持部署环境和本地环境配置分离。

## 9. 风险与处理

- CPA 接口响应结构变化：通过字段兼容和 `raw` 保留降低风险。
- Cloudflare Worker 请求超时：限制并发，批量检测分批执行。
- usage 响应体字段不稳定：先以 HTTP 状态判断可用性，额度详情做渐进增强。
- access key 泄漏：仅使用 Worker secret，前端接口脱敏。
- 大量认证文件导致检测慢：提供并发配置、跳过 disabled、只检测异常或当前筛选。

## 10. 后续实现顺序

1. 初始化 Cloudflare 项目配置和 TypeScript Worker。
2. 抽取 `index.html` 样式为可复用前端页面。
3. 实现 CPA client：认证文件拉取、api-call 检测、超时和错误归一化。
4. 实现 Worker API：health、config、auth-files、check-all、snapshot。
5. 前端接入真实 API，完成统计卡片、表格、筛选和刷新。
6. 增加本地开发说明和部署说明。
7. 可选加入 KV 快照、Cron 定时检测和历史趋势。
