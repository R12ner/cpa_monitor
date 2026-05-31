const CACHE_KEY = "cpa-monitor:snapshot:v2";
const FILTER_KEY = "cpa-monitor:filters:v2";
const CACHE_TTL_MS = 10 * 60 * 1000;

const state = {
  config: null,
  instances: [],
  rows: [],
  checks: new Map(),
  summary: emptySummary(),
  lastCheckedAt: null,
  loadedFromCache: false,
};

const els = {
  apiStatus: document.getElementById("apiStatus"),
  timeoutMs: document.getElementById("timeoutMs"),
  concurrency: document.getElementById("concurrency"),
  skipDisabled: document.getElementById("skipDisabled"),
  configNote: document.getElementById("configNote"),
  sideHealthy: document.getElementById("sideHealthy"),
  sideProblems: document.getElementById("sideProblems"),
  problemBadge: document.getElementById("problemBadge"),
  metricInstances: document.getElementById("metricInstances"),
  metricInstanceHint: document.getElementById("metricInstanceHint"),
  metricFiles: document.getElementById("metricFiles"),
  metricOk: document.getElementById("metricOk"),
  metricInvalid: document.getElementById("metricInvalid"),
  metricLimited: document.getElementById("metricLimited"),
  metricErrors: document.getElementById("metricErrors"),
  instanceFilter: document.getElementById("instanceFilter"),
  statusFilter: document.getElementById("statusFilter"),
  disabledFilter: document.getElementById("disabledFilter"),
  searchInput: document.getElementById("searchInput"),
  onlyProblems: document.getElementById("onlyProblems"),
  tableCount: document.getElementById("tableCount"),
  lastChecked: document.getElementById("lastChecked"),
  fileTable: document.getElementById("fileTable"),
  quotaCount: document.getElementById("quotaCount"),
  quotaGrid: document.getElementById("quotaGrid"),
  quotaMode: document.getElementById("quotaMode"),
  cacheStatus: document.getElementById("cacheStatus"),
  logOutput: document.getElementById("logOutput"),
  refreshBtn: document.getElementById("refreshBtn"),
  checkBtn: document.getElementById("checkBtn"),
};

boot();

async function boot() {
  bindEvents();
  restoreFilters();
  restoreSnapshot();
  log("init", "Loading Worker config");

  try {
    await loadConfig();
    if (state.rows.length === 0 || isCacheExpired()) {
      await refreshList({ force: false });
    } else {
      log("cache", "Using browser cache; click refresh to request CPA again");
      render();
    }
  } catch (error) {
    renderError(error);
  }
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", () => refreshList({ force: true }));
  els.checkBtn.addEventListener("click", checkAll);

  for (const input of [els.instanceFilter, els.statusFilter, els.disabledFilter, els.searchInput, els.onlyProblems, els.quotaMode]) {
    input.addEventListener("change", () => {
      saveFilters();
      render();
    });
  }
  els.searchInput.addEventListener("input", () => {
    saveFilters();
    render();
  });

  document.querySelector('[data-action="refresh-list"]').addEventListener("click", () => refreshList({ force: true }));
  document.querySelector('[data-action="check-all"]').addEventListener("click", checkAll);
  document.querySelector('[data-action="export-json"]').addEventListener("click", exportJson);
}

async function loadConfig() {
  const [health, config] = await Promise.all([apiGet("/api/health"), apiGet("/api/config")]);
  state.config = config;
  state.instances = mergeInstanceMeta(state.instances, config.instances || []);

  els.apiStatus.textContent = health.status || "ok";
  els.timeoutMs.textContent = `${config.timeoutMs}ms`;
  els.concurrency.textContent = String(config.concurrency);
  els.skipDisabled.textContent = config.skipDisabled ? "true" : "false";
  els.configNote.textContent = `${state.instances.length} CPA instance(s), target: ${config.targetUrl}`;

  renderInstanceOptions();
  restoreFilters();
}

async function refreshList({ force }) {
  if (!force && state.rows.length > 0 && !isCacheExpired()) {
    log("cache", "Skipped network request because cache is still fresh");
    render();
    return;
  }

  setBusy(true, "Refreshing");
  try {
    log("fetch", "Fetching CPA auth files");
    const data = await apiGet("/api/auth-files");
    ingestInstances(data.instances || [], false);
    state.lastCheckedAt = state.lastCheckedAt || new Date().toISOString();
    saveSnapshot();
    log("ok", `List loaded: ${state.rows.length} row(s)`);
    render();
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

async function checkAll() {
  setBusy(true, "Checking");
  try {
    const instanceId = els.instanceFilter.value;
    log("check", instanceId ? `Checking instance ${instanceId}` : "Checking all instances");
    const data = await apiPost("/api/check-all", { instanceId });
    ingestInstances(data.instances || [], true);
    state.summary = data.summary || summarizeRows(state.rows);
    state.lastCheckedAt = new Date().toISOString();
    saveSnapshot();
    log("ok", `Done: ok ${state.summary.ok}, 401 ${state.summary.invalid401}, errors ${state.summary.errors}`);
    render();
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

function ingestInstances(instances, withChecks) {
  state.instances = mergeInstanceMeta(state.instances, instances.map((item) => item.instance));
  const rows = [];

  for (const item of instances) {
    const instance = item.instance;
    const checks = new Map((item.checks || []).map((check) => [check.fileId, check]));

    if (withChecks) {
      for (const check of item.checks || []) {
        state.checks.set(`${instance.id}:${check.fileId}`, check);
      }
    }

    for (const file of item.files || []) {
      const key = `${instance.id}:${file.id}`;
      rows.push({
        instance,
        file,
        check: checks.get(file.id) || state.checks.get(key) || null,
        instanceError: item.ok ? null : item.error,
      });
    }

    if (!item.ok && (!item.files || item.files.length === 0)) {
      rows.push({ instance, file: null, check: null, instanceError: item.error });
    }
  }

  state.rows = rows;
  state.summary = summarizeRows(rows);
  state.loadedFromCache = false;
  renderInstanceOptions();
}

function saveSnapshot() {
  const payload = {
    savedAt: new Date().toISOString(),
    config: state.config,
    instances: state.instances,
    rows: state.rows,
    checks: [...state.checks.entries()],
    lastCheckedAt: state.lastCheckedAt,
  };
  localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
}

function restoreSnapshot() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return;

  try {
    const payload = JSON.parse(raw);
    state.config = payload.config || null;
    state.instances = payload.instances || [];
    state.rows = payload.rows || [];
    state.checks = new Map(payload.checks || []);
    state.lastCheckedAt = payload.lastCheckedAt || payload.savedAt || null;
    state.loadedFromCache = true;
    renderInstanceOptions();
    render();
  } catch {
    localStorage.removeItem(CACHE_KEY);
  }
}

function isCacheExpired() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return true;
  try {
    const payload = JSON.parse(raw);
    return Date.now() - new Date(payload.savedAt).getTime() > CACHE_TTL_MS;
  } catch {
    return true;
  }
}

function saveFilters() {
  const filters = {
    instance: els.instanceFilter.value,
    status: els.statusFilter.value,
    disabled: els.disabledFilter.value,
    search: els.searchInput.value,
    onlyProblems: els.onlyProblems.checked,
    quotaMode: els.quotaMode.value,
  };
  localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
}

function restoreFilters() {
  const raw = localStorage.getItem(FILTER_KEY);
  if (!raw) return;

  try {
    const filters = JSON.parse(raw);
    if (filters.instance && [...els.instanceFilter.options].some((option) => option.value === filters.instance)) {
      els.instanceFilter.value = filters.instance;
    }
    els.statusFilter.value = filters.status || "";
    els.disabledFilter.value = filters.disabled || "";
    els.searchInput.value = filters.search || "";
    els.onlyProblems.checked = Boolean(filters.onlyProblems);
    els.quotaMode.value = filters.quotaMode || "paged";
  } catch {
    localStorage.removeItem(FILTER_KEY);
  }
}

function mergeInstanceMeta(existing, incoming) {
  const map = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming.filter(Boolean)) {
    map.set(item.id, { ...map.get(item.id), ...item });
  }
  return [...map.values()];
}

function renderInstanceOptions() {
  const current = els.instanceFilter.value;
  els.instanceFilter.innerHTML = '<option value="">All instances</option>';
  for (const instance of state.instances) {
    const option = document.createElement("option");
    option.value = instance.id;
    option.textContent = `${instance.name} (${instance.id})`;
    els.instanceFilter.appendChild(option);
  }
  els.instanceFilter.value = state.instances.some((item) => item.id === current) ? current : "";
}

function render() {
  const rows = getFilteredRows();
  const summary = summarizeRows(state.rows);
  const problems = summary.invalid401 + summary.limitedOrForbidden + summary.errors;

  els.sideHealthy.textContent = String(summary.healthyInstances);
  els.sideProblems.textContent = String(problems);
  els.problemBadge.textContent = String(problems);
  els.metricInstances.textContent = String(summary.instances);
  els.metricInstanceHint.textContent = `${summary.healthyInstances} healthy / ${summary.errorInstances} error`;
  els.metricFiles.textContent = String(summary.totalFiles);
  els.metricOk.textContent = String(summary.ok);
  els.metricInvalid.textContent = String(summary.invalid401);
  els.metricLimited.textContent = String(summary.limitedOrForbidden);
  els.metricErrors.textContent = String(summary.errors);
  els.tableCount.textContent = `${rows.length} row(s)`;
  els.lastChecked.textContent = state.lastCheckedAt ? `Last checked ${formatTime(state.lastCheckedAt)}` : "Not checked yet";
  els.cacheStatus.textContent = state.loadedFromCache
    ? `Loaded from browser cache${state.lastCheckedAt ? `, ${formatTime(state.lastCheckedAt)}` : ""}`
    : state.lastCheckedAt
      ? `Saved to browser cache, ${formatTime(state.lastCheckedAt)}`
      : "No cached check result";

  renderQuotaCards(rows);
  renderTable(rows);
}

function renderQuotaCards(rows) {
  const usable = rows.filter((row) => row.file && !row.instanceError);
  const withQuota = usable.filter((row) => (row.check && row.check.quotaBars && row.check.quotaBars.length > 0) || row.check);
  const visible = els.quotaMode.value === "all" ? withQuota : withQuota.slice(0, 12);
  els.quotaCount.textContent = String(withQuota.length);

  if (withQuota.length === 0) {
    els.quotaGrid.innerHTML = '<div class="empty quota-empty">No quota data yet. Click "Check all" first.</div>';
    return;
  }

  els.quotaGrid.innerHTML = visible
    .map((row) => {
      const bars = row.check.quotaBars || [];
      const fallback = row.check.status === "ok"
        ? '<div class="quota-empty-inner">No detailed quota fields in usage response</div>'
        : `<div class="quota-empty-inner">${escapeHtml(row.check.message || row.check.status)}</div>`;

      return `<article class="quota-card">
        <div class="quota-head">
          <span class="provider-pill">${escapeHtml(row.file.provider || "CPA")}</span>
          <strong title="${escapeHtml(row.file.id)}">${escapeHtml(shorten(row.file.id, 58))}</strong>
        </div>
        <div class="quota-plan">Account ${escapeHtml(shorten(row.file.chatgptAccountId || "-", 42))}</div>
        ${bars.length ? bars.map(renderQuotaBar).join("") : fallback}
      </article>`;
    })
    .join("");
}

function renderQuotaBar(bar) {
  const percent = Math.max(0, Math.min(100, Number(bar.percent) || 0));
  const reset = bar.resetAt ? `<span>${escapeHtml(formatShortDate(bar.resetAt))}</span>` : "";
  return `<div class="quota-row">
    <div class="quota-label">
      <strong>${escapeHtml(bar.label || "Quota")}</strong>
      <span>${percent}%</span>
      ${reset}
    </div>
    <div class="quota-track">
      <div class="quota-fill" style="width:${percent}%"></div>
    </div>
  </div>`;
}

function renderTable(rows) {
  if (rows.length === 0) {
    els.fileTable.innerHTML = '<tr><td colspan="10" class="empty">No matching data</td></tr>';
    return;
  }

  els.fileTable.innerHTML = rows
    .map((row) => {
      if (row.instanceError) {
        return `<tr>
          <td class="mono-strong">${escapeHtml(row.instance.name)}</td>
          <td colspan="9"><span class="tag danger">Instance error</span> ${escapeHtml(row.instanceError.message || "unknown error")}</td>
        </tr>`;
      }

      const file = row.file;
      const check = row.check;
      const status = check ? check.status : "unchecked";
      return `<tr>
        <td class="mono-strong">${escapeHtml(row.instance.name)}</td>
        <td title="${escapeHtml(file.id)}">${escapeHtml(shorten(file.id, 26))}</td>
        <td>${escapeHtml(file.provider)}</td>
        <td>${escapeHtml(String(file.authIndex))}</td>
        <td>${file.disabled ? '<span class="tag warn">true</span>' : '<span class="tag neutral">false</span>'}</td>
        <td title="${escapeHtml(file.chatgptAccountId)}">${escapeHtml(shorten(file.chatgptAccountId || "-", 24))}</td>
        <td>${statusTag(status)}</td>
        <td>${check && check.statusCode ? check.statusCode : "-"}</td>
        <td>${check ? `${check.latencyMs}ms` : "-"}</td>
        <td title="${escapeHtml(check ? check.message || "" : "")}">${escapeHtml(shorten(check ? check.message || "" : "Unchecked", 48))}</td>
      </tr>`;
    })
    .join("");
}

function getFilteredRows() {
  const instanceId = els.instanceFilter.value;
  const status = els.statusFilter.value;
  const disabled = els.disabledFilter.value;
  const onlyProblems = els.onlyProblems.checked;
  const query = els.searchInput.value.trim().toLowerCase();

  return state.rows.filter((row) => {
    if (instanceId && row.instance.id !== instanceId) return false;
    if (row.instanceError) return true;
    if (!row.file) return false;

    const rowStatus = row.check ? row.check.status : "unchecked";
    if (status && rowStatus !== status) return false;
    if (disabled && String(Boolean(row.file.disabled)) !== disabled) return false;
    if (onlyProblems && !["invalid_401", "limited_or_forbidden", "upstream_error", "check_error"].includes(rowStatus)) {
      return false;
    }
    if (query) {
      const text = `${row.instance.name} ${row.instance.id} ${row.file.id} ${row.file.provider} ${row.file.authIndex} ${row.file.chatgptAccountId}`.toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  });
}

function summarizeRows(rows) {
  const summary = emptySummary();
  const seenInstances = new Map();

  for (const row of rows) {
    if (!seenInstances.has(row.instance.id)) {
      seenInstances.set(row.instance.id, row.instanceError ? "error" : "ok");
    } else if (row.instanceError) {
      seenInstances.set(row.instance.id, "error");
    }

    if (!row.file) continue;
    summary.totalFiles += 1;
    if (row.file.disabled) summary.disabled += 1;

    const status = row.check ? row.check.status : "unchecked";
    if (status !== "unchecked" && status !== "skipped") summary.checked += 1;
    if (status === "ok") summary.ok += 1;
    if (status === "invalid_401") summary.invalid401 += 1;
    if (status === "limited_or_forbidden") summary.limitedOrForbidden += 1;
    if (status === "skipped") summary.skipped += 1;
    if (status === "unchecked") summary.unchecked += 1;
    if (status === "upstream_error" || status === "check_error") summary.errors += 1;
  }

  summary.instances = seenInstances.size || state.instances.length;
  summary.errorInstances = [...seenInstances.values()].filter((value) => value === "error").length;
  summary.healthyInstances = Math.max(0, summary.instances - summary.errorInstances);
  return summary;
}

function emptySummary() {
  return {
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
  };
}

function statusTag(status) {
  const map = {
    ok: ["ok", "OK"],
    invalid_401: ["danger", "401"],
    limited_or_forbidden: ["warn", "Limited"],
    upstream_error: ["danger", "Upstream"],
    check_error: ["danger", "Error"],
    skipped: ["neutral", "Skipped"],
    unchecked: ["neutral", "Unchecked"],
  };
  const [cls, label] = map[status] || ["neutral", status];
  return `<span class="tag ${cls}">${label}</span>`;
}

async function apiGet(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  return readApiResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  return readApiResponse(response);
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok === false) {
    const message = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload.data;
}

function setBusy(busy, label = "Working") {
  els.refreshBtn.disabled = busy;
  els.checkBtn.disabled = busy;
  els.refreshBtn.textContent = busy ? label : "Refresh list";
  els.checkBtn.textContent = busy ? label : "Check all";
}

function renderError(error) {
  els.apiStatus.textContent = "error";
  log("error", error.message || "Unknown error");
  if (state.rows.length === 0) {
    els.fileTable.innerHTML = `<tr><td colspan="10" class="empty">${escapeHtml(error.message || "Load failed")}</td></tr>`;
  }
}

function log(type, message) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<strong>[${escapeHtml(type)}]</strong> ${escapeHtml(new Date().toLocaleTimeString("zh-CN", { hour12: false }))} ${escapeHtml(message)}`;
  els.logOutput.prepend(line);
  while (els.logOutput.children.length > 50) {
    els.logOutput.removeChild(els.logOutput.lastChild);
  }
}

function exportJson() {
  const data = {
    exportedAt: new Date().toISOString(),
    config: {
      targetUrl: state.config && state.config.targetUrl,
      instances: state.instances,
    },
    summary: summarizeRows(state.rows),
    rows: state.rows,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cpa-monitor-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function shorten(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
