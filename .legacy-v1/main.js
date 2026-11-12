import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const $ = (id) => document.getElementById(id);
const APP_NAME = "NanoSSH";
// 旧版把连接配置明文放在 localStorage，仅在首次启动时迁移到 Rust 侧加密存储
const LEGACY_PROFILES_KEY = "nanossh-profiles";
const THEME_KEY = "nanossh-theme";
const state = { tabs: [], activeId: null, seq: 0, cloneSeq: 0 };
const find = (id) => state.tabs.find((t) => t.id === id);
const SFTP_LOCAL_DIR_KEY = "nanossh-sftp-local-dir";
// 传输记录：最多 20 条，加密缓存到本机 transfers.enc；进度事件高频到达，只在状态变更时防抖写盘
const TRANSFER_LIMIT = 20;
const TRANSFER_SAVE_DELAY = 250;
const TRANSFER_FIELDS = [
  "job", "kind", "label", "count", "index", "file", "percent", "sent", "total",
  "state", "ok", "failed", "error", "targetDir", "at",
];

/* ---------- 内联 SVG 图标 ---------- */
const ICONS = {
  eye: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2C4.6 3.2 1.9 5.3 1 8c.9 2.7 3.6 4.8 7 4.8s6.1-2.1 7-4.8c-.9-2.7-3.6-4.8-7-4.8Zm0 7.6A2.8 2.8 0 1 1 8 5.2a2.8 2.8 0 0 1 0 5.6Zm0-1.4a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z" fill="currentColor"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2C4.6 3.2 1.9 5.3 1 8c.9 2.7 3.6 4.8 7 4.8s6.1-2.1 7-4.8c-.9-2.7-3.6-4.8-7-4.8Zm0 7.6A2.8 2.8 0 1 1 8 5.2a2.8 2.8 0 0 1 0 5.6Z" fill="currentColor" opacity=".4"/><path d="M2.2 2.2 13.8 13.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.1 2.5a1.4 1.4 0 0 1 2 2l-7.3 7.3-2.8.8.8-2.8 7.3-7.3Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="m10.3 3.3 2.4 2.4" stroke="currentColor" stroke-width="1.3"/></svg>',
  trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 4.5h9.2M6.2 4.5V3h3.6v1.5M4.8 4.5l.6 8.3h5.2l.6-8.3M6.7 7v3.6M9.3 7v3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 7V5.1a3.4 3.4 0 0 1 6.8 0V7M3.4 7h9.2v6.1H3.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.4" y="5.4" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.6 5.4V4.2c0-.9-.7-1.6-1.6-1.6H4.2c-.9 0-1.6.7-1.6 1.6v4.8c0 .9.7 1.6 1.6 1.6h1.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};

/* ---------- 主题 ---------- */
function terminalTheme() {
  const light = document.documentElement.dataset.theme === "light";
  return light
    ? { background: "#ffffff", foreground: "#1d2433", cursor: "#2f6fdb", selectionBackground: "#c9dcff" }
    : { background: "#14171d", foreground: "#d8dee9", cursor: "#4c8dff", selectionBackground: "#31456b" };
}

// 兼容旧版本 SSHTabs 的主题设置
document.documentElement.dataset.theme =
  localStorage.getItem(THEME_KEY) || localStorage.getItem("sshtabs-theme") || "dark";
$("btn-theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, root.dataset.theme);
  state.tabs.forEach((t) => { if (t.term) t.term.options.theme = terminalTheme(); });
});

/* ---------- 字节流 <-> base64（终端输出可能不是完整 UTF-8，必须按字节传） ---------- */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------- 复制标题：优先 WebView 剪贴板，失败降级到 execCommand ---------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function copyTitle(tab) {
  if (!tab) return toast("当前没有页签可复制", true);
  const ok = await copyText(tab.title);
  toast(ok ? `已复制标题：${tab.title}` : "复制失败，请检查剪贴板权限", !ok);
}

/* ---------- 轻提示 ---------- */
function toast(message, isError = false) {
  const node = document.createElement("div");
  node.className = "toast" + (isError ? " is-error" : "");
  node.textContent = message;
  $("toasts").appendChild(node);
  setTimeout(() => node.remove(), 2400);
}

function setStatus(text, kind) {
  $("status-text").textContent = text;
  $("status-dot").className = "statusbar__dot" + (kind ? ` is-${kind}` : "");
}

/* ---------- 密码显示 / 隐藏，返回刷新图标状态的函数 ---------- */
function bindSecretToggle(btn, input) {
  const paint = () => {
    const visible = input.type === "text";
    btn.innerHTML = visible ? ICONS.eyeOff : ICONS.eye;
    btn.title = visible ? "隐藏密码" : "显示密码";
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("is-on", visible);
  };
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    input.type = input.type === "password" ? "text" : "password";
    paint();
    input.focus();
  });
  paint();
  return paint;
}

/* ---------- 已保存的连接：Rust 侧 AES-256-GCM 加密存储 ---------- */
let profiles = [];

const uid = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const defaultTitle = (cfg) => cfg.title?.trim() || `${cfg.username}@${cfg.host}`;
function profileToConfig(p) {
  return {
    title: p.title || "", host: p.host || "", port: p.port || 22,
    username: p.username || "", password: p.password || "", privateKey: p.privateKey || "",
  };
}
function persistProfiles() {
  invoke("profiles_save", { json: JSON.stringify(profiles) })
    .catch((e) => toast(`连接保存失败：${e}`, true));
  renderProfiles();
}
function upsertProfile(p) {
  const i = profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) profiles[i] = { ...profiles[i], ...p };
  else profiles.push(p);
  persistProfiles();
}
function removeProfile(id) {
  profiles = profiles.filter((p) => p.id !== id);
  persistProfiles();
}

/** 启动时读取加密配置；顺带把旧版 localStorage 的明文数据迁移过来并删除 */
async function initProfiles() {
  try {
    const parsed = JSON.parse(await invoke("profiles_load") || "[]");
    if (Array.isArray(parsed) && parsed.length) {
      profiles = parsed;
    } else {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) || "[]");
      if (Array.isArray(legacy) && legacy.length) {
        profiles = legacy;
        await invoke("profiles_save", { json: JSON.stringify(profiles) });
        localStorage.removeItem(LEGACY_PROFILES_KEY);
        toast("已将旧版连接迁移到加密存储");
      }
    }
  } catch (e) {
    toast(`读取已保存的连接失败：${e}`, true);
    profiles = [];
  }
  renderProfiles();
}

function iconBtn(icon, label, run, extraClass = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `icon-op ${extraClass}`.trim();
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = ICONS[icon];
  b.addEventListener("click", (e) => { e.stopPropagation(); run(b); });
  return b;
}

/** 按名称 / 主机 / 用户名 / 端口过滤（忽略大小写） */
/** 按名称 / 主机 / 用户名 / 端口过滤（忽略大小写） */
function filteredProfiles(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return profiles;
  return profiles.filter((p) =>
    [defaultTitle(p), p.host, p.username, String(p.port || 22), p.privateKey || ""]
      .some((v) => v.toLowerCase().includes(q))
  );
}

/** 删除按钮的二次确认逻辑 */
function deleteProfileButton(p) {
  return iconBtn("trash", "删除", (b) => {
    if (b.dataset.confirm) {
      removeProfile(p.id);
      toast("已删除连接");
      return;
    }
    b.dataset.confirm = "1";
    b.classList.add("is-danger");
    b.title = "再次点击确认删除";
    toast("再次点击删除按钮以确认");
    setTimeout(() => {
      if (b.isConnected) {
        delete b.dataset.confirm;
        b.classList.remove("is-danger");
        b.title = "删除";
      }
    }, 3000);
  }, "icon-op--danger");
}

/** 复制出一份新连接（新 id、标题加「副本」），立即保存到加密列表并打开编辑弹窗 */
function duplicateProfile(p) {
  const dup = { ...p, id: uid(), title: `${defaultTitle(p)} 副本` };
  upsertProfile(dup);
  closePanels();
  openModal({
    profileId: dup.id, connectAfterSave: false,
    prefill: profileToConfig(dup), duplicate: true,
  });
  toast("已复制连接，修改后保存即可");
}

/** ☰ 管理面板条目：点击连接，右侧 复制 / 编辑 / 删除 三个图标常显 */
function manageRow(p) {
  const row = document.createElement("div");
  row.className = "profile";
  const info = document.createElement("div");
  info.className = "profile__info";
  const name = document.createElement("span");
  name.className = "profile__name";
  name.textContent = defaultTitle(p);
  const meta = document.createElement("span");
  meta.className = "profile__meta";
  meta.textContent = `${p.username}@${p.host}:${p.port || 22}${p.password || p.privateKey ? "" : " · 需填密码"}`;
  info.append(name, meta);

  const credential = p.password ? "密码已加密保存" : (p.privateKey ? "使用私钥" : "连接时需输入密码");
  const ops = document.createElement("div");
  ops.className = "profile__ops";
  ops.append(
    iconBtn("copy", "复制为新连接并编辑", () => duplicateProfile(p)),
    iconBtn("edit", "编辑", () => {
      closePanels();
      openModal({ profileId: p.id, connectAfterSave: false, prefill: profileToConfig(p) });
    }),
    deleteProfileButton(p),
  );
  row.append(info, ops);
  row.title = `点击直接连接（${credential}）；右侧图标可复制 / 编辑 / 删除`;
  row.addEventListener("click", () => connectProfile(p));
  return row;
}

/** ＋ 快捷面板条目：只有名称与目标，点击即连，无任何操作图标或说明 */
function quickRow(p) {
  const row = document.createElement("div");
  row.className = "profile profile--quick";
  const info = document.createElement("div");
  info.className = "profile__info";
  const name = document.createElement("span");
  name.className = "profile__name";
  name.textContent = defaultTitle(p);
  const meta = document.createElement("span");
  meta.className = "profile__meta";
  meta.textContent = `${p.username}@${p.host}:${p.port || 22}`;
  info.append(name, meta);
  row.append(info);
  row.title = "点击直接连接";
  row.addEventListener("click", () => connectProfile(p));
  return row;
}

/** 两个面板各有独立搜索框与列表，一次调用同时刷新 */
function renderProfiles() {
  const panels = [
    { input: "profiles-search-input", count: "profiles-search-count", list: "profiles-list",
      row: manageRow, empty: "还没有保存的连接。新建连接时勾选「保存到连接列表」即可。" },
    { input: "quick-search-input", count: "quick-search-count", list: "quick-list",
      row: quickRow, empty: "还没有保存的连接" },
  ];
  for (const panel of panels) {
    const list = $(panel.list);
    const q = $(panel.input).value.trim();
    const shown = filteredProfiles(q);
    $(panel.count).textContent = q ? `${shown.length}/${profiles.length}` : "";
    list.innerHTML = "";
    if (!profiles.length) {
      const tip = document.createElement("div");
      tip.className = "profiles__empty";
      tip.textContent = panel.empty;
      list.appendChild(tip);
    } else if (!shown.length) {
      const tip = document.createElement("div");
      tip.className = "profiles__empty";
      tip.textContent = `没有匹配「${q}」的连接`;
      list.appendChild(tip);
    } else {
      shown.forEach((item) => list.appendChild(panel.row(item)));
    }
  }

  // 空状态页的快捷入口
  const quick = $("empty-profiles");
  quick.innerHTML = "";
  $("empty-saved").hidden = profiles.length === 0;
  profiles.forEach((item) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "saved-chip";
    chip.textContent = defaultTitle(item);
    chip.title = `${item.username}@${item.host}:${item.port || 22}`;
    chip.addEventListener("click", () => connectProfile(item));
    quick.appendChild(chip);
  });
}

/** 点击已保存连接：有凭据直接连；没密码则开页签并在页内询问，不再弹连接对话框 */
async function connectProfile(p) {
  closePanels();
  const cfg = profileToConfig(p);
  const needPassword = !cfg.password && !cfg.privateKey;
  const tab = await createTab(cfg, { askPassword: needPassword, profileId: p.id });
  tab.profileId = p.id;
}

/* ---------- 页签 ---------- */
function updateTabState(tab) {
  const dot = tab.tabEl.querySelector(".tab__state");
  dot.className = "tab__state" + (tab.status === "connecting" || tab.status === "need-password" ? " is-connecting" : "");
  dot.title = {
    connected: "已连接",
    connecting: "连接中",
    "need-password": "等待输入密码",
    failed: tab.kind === "local" ? "本地终端已结束，按 Enter 重新打开" : "连接失败，按 Enter 重新连接",
  }[tab.status] || "已断开";
  tab.tabEl.classList.toggle("is-disconnected", tab.status === "failed");
}

function focusIfActive(tab) {
  if (tab.id === state.activeId) tab.term?.focus();
}

function activateTab(id) {
  const tab = find(id);
  if (!tab) return;
  state.activeId = id;
  state.tabs.forEach((t) => {
    const active = t.id === id;
    t.tabEl.classList.toggle("is-active", active);
    t.pane.classList.toggle("is-active", active);
  });
  $("empty").hidden = state.tabs.length > 0;
  requestAnimationFrame(() => {
    const t = find(id);
    if (!t || !t.fit) return;
    try { t.fit.fit(); } catch { /* 容器尺寸为 0 时忽略 */ }
    t.term?.focus();
  });
}

async function closeTab(id) {
  const tab = find(id);
  if (!tab) return;
  // 先解绑 sessionId，避免 ssh-closed 事件在移除过程中把状态改回失败
  const sid = tab.sessionId;
  tab.sessionId = null;
  if (sid) {
    try { await invoke("ssh_close", { id: sid }); } catch { /* 后端可能已断开 */ }
  }
  tab.resizeObserver?.disconnect();
  tab.term?.dispose();
  tab.tabEl.remove();
  tab.pane.remove();
  state.tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeId === id) {
    state.activeId = null;
    const next = state.tabs[state.tabs.length - 1];
    if (next) activateTab(next.id);
    else {
      $("empty").hidden = false;
      setStatus("就绪");
    }
  }
}

function failureHint(err, isLocal) {
  if (isLocal) {
    return `\r\n\x1b[31m本地终端启动失败：${String(err)}\x1b[0m\r\n` +
           `\x1b[90m按 Enter 重新打开本地终端\x1b[0m\r\n\r\n`;
  }
  return `\r\n\x1b[31m连接失败：${String(err)}\x1b[0m\r\n` +
         `\x1b[90m按 Enter 重新连接 · 右键页签可「编辑连接」修改配置\x1b[0m\r\n\r\n`;
}

/** 建立（或重建）SSH 会话，成功/失败统一更新页签状态与终端提示 */
/** 建立（或重建）会话：SSH 走 ssh_connect，本地终端走 local_open，其余链路完全共用 */
async function establish(tab) {
  const isLocal = tab.kind === "local";
  const cfg = tab.config;
  const { title: _ignored, ...sshConfig } = cfg;
  tab.status = "connecting";
  tab.cwd = null;   // 新会话重置路径缓存，避免沿用上一次连接（不再主动注入探测命令）
  updateTabState(tab);
  setStatus(isLocal ? "正在启动本地终端…" : `正在连接 ${cfg.username}@${cfg.host}…`);
  try {
    const sessionId = isLocal
      ? await invoke("local_open", { cols: tab.term.cols, rows: tab.term.rows })
      : await invoke("ssh_connect", {
          config: { ...sshConfig, cols: tab.term.cols, rows: tab.term.rows },
        });
    tab.sessionId = sessionId;
    tab.status = "connected";
    updateTabState(tab);
    setStatus(isLocal ? "本地终端已就绪" : `已连接 ${cfg.username}@${cfg.host}`, "ok");
    toast(isLocal ? "本地终端已启动" : `已连接：${tab.title}`);
    try { tab.fit.fit(); } catch { /* 忽略 */ }
    // 连接建立后不向终端写入任何字符：文件浏览器默认目录由 SFTP 自身给出
    focusIfActive(tab);
  } catch (err) {
    tab.sessionId = null;
    tab.status = "failed";
    updateTabState(tab);
    tab.term.write(failureHint(err, isLocal));
    setStatus(isLocal ? "本地终端启动失败" : `连接失败：${tab.title}`, "error");
    toast(`${isLocal ? "本地终端启动失败" : "连接失败"}：${String(err)}`, true);
    focusIfActive(tab);
  }
}

/** 重新连接：先关掉旧会话（若有），再复用同一个终端重建 */
/** 重新连接：先关掉旧会话（若有），再复用同一个终端重建 */
async function reconnect(tab) {
  if (!tab || tab.status === "connecting") return;
  if (tab.sessionId) {
    const old = tab.sessionId;
    tab.sessionId = null;
    try { await invoke("ssh_close", { id: old }); } catch { /* 已断开 */ }
  }
  tab.term.write(tab.kind === "local"
    ? "\r\n\x1b[90m正在重新打开本地终端…\x1b[0m\r\n"
    : "\r\n\x1b[90m正在重新连接…\x1b[0m\r\n");
  await establish(tab);
}

/** 页内密码输入：未保存密码的连接直接在这个页签上输入并连接 */
function showPasswordPrompt(tab, profileId) {
  const box = document.createElement("div");
  box.className = "pw-prompt";
  box.innerHTML = `
    <div class="pw-prompt__card">
      <div class="pw-prompt__lock">${ICONS.lock}</div>
      <h3>需要密码</h3>
      <p class="pw-prompt__desc"></p>
      <form class="pw-prompt__form">
        <span class="secret-field">
          <input type="password" class="pw-prompt__input" placeholder="输入 SSH 密码" autocomplete="off" />
          <button type="button" class="secret-toggle" title="显示密码" aria-label="显示密码"></button>
        </span>
        <label class="check pw-prompt__remember">
          <input type="checkbox" class="pw-prompt__remember-box" /><span>记住密码（加密保存到此连接）</span>
        </label>
        <div class="pw-prompt__actions">
          <button type="button" class="btn-ghost" data-cancel>取消</button>
          <button type="submit" class="btn-primary">连接</button>
        </div>
      </form>
      <p class="pw-prompt__hint">密码仅用于本次连接，不会写入连接列表（除非勾选记住）。</p>
    </div>`;
  box.querySelector(".pw-prompt__desc").textContent =
    `已保存的连接「${tab.title}」没有保存密码，输入密码即可直接连接。`;
  tab.pane.appendChild(box);

  const input = box.querySelector(".pw-prompt__input");
  const toggle = box.querySelector(".secret-toggle");
  const remember = box.querySelector(".pw-prompt__remember-box");
  const form = box.querySelector("form");
  const cancel = box.querySelector("[data-cancel]");
  bindSecretToggle(toggle, input);

  const submit = async () => {
    const pw = input.value;
    if (!pw) { toast("请先输入密码", true); input.focus(); return; }
    tab.config = { ...tab.config, password: pw };
    if (remember.checked && profileId) {
      const p = profiles.find((x) => x.id === profileId);
      if (p) {
        p.password = pw;
        p.rememberPassword = true;
        persistProfiles();
        toast("密码已加密保存");
      }
    }
    box.remove();
    await establish(tab);
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  cancel.addEventListener("click", async () => { box.remove(); await closeTab(tab.id); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancel.click(); }
  });
  // activateTab 也会 focus 终端，这里延后一帧把焦点交给密码框
  requestAnimationFrame(() => input.focus());
}

async function createTab(cfg, opts = {}) {
  const id = `tab-${++state.seq}`;
  const tab = {
    id, title: defaultTitle(cfg), config: cfg, profileId: null, kind: opts.kind || "ssh",
    sessionId: null, status: opts.askPassword ? "need-password" : "connecting",
    term: null, fit: null, resizeObserver: null, tabEl: null, pane: null, cwd: null,
  };

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.dataset.id = id;
  tabEl.innerHTML = `
    <span class="tab__state is-connecting" title="连接中"></span>
    <span class="tab__title"></span>
    <button class="tab__copy" title="复制标题" aria-label="复制标题">⧉</button>
    <button class="tab__close" title="关闭页签" aria-label="关闭页签">×</button>
  `;
  tabEl.querySelector(".tab__title").textContent = tab.title;
  $("tabs").appendChild(tabEl);

  const pane = document.createElement("div");
  pane.className = "pane";
  $("workspace").appendChild(pane);

  Object.assign(tab, { tabEl, pane });
  state.tabs.push(tab);
  activateTab(id);
  updateTabState(tab);

  const term = new Terminal({
    fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 10000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  Object.assign(tab, { term, fit });
  // OSC 1337 CurrentDir：仅被动接收 shell 自己上报的目录，应用不注入任何探测命令
  term.parser.registerOscHandler(1337, (data) => {
    const m = /^CurrentDir=(.*)$/.exec(data);
    if (!m || !m[1]) return false;
    tab.cwd = m[1];
    return true;
  });

  // 失败态下吞掉输入，只把 Enter 当作「重新连接」
  term.onData((data) => {
    if (tab.status === "failed") {
      if (data.includes("\r") || data.includes("\n")) reconnect(tab);
      return;
    }
    if (!tab.sessionId) return;
    invoke("ssh_write", { id: tab.sessionId, data: toBase64(data) })
      .catch((e) => toast(`发送失败：${e}`, true));
  });
  term.onResize(({ cols, rows }) => {
    if (!tab.sessionId) return;
    invoke("ssh_resize", { id: tab.sessionId, cols, rows }).catch(() => {});
  });

  tab.resizeObserver = new ResizeObserver(() => {
    if (!pane.classList.contains("is-active")) return;
    try { fit.fit(); } catch { /* 忽略 */ }
  });
  tab.resizeObserver.observe(pane);
  try { fit.fit(); } catch { /* 忽略 */ }

  // 没保存密码的已保存连接：在页签内询问密码，不弹连接对话框
  if (opts.askPassword) showPasswordPrompt(tab, opts.profileId ?? null);
  else await establish(tab);
  return tab;
}

/** 生成「原标题 副本N」：编号全局累加，跳过仍占用的编号，关闭页签也不回退；
    克隆副本时先剥掉自身的旧编号，避免「xxx 副本1 副本2」越叠越长 */
function nextCloneTitle(sourceTitle) {
  const base = sourceTitle.replace(/\s*副本\d+$/, "").trim() || sourceTitle;
  const used = new Set(
    state.tabs
      .map((t) => /(?:^|\s)副本(\d+)$/.exec(t.title)?.[1])
      .filter(Boolean)
      .map(Number)
  );
  let n = state.cloneSeq + 1;
  while (used.has(n)) n++;
  state.cloneSeq = n;
  return `${base} 副本${n}`;
}

/** 双击页签 / 右键：克隆整个会话（复制连接配置并新开一个页签，标题为 原标题 副本N） */
async function cloneTab(tab) {
  if (!tab) return;
  const title = nextCloneTitle(tab.title);
  const t = await createTab({ ...tab.config, title }, { kind: tab.kind });
  t.profileId = tab.profileId;
  t.tabEl.title = `克隆自「${tab.title}」`;
  toast(`已克隆会话：${title}`);
}

/* ---------- 页签栏事件（委托） ---------- */
$("tabs").addEventListener("click", (e) => {
  const tabEl = e.target.closest(".tab");
  if (!tabEl) return;
  const tab = find(tabEl.dataset.id);
  if (e.target.closest(".tab__copy")) { copyTitle(tab); return; }   // 悬停出现的复制按钮
  if (e.target.closest(".tab__close")) { closeTab(tab.id); return; }
  activateTab(tab.id);
});

$("tabs").addEventListener("dblclick", (e) => {
  const tabEl = e.target.closest(".tab");
  if (!tabEl || e.target.closest("button")) return;
  cloneTab(find(tabEl.dataset.id));
});

$("tabs").addEventListener("contextmenu", (e) => {
  const tabEl = e.target.closest(".tab");
  if (!tabEl) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, find(tabEl.dataset.id));
});

function showContextMenu(x, y, tab) {
  const menu = $("context-menu");
  menu.innerHTML = "";
  const isLocal = tab.kind === "local";
  const items = [
    { label: "复制标题", run: () => copyTitle(tab) },
    { label: isLocal ? "克隆本地终端" : "克隆会话（复制页签）", run: () => cloneTab(tab) },
    { sep: true },
    ...(isLocal ? [] : [
      { label: "编辑连接", run: () => openModal({
        tabId: tab.id, profileId: tab.profileId, connectAfterSave: true, prefill: tab.config,
      }) },
      { label: "文件传输…（SFTP）", run: () => openSftp(tab) },
    ]),
    { label: isLocal ? "重新打开本地终端" : "重新连接", run: () => reconnect(tab) },
    { sep: true },
    { label: "关闭页签", run: () => closeTab(tab.id), danger: true },
  ];
  items.forEach((item) => {
    if (item.sep) { menu.appendChild(document.createElement("hr")); return; }
    const btn = document.createElement("button");
    btn.textContent = item.label;
    if (item.danger) btn.className = "is-danger";
    btn.addEventListener("click", () => { menu.hidden = true; item.run(); });
    menu.appendChild(btn);
  });
  menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 240)}px`;
  menu.hidden = false;
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("#context-menu")) $("context-menu").hidden = true;
  // 点击两个面板与各自触发按钮之外的地方，分别收起
  if (!e.target.closest("#profiles-panel") && !e.target.closest("#btn-profiles")) closeProfiles();
  if (!e.target.closest("#quick-panel") && !e.target.closest("#tab-add")) closeQuick();
  if (!e.target.closest("#transfer-panel") && !e.target.closest("#btn-upload")) closeTransfers();
});

/* 标题栏仅展示应用名，不绑定任何复制交互 */

/* ---------- 窗口控制（无边框窗口） ---------- */
const win = getCurrentWindow();
$("win-close").addEventListener("click", () => win.close());
$("win-min").addEventListener("click", () => win.minimize());
$("win-max").addEventListener("click", () => win.toggleMaximize());

/* ---------- SFTP 双栏文件浏览器：零侵入默认目录 ---------- */
///
/// 连接建立后不向终端写入任何字符、不修改远端 shell 配置：
/// 远端默认目录由后端 sftp_list("") 的 canonicalize(".") 给出，
/// 本地默认目录取上次目录 / 本机 HOME。只有 shell 自己上报 OSC 1337
/// CurrentDir（例如已装 iTerm2 shell integration）时才被动更新 tab.cwd。


const browser = {
  sessionId: null,
  tabId: null,
  local:  { path: "", home: "", entries: [], selected: new Set() },
  remote: { path: "", home: "", entries: [], selected: new Set() },
};
const sides = { local: browser.local, remote: browser.remote };

const DIR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2h4.4l1.3 1.7h6.7v7.5H1.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.9h5l3 3v9.2H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.9v3h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

const basename = (p) => p.split(/[\\/]/).pop() || p;
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 取上级目录：兼容 Unix `/` 与 Windows `C:\` */
function parentPath(path) {
  const win = /^[A-Za-z]:/.test(path);
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return win ? path : "/";
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return win ? `${trimmed.slice(0, 2)}\\` : "/";
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function renderDir(side) {
  const st = sides[side];
  const box = $(`${side}-list`);
  $(`${side}-path`).value = st.path;
  box.innerHTML = "";
  const showHidden = $("sftp-hidden").checked;
  const entries = st.entries.filter((e) => showHidden || !e.name.startsWith("."));
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "sftp-list__empty";
    empty.textContent = st.entries.length ? "只含隐藏文件（可勾选「显示隐藏文件」）" : "空目录";
    box.appendChild(empty);
    return;
  }
  entries.forEach((e) => {
    const row = document.createElement("div");
    row.className = "sftp-row" + (st.selected.has(e.path) ? " is-selected" : "");
    row.dataset.path = e.path;
    row.title = e.path;
    const icon = document.createElement("span");
    icon.className = "sftp-row__icon";
    icon.innerHTML = e.isDir ? DIR_ICON : FILE_ICON;
    const name = document.createElement("span");
    name.className = "sftp-row__name";
    name.textContent = e.name;
    const meta = document.createElement("span");
    meta.className = "sftp-row__meta";
    meta.textContent = e.isDir ? "目录" : humanSize(e.size);
    row.append(icon, name, meta);
    box.appendChild(row);
  });
}

/** 只切换选中态，不重建 DOM：重建会让双击落空，也会丢掉列表滚动位置 */
function updateSelection(side) {
  const st = sides[side];
  $(`${side}-list`).querySelectorAll(".sftp-row").forEach((row) => {
    row.classList.toggle("is-selected", st.selected.has(row.dataset.path));
  });
}

/** 返回是否成功；失败时清空旧条目并显示原因，避免把上一次的目录误当成当前目录 */
async function loadDir(side, path) {
  const st = sides[side];
  const box = $(`${side}-list`);
  const cmd = side === "local" ? "local_list" : "sftp_list";
  const args = side === "local"
    ? { path: path || "" }
    : { id: browser.sessionId, path: path || "" };
  box.innerHTML = '<div class="sftp-list__empty">正在读取目录…</div>';
  try {
    const listing = await invoke(cmd, args);
    st.path = listing.path;
    st.home = listing.home;
    st.entries = listing.entries;
    st.selected.clear();
    renderDir(side);
    if (side === "local") localStorage.setItem(SFTP_LOCAL_DIR_KEY, st.path);
    return true;
  } catch (err) {
    st.entries = [];
    st.selected.clear();
    $(`${side}-path`).value = path || "";
    box.innerHTML = "";
    const row = document.createElement("div");
    row.className = "sftp-list__error";
    row.textContent = `无法打开目录：${String(err)}`;
    box.appendChild(row);
    return false;
  }
}

/* ---------- 后台传输队列：悬停 ⬆ 查看进度 / 暂停 / 删除 ---------- */
const transfers = [];
const transferById = (job) => transfers.find((t) => t.job === job);
const newJobId = () =>
  (crypto.randomUUID?.() || `job-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let transferSaveTimer = 0;

/** 只保留最近 20 条：运行/暂停中的任务永不淘汰，其余按新→旧保留 */
function trimTransfers() {
  const active = transfers.filter((t) => t.state === "running" || t.state === "paused");
  const activeSet = new Set(active);
  const finished = transfers.filter((t) => !activeSet.has(t));
  const keep = new Set([...active, ...finished.slice(0, Math.max(0, TRANSFER_LIMIT - active.length))]);
  let removed = 0;
  for (let i = transfers.length - 1; i >= 0; i--) {
    if (!keep.has(transfers[i])) { transfers.splice(i, 1); removed++; }
  }
  return removed;
}

/** 落盘快照只留展示所需字段，不写 outcomes（逐文件结果可能很长）；进度事件不触发写盘。
 *  入队时 immediate=true 立即写，避免刚发起就退出应用丢记录；其余状态变更防抖合并。 */
function persistTransfers(immediate = false) {
  clearTimeout(transferSaveTimer);
  const flush = () => {
    // 防抖写盘时若淘汰了旧记录，同步一次列表，避免 DOM 还留着已被移除的项
    if (trimTransfers()) renderTransfers();
    const snapshot = transfers.map((t) =>
      Object.fromEntries(TRANSFER_FIELDS.map((k) => [k, t[k] ?? ""])));
    invoke("transfers_save", { json: JSON.stringify(snapshot) })
      .catch((e) => console.warn("传输记录保存失败：", e));
  };
  if (immediate) flush();
  else transferSaveTimer = setTimeout(flush, TRANSFER_SAVE_DELAY);
}

/** 存档字段兜底；后端 job 在重启后已失效，运行中的任务统一标记为「已中断」 */
function normalizeTransfer(t) {
  if (!t || typeof t !== "object" || !t.job) return null;
  const active = t.state === "running" || t.state === "paused";
  const ended = ["done", "error", "canceled", "interrupted"];
  return {
    job: String(t.job),
    kind: t.kind === "download" ? "download" : "upload",
    label: String(t.label || "传输任务"),
    count: Number(t.count) || 1,
    index: 0, file: "", sent: 0, total: 0,
    percent: active ? 0 : (Number(t.percent) || 0),
    state: active ? "interrupted" : (ended.includes(t.state) ? t.state : "error"),
    ok: Number(t.ok) || 0,
    failed: Number(t.failed) || 0,
    error: active ? "应用重启，传输未完成" : String(t.error || ""),
    targetDir: String(t.targetDir || ""),
    sessionId: null,
    outcomes: [],
    at: Number(t.at) || Date.now(),
  };
}

/** 启动时解密读取本机记录；读不到或格式异常时保持空列表 */
async function initTransfers() {
  try {
    const saved = JSON.parse(await invoke("transfers_load") || "[]");
    const restored = (Array.isArray(saved) ? saved : [])
      .map(normalizeTransfer).filter(Boolean).slice(0, TRANSFER_LIMIT);
    transfers.splice(0, transfers.length, ...restored);
  } catch (e) {
    console.warn("读取传输记录失败：", e);
  }
  renderTransfers();
}

function buildTransferNode(t) {
  const node = document.createElement("div");
  node.className = "transfer-item";
  node.dataset.job = t.job;
  node.innerHTML = `
    <div class="transfer-item__top">
      <span class="transfer-item__kind"></span>
      <span class="transfer-item__name"></span>
      <span class="transfer-item__ops">
        <button type="button" data-act="toggle" title="暂停 / 继续"></button>
        <button type="button" data-act="remove" title="删除任务">×</button>
      </span>
    </div>
    <div class="transfer-item__meta"></div>
    <div class="transfer-item__bar"><span></span></div>
  `;
  return node;
}

function updateTransferNode(node, t) {
  const running = t.state === "running";
  const paused = t.state === "paused";
  node.className = `transfer-item is-${t.state}`;
  node.title = t.at ? new Date(t.at).toLocaleString("zh-CN") : "";
  node.querySelector(".transfer-item__kind").textContent = t.kind === "upload" ? "↑" : "↓";
  node.querySelector(".transfer-item__name").textContent = t.label;
  const meta = node.querySelector(".transfer-item__meta");
  if (t.state === "done") {
    meta.textContent = `完成 ${t.ok}/${t.count} · ${t.targetDir}`;
  } else if (t.state === "canceled") {
    meta.textContent = `已取消 · ${t.ok}/${t.count} 已完成`;
  } else if (t.state === "interrupted") {
    meta.textContent = `已中断 · ${t.ok}/${t.count} 已完成（应用重启）`;
  } else if (t.state === "error") {
    meta.textContent = t.error;
  } else if (paused) {
    meta.textContent = `已暂停 · ${t.index + 1}/${t.count} ${t.file}`;
  } else {
    meta.textContent = `${t.index + 1}/${t.count} ${t.file || "准备中…"} · ${humanSize(t.sent)} / ${humanSize(t.total)}`;
  }
  node.querySelector(".transfer-item__bar span").style.width = `${t.percent}%`;
  const toggle = node.querySelector('[data-act="toggle"]');
  toggle.hidden = !(running || paused);
  toggle.textContent = running ? "⏸" : "▶";
  toggle.title = running ? "暂停" : "继续";
  node.querySelector('[data-act="remove"]').title =
    running || paused ? "取消并删除" : "从列表移除";
}

/** 复用已有节点，只更新文本/宽度：进度事件高频到达时不会打断鼠标点击 */
function renderTransfers() {
  const box = $("transfer-list");
  const busy = transfers.filter((t) => t.state === "running" || t.state === "paused").length;
  $("btn-upload").classList.toggle("is-transferring", busy > 0);
  $("transfer-summary").textContent = busy ? `${busy} 项进行中` : "";

  const existing = new Map(
    [...box.querySelectorAll(".transfer-item")].map((n) => [n.dataset.job, n])
  );
  transfers.forEach((t) => {
    let node = existing.get(t.job);
    if (node) existing.delete(t.job);
    else node = buildTransferNode(t);
    updateTransferNode(node, t);
    box.appendChild(node);
  });
  existing.forEach((n) => n.remove());

  const empty = box.querySelector(".transfer-empty");
  if (!transfers.length && !empty) {
    const n = document.createElement("div");
    n.className = "transfer-empty";
    n.textContent = "暂无传输任务";
    box.appendChild(n);
  } else if (transfers.length && empty) {
    empty.remove();
  }
}

async function toggleTransfer(t) {
  if (t.state !== "running" && t.state !== "paused") return;
  const pause = t.state === "running";
  t.state = pause ? "paused" : "running";
  renderTransfers();
  persistTransfers();
  try {
    await invoke(pause ? "sftp_transfer_pause" : "sftp_transfer_resume", { job: t.job });
  } catch (e) {
    toast(`操作失败：${String(e)}`, true);
  }
}

async function removeTransfer(t) {
  const active = t.state === "running" || t.state === "paused";
  if (active) {
    try { await invoke("sftp_transfer_cancel", { job: t.job }); } catch { /* 已结束 */ }
  }
  const i = transfers.indexOf(t);
  if (i >= 0) transfers.splice(i, 1);
  renderTransfers();
  persistTransfers();
}

function updateTransferProgress(p) {
  const t = transferById(p.job);
  if (!t || (t.state !== "running" && t.state !== "paused")) return;
  t.index = p.index;
  t.file = p.file;
  t.sent = p.sent;
  t.total = p.total;
  t.percent = p.percent;
  renderTransfers();
}

function finishTransfer(p) {
  const t = transferById(p.job);
  if (!t) return;
  t.ok = p.ok;
  t.failed = p.failed;
  t.outcomes = p.outcomes || [];
  t.error = p.error || "";
  t.state = p.canceled ? "canceled" : (p.error || p.failed ? "error" : "done");
  if (t.state === "done") t.percent = 100;
  if (t.state === "error" && !t.error) {
    const bad = t.outcomes.find((o) => !o.ok);
    t.error = bad ? `${basename(bad.path)}：${bad.error}` : "传输失败";
  }
  persistTransfers(true);   // 终态立即落盘，避免重启后误判为「进行中」
  renderTransfers();
  const verb = t.kind === "upload" ? "上传" : "下载";
  setStatus(`${verb}完成：${t.ok}/${t.count} 成功`, t.state === "done" ? "ok" : "error");
  toast(`${verb}完成：${t.ok}/${t.count} 成功`, t.state !== "done");
  // 文件传完后如果浏览器还停在原来的目录，顺手刷新目标栏
  if (!$("sftp-modal").hidden && browser.sessionId === t.sessionId) {
    loadDir(t.kind === "upload" ? "remote" : "local", t.targetDir);
  }
}

$("transfer-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  const node = btn?.closest(".transfer-item");
  const t = transferById(node?.dataset.job);
  if (!btn || !t) return;
  if (btn.dataset.act === "toggle") toggleTransfer(t);
  else if (btn.dataset.act === "remove") removeTransfer(t);
});

let transferOpenTimer = null;
let transferCloseTimer = null;

function showTransfers() {
  if (!$("modal").hidden) return;
  clearTimeout(transferOpenTimer);
  clearTimeout(transferCloseTimer);
  closeProfiles();
  closeQuick();
  const panel = $("transfer-panel");
  const r = $("btn-upload").getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 24);
  panel.style.top = `${r.bottom + 6}px`;
  panel.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 12))}px`;
  panel.style.right = "auto";
  panel.hidden = false;
  renderTransfers();
}

function closeTransfers() {
  clearTimeout(transferOpenTimer);
  clearTimeout(transferCloseTimer);
  const panel = $("transfer-panel");
  const wasOpen = !panel.hidden;
  panel.hidden = true;
  panel.style.top = "";
  panel.style.left = "";
  panel.style.right = "";
  if (wasOpen) restoreTerminalFocus();
}

function scheduleTransferClose() {
  clearTimeout(transferCloseTimer);
  transferCloseTimer = setTimeout(() => {
    if ($("transfer-panel").matches(":hover") || $("btn-upload").matches(":hover")) return;
    closeTransfers();
  }, 260);
}

$("btn-upload").addEventListener("mouseenter", () => {
  if (!$("transfer-panel").hidden) { clearTimeout(transferCloseTimer); return; }
  clearTimeout(transferCloseTimer);
  transferOpenTimer = setTimeout(showTransfers, 120);
});
$("btn-upload").addEventListener("mouseleave", () => {
  clearTimeout(transferOpenTimer);
  scheduleTransferClose();
});
$("transfer-panel").addEventListener("mouseenter", () => {
  clearTimeout(transferOpenTimer);
  clearTimeout(transferCloseTimer);
});
$("transfer-panel").addEventListener("mouseleave", scheduleTransferClose);
$("transfer-open-browser").addEventListener("click", () => { closeTransfers(); openSftp(); });

function closeSftp() { $("sftp-modal").hidden = true; }

async function openSftp(tab) {
  const target = tab || find(state.activeId);
  if (!target) return toast("请先打开一个 SSH 会话", true);
  if (target.kind === "local") return toast("本地终端没有远端目录，请先切换到 SSH 页签", true);
  if (target.status !== "connected" || !target.sessionId) {
    return toast("当前 SSH 会话未连接，请先连接成功再传输文件", true);
  }
  closePanels();
  closeModal();
  browser.sessionId = target.sessionId;
  browser.tabId = target.id;
  browser.local.selected.clear();
  browser.remote.selected.clear();
  browser.local.entries = [];
  browser.remote.entries = [];
  $("sftp-target").textContent = `目标会话：${target.title}（${target.config.username}@${target.config.host}）`;
  $("sftp-overwrite").checked = true;
  $("sftp-hidden").checked = false;
  $("sftp-status").textContent = "正在加载目录…";
  $("sftp-modal").hidden = false;
  renderDir("local");
  renderDir("remote");

  // 零侵入：不向终端写任何字符。远端用 SFTP 默认目录（后端 canonicalize(".")），
  // 本地用上次目录 / 本机 HOME；仅当 shell 自己上报过 OSC 1337 时才用 tab.cwd。
  const cwd = target.cwd || "";
  const localTab = [...state.tabs].reverse().find((t) => t.kind === "local" && t.cwd);
  const localStart = localTab?.cwd || localStorage.getItem(SFTP_LOCAL_DIR_KEY) || "";
  $("sftp-status").textContent = "";
  const [okLocal, okRemote] = await Promise.all([
    loadDir("local", localStart),
    loadDir("remote", cwd),
  ]);
  if (!okLocal) await loadDir("local", "");
  if (cwd && !okRemote) {
    $("sftp-status").textContent = "目录不可访问，已回落到远端默认目录";
    await loadDir("remote", "");
  }
}

document.querySelectorAll("[data-close-sftp]").forEach((n) =>
  n.addEventListener("click", closeSftp));

$("btn-upload").addEventListener("click", () => openSftp());

$("sftp-hidden").addEventListener("change", () => { renderDir("local"); renderDir("remote"); });

["local", "remote"].forEach((side) => {
  const st = sides[side];
  const list = $(`${side}-list`);
  list.addEventListener("click", async (e) => {
    if (e.detail > 1) return;   // 双击的第二下不重复处理，避免连进两层目录
    const row = e.target.closest(".sftp-row");
    if (!row) return;
    const path = row.dataset.path;
    const entry = st.entries.find((x) => x.path === path);
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    if (multi) {
      if (st.selected.has(path)) st.selected.delete(path);
      else st.selected.add(path);
    } else {
      st.selected.clear();
      st.selected.add(path);
    }
    updateSelection(side);
    // 目录单击即进入（目录不参与传输，选中它没有意义）；多选时只选中不跳转
    if (!multi && entry?.isDir) await loadDir(side, entry.path);
  });
  $(`${side}-path`).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadDir(side, $(`${side}-path`).value.trim());
    }
  });
  $(`${side}-up`).addEventListener("click", () => {
    if (st.path) loadDir(side, parentPath(st.path));
  });
  $(`${side}-home`).addEventListener("click", () => loadDir(side, ""));
  $(`${side}-refresh`).addEventListener("click", () => loadDir(side, st.path));
});

function selectedFiles(side) {
  const st = sides[side];
  if (!st.selected.size) return [];
  return st.entries.filter((e) => st.selected.has(e.path) && !e.isDir).map((e) => e.path);
}

/** 上传/下载只负责入队：后台 task 在 Rust 侧跑，弹窗关掉也不中断 */
async function startTransfer(upload) {
  const tab = find(browser.tabId);
  if (!tab || tab.sessionId !== browser.sessionId) {
    return toast("会话已切换或断开，请重新打开文件浏览器", true);
  }
  const paths = selectedFiles(upload ? "local" : "remote");
  if (!paths.length) {
    const pickedDir = [...sides[upload ? "local" : "remote"].selected].length > 0;
    return toast(pickedDir ? "暂不支持目录递归传输，请选择文件" :
      (upload ? "请先在左侧选中本地文件" : "请先在右侧选中远端文件"), true);
  }
  const targetDir = upload ? browser.remote.path : browser.local.path;
  if (!targetDir) return toast("目标目录尚未就绪", true);

  const job = newJobId();
  const t = {
    job,
    kind: upload ? "upload" : "download",
    label: paths.length === 1 ? basename(paths[0]) : `${paths.length} 个文件`,
    count: paths.length, index: 0, file: "", percent: 0, sent: 0, total: 0,
    state: "running", ok: 0, failed: 0, error: "", outcomes: [],
    targetDir, sessionId: browser.sessionId, at: Date.now(),
  };
  transfers.unshift(t);
  persistTransfers(true);   // 入队立即落盘
  renderTransfers();
  toast(`已加入后台${upload ? "上传" : "下载"} · 悬停 ⬆ 查看进度`);
  try {
    await invoke(upload ? "sftp_upload" : "sftp_download", {
      id: browser.sessionId,
      job,
      paths,
      dir: targetDir,
      overwrite: $("sftp-overwrite").checked,
    });
  } catch (e) {
    if (!transferById(job)) return;
    t.state = "error";
    t.error = String(e);
    persistTransfers();
    renderTransfers();
    toast(`无法启动传输：${String(e)}`, true);
  }
}

$("sftp-upload-btn").addEventListener("click", () => startTransfer(true));
$("sftp-download-btn").addEventListener("click", () => startTransfer(false));

/* ---------- 连接弹窗 ---------- */
let modalMode = { profileId: null, tabId: null, connectAfterSave: true, duplicate: false };
const syncMainSecret = bindSecretToggle($("pw-toggle"), $("connect-form").elements.password);

function openModal(options = {}) {
  // 编辑时先收起两个面板，且弹窗 z-index 更高，保证一定可见
  closeSftp();
  closePanels();
  modalMode = {
    profileId: options.profileId ?? null,
    tabId: options.tabId ?? null,
    connectAfterSave: options.connectAfterSave ?? true,
    duplicate: options.duplicate ?? false,
  };
  const form = $("connect-form");
  form.reset();
  const pwInput = form.elements.password;
  pwInput.type = "password";   // 关掉上次可能留下的明文显示
  syncMainSecret();
  const cfg = options.prefill;
  if (cfg) {
    form.elements.title.value = cfg.title || "";
    form.elements.host.value = cfg.host || "";
    form.elements.port.value = cfg.port || 22;
    form.elements.username.value = cfg.username || "";
    pwInput.value = cfg.password || "";
    form.elements.privateKey.value = cfg.privateKey || "";
  }
  const profile = profiles.find((p) => p.id === modalMode.profileId);
  form.elements.saveProfile.checked = true;
  form.elements.rememberPassword.checked = !!(profile && profile.rememberPassword);
  $("modal-title").textContent = modalMode.duplicate
    ? "复制并编辑连接"
    : (modalMode.tabId
      ? "编辑连接"
      : (profile ? "编辑已保存的连接" : "新建 SSH 连接"));
  $("connect-submit").textContent = modalMode.connectAfterSave
    ? (modalMode.tabId ? "保存并重连" : "连接")
    : "保存";
  $("test-result").hidden = true;
  $("test-result").textContent = "";
  $("modal").hidden = false;
  form.scrollTop = 0;
  (cfg && cfg.host && !cfg.password ? pwInput : form.elements.host).focus();
}

function closeModal() { $("modal").hidden = true; }
let hoverOpenTimer = null;
let hoverCloseTimer = null;

/** 一次性收起两个面板（打开连接弹窗、发起连接时调用） */
function closePanels() {
  closeProfiles();
  closeQuick();
  closeTransfers();
}

/** 面板收起后把键盘焦点还给当前终端（页内密码框优先保留） */
function restoreTerminalFocus() {
  if (!$("modal").hidden || !$("sftp-modal").hidden) return;
  const tab = find(state.activeId);
  if (tab?.term && !tab.pane.querySelector(".pw-prompt")) tab.term.focus();
}

/** ☰：已保存连接的管理面板，固定右上角 */
function openProfiles() {
  if (!$("modal").hidden) return;
  const panel = $("profiles-panel");
  if (!panel.hidden) { closeProfiles(); return; }
  closeQuick();
  panel.hidden = false;
  $("profiles-search-input").value = "";
  renderProfiles();
  requestAnimationFrame(() => {
    if (!$("profiles-panel").hidden) $("profiles-search-input").focus();
  });
}

function closeProfiles() {
  const panel = $("profiles-panel");
  const wasOpen = !panel.hidden;
  panel.hidden = true;
  $("profiles-search-input").value = "";
  $("profiles-search-input").blur();
  if (wasOpen) restoreTerminalFocus();
}

/** ＋：快捷新建面板，锚定到页签栏 ＋ 按钮正下方 */
function showQuick() {
  if (!$("modal").hidden) return;
  clearTimeout(hoverOpenTimer);
  clearTimeout(hoverCloseTimer);
  closeProfiles();
  const panel = $("quick-panel");
  const r = $("tab-add").getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  panel.style.top = `${r.bottom + 6}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left - 8, window.innerWidth - width - 12))}px`;
  panel.style.right = "auto";
  panel.classList.add("is-near-add");
  panel.hidden = false;
  $("quick-search-input").value = "";
  renderProfiles();
  requestAnimationFrame(() => {
    if (!$("quick-panel").hidden) $("quick-search-input").focus();
  });
}

function closeQuick() {
  clearTimeout(hoverOpenTimer);
  clearTimeout(hoverCloseTimer);
  const panel = $("quick-panel");
  const wasOpen = !panel.hidden;
  panel.hidden = true;
  panel.classList.remove("is-near-add");
  panel.style.top = "";
  panel.style.left = "";
  panel.style.right = "";
  $("quick-search-input").value = "";
  $("quick-search-input").blur();
  if (wasOpen) restoreTerminalFocus();
}

/** 鼠标从 ＋ 移到面板之间有一小段空隙，延时收起避免面板闪退 */
function scheduleHoverClose() {
  clearTimeout(hoverCloseTimer);
  hoverCloseTimer = setTimeout(() => {
    if ($("quick-panel").matches(":hover") || $("tab-add").matches(":hover")) return;
    closeQuick();
  }, 260);
}

/** 打开一个本地 shell 页签（与 SSH 页签共用读写、尺寸与关闭链路） */
async function openLocalTerminal() {
  closePanels();
  await createTab({ title: "本地终端" }, { kind: "local" });
}

function readForm() {
  const f = $("connect-form").elements;
  return {
    title: f.title.value.trim(),
    host: f.host.value.trim(),
    port: Number(f.port.value) || 22,
    username: f.username.value.trim(),
    password: f.password.value,
    privateKey: f.privateKey.value.trim(),
  };
}
function validateConfig(cfg) {
  if (!cfg.host || !cfg.username) return "请填写主机和用户名";
  if (!cfg.password && !cfg.privateKey) return "请填写密码或私钥路径";
  return null;
}
function showTestResult(text, ok) {
  const n = $("test-result");
  n.hidden = false;
  n.className = "modal__result" + (ok ? " is-ok" : " is-error");
  n.textContent = text;
}

$("btn-new").addEventListener("click", () => openModal());
$("tab-add").addEventListener("click", () => openLocalTerminal());
$("empty-new").addEventListener("click", () => openModal());
$("btn-profiles").addEventListener("click", openProfiles);
$("profiles-new").addEventListener("click", () => { closePanels(); openModal(); });
$("quick-new-ssh").addEventListener("click", () => { closePanels(); openModal(); });
$("quick-local").addEventListener("click", openLocalTerminal);
document.querySelectorAll("[data-close-modal]").forEach((n) => n.addEventListener("click", closeModal));

/* ---------- 两个面板各自独立的搜索：输入即过滤，回车直连第一条，Esc 收起 ---------- */
[
  { input: "profiles-search-input", close: closeProfiles },
  { input: "quick-search-input", close: closeQuick },
].forEach(({ input, close }) => {
  $(input).addEventListener("input", renderProfiles);
  $(input).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = filteredProfiles($(input).value)[0];
      if (first) connectProfile(first);
      else toast("没有匹配的连接");
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
});

/* ---------- 页签栏 ＋ 悬停快捷新建 ---------- */
$("tab-add").addEventListener("mouseenter", () => {
  if (!$("quick-panel").hidden) { clearTimeout(hoverCloseTimer); return; }
  clearTimeout(hoverCloseTimer);
  hoverOpenTimer = setTimeout(showQuick, 120);
});
$("tab-add").addEventListener("mouseleave", () => {
  clearTimeout(hoverOpenTimer);
  scheduleHoverClose();
});
$("quick-panel").addEventListener("mouseenter", () => {
  clearTimeout(hoverOpenTimer);
  clearTimeout(hoverCloseTimer);
});
$("quick-panel").addEventListener("mouseleave", scheduleHoverClose);

/* ---------- 测试连接：只验证 TCP + 认证，不创建页签 ---------- */
$("btn-test").addEventListener("click", async () => {
  const cfg = readForm();
  const invalid = validateConfig(cfg);
  if (invalid) return showTestResult(invalid, false);
  const { title: _ignored, ...sshConfig } = cfg;
  const btn = $("btn-test");
  btn.disabled = true;
  btn.textContent = "测试中…";
  showTestResult("正在连接并验证凭据…", true);
  try {
    const res = await invoke("ssh_test", { config: { ...sshConfig, cols: 80, rows: 24 } });
    showTestResult(`✓ ${res}`, true);
  } catch (err) {
    showTestResult(`✗ ${String(err)}`, false);
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接";
  }
});

/* ---------- 提交：保存配置 / 新建页签 / 编辑并重连 ---------- */
$("connect-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget.elements;
  const cfg = readForm();
  const invalid = validateConfig(cfg);
  if (invalid) return toast(invalid, true);

  const mode = { ...modalMode };
  let profileId = mode.profileId;
  if (f.saveProfile.checked) {
    if (!profileId) profileId = uid();
    upsertProfile({
      id: profileId,
      title: cfg.title,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      password: f.rememberPassword.checked ? cfg.password : "",
      rememberPassword: f.rememberPassword.checked,
    });
  }
  closeModal();

  // 编辑现有页签：更新配置；失败态立即重连，等待密码态直接连接
  if (mode.tabId) {
    const tab = find(mode.tabId);
    if (tab) {
      tab.pane.querySelector(".pw-prompt")?.remove();
      tab.config = cfg;
      tab.profileId = profileId;
      tab.title = defaultTitle(cfg);
      tab.tabEl.querySelector(".tab__title").textContent = tab.title;
      if (tab.status === "failed") await reconnect(tab);
      else if (tab.status === "need-password" || !tab.sessionId) await establish(tab);
      else toast("配置已保存，右键页签「重新连接」后生效");
    }
    return;
  }
  // 只保存、不连接（连接列表面板里的编辑）
  if (!mode.connectAfterSave) { toast("连接已保存"); return; }

  const tab = await createTab(cfg);
  tab.profileId = profileId;
});

/* ---------- Rust 侧事件 ---------- */
listen("sftp-progress", ({ payload }) => updateTransferProgress(payload));
listen("sftp-transfer-done", ({ payload }) => finishTransfer(payload));
listen("ssh-data", ({ payload }) => {
  const tab = state.tabs.find((t) => t.sessionId === payload.id);
  if (tab) tab.term?.write(fromBase64(payload.data));
});

listen("ssh-closed", ({ payload }) => {
  const tab = state.tabs.find((t) => t.sessionId === payload.id);
  if (!tab) return;
  tab.sessionId = null;
  tab.status = "failed";
  updateTabState(tab);
  const hint = tab.kind === "local"
    ? "\x1b[90m按 Enter 重新打开本地终端\x1b[0m"
    : "\x1b[90m按 Enter 重新连接 · 右键页签可「编辑连接」修改配置\x1b[0m";
  tab.term?.write(
    `\r\n\x1b[33m[会话已结束] ${payload.reason}\x1b[0m\r\n` + `${hint}\r\n\r\n`
  );
  setStatus(`会话已断开：${tab.title}`, "error");
  focusIfActive(tab);
});

/* ---------- 启动 ---------- */
document.title = APP_NAME;
$("empty").hidden = false;
renderProfiles();
setStatus("就绪");
initProfiles();   // 异步解密读取本机连接配置
initTransfers();  // 异步解密读取传输记录（最近 20 条）
