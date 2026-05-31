const DEFAULT_TARGET_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PUBLIC_CHECK_CACHE_SECONDS = 60;

export async function onRequest(context) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const url = new URL(context.request.url);

  if (context.request.method === "OPTIONS") {
    return jsonResponse(null, { status: 204 });
  }

  try {
    const route = url.pathname.replace(/^\/api\/?/, "") || "health";
    const method = context.request.method.toUpperCase();

    if (route === "health" && method === "GET") {
      return ok({ status: "ok", service: "cpa-monitor" }, requestId, startedAt);
    }

    if (route === "session" && method === "GET") {
      return ok({ loginRequired: Boolean(getAdminPassword(context.env)) }, requestId, startedAt);
    }

    if (route === "session" && method === "POST") {
      const body = await readJson(context.request);
      const password = getAdminPassword(context.env);
      if (password && String(body.password || "") !== password) {
        throw appError("AUTH_FAILED", "密码错误", null, 401);
      }
      const token = await createSessionToken(context.env);
      return ok({ token }, requestId, startedAt);
    }

    if (route === "config" && method === "GET") {
      const config = getRuntimeConfig(context.env);
      return ok(
        {
          targetUrl: config.targetUrl,
          timeoutMs: config.timeoutMs,
          concurrency: config.concurrency,
          skipDisabled: config.skipDisabled,
          instances: config.instances.map(sanitizeInstance),
          loginRequired: Boolean(getAdminPassword(context.env)),
        },
        requestId,
        startedAt,
      );
    }

    if (route === "check-all" && method === "POST") {
      const config = getRuntimeConfig(context.env);
      const body = await readOptionalJson(context.request);
      const isAuthed = await hasValidSession(context.request, context.env);
      const data = isAuthed
        ? await runCheckAll(config, body.instanceId || "", body.instances)
        : await runPublicCheckAll(context.request, config, body.instanceId || "");
      return ok(data, requestId, startedAt);
    }

    await requireSession(context.request, context.env);

    if (route === "instances" && method === "GET") {
      const config = getRuntimeConfig(context.env);
      return ok({ instances: config.instances.map(sanitizeInstance) }, requestId, startedAt);
    }

    if (route === "auth-files" && method === "GET") {
      const config = getRuntimeConfig(context.env);
      const instanceId = url.searchParams.get("instance") || "";
      const instances = mergeRequestInstances(config.instances, url.searchParams.get("instances")).filter((instance) =>
        !instanceId || instance.id === instanceId,
      );
      const results = await Promise.all(instances.map((instance) => listAuthFiles(instance, config)));
      return ok({ instances: results }, requestId, startedAt);
    }

    if (route === "check" && method === "POST") {
      const config = getRuntimeConfig(context.env);
      const body = await readJson(context.request);
      const instance = findInstance(config.instances, body.instanceId);
      const filesResult = await listAuthFiles(instance, config);
      if (!filesResult.ok) {
        return ok({ instance: filesResult, result: null }, requestId, startedAt);
      }

      const file = filesResult.files.find((item) => item.id === body.fileId);
      if (!file) {
        throw appError("AUTH_FILE_NOT_FOUND", `认证文件不存在: ${body.fileId}`, instance.id);
      }

      const result = await checkAuthFile(instance, file, config);
      return ok({ instance: sanitizeInstance(instance), result }, requestId, startedAt);
    }

    if (route === "snapshot" && method === "GET") {
      const config = getRuntimeConfig(context.env);
      const mode = url.searchParams.get("mode") || "list";
      const instances =
        mode === "check"
          ? await Promise.all(config.instances.map((instance) => checkInstance(instance, config)))
          : await Promise.all(config.instances.map((instance) => listAuthFiles(instance, config)));
      return ok({ instances, summary: summarizeInstances(instances) }, requestId, startedAt);
    }

    throw appError("NOT_FOUND", `未知 API: ${method} /api/${route}`, route, 404);
  } catch (error) {
    return fail(normalizeError(error), requestId, startedAt);
  }
}

function getRuntimeConfig(env) {
  const jsonConfig = env.CPA_INSTANCES_JSON || decodeBase64Config(env.CPA_INSTANCES_JSON_B64);
  const singleInstance = parseSingleInstance(env);
  const instances = parseInstances(jsonConfig);
  if (singleInstance) instances.push(singleInstance);
  if (instances.length === 0) {
    throw appError(
      "CONFIG_EMPTY",
      "未配置 CPA 实例。请设置 CPA_INSTANCES_JSON，或设置 CPA_BASE_URL + CPA_ACCESS_KEY",
    );
  }

  return {
    instances,
    targetUrl: env.MONITOR_TARGET_URL || DEFAULT_TARGET_URL,
    timeoutMs: parsePositiveInt(env.CHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    concurrency: Math.min(parsePositiveInt(env.CHECK_CONCURRENCY, DEFAULT_CONCURRENCY), 20),
    skipDisabled: parseBool(env.SKIP_DISABLED, true),
    publicCheckCacheSeconds: parsePositiveInt(env.PUBLIC_CHECK_CACHE_SECONDS, DEFAULT_PUBLIC_CHECK_CACHE_SECONDS),
  };
}

function getAdminPassword(env) {
  return String(env.ADMIN_PASSWORD || env.CPA_MONITOR_PASSWORD || "").trim();
}

async function requireSession(request, env) {
  const password = getAdminPassword(env);
  if (!password) return;

  if (!(await hasValidSession(request, env))) {
    throw appError("UNAUTHORIZED", "请先登录", null, 401);
  }
}

async function hasValidSession(request, env) {
  const password = getAdminPassword(env);
  if (!password) return true;

  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return Boolean(token && (await verifySessionToken(token, env)));
}

async function createSessionToken(env) {
  const issuedAt = Date.now();
  const payload = b64urlEncode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 12 * 60 * 60 * 1000 }));
  const signature = await signText(payload, env);
  return `${payload}.${signature}`;
}

async function verifySessionToken(token, env) {
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature) return false;
  if ((await signText(payload, env)) !== signature) return false;

  try {
    const data = JSON.parse(b64urlDecode(payload));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

async function signText(text, env) {
  const secret = getAdminPassword(env) || "cpa-monitor-dev";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return b64urlEncodeBytes(new Uint8Array(signature));
}

function b64urlEncode(text) {
  return b64urlEncodeBytes(new TextEncoder().encode(text));
}

function b64urlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64urlDecode(text) {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseInstances(raw) {
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw appError("CONFIG_INVALID_JSON", "CPA_INSTANCES_JSON 不是有效 JSON", error.message);
  }

  if (!Array.isArray(parsed)) {
    throw appError("CONFIG_INVALID_SHAPE", "CPA_INSTANCES_JSON 必须是数组");
  }

  return parsed
    .map((item, index) => ({
      id: String(item.id || `instance-${index + 1}`).trim(),
      name: String(item.name || item.id || `Instance ${index + 1}`).trim(),
      baseUrl: normalizeBaseUrl(item.baseUrl || item.base_url || ""),
      accessKey: String(item.accessKey || item.access_key || "").trim(),
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.enabled && item.baseUrl && item.accessKey);
}

function decodeBase64Config(raw) {
  if (!raw) return "";
  try {
    return atob(String(raw).trim());
  } catch {
    throw appError("CONFIG_INVALID_BASE64", "CPA_INSTANCES_JSON_B64 不是有效 base64");
  }
}

function parseSingleInstance(env) {
  const baseUrl = normalizeBaseUrl(env.CPA_BASE_URL || "");
  const accessKey = String(env.CPA_ACCESS_KEY || "").trim();
  if (!baseUrl || !accessKey) return null;

  return {
    id: String(env.CPA_INSTANCE_ID || "main").trim(),
    name: String(env.CPA_INSTANCE_NAME || env.CPA_INSTANCE_ID || "Main CPA").trim(),
    baseUrl,
    accessKey,
    enabled: parseBool(env.CPA_INSTANCE_ENABLED, true),
  };
}

async function listAuthFiles(instance, config) {
  const startedAt = Date.now();
  try {
    const data = await cpaFetchJson(instance, "/v0/management/auth-files", {
      method: "GET",
      timeoutMs: config.timeoutMs,
    });

    if (!Array.isArray(data.files)) {
      throw appError("CPA_BAD_RESPONSE", "CPA 响应缺少 files 数组", instance.id);
    }

    const files = data.files.map((item) => normalizeAuthFile(item)).filter((item) => item.id);
    return {
      ok: true,
      instance: sanitizeInstance(instance),
      files,
      summary: summarizeFiles(files, []),
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      instance: sanitizeInstance(instance),
      files: [],
      summary: summarizeFiles([], []),
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: normalizeError(error),
    };
  }
}

async function checkInstance(instance, config) {
  const listed = await listAuthFiles(instance, config);
  if (!listed.ok) return { ...listed, checks: [] };

  const targets = listed.files.filter((file) => !(config.skipDisabled && file.disabled)).filter(fileMatchesCodex);
  const ignored = listed.files
    .filter((file) => !(config.skipDisabled && file.disabled))
    .filter((file) => !fileMatchesCodex(file))
    .map((file) => ({
      fileId: file.id,
      status: "skipped",
      statusCode: null,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      message: "非 Codex 认证文件，已跳过",
      usage: null,
      quotaBars: [],
    }));
  const skipped = listed.files
    .filter((file) => config.skipDisabled && file.disabled)
    .map((file) => ({
      fileId: file.id,
      status: "skipped",
      statusCode: null,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      message: "disabled 文件已跳过",
      usage: null,
      quotaBars: [],
    }));

  const checks = await promisePool(targets, config.concurrency, (file) => checkAuthFile(instance, file, config));
  const allChecks = [...checks, ...skipped, ...ignored];

  return {
    ...listed,
    checks: allChecks,
    summary: summarizeFiles(listed.files, allChecks),
    checkedAt: new Date().toISOString(),
  };
}

async function runCheckAll(config, instanceId, requestInstances) {
  const allInstances = mergeRequestInstances(config.instances, requestInstances);
  const instances = selectInstances(allInstances, instanceId || "");
  const checked = await Promise.all(instances.map((instance) => checkInstance(instance, config)));
  return {
    instances: checked,
    summary: summarizeInstances(checked),
    cached: false,
    public: false,
  };
}

async function runPublicCheckAll(request, config, instanceId) {
  const cacheKey = new Request(buildPublicCheckCacheUrl(request, instanceId));
  const cached = await readPublicCheckCache(cacheKey);
  if (cached) return cached;

  const instances = selectInstances(config.instances, instanceId || "");
  const checked = await Promise.all(instances.map((instance) => checkInstance(instance, config)));
  const data = {
    instances: checked,
    summary: summarizeInstances(checked),
    cached: false,
    public: true,
    cacheSeconds: config.publicCheckCacheSeconds,
  };
  await writePublicCheckCache(cacheKey, data, config.publicCheckCacheSeconds);
  return data;
}

function buildPublicCheckCacheUrl(request, instanceId) {
  const url = new URL(request.url);
  url.pathname = "/api/cache/public-check-all";
  url.search = "";
  url.searchParams.set("instance", instanceId || "all");
  return url.toString();
}

async function readPublicCheckCache(cacheKey) {
  if (typeof caches === "undefined" || !caches.default) return null;
  const response = await caches.default.match(cacheKey);
  if (!response) return null;
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") return null;
  return {
    ...data,
    cached: true,
    public: true,
  };
}

async function writePublicCheckCache(cacheKey, data, seconds) {
  if (typeof caches === "undefined" || !caches.default) return;
  await caches.default.put(
    cacheKey,
    new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${seconds}`,
      },
    }),
  );
}

async function checkAuthFile(instance, file, config) {
  const startedAt = Date.now();
  try {
    const data = await cpaFetchJson(instance, "/v0/management/api-call", {
      method: "POST",
      timeoutMs: config.timeoutMs,
      body: {
        authIndex: file.authIndex,
        method: "GET",
        url: config.targetUrl,
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
          "Chatgpt-Account-Id": file.chatgptAccountId || "",
        },
      },
    });

    const statusCode = Number(data.status_code ?? data.statusCode);
    if (!Number.isFinite(statusCode)) {
      throw appError("CPA_BAD_CHECK_RESPONSE", "检测响应缺少 status_code", file.id);
    }

    const usage = extractUsage(data.body);
    return {
      fileId: file.id,
      status: classifyStatus(statusCode, data.body),
      statusCode,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      message: buildStatusMessage(statusCode, data.body),
      usage,
      quotaBars: extractQuotaBars(data.body),
      bodyPreview: truncatePreview(data.body, 500),
    };
  } catch (error) {
    return {
      fileId: file.id,
      status: "check_error",
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      message: normalizeError(error).message,
      usage: null,
      quotaBars: [],
      error: normalizeError(error),
    };
  }
}

async function cpaFetchJson(instance, path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), options.timeoutMs);

  try {
    const init = {
      method: options.method,
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${instance.accessKey}`,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      signal: controller.signal,
    };

    if (options.body) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${instance.baseUrl}${path}`, init);
    const text = await response.text();
    const data = parseJsonText(text);

    if (!response.ok) {
      const message = data && typeof data === "object" ? data.message || JSON.stringify(data) : text;
      throw appError("CPA_HTTP_ERROR", `CPA HTTP ${response.status}: ${message || "empty response"}`, instance.id, response.status);
    }

    if (!data || typeof data !== "object") {
      throw appError("CPA_BAD_RESPONSE", "CPA 响应不是 JSON 对象", instance.id);
    }

    return data;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw appError("CPA_TIMEOUT", `CPA 请求超时: ${options.timeoutMs}ms`, instance.id);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAuthFile(item) {
  const source = item && typeof item === "object" ? item : {};
  return {
    id: String(source.id || source.name || "").trim(),
    provider: String(source.provider || source.provider_name || source.type || "unknown"),
    authIndex: source.auth_index ?? source.authIndex ?? "",
    disabled: Boolean(source.disabled),
    chatgptAccountId: String(getDeep(source, ["id_token", "chatgpt_account_id"]) || source.chatgpt_account_id || ""),
    raw: source,
  };
}

function fileMatchesCodex(file) {
  const provider = String(file.provider || "").toLowerCase();
  const fileId = String(file.id || "").toLowerCase();
  const accountId = String(file.chatgptAccountId || "").toLowerCase();
  const isGemini = provider.includes("gemini") || fileId.startsWith("gemini-") || fileId.includes("/gemini");
  const isCodex = provider.includes("codex") || fileId.startsWith("codex-") || accountId.includes("chatgpt");
  return isCodex && !isGemini;
}

function classifyStatus(statusCode, body) {
  if (statusCode === 401) return "invalid_401";
  if (statusCode === 403 || statusCode === 429) return "limited_or_forbidden";
  if (statusCode >= 200 && statusCode < 300) return "ok";
  if (statusCode >= 500) return "upstream_error";

  const text = stringifyBody(body).toLowerCase();
  if (text.includes("rate limit") || text.includes("usage limit") || text.includes("quota")) {
    return "limited_or_forbidden";
  }

  return "check_error";
}

function buildStatusMessage(statusCode, body) {
  if (statusCode === 401) return "认证失效或 token 不可用";
  if (statusCode === 403) return "请求被拒绝，可能是权限或额度限制";
  if (statusCode === 429) return "触发速率或额度限制";
  if (statusCode >= 200 && statusCode < 300) return "可用";
  if (statusCode >= 500) return "上游服务异常";
  return truncatePreview(body, 160) || `HTTP ${statusCode}`;
}

function extractUsage(body) {
  const parsed = typeof body === "string" ? parseJsonText(body) : body;
  if (!parsed || typeof parsed !== "object") return null;

  const candidates = [
    parsed.usage,
    parsed.data && parsed.data.usage,
    parsed.account_usage,
    parsed.limits,
    parsed,
  ].filter(Boolean);

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const result = {};
    for (const key of ["used", "limit", "remaining", "reset_at", "resets_at", "plan", "has_available_quota"]) {
      if (key in item) result[key] = item[key];
    }
    if (Object.keys(result).length > 0) return result;
  }

  return null;
}

function extractQuotaBars(body) {
  const parsed = typeof body === "string" ? parseJsonText(body) : body;
  if (!parsed || typeof parsed !== "object") return [];

  const bars = [];
  const seen = new Set();

  function addBar(label, percent, resetAt = null, used = null, limit = null) {
    const normalizedPercent = Number(percent);
    if (!Number.isFinite(normalizedPercent)) return;
    const safePercent = Math.max(0, Math.min(100, normalizedPercent));
    const key = `${label}:${safePercent}:${resetAt || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    bars.push({
      label,
      percent: Math.round(safePercent),
      resetAt,
      used,
      limit,
    });
  }

  function inferLabel(keyPath, fallback) {
    const text = keyPath.join(".").toLowerCase();
    if (text.includes("primary_window")) return "5 小时限额";
    if (text.includes("secondary_window")) return "周限额";
    if (text.includes("codex")) return "Codex 额度";
    if (text.includes("weekly") || text.includes("week")) return "周限额";
    if (text.includes("daily") || text.includes("day")) return "日限额";
    if (text.includes("hour") || text.includes("5h") || text.includes("five")) return "5 小时限额";
    if (text.includes("message")) return "消息额度";
    return fallback;
  }

  function scan(node, keyPath = []) {
    if (!node || typeof node !== "object" || bars.length >= 8) return;

    if (Array.isArray(node)) {
      node.forEach((item, index) => scan(item, [...keyPath, String(index)]));
      return;
    }

    const label = String(node.label || node.name || node.title || inferLabel(keyPath, "额度"));
    const resetAt =
      normalizeResetAt(
        node.reset_at ??
          node.resetAt ??
          node.resets_at ??
          node.resetsAt ??
          node.next_reset_at ??
          node.nextResetAt,
      ) ||
      inferResetAt(node) ||
      null;
    const directPercent =
      node.percent ??
      node.percentage ??
      node.used_percent ??
      node.usedPercentage ??
      node.usage_percent ??
      node.usagePercentage ??
      normalizeRatio(node.used_ratio ?? node.usage_ratio);

    if (directPercent !== undefined) {
      addBar(label, Number(directPercent), resetAt);
    }

    const used = Number(node.used ?? node.consumed ?? node.current ?? node.count ?? node.total_used);
    const limit = Number(node.limit ?? node.total ?? node.max ?? node.capacity ?? node.quota);
    const remaining = Number(node.remaining ?? node.available ?? node.left);

    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      addBar(label, (used / limit) * 100, resetAt, used, limit);
    } else if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      addBar(label, ((limit - remaining) / limit) * 100, resetAt, limit - remaining, limit);
    }

    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") scan(value, [...keyPath, key]);
    }
  }

  scan(parsed);
  return bars.slice(0, 8);
}

function inferResetAt(node) {
  const seconds =
    node.reset_after_seconds ??
    node.resetAfterSeconds ??
    node.resets_after_seconds ??
    node.resetsAfterSeconds ??
    node.reset_in_seconds ??
    node.resetInSeconds;
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return new Date(Date.now() + parsed * 1000).toISOString();
}

function normalizeResetAt(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    const milliseconds = value > 100000000000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    const milliseconds = number > 100000000000 ? number : number * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? text : date.toISOString();
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function normalizeRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed <= 1 ? parsed * 100 : parsed;
}

async function promisePool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, run);
  await Promise.all(runners);
  return results;
}

function summarizeFiles(files, checks) {
  const byFileId = new Map(checks.map((check) => [check.fileId, check]));
  return {
    total: files.length,
    checked: checks.filter((check) => check.status !== "skipped").length,
    ok: checks.filter((check) => check.status === "ok").length,
    invalid401: checks.filter((check) => check.status === "invalid_401").length,
    limitedOrForbidden: checks.filter((check) => check.status === "limited_or_forbidden").length,
    disabled: files.filter((file) => file.disabled).length,
    skipped: checks.filter((check) => check.status === "skipped").length,
    errors: checks.filter((check) => ["upstream_error", "check_error"].includes(check.status)).length,
    unchecked: files.filter((file) => !byFileId.has(file.id)).length,
  };
}

function summarizeInstances(instances) {
  return instances.reduce(
    (acc, item) => {
      acc.instances += 1;
      if (item.ok) acc.healthyInstances += 1;
      else acc.errorInstances += 1;

      const summary = item.summary || {};
      acc.totalFiles += summary.total || 0;
      acc.checked += summary.checked || 0;
      acc.ok += summary.ok || 0;
      acc.invalid401 += summary.invalid401 || 0;
      acc.limitedOrForbidden += summary.limitedOrForbidden || 0;
      acc.disabled += summary.disabled || 0;
      acc.skipped += summary.skipped || 0;
      acc.errors += summary.errors || 0;
      acc.unchecked += summary.unchecked || 0;
      return acc;
    },
    {
      instances: 0,
      healthyInstances: 0,
      errorInstances: 0,
      totalFiles: 0,
      checked: 0,
      ok: 0,
      invalid401: 0,
      limitedOrForbidden: 0,
      disabled: 0,
      skipped: 0,
      errors: 0,
      unchecked: 0,
    },
  );
}

function selectInstances(instances, instanceId) {
  if (!instanceId) return instances;
  return [findInstance(instances, instanceId)];
}

function mergeRequestInstances(baseInstances, rawInstances) {
  const extra = parseRequestInstances(rawInstances);
  const map = new Map(baseInstances.map((instance) => [instance.id, instance]));
  for (const instance of extra) {
    if (instance.enabled) map.set(instance.id, instance);
  }
  return [...map.values()];
}

function parseRequestInstances(rawInstances) {
  if (!rawInstances) return [];
  let parsed = rawInstances;
  if (typeof rawInstances === "string") {
    try {
      parsed = JSON.parse(rawInstances);
    } catch {
      throw appError("BAD_INSTANCES_JSON", "端点配置不是有效 JSON", null, 400);
    }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item, index) => ({
      id: String(item.id || `custom-${index + 1}`).trim(),
      name: String(item.name || item.id || `Custom ${index + 1}`).trim(),
      baseUrl: normalizeBaseUrl(item.baseUrl || item.base_url || ""),
      accessKey: String(item.accessKey || item.access_key || "").trim(),
      enabled: item.enabled !== false,
    }))
    .filter((instance) => instance.id && instance.baseUrl && instance.accessKey);
}

function findInstance(instances, instanceId) {
  const instance = instances.find((item) => item.id === instanceId);
  if (!instance) throw appError("INSTANCE_NOT_FOUND", `CPA 实例不存在: ${instanceId}`);
  return instance;
}

function sanitizeInstance(instance) {
  return {
    id: instance.id,
    name: instance.name,
    baseUrl: instance.baseUrl,
    enabled: instance.enabled,
  };
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw appError("BAD_JSON", "请求体不是有效 JSON", null, 400);
  }
}

async function readOptionalJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw appError("BAD_JSON", "请求体不是有效 JSON", null, 400);
  }
}

function parseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getDeep(data, path) {
  let current = data;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function stringifyBody(body) {
  if (body === null || body === undefined) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

function truncatePreview(body, maxLength) {
  const text = stringifyBody(body);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function ok(data, requestId, startedAt) {
  return jsonResponse({
    ok: true,
    data,
    error: null,
    meta: {
      requestId,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    },
  });
}

function fail(error, requestId, startedAt) {
  return jsonResponse(
    {
      ok: false,
      data: null,
      error,
      meta: {
        requestId,
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
    },
    { status: error.status || 500 },
  );
}

function jsonResponse(body, init = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    ...init,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function appError(code, message, detail = null, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  error.status = status;
  return error;
}

function normalizeError(error) {
  return {
    code: error && error.code ? error.code : "INTERNAL_ERROR",
    message: error && error.message ? error.message : "未知错误",
    detail: error && error.detail ? error.detail : null,
    status: error && error.status ? error.status : 500,
  };
}
