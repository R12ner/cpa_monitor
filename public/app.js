const CACHE_KEY = "cpa-monitor:snapshot:v2";
const FILTER_KEY = "cpa-monitor:filters:v2";
const WINDOW_KEY = "cpa-monitor:windows:v1";
const THEME_KEY = "cpa-monitor:theme:v1";
const SESSION_KEY = "cpa-monitor:session:v1";
const COMPONENT_KEY = "cpa-monitor:components:v1";
const ENDPOINT_KEY = "cpa-monitor:endpoints:v1";
const GLOBAL_SETTINGS_FALLBACK_KEY = "cpa-monitor:global-settings-fallback:v1";
const CACHE_TTL_MS = 10 * 60 * 1000;

const WINDOW_TITLES = {
  quota: "Codex 额度",
  filters: "筛选",
  "auth-files": "认证文件",
  logs: "日志",
};

const state = {
  config: null,
  instances: [],
  rows: [],
  checks: new Map(),
  summary: emptySummary(),
  lastCheckedAt: null,
  loadedFromCache: false,
  globalSettings: {},
  settingsPersisted: false,
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
  pageSizeSelect: document.getElementById("pageSizeSelect"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  pageInfo: document.getElementById("pageInfo"),
  quotaCount: document.getElementById("quotaCount"),
  quotaWindowTitle: document.getElementById("quotaWindowTitle"),
  quotaHeading: document.getElementById("quotaHeading"),
  quotaGrid: document.getElementById("quotaGrid"),
  quotaMode: document.getElementById("quotaMode"),
  cacheStatus: document.getElementById("cacheStatus"),
  logOutput: document.getElementById("logOutput"),
  checkBtn: document.getElementById("checkBtn"),
  windowDock: document.getElementById("windowDock"),
  themeToggle: document.getElementById("themeToggle"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  settingsDrawer: document.getElementById("settingsDrawer"),
  settingsClose: document.getElementById("settingsClose"),
  adminToggle: document.getElementById("adminToggle"),
  loginScreen: document.getElementById("loginScreen"),
  loginForm: document.getElementById("loginForm"),
  passwordInput: document.getElementById("passwordInput"),
  loginError: document.getElementById("loginError"),
  endpointName: document.getElementById("endpointName"),
  endpointBaseUrl: document.getElementById("endpointBaseUrl"),
  endpointAccessKey: document.getElementById("endpointAccessKey"),
  addEndpointBtn: document.getElementById("addEndpointBtn"),
  endpointList: document.getElementById("endpointList"),
};

let sessionToken = localStorage.getItem(SESSION_KEY) || "";
let loginRequired = false;

boot();

async function boot() {
  bindEvents();
  applyComponentSettings();
  restoreFilters();
  restoreSnapshot();

  try {
    await loadSessionState();
    await loadGlobalSettings();
    applyComponentSettings();
    restoreWindowState();
    renderWindowDock();
    log("init", "加载 Worker 配置");
    await loadConfig();
    log("cache", state.rows.length ? "已加载公开缓存页面" : "暂无公开缓存，请登录后台后刷新数据");
    render();
  } catch (error) {
    renderError(error);
  }
}

function bindEvents() {
  initTheme();
  initWindowManager();
  initResponsiveWindows();
  initSettings();
  initLogin();
  renderEndpointList();

  els.checkBtn?.addEventListener("click", checkAll);

  for (const input of [els.instanceFilter, els.statusFilter, els.disabledFilter, els.searchInput, els.onlyProblems, els.quotaMode]) {
    input?.addEventListener("change", () => {
      if (input !== els.quotaMode) setCurrentPage(1, { renderNow: false });
      saveFilters();
      render();
    });
  }
  els.searchInput?.addEventListener("input", () => {
    setCurrentPage(1, { renderNow: false });
    saveFilters();
    render();
  });
  els.pageSizeSelect?.addEventListener("change", () => {
    setCurrentPage(1, { renderNow: false });
    saveFilters();
    render();
  });
  els.prevPageBtn?.addEventListener("click", () => {
    setCurrentPage(getCurrentPage() - 1);
  });
  els.nextPageBtn?.addEventListener("click", () => {
    setCurrentPage(getCurrentPage() + 1);
  });

  document.querySelectorAll("[data-target-kind]").forEach((button) => button.classList.add("active"));
}

function initResponsiveWindows() {
  const sync = () => {
    const compact = window.matchMedia("(max-width: 760px), (pointer: coarse)").matches;
    document.querySelectorAll(".window-panel").forEach((panel) => {
      panel.draggable = !compact;
    });
  };
  sync();
  window.addEventListener("resize", sync, { passive: true });
}

function initTheme() {
  setTheme(localStorage.getItem(THEME_KEY) || "light");
  els.themeToggle?.addEventListener("click", () => {
    setTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
  });
}

function setTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem(THEME_KEY, nextTheme);
  const icon = els.themeToggle?.querySelector("i");
  if (icon) {
    icon.className = nextTheme === "dark" ? "ph-bold ph-sun" : "ph-bold ph-moon";
  } else if (els.themeToggle) {
    els.themeToggle.dataset.icon = nextTheme === "dark" ? "sun" : "moon";
  }
}

function initLogin() {
  els.loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    els.loginError.textContent = "";
    try {
      const data = await apiPost("/api/session", { password: els.passwordInput.value }, { skipAuth: true });
      sessionToken = data.token || "";
      localStorage.setItem(SESSION_KEY, sessionToken);
      els.loginScreen.hidden = true;
      els.passwordInput.value = "";
      updateAdminState();
      await loadGlobalSettings();
      applyComponentSettings();
      restoreWindowState();
      renderWindowDock();
      await loadConfig();
      await refreshList({ force: false });
    } catch (error) {
      els.loginError.textContent = error.message || "登录失败";
    }
  });
}

async function openAdminLogin() {
  await loadSessionState();

  if (sessionToken && loginRequired) {
    logoutAdmin();
    return;
  }

  if (!loginRequired) {
    updateAdminState();
    return;
  }

  els.loginError.textContent = "";
  els.loginScreen.hidden = false;
  els.passwordInput.focus();
}

async function loadSessionState() {
  try {
    const session = await apiGet("/api/session", { skipAuth: true });
    loginRequired = Boolean(session.loginRequired);
    updateAdminState();
  } catch (error) {
    log("warn", `登录状态读取失败: ${error.message || "unknown"}`);
  }
}

async function loadGlobalSettings() {
  const fallback = readLocalGlobalSettings();
  if (fallback && Object.keys(fallback).length > 0) {
    state.globalSettings = fallback;
  }

  try {
    const settings = await apiGet("/api/settings");
    const remoteSettings = settings || {};
    const remoteHasSettings = hasStoredGlobalSettings(remoteSettings);
    const fallbackHasSettings = hasStoredGlobalSettings(fallback);
    if (remoteSettings.persisted && sessionToken && !remoteHasSettings && fallbackHasSettings) {
      state.globalSettings = fallback;
      await saveGlobalSettings();
      return;
    }

    state.globalSettings = remoteHasSettings ? remoteSettings : { ...fallback, ...remoteSettings };
    state.settingsPersisted = Boolean(settings && settings.persisted);
    localStorage.setItem(GLOBAL_SETTINGS_FALLBACK_KEY, JSON.stringify(state.globalSettings));
  } catch (error) {
    log("warn", `全局设置读取失败，已使用本地设置: ${error.message || "unknown"}`);
  }
}

function hasStoredGlobalSettings(settings) {
  return Boolean(
    settings &&
      ((settings.components && Object.keys(settings.components).length > 0) ||
        (settings.windows && Object.keys(settings.windows).length > 0) ||
        (Array.isArray(settings.endpoints) && settings.endpoints.length > 0)),
  );
}

function readLocalGlobalSettings() {
  const settings = {};
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(GLOBAL_SETTINGS_FALLBACK_KEY) || "{}"));
  } catch {
    // Ignore invalid fallback settings.
  }
  try {
    if (!settings.components) settings.components = JSON.parse(localStorage.getItem(COMPONENT_KEY) || "null");
  } catch {
    // Ignore invalid legacy component settings.
  }
  try {
    if (!settings.windows) settings.windows = JSON.parse(localStorage.getItem(WINDOW_KEY) || "null");
  } catch {
    // Ignore invalid legacy window settings.
  }
  try {
    if (!settings.endpoints) settings.endpoints = JSON.parse(localStorage.getItem(ENDPOINT_KEY) || "null");
  } catch {
    // Ignore invalid legacy endpoint settings.
  }
  if (!settings.components) delete settings.components;
  if (!settings.windows) delete settings.windows;
  if (!settings.endpoints) delete settings.endpoints;
  return settings;
}

function collectGlobalSettings() {
  return {
    components: readComponentSettings(),
    windows: readWindowState(),
    endpoints: readEndpoints(),
  };
}

async function saveGlobalSettings() {
  state.globalSettings = collectGlobalSettings();
  localStorage.setItem(GLOBAL_SETTINGS_FALLBACK_KEY, JSON.stringify(state.globalSettings));

  if (loginRequired && !sessionToken) return;

  try {
    const saved = await apiPost("/api/settings", state.globalSettings);
    state.settingsPersisted = Boolean(saved && saved.persisted);
    if (saved) {
      state.globalSettings = {
        components: saved.components || state.globalSettings.components,
        windows: saved.windows || state.globalSettings.windows,
        endpoints: saved.endpoints || state.globalSettings.endpoints,
      };
      localStorage.setItem(GLOBAL_SETTINGS_FALLBACK_KEY, JSON.stringify(state.globalSettings));
    }
    if (!state.settingsPersisted) {
      log("warn", "全局设置未绑定 KV，当前只能保存在本地浏览器");
    }
  } catch (error) {
    log("warn", `全局设置保存失败: ${error.message || "unknown"}`);
  }
}

function logoutAdmin() {
  sessionToken = "";
  localStorage.removeItem(SESSION_KEY);
  setSettingsOpen(false);
  updateAdminState();
  log("auth", "已退出管理员模式");
}

async function withAdmin(action) {
  if (loginRequired && !sessionToken) {
    openAdminLogin();
    return;
  }
  await action();
}

function updateAdminState() {
  const isAdmin = Boolean(sessionToken) || !loginRequired;
  document.body.classList.toggle("is-admin", isAdmin);
  els.adminToggle?.classList.toggle("logged-in", isAdmin);
  if (els.adminToggle) {
    els.adminToggle.title = sessionToken && loginRequired ? "退出管理员" : "后台登录";
    els.adminToggle.setAttribute("aria-label", sessionToken && loginRequired ? "退出管理员" : "后台登录");
    const icon = els.adminToggle.querySelector("i");
    if (icon) icon.className = sessionToken && loginRequired ? "ph-bold ph-sign-out" : "ph-bold ph-user";
  }
}

function initSettings() {
  els.adminToggle?.addEventListener("click", openAdminLogin);
  els.settingsToggle?.addEventListener("click", () => withAdmin(() => setSettingsOpen(true)));
  els.settingsClose?.addEventListener("click", () => setSettingsOpen(false));
  els.settingsOverlay?.addEventListener("click", () => setSettingsOpen(false));

  document.querySelectorAll("[data-component-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      const settings = readComponentSettings();
      settings[input.dataset.componentToggle] = input.checked;
      localStorage.setItem(COMPONENT_KEY, JSON.stringify(settings));
      state.globalSettings.components = settings;
      saveGlobalSettings();
      applyComponentSettings();
    });
  });

  els.addEndpointBtn?.addEventListener("click", addOrUpdateEndpoint);
}

function setSettingsOpen(open) {
  if (els.settingsOverlay) els.settingsOverlay.hidden = !open;
  if (els.settingsDrawer) els.settingsDrawer.hidden = !open;
}

function readComponentSettings() {
  const defaults = {
    quota: true,
    filters: true,
    "auth-files": true,
    logs: true,
    metrics: true,
    hero: true,
  };
  if (state.globalSettings?.components) {
    return { ...defaults, ...state.globalSettings.components };
  }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(COMPONENT_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function applyComponentSettings() {
  const settings = readComponentSettings();
  document.querySelectorAll(".configurable-panel[data-component]").forEach((panel) => {
    panel.hidden = settings[panel.dataset.component] === false;
  });
  document.querySelectorAll("[data-component-toggle]").forEach((input) => {
    input.checked = settings[input.dataset.componentToggle] !== false;
  });
}

function readEndpoints() {
  if (Array.isArray(state.globalSettings?.endpoints)) {
    return state.globalSettings.endpoints.filter((item) => item && item.baseUrl && item.accessKey);
  }
  try {
    return JSON.parse(localStorage.getItem(ENDPOINT_KEY) || "[]").filter((item) => item && item.baseUrl && item.accessKey);
  } catch {
    return [];
  }
}

function saveEndpoints(endpoints) {
  localStorage.setItem(ENDPOINT_KEY, JSON.stringify(endpoints));
  state.globalSettings.endpoints = endpoints;
  saveGlobalSettings();
  renderEndpointList();
}

function addOrUpdateEndpoint() {
  const name = els.endpointName.value.trim();
  const baseUrl = els.endpointBaseUrl.value.trim().replace(/\/+$/, "");
  const accessKey = els.endpointAccessKey.value.trim();
  if (!baseUrl || !accessKey) {
    log("warn", "端点 URL 和管理密钥不能为空");
    return;
  }

  const endpoints = readEndpoints();
  const id = slugify(name || baseUrl);
  const next = { id, name: name || id, baseUrl, accessKey, enabled: true };
  const index = endpoints.findIndex((item) => item.id === id);
  if (index >= 0) endpoints[index] = next;
  else endpoints.push(next);
  saveEndpoints(endpoints);

  els.endpointName.value = "";
  els.endpointBaseUrl.value = "";
  els.endpointAccessKey.value = "";
  log("ok", `端点已保存: ${next.name}`);
}

function renderEndpointList() {
  if (!els.endpointList) return;
  const endpoints = readEndpoints();
  const configured = state.config?.instances || state.instances || [];
  const blocks = [];

  if (configured.length > 0) {
    blocks.push('<div class="endpoint-section-title">环境变量中的 CPA</div>');
    blocks.push(
      ...configured.map(
        (item) => `<div class="endpoint-item endpoint-item-readonly">
        <div>
          <strong>${escapeHtml(item.name || item.id)}</strong>
          <span>${escapeHtml(item.baseUrl || "-")}</span>
          <em>ID: ${escapeHtml(item.id || "-")}</em>
        </div>
        <b class="endpoint-badge">已配置</b>
      </div>`,
      ),
    );
  }

  if (endpoints.length > 0) {
    blocks.push('<div class="endpoint-section-title">浏览器本地添加</div>');
    blocks.push(
      ...endpoints.map(
        (item) => `<div class="endpoint-item">
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.baseUrl)}</span>
          <em>ID: ${escapeHtml(item.id)} · 密钥已保存在本地浏览器</em>
        </div>
        <button type="button" data-delete-endpoint="${escapeHtml(item.id)}">删除</button>
      </div>`,
      ),
    );
  }

  if (blocks.length === 0) {
    blocks.push('<div class="endpoint-empty">暂无 CPA 端点。请添加本地端点，或在环境变量中配置 CPA_BASE_URL / CPA_ACCESS_KEY。</div>');
  }

  els.endpointList.innerHTML = blocks.join("");
  els.endpointList.querySelectorAll("[data-delete-endpoint]").forEach((button) => {
    button.addEventListener("click", () => {
      saveEndpoints(endpoints.filter((item) => item.id !== button.dataset.deleteEndpoint));
    });
  });
}

function endpointQuery() {
  const endpoints = readEndpoints();
  if (endpoints.length === 0) return "";
  return `?instances=${encodeURIComponent(JSON.stringify(endpoints))}`;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `endpoint-${Date.now()}`;
}

function initWindowManager() {
  restoreWindowState();
  renderWindowDock();

  document.querySelectorAll(".window-panel").forEach((panel) => {
    const titleBar = panel.querySelector(".title-bar");

    panel.addEventListener("dragstart", (event) => {
      if (!event.target.closest(".title-bar") || event.target.closest("[data-window-action]")) {
        event.preventDefault();
        return;
      }
      panel.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", panel.dataset.window);
    });

    panel.addEventListener("dragend", () => {
      panel.classList.remove("dragging");
      persistWindowState();
    });

    panel.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });

    panel.addEventListener("drop", (event) => {
      event.preventDefault();
      const sourceId = event.dataTransfer.getData("text/plain");
      const source = document.querySelector(`.window-panel[data-window="${cssEscape(sourceId)}"]`);
      if (!source || source === panel) return;

      const rect = panel.getBoundingClientRect();
      const placeAfter = event.clientY > rect.top + rect.height / 2;
      panel.parentElement.insertBefore(source, placeAfter ? panel.nextSibling : panel);
      persistWindowState();
    });

    titleBar?.addEventListener("dblclick", (event) => {
      if (!event.target.closest("[data-window-action]")) toggleMaximize(panel);
    });

    panel.querySelectorAll("[data-window-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.windowAction;
        if (action === "close") closeWindow(panel);
        if (action === "minimize") minimizeWindow(panel);
        if (action === "maximize") toggleMaximize(panel);
      });
    });
  });
}

function closeWindow(panel) {
  panel.classList.remove("maximized", "minimizing", "restoring", "maximizing", "unmaximizing");
  panel.hidden = true;
  refreshMaximizedClass();
  persistWindowState({ persistClosed: false });
}

function minimizeWindow(panel) {
  if (panel.dataset.animating === "true") return;
  panel.dataset.animating = "true";
  setWindowAnimationActive(true);
  panel.classList.remove("maximized", "maximizing", "unmaximizing", "restoring");
  refreshMaximizedClass();

  const fromRect = panel.getBoundingClientRect();
  const clone = createWindowAnimationClone(panel, fromRect);
  panel.hidden = true;
  panel.dataset.minimized = "true";
  persistWindowState();
  renderWindowDock();

  animateRectElementTo(clone, fromRect, getDockTargetRect(), { opacityOut: true, duration: 320 }).finally(() => {
    clone.remove();
    panel.dataset.animating = "false";
    setWindowAnimationActive(false);
  }, 380);
}

function restoreWindow(id) {
  const panel = document.querySelector(`.window-panel[data-window="${cssEscape(id)}"]`);
  if (!panel) return;
  if (panel.dataset.animating === "true") return;
  panel.dataset.animating = "true";
  setWindowAnimationActive(true);
  panel.hidden = false;
  panel.classList.remove("minimizing", "maximizing", "unmaximizing", "restoring");
  panel.classList.add("window-animating-panel");
  panel.dataset.minimized = "false";
  animatePanelFromRect(panel, getDockTargetRect(), { opacityIn: true, duration: 360 }).finally(() => {
    panel.classList.remove("window-animating-panel");
    panel.dataset.animating = "false";
    setWindowAnimationActive(false);
    persistWindowState();
    renderWindowDock();
  });
}

function toggleMaximize(panel) {
  if (panel.dataset.animating === "true") return;
  const isMaximized = panel.classList.contains("maximized");

  for (const item of document.querySelectorAll(".window-panel.maximized")) {
    if (item !== panel) item.classList.remove("maximized", "maximizing", "unmaximizing");
  }

  panel.dataset.animating = "true";
  setWindowAnimationActive(true);
  if (isMaximized) {
    const fromRect = panel.getBoundingClientRect();
    panel.classList.remove("maximized", "maximizing", "unmaximizing");
    refreshMaximizedClass();
    const toRect = panel.getBoundingClientRect();
    panel.classList.add("window-animating-panel");
    animatePanelFlip(panel, fromRect, toRect, { duration: 300 }).finally(() => {
      panel.classList.remove("window-animating-panel");
      panel.dataset.animating = "false";
      setWindowAnimationActive(false);
      refreshMaximizedClass();
      persistWindowState();
      renderWindowDock();
    });
  } else {
    const fromRect = panel.getBoundingClientRect();
    panel.hidden = false;
    panel.dataset.minimized = "false";
    panel.classList.remove("unmaximizing", "restoring", "maximizing");
    panel.classList.add("maximized", "window-animating-panel");
    refreshMaximizedClass();
    const toRect = panel.getBoundingClientRect();
    animatePanelFlip(panel, fromRect, toRect, { duration: 330 }).finally(() => {
      panel.classList.remove("window-animating-panel");
      panel.dataset.animating = "false";
      setWindowAnimationActive(false);
      refreshMaximizedClass();
      persistWindowState();
      renderWindowDock();
    });
  }
  refreshMaximizedClass();
}

function refreshMaximizedClass() {
  document.body.classList.toggle("has-maximized-window", Boolean(document.querySelector(".window-panel.maximized")));
}

function setWindowAnimationActive(active) {
  document.body.classList.toggle("window-animating", active);
}

function getDockTargetRect() {
  const dock = els.windowDock && !els.windowDock.hidden ? els.windowDock.getBoundingClientRect() : null;
  const width = Math.min(140, Math.max(92, window.innerWidth * 0.18));
  const height = 36;
  return {
    left: dock ? dock.left + 10 : 18,
    top: dock ? dock.top + 8 : window.innerHeight - height - 18,
    width,
    height,
  };
}

function animatePanelToRect(panel, targetRect, options = {}) {
  const fromRect = panel.getBoundingClientRect();
  const toRect = {
    left: targetRect.left,
    top: targetRect.top,
    width: targetRect.width,
    height: targetRect.height,
  };
  return animatePanelTransform(panel, fromRect, toRect, {
    direction: "out",
    duration: options.duration || 320,
    opacityOut: options.opacityOut,
  });
}

function animatePanelFromRect(panel, sourceRect, options = {}) {
  const toRect = panel.getBoundingClientRect();
  const fromRect = {
    left: sourceRect.left,
    top: sourceRect.top,
    width: sourceRect.width,
    height: sourceRect.height,
  };
  return animatePanelTransform(panel, fromRect, toRect, {
    direction: "in",
    duration: options.duration || 360,
    opacityIn: options.opacityIn,
  });
}

function animatePanelFlip(panel, fromRect, toRect, options = {}) {
  return animatePanelTransform(panel, fromRect, toRect, {
    direction: "in",
    duration: options.duration || 320,
  });
}

function animatePanelTransform(panel, fromRect, toRect, options) {
  const invertScaleX = fromRect.width && toRect.width ? fromRect.width / toRect.width : 1;
  const invertScaleY = fromRect.height && toRect.height ? fromRect.height / toRect.height : 1;
  const outScaleX = fromRect.width ? toRect.width / fromRect.width : 1;
  const outScaleY = fromRect.height ? toRect.height / fromRect.height : 1;
  const invert = `translate3d(${fromRect.left - toRect.left}px, ${fromRect.top - toRect.top}px, 0) scale(${invertScaleX}, ${invertScaleY})`;
  const target = `translate3d(${toRect.left - fromRect.left}px, ${toRect.top - fromRect.top}px, 0) scale(${outScaleX}, ${outScaleY})`;
  const identity = "translate3d(0, 0, 0) scale(1, 1)";
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
  const duration = options.duration || 320;
  const keyframes =
    options.direction === "out"
      ? [
          { transform: identity, opacity: 1 },
          { transform: target, opacity: options.opacityOut ? 0.18 : 1 },
        ]
      : [
          { transform: invert, opacity: options.opacityIn ? 0.18 : 1 },
          { transform: identity, opacity: 1 },
        ];

  panel.style.transformOrigin = "top left";
  const animation = panel.animate(keyframes, { duration, easing, fill: "both" });
  return animation.finished
    .catch(() => null)
    .finally(() => {
      animation.cancel();
      panel.style.transformOrigin = "";
    });
}

function createWindowAnimationClone(panel, rect) {
  const clone = panel.cloneNode(true);
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((item) => item.removeAttribute("id"));
  clone.setAttribute("aria-hidden", "true");
  clone.classList.add("window-animating-panel", "window-animation-clone");
  Object.assign(clone.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    zIndex: "120",
    pointerEvents: "none",
  });
  document.body.appendChild(clone);
  return clone;
}

function animateRectElementTo(element, fromRect, toRect, options = {}) {
  const outScaleX = fromRect.width ? toRect.width / fromRect.width : 1;
  const outScaleY = fromRect.height ? toRect.height / fromRect.height : 1;
  const target = `translate3d(${toRect.left - fromRect.left}px, ${toRect.top - fromRect.top}px, 0) scale(${outScaleX}, ${outScaleY})`;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
  const duration = options.duration || 320;
  element.style.transformOrigin = "top left";
  const animation = element.animate(
    [
      { transform: "translate3d(0, 0, 0) scale(1, 1)", opacity: 1 },
      { transform: target, opacity: options.opacityOut ? 0.18 : 1 },
    ],
    { duration, easing, fill: "both" },
  );
  return animation.finished.catch(() => null).finally(() => animation.cancel());
}

function restoreWindowState() {
  try {
    const saved = state.globalSettings?.windows || JSON.parse(localStorage.getItem(WINDOW_KEY) || "null");
    if (!saved) return;
    const main = document.querySelector(".main");
    for (const id of saved.order || []) {
      const panel = document.querySelector(`.window-panel[data-window="${cssEscape(id)}"]`);
      if (panel) main.appendChild(panel);
    }

    for (const [id, view] of Object.entries(saved.views || {})) {
      const panel = document.querySelector(`.window-panel[data-window="${cssEscape(id)}"]`);
      if (!panel) continue;
      panel.dataset.minimized = view.minimized ? "true" : "false";
      panel.hidden = Boolean(view.minimized);
    }
  } catch {
    localStorage.removeItem(WINDOW_KEY);
  }
}

function readWindowState(options = {}) {
  const persistClosed = options.persistClosed !== false;
  const panels = [...document.querySelectorAll(".window-panel")];
  const views = {};

  for (const panel of panels) {
    const minimized = panel.dataset.minimized === "true";
    views[panel.dataset.window] = {
      minimized,
      closed: persistClosed ? Boolean(panel.hidden && !minimized) : false,
    };
  }

  return {
    order: panels.map((panel) => panel.dataset.window),
    views,
  };
}

function persistWindowState(options = {}) {
  const windowState = readWindowState(options);
  localStorage.setItem(WINDOW_KEY, JSON.stringify(windowState));
  state.globalSettings.windows = windowState;
  saveGlobalSettings();
}

function renderWindowDock() {
  if (!els.windowDock) return;
  const minimized = [...document.querySelectorAll(".window-panel")]
    .filter((panel) => panel.dataset.minimized === "true")
    .map((panel) => panel.dataset.window);

  els.windowDock.innerHTML = minimized
    .map((id) => `<button type="button" data-restore-window="${escapeHtml(id)}">${escapeHtml(WINDOW_TITLES[id] || id)}</button>`)
    .join("");

  els.windowDock.hidden = minimized.length === 0;
  els.windowDock.querySelectorAll("[data-restore-window]").forEach((button) => {
    button.addEventListener("click", () => restoreWindow(button.dataset.restoreWindow));
  });
}

async function loadConfig() {
  const [health, config] = await Promise.all([
    apiGet("/api/health", { skipAuth: true }),
    apiGet("/api/config", { skipAuth: true }),
  ]);
  loginRequired = Boolean(config.loginRequired || loginRequired);
  updateAdminState();
  state.config = config;
  state.instances = mergeInstanceMeta(state.instances, config.instances || []);

  els.apiStatus.textContent = health.status || "ok";
  els.timeoutMs.textContent = `${config.timeoutMs}ms`;
  els.concurrency.textContent = String(config.concurrency);
  els.skipDisabled.textContent = config.skipDisabled ? "true" : "false";
  els.configNote.textContent = `${state.instances.length} 个 CPA 实例，目标: ${config.targetUrl}`;

  renderInstanceOptions();
  renderEndpointList();
  restoreFilters();
}

async function refreshList({ force }) {
  if (loginRequired && !sessionToken) {
    openAdminLogin();
    return;
  }

  if (!force && state.rows.length > 0 && !isCacheExpired()) {
    log("cache", "缓存仍有效，已跳过网络请求");
    render();
    return;
  }

  setBusy(true, "刷新中");
  try {
    log("fetch", "正在拉取 CPA 认证文件");
    const data = await apiGet(`/api/auth-files${endpointQuery()}`);
    ingestInstances(data.instances || [], false);
    state.lastCheckedAt = state.lastCheckedAt || new Date().toISOString();
    saveSnapshot();
    log("ok", `列表已加载: ${state.rows.length} 行`);
    render();
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

async function checkAll() {
  setBusy(true, "检测中");
  try {
    const instanceId = els.instanceFilter.value;
    log("check", instanceId ? `正在检测 ${targetLabel()} 实例 ${instanceId}` : `正在检测全部 ${targetLabel()} 实例`);
    const body = { instanceId };
    if (sessionToken) {
      body.instances = readEndpoints();
    } else if (readEndpoints().length > 0) {
      log("warn", "未登录时不会发送浏览器本地端点，只检测 Cloudflare 环境变量中的 CPA");
    }
    const data = await apiPost("/api/check-all", body);
    ingestInstances(data.instances || [], true);
    state.summary = data.summary || summarizeRows(state.rows);
    state.lastCheckedAt = new Date().toISOString();
    saveSnapshot();
    log(
      "ok",
      data.cached
        ? `已使用 ${data.cacheSeconds || 60} 秒内缓存: 正常 ${state.summary.ok}, 401 ${state.summary.invalid401}, 错误 ${state.summary.errors}`
        : `检测完成: 正常 ${state.summary.ok}, 401 ${state.summary.invalid401}, 错误 ${state.summary.errors}`,
    );
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
    pageSize: els.pageSizeSelect?.value || "25",
    page: getCurrentPage(),
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
    document.querySelectorAll("[data-target-kind]").forEach((button) => button.classList.add("active"));
    if (els.pageSizeSelect) els.pageSizeSelect.value = filters.pageSize || "25";
    setCurrentPage(Number(filters.page || 1), { renderNow: false });
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
  els.instanceFilter.innerHTML = '<option value="">全部实例</option>';
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
  const paged = paginateRows(rows);
  const targetRows = state.rows.filter(rowMatchesCodex);
  const summary = summarizeRows(targetRows);
  const problems = summary.invalid401 + summary.limitedOrForbidden + summary.errors;

  els.sideHealthy.textContent = String(summary.healthyInstances);
  els.sideProblems.textContent = String(problems);
  if (els.problemBadge) els.problemBadge.textContent = String(problems);
  els.metricInstances.textContent = String(summary.instances);
  els.metricInstanceHint.textContent = `${summary.healthyInstances} 健康 / ${summary.errorInstances} 异常`;
  els.metricFiles.textContent = String(summary.totalFiles);
  els.metricOk.textContent = String(summary.ok);
  els.metricInvalid.textContent = String(summary.invalid401);
  els.metricLimited.textContent = String(summary.limitedOrForbidden);
  els.metricErrors.textContent = String(summary.errors);
  els.tableCount.textContent = `${rows.length} 行`;
  els.lastChecked.textContent = state.lastCheckedAt ? `最近检测 ${formatTime(state.lastCheckedAt)}` : "尚未检测";
  if (els.quotaWindowTitle) els.quotaWindowTitle.textContent = `${targetLabel()} 额度`;
  if (els.quotaHeading) els.quotaHeading.textContent = `${targetLabel()} 额度`;
  if (els.checkBtn) els.checkBtn.title = `检测 ${targetLabel()} 额度`;
  els.cacheStatus.textContent = state.loadedFromCache
    ? `已从浏览器缓存加载${state.lastCheckedAt ? `，${formatTime(state.lastCheckedAt)}` : ""}`
    : state.lastCheckedAt
      ? `已保存到浏览器缓存，${formatTime(state.lastCheckedAt)}`
      : "暂无缓存检测结果";

  renderQuotaCards(rows);
  renderPagination(rows.length);
  renderTable(paged.rows);
}

function renderQuotaCards(rows) {
  const usable = rows.filter((row) => row.file && !row.instanceError);
  const withQuota = usable.filter((row) => row.check && row.check.quotaBars && row.check.quotaBars.length > 0);
  const visible = els.quotaMode.value === "all" ? withQuota : withQuota.slice(0, 12);
  els.quotaCount.textContent = String(withQuota.length);

  if (withQuota.length === 0) {
    const checked = usable.filter((row) => row.check).length;
    els.quotaGrid.innerHTML = `<div class="empty quota-empty">${
      checked
        ? "最近的真实 usage 响应中没有可解析的额度字段。"
        : `暂无${targetLabel()}额度数据，请先点击“检测全部”。`
    }</div>`;
    return;
  }

  els.quotaGrid.innerHTML = visible
    .map((row) => {
      const bars = row.check.quotaBars || [];
      return `<article class="quota-card">
        <div class="quota-head">
          <span class="provider-pill">${escapeHtml(targetLabel())}</span>
          <strong title="${escapeHtml(row.file.id)}">${escapeHtml(shorten(row.file.id, 58))}</strong>
        </div>
        <div class="quota-plan">账号 ${escapeHtml(shorten(row.file.chatgptAccountId || "-", 42))}</div>
        ${bars.map(renderQuotaBar).join("")}
      </article>`;
    })
    .join("");
}

function renderQuotaBar(bar) {
  const usedPercent = Math.max(0, Math.min(100, Number(bar.percent) || 0));
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
  const level = remainingPercent >= 50 ? "good" : remainingPercent >= 20 ? "warn" : "danger";
  const reset = bar.resetAt ? `<span>${escapeHtml(formatShortDate(bar.resetAt))}</span>` : "";

  return `<div class="quota-row">
    <div class="quota-label">
      <strong>${escapeHtml(bar.label || "额度")}</strong>
      <span class="quota-percent ${level}">剩余 ${Math.round(remainingPercent)}%</span>
      ${reset}
    </div>
    <div class="quota-track">
      <div class="quota-fill ${level}" style="width:${remainingPercent}%"></div>
    </div>
  </div>`;
}

function renderTable(rows) {
  if (rows.length === 0) {
    els.fileTable.innerHTML = '<tr><td colspan="10" class="empty">没有符合条件的数据</td></tr>';
    return;
  }

  els.fileTable.innerHTML = rows
    .map((row) => {
      if (row.instanceError) {
        return `<tr>
          <td class="mono-strong">${escapeHtml(row.instance.name)}</td>
          <td colspan="9"><span class="tag danger">实例错误</span> ${escapeHtml(row.instanceError.message || "unknown error")}</td>
        </tr>`;
      }

      const file = row.file;
      const check = row.check;
      const status = check ? check.status : "unchecked";
      const mobileSummary = renderMobileRowSummary(row, status);
      return `<tr>
        <td class="mono-strong" data-cell="instance">${mobileSummary}${escapeHtml(row.instance.name)}</td>
        <td data-cell="file" title="${escapeHtml(file.id)}">${escapeHtml(shorten(file.id, 26))}</td>
        <td data-cell="provider">${escapeHtml(file.provider)}</td>
        <td data-cell="auth-index">${escapeHtml(String(file.authIndex))}</td>
        <td data-cell="disabled">${file.disabled ? '<span class="tag warn">true</span>' : '<span class="tag neutral">false</span>'}</td>
        <td data-cell="account" title="${escapeHtml(file.chatgptAccountId)}">${escapeHtml(shorten(file.chatgptAccountId || "-", 24))}</td>
        <td data-cell="status">${statusTag(status)}</td>
        <td data-cell="http">${check && check.statusCode ? check.statusCode : "-"}</td>
        <td data-cell="latency">${check ? `${check.latencyMs}ms` : "-"}</td>
        <td data-cell="message" title="${escapeHtml(check ? check.message || "" : "")}">${escapeHtml(shorten(check ? check.message || "" : "未检测", 48))}</td>
      </tr>`;
    })
    .join("");
}

function renderMobileRowSummary(row, status) {
  if (row.instanceError || !row.file) return "";
  const http = row.check && row.check.statusCode ? row.check.statusCode : "-";
  const latency = row.check ? `${row.check.latencyMs}ms` : "-";
  return `<div class="mobile-row-summary" aria-hidden="true">
    <div class="mobile-row-head">
      <strong>${escapeHtml(shorten(row.file.id, 28))}</strong>
      <span class="mobile-row-provider">${escapeHtml(row.file.provider || "-")}</span>
    </div>
    <div class="mobile-row-meta">
      ${statusTag(status)}
      <span class="mobile-chip">HTTP ${escapeHtml(String(http))}</span>
      <span class="mobile-chip">${escapeHtml(latency)}</span>
    </div>
  </div>`;
}

function getFilteredRows() {
  const instanceId = els.instanceFilter.value;
  const status = els.statusFilter.value;
  const disabled = els.disabledFilter.value;
  const onlyProblems = els.onlyProblems.checked;
  const query = els.searchInput.value.trim().toLowerCase();

  return state.rows.filter((row) => {
    if (!rowMatchesCodex(row)) return false;
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

function rowMatchesCodex(row) {
  if (row.instanceError) return true;
  if (!row.file) return false;
  const provider = String(row.file.provider || "").toLowerCase();
  const fileId = String(row.file.id || "").toLowerCase();
  const accountId = String(row.file.chatgptAccountId || "").toLowerCase();
  const isGemini = provider.includes("gemini") || fileId.startsWith("gemini-") || fileId.includes("/gemini");
  const isCodex = provider.includes("codex") || fileId.startsWith("codex-") || accountId.includes("chatgpt");
  return isCodex && !isGemini;
}

function targetLabel() {
  return "Codex";
}

function getCurrentPage() {
  return Math.max(1, Number(document.body.dataset.tablePage || 1));
}

function setCurrentPage(page, options = {}) {
  document.body.dataset.tablePage = String(Math.max(1, Number(page) || 1));
  if (options.renderNow !== false) {
    saveFilters();
    render();
  }
}

function getPageSize() {
  return Math.max(1, Number(els.pageSizeSelect?.value || 25));
}

function paginateRows(rows) {
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(getCurrentPage(), totalPages);
  document.body.dataset.tablePage = String(page);
  const start = (page - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    page,
    totalPages,
  };
}

function renderPagination(totalRows) {
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(getCurrentPage(), totalPages);
  document.body.dataset.tablePage = String(page);

  if (els.pageInfo) els.pageInfo.textContent = `${page} / ${totalPages}`;
  if (els.prevPageBtn) els.prevPageBtn.disabled = page <= 1;
  if (els.nextPageBtn) els.nextPageBtn.disabled = page >= totalPages;
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
    if (status === "upstream_error" || status === "check_error") {
      summary.errors += 1;
    }
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
    ok: ["ok", "正常"],
    invalid_401: ["danger", "401"],
    limited_or_forbidden: ["warn", "受限"],
    upstream_error: ["danger", "上游错误"],
    check_error: ["danger", "检测错误"],
    skipped: ["neutral", "已跳过"],
    unchecked: ["neutral", "未检测"],
  };
  const [cls, label] = map[status] || ["neutral", status];
  return `<span class="tag ${cls}">${label}</span>`;
}

async function apiGet(path, options = {}) {
  const response = await fetch(path, { headers: buildHeaders(options) });
  return readApiResponse(response);
}

async function apiPost(path, body, options = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: buildHeaders(options, true),
    body: JSON.stringify(body || {}),
  });
  return readApiResponse(response);
}

function buildHeaders(options = {}, json = false) {
  const headers = { Accept: "application/json" };
  if (json) headers["Content-Type"] = "application/json";
  if (!options.skipAuth && sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  return headers;
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok === false) {
    const message = payload && payload.error ? payload.error.message : `HTTP ${response.status}`;
    if (response.status === 401) {
      sessionToken = "";
      localStorage.removeItem(SESSION_KEY);
      els.loginScreen.hidden = false;
    }
    throw new Error(message);
  }
  return payload.data;
}

function setBusy(busy, label = "处理中") {
  if (!els.checkBtn) return;
  els.checkBtn.disabled = busy;
  els.checkBtn.classList.toggle("loading", busy);
  els.checkBtn.title = busy ? label : "检测全部";
}

function renderError(error) {
  els.apiStatus.textContent = "error";
  log("error", error.message || "未知错误");
  if (state.rows.length === 0) {
    els.fileTable.innerHTML = `<tr><td colspan="10" class="empty">${escapeHtml(error.message || "加载失败")}</td></tr>`;
  }
}

function log(type, message) {
  if (!els.logOutput) return;
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

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}
