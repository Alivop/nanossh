/** 页签与终端：Svelte 只保存响应式元数据，xterm / FitAddon / ResizeObserver
 *  存在模块级 Map（非响应式），避免 $state 代理包装 DOM 与第三方类实例。
 *  连接建立后不向终端写入任何字符（零注入）。 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { ui, toast, setStatus, copyText, closePanels } from "./ui.svelte";
import { profilesState } from "./profiles.svelte";
import { t } from "../i18n.svelte";
import { cursorState, saveCursorStyle, CURSOR_BAR_WIDTH, type CursorStyle } from "./cursor.svelte";
import type { Tab, TabKind, SshConfig, ProgressPayload } from "../types";

interface Runtime {
  term: Terminal;
  fit: FitAddon;
  observer: ResizeObserver;
}

const runtime = new Map<string, Runtime>();

export const tabsState = $state({
  list: [] as Tab[],
  activeId: null as string | null,
  seq: 0,
  cloneSeq: 0,
});

/* ==================== 页签持久化（跨重启恢复） ==================== */

const TABS_KEY = "nanossh-tabs";
/** restoreTabs 重建页签期间为 true：activateTab 不自动建连，避免恢复时把所有页签都连上 */
let restoringTabs = false;
/** 启动时先读后写：restoreTabs（哪怕没恢复任何页签）跑完前不允许 effect 写盘，否则空列表会覆盖上次数据 */
let persistArmed = $state(false);

interface SavedTab {
  id: string;
  kind: TabKind;
  profileId: string | null;
  title: string;
  config: SshConfig;
}

/** 只持久化页签身份（kind/配置/标题/顺序/活动页签），密码一律抹掉、会话状态不存。
 *  $effect 精确追踪：status / sessionId 变化不会触发写盘。 */
$effect.root(() => {
  $effect(() => {
    if (!persistArmed) return;
    const list: SavedTab[] = tabsState.list.map((tb) => ({
      id: tb.id,
      kind: tb.kind,
      profileId: tb.profileId,
      title: tb.title,
      config: { ...tb.config, password: "" },
    }));
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ activeId: tabsState.activeId, list }));
    } catch { /* 隐私模式等写入失败时忽略 */ }
  });
});

/** 应用启动时恢复上次的页签：**默认只连接活动页签**，其余恢复为「待连接」，
 *  切换到该页签（或在其终端里按 Enter）时再自动连接。
 *  凭据从已保存的连接回填（仅勾了「记住密码」）；没有凭据的恢复为页内密码输入态。 */
export function restoreTabs() {
  try {
    let saved: { activeId: string | null; list: SavedTab[] } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(TABS_KEY) || "null");
    } catch { /* 数据损坏则放弃恢复 */ }
    if (saved && Array.isArray(saved.list) && saved.list.length) {
      restoringTabs = true;
      const idMap = new Map<string, string>();
      for (const s of saved.list) {
        if (!s || typeof s.config !== "object" || (s.kind !== "local" && !s.config.host)) continue;
        const cfg: SshConfig = { ...s.config };
        const prof = s.profileId ? profilesState.list.find((p) => p.id === s.profileId) : undefined;
        cfg.password = s.kind !== "local" && prof?.rememberPassword ? prof.password : "";
        const hasCreds = s.kind === "local" || !!cfg.password || !!cfg.privateKey;
        const tab = createTab(cfg, {
          kind: s.kind === "local" ? "local" : "ssh",
          profileId: s.profileId ?? null,
          title: typeof s.title === "string" ? s.title : undefined,
          restored: hasCreds,
          askPassword: s.kind !== "local" && !hasCreds,
        });
        if (s.id) idMap.set(s.id, tab.id);
      }
      restoringTabs = false;
      // 只激活（并连接）上次活动的页签
      const target = idMap.get(saved.activeId ?? "") ?? tabsState.list[tabsState.list.length - 1]?.id;
      if (target) activateTab(target);
    }
  } finally {
    persistArmed = true; // 无论恢复与否，此后页签变化才允许写盘
  }
}

export const findTab = (id: string | null) =>
  id ? tabsState.list.find((t) => t.id === id) : undefined;
export const activeTab = () => findTab(tabsState.activeId);

export function terminalTheme() {
  // 背景色以 CSS 的 --term-bg 为唯一来源：xterm 行高向下取整会在底部留几像素，
  // .pane 用同一个值铺底，缝隙才不会露出异色。
  const cssBg = getComputedStyle(document.documentElement).getPropertyValue("--term-bg").trim();
  return ui.theme === "light"
    ? { background: cssBg || "#ffffff", foreground: "#1d2433", cursor: "#2f6fdb", selectionBackground: "#c9dcff" }
    : { background: cssBg || "#212429", foreground: "#d8dee9", cursor: "#4c8dff", selectionBackground: "#3b4d70" };
}

/** 终端输出可能不是完整 UTF-8，必须按字节传 base64 */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const defaultTitle = (cfg: SshConfig) => cfg.title?.trim() || `${cfg.username}@${cfg.host}`;

export function fitTab(id: string) {
  try { runtime.get(id)?.fit.fit(); } catch { /* 容器尺寸为 0 时忽略 */ }
}

export function focusTab(id: string) {
  runtime.get(id)?.term.focus();
}

/** xterm 的 write 同时接受字符串与二进制块：SSH 输出来自 base64 解码，走 Uint8Array 不会破坏多字节字符 */
function writeTab(id: string, data: string | Uint8Array) {
  runtime.get(id)?.term.write(data);
}

/** 面板收起后把焦点还给终端；有弹窗或正在输入密码时不抢焦点 */
export function restoreTerminalFocus() {
  if (ui.modal.open || ui.sftpOpen) return;
  const tab = activeTab();
  if (tab && tab.status !== "need-password") focusTab(tab.id);
}

export function refreshTheme() {
  runtime.forEach(({ term }) => { term.options.theme = terminalTheme(); });
}

/* ==================== 终端字号（⌘+ / ⌘- / ⌘0，跨重启记住） ==================== */

const FONT_KEY = "nanossh-font-size";
const FONT_DEFAULT = 13;
const FONT_MIN = 9;
const FONT_MAX = 28;

function readFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) return Math.round(n);
  } catch { /* 隐私模式等读取失败时用默认值 */ }
  return FONT_DEFAULT;
}

/** 当前终端字号：新页签按它创建，缩放时同步已打开的所有终端 */
export const fontState = $state({ size: readFontSize() });

function applyFontSize(size: number) {
  const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)));
  fontState.size = clamped;
  try { localStorage.setItem(FONT_KEY, String(clamped)); } catch { /* 忽略 */ }
  // 改字号会改变行列数：重排后 fit 一次，onResize 会把新的 cols/rows 推给远端
  runtime.forEach(({ term, fit }) => {
    term.options.fontSize = clamped;
    try { fit.fit(); } catch { /* 容器尺寸为 0 时忽略 */ }
  });
}

/** 缩放终端字号（delta 为 ±1 步，每步 1px）；已到上下限时只提示不动 */
export function zoomFont(delta: number) {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, fontState.size + delta));
  if (next === fontState.size) {
    toast(delta > 0
      ? t("已是最大字号 {n}px", { n: fontState.size })
      : t("已是最小字号 {n}px", { n: fontState.size }));
    return;
  }
  applyFontSize(next);
  toast(t("字号 {n}px", { n: next }));
}

/** 恢复默认字号 */
export function resetFont() {
  applyFontSize(FONT_DEFAULT);
  toast(t("字号恢复默认 {n}px", { n: FONT_DEFAULT }));
}

/* ==================== 终端光标样式（视图菜单切换，跨重启记住） ==================== */

/** 切换光标样式：立即作用于已打开的所有终端（xterm 支持热改 options） */
export function applyCursorStyle(style: CursorStyle) {
  saveCursorStyle(style);
  runtime.forEach(({ term }) => {
    term.options.cursorStyle = style;
    term.options.cursorWidth = CURSOR_BAR_WIDTH;
  });
}

/** TerminalView 挂载完成后调用：创建 xterm 并按状态决定是否立即建连 */
export async function registerTerminal(tabId: string, container: HTMLElement) {
  const tab = findTab(tabId);
  if (!tab || runtime.has(tabId)) return;

  const term = new Terminal({
    fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: fontState.size,
    lineHeight: 1.25,
    cursorBlink: true,
    // xterm 默认 cursorStyle=block：整格涂满，中文/宽字体下看着像一条粗蓝块。
    // 默认改用竖线（bar, 2px），样式可在「视图 → 光标样式」里换回块状/下划线。
    cursorStyle: cursorState.style,
    cursorWidth: CURSOR_BAR_WIDTH,
    // 失焦窗口的光标默认仍是实心块，这里统一成空心框，避免误以为是输入位置
    cursorInactiveStyle: "outline",
    scrollback: 10000,
    theme: terminalTheme(),
    // xterm 默认 scrollOnUserInput=true：任何 keydown（包括纯 Ctrl/Option/Command 修饰键）
    // 都会把视口拽回底部——往上翻历史想复制时，一按 Cmd+C 就跳走。关掉后由 onData 里
    // 自己滚（只有真正产生输入/粘贴才回底部，修饰键与复制快捷键不再触发）。
    scrollOnUserInput: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // xterm 用隐藏 textarea 收键，它同样受 macOS 自动更正 / 自动大写影响：在 shell 里敲首个
  // 小写字母会被替换成大写（甚至弹出「R ×」建议气泡），直接变成错命令。三个属性关掉。
  const ta = term.textarea;
  if (ta) {
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("spellcheck", "false");
    ta.setAttribute("autocomplete", "off");
  }

  // OSC 1337 CurrentDir：仅被动接收 shell 自己上报的目录，应用不注入任何探测命令
  term.parser.registerOscHandler(1337, (data) => {
    const m = /^CurrentDir=(.*)$/.exec(data);
    if (!m || !m[1]) return false;
    const t = findTab(tabId);
    if (t) t.cwd = m[1];
    return true;
  });

  term.onData((data) => {
    const tb = findTab(tabId);
    if (!tb) return;
    // scrollOnUserInput 已关：真正产生了输入（键入 / 粘贴 / 发送）才回到底部
    term.scrollToBottom();
    // 失败/待连接态下吞掉输入，只把 Enter 当作「重新连接」
    if (tb.status === "failed" || tb.status === "restored") {
      if (data.includes("\r") || data.includes("\n")) void reconnect(tb);
      return;
    }
    if (!tb.sessionId) return;
    invoke("ssh_write", { id: tb.sessionId, data: toBase64(data) })
      .catch((e) => toast(t("发送失败：{err}", { err: String(e) }), true));
  });

  term.onResize(({ cols, rows }) => {
    const t = findTab(tabId);
    if (!t?.sessionId) return;
    invoke("ssh_resize", { id: t.sessionId, cols, rows }).catch(() => {});
  });

  const observer = new ResizeObserver(() => {
    if (tabsState.activeId === tabId) fitTab(tabId);
  });
  observer.observe(container);
  runtime.set(tabId, { term, fit, observer });
  try { fit.fit(); } catch { /* 忽略 */ }

  if (tab.status === "restored") {
    // 重启恢复的页签：不自动建连；活动页签在挂载完成后立即连接（activateTab 可能早于挂载执行），
    // 其余页签保持空白，切换到它时由 activateTab 自动连接
    if (tabsState.activeId === tabId) {
      await establish(tab);
    }
    return;
  }
  if (tab.status !== "need-password") await establish(tab);
}

export function disposeTerminal(tabId: string) {
  const r = runtime.get(tabId);
  if (!r) return;
  r.observer.disconnect();
  r.term.dispose();
  runtime.delete(tabId);
}

/** 当前终端选区文本（右键菜单「复制」用；无选区返回空串） */
export function terminalSelection(tabId: string | null): string {
  if (!tabId) return "";
  return runtime.get(tabId)?.term.getSelection() ?? "";
}

/** 把文本粘进终端：走 xterm 的 paste，等价于用户键入（会经 onData 发往远端） */
export function pasteToTerminal(tabId: string | null, text: string) {
  if (!tabId || !text) return;
  runtime.get(tabId)?.term.paste(text);
}

function failureHint(err: unknown, isLocal: boolean) {
  if (isLocal) {
    return `\r\n\x1b[31m${t("本地终端启动失败：{err}", { err: String(err) })}\x1b[0m\r\n` +
           `\x1b[90m${t("按 Enter 重新打开本地终端")}\x1b[0m\r\n\r\n`;
  }
  return `\r\n\x1b[31m${t("连接失败：{err}", { err: String(err) })}\x1b[0m\r\n` +
         `\x1b[90m${t("按 Enter 重新连接 · 右键页签可「编辑连接」修改配置")}\x1b[0m\r\n\r\n`;
}

/** 建立（或重建）会话：SSH 走 ssh_connect，本地终端走 local_open，其余链路共用 */
export async function establish(tab: Tab) {
  const isLocal = tab.kind === "local";
  const cfg = tab.config;
  const { title: _ignored, ...sshConfig } = cfg;
  const r = runtime.get(tab.id);
  if (!r) return;
  tab.status = "connecting";
  tab.cwd = null;
  setStatus(isLocal ? t("正在启动本地终端…") : t("正在连接 {user}@{host}…", { user: cfg.username, host: cfg.host }));
  try {
    const sessionId = isLocal
      ? await invoke<string>("local_open", { cols: r.term.cols, rows: r.term.rows })
      : await invoke<string>("ssh_connect", {
          config: { ...sshConfig, cols: r.term.cols, rows: r.term.rows },
        });
    tab.sessionId = sessionId;
    tab.status = "connected";
    setStatus(isLocal ? t("本地终端已就绪") : t("已连接 {user}@{host}", { user: cfg.username, host: cfg.host }), "ok");
    toast(isLocal ? t("本地终端已启动") : t("已连接：{title}", { title: tab.title }));
    fitTab(tab.id);
    if (tabsState.activeId === tab.id) focusTab(tab.id);
  } catch (err) {
    tab.sessionId = null;
    tab.status = "failed";
    writeTab(tab.id, failureHint(err, isLocal));
    setStatus(isLocal ? t("本地终端启动失败") : t("连接失败：{title}", { title: tab.title }), "error");
    toast(t(isLocal ? "本地终端启动失败：{err}" : "连接失败：{err}", { err: String(err) }), true);
    if (tabsState.activeId === tab.id) focusTab(tab.id);
  }
}

export async function reconnect(tab: Tab) {
  if (tab.status === "connecting") return;
  if (tab.sessionId) {
    const old = tab.sessionId;
    tab.sessionId = null;
    try { await invoke("ssh_close", { id: old }); } catch { /* 已断开 */ }
  }
  writeTab(tab.id, tab.kind === "local"
    ? `\r\n\x1b[90m${t("正在重新打开本地终端…")}\x1b[0m\r\n`
    : `\r\n\x1b[90m${t("正在重新连接…")}\x1b[0m\r\n`);
  await establish(tab);
}

/** 页内输入密码后连接；「记住密码」由组件另行调用 profiles.rememberPassword */
export async function submitPassword(tab: Tab, password: string) {
  tab.config = { ...tab.config, password };
  tab.status = "connecting";
  await establish(tab);
}

/** 新建本地 shell 页签（与 SSH 页签共用读写、尺寸与关闭链路） */
export function openLocalTerminal() {
  closePanels();
  createTab(
    { title: t("本地终端"), host: "", port: 22, username: "", password: "", privateKey: "" },
    { kind: "local" },
  );
}

export function createTab(
  cfg: SshConfig,
  opts: {
    kind?: TabKind;
    askPassword?: boolean;
    profileId?: string | null;
    cloneFrom?: string | null;
    /** 重启恢复：建为「待连接」页签，不立即建连 */
    restored?: boolean;
    /** 恢复时沿用持久化保存的标题（保留「副本N」等） */
    title?: string;
  } = {},
): Tab {
  const id = `tab-${++tabsState.seq}`;
  const tab: Tab = {
    id,
    title: opts.title ?? defaultTitle(cfg),
    config: cfg,
    profileId: opts.profileId ?? null,
    kind: opts.kind ?? "ssh",
    sessionId: null,
    status: opts.restored ? "restored" : (opts.askPassword ? "need-password" : "connecting"),
    cwd: null,
    cloneFrom: opts.cloneFrom ?? null,
  };
  tabsState.list.push(tab);
  activateTab(id);
  // 返回响应式代理对象，后续赋值才能触发组件更新
  return findTab(id)!;
}

export function activateTab(id: string) {
  const tab = findTab(id);
  if (!tab) return;
  tabsState.activeId = id;
  requestAnimationFrame(() => {
    fitTab(id);
    focusTab(id);
  });
  setStatus(tab.status === "connected" ? t("已连接 {title}", { title: tab.title }) : t("就绪"));
  // 恢复的页签：切换到它时自动连接；启动恢复过程中由 restoreTabs 统一处理活动页签
  if (tab.status === "restored" && !restoringTabs) void establish(tab);
}

/** 拖动页签排序：把 id 移到列表第 to 个位置（0..list.length，含"放到末尾"）。
 *  to 是按拖动前的布局算出的插入位：目标在原位之后时先移除会前移一位，这里补回来 */
export function moveTabTo(id: string, to: number) {
  const list = tabsState.list;
  const from = list.findIndex((tb) => tb.id === id);
  if (from < 0 || to < 0 || to > list.length || to === from || to === from + 1) return;
  const [moved] = list.splice(from, 1);
  const insert = from < to ? to - 1 : to;
  list.splice(Math.min(insert, list.length), 0, moved);
}

export async function closeTab(id: string) {
  const tab = findTab(id);
  if (!tab) return;
  // 先解绑 sessionId，避免 ssh-closed 事件在移除过程中把状态改回失败
  const sid = tab.sessionId;
  tab.sessionId = null;
  if (sid) {
    try { await invoke("ssh_close", { id: sid }); } catch { /* 后端可能已断开 */ }
  }
  disposeTerminal(id);
  const i = tabsState.list.findIndex((t) => t.id === id);
  if (i >= 0) tabsState.list.splice(i, 1);
  if (tabsState.activeId === id) {
    const next = tabsState.list[tabsState.list.length - 1];
    tabsState.activeId = next?.id ?? null;
    if (next) activateTab(next.id);
    else setStatus(t("就绪"));
  }
}

/** 克隆尾缀（zh「副本N」/ en「copy N」）：生成时随界面语言，剥除时两种历史格式都兼容 */
const CLONE_TAIL = /\s*(?:副本\s*(\d+)|[Cc]opy\s+(\d+))$/;

/** 「原标题 副本N」：编号全局累加、关闭页签不回退，克隆副本时先剥掉旧编号 */
export function nextCloneTitle(sourceTitle: string): string {
  const base = sourceTitle.replace(CLONE_TAIL, "").trim() || sourceTitle;
  const used = new Set(
    tabsState.list
      .map((t) => CLONE_TAIL.exec(t.title))
      .map((m) => (m ? Number(m[1] ?? m[2]) : null))
      .filter((n): n is number => n !== null)
  );
  let n = tabsState.cloneSeq + 1;
  while (used.has(n)) n++;
  tabsState.cloneSeq = n;
  return `${base} ${t("副本{n}", { n })}`;
}

export function cloneTab(tab: Tab) {
  const title = nextCloneTitle(tab.title);
  createTab({ ...tab.config, title }, {
    kind: tab.kind,
    profileId: tab.profileId,
    cloneFrom: tab.title,
  });
  toast(t("已克隆会话：{title}", { title }));
}

/** 编辑连接后更新页签配置，并立即按新配置重建会话（保存即重连） */
export async function applyEditedConfig(tab: Tab, cfg: SshConfig, profileId: string | null) {
  tab.config = cfg;
  tab.profileId = profileId;
  tab.title = defaultTitle(cfg);
  // 不论当前状态（已连接 / 失败 / 待输密码），都断开旧会话按新配置重连
  await reconnect(tab);
}

export async function copyTitle(tab: Tab) {
  const ok = await copyText(tab.title);
  toast(ok ? t("已复制标题：{title}", { title: tab.title }) : t("复制失败，请检查剪贴板权限"), !ok);
}

/** SSH 输出流：按 sessionId 找到页签并写入 xterm */
export function handleSshData(payload: { id: string; data: string }) {
  const tab = tabsState.list.find((t) => t.sessionId === payload.id);
  if (tab) writeTab(tab.id, fromBase64(payload.data));
}

export function handleSshClosed(payload: { id: string; reason: string }) {
  const tab = tabsState.list.find((t) => t.sessionId === payload.id);
  if (!tab) return;
  tab.sessionId = null;
  tab.status = "failed";
  const hint = tab.kind === "local"
    ? `\x1b[90m${t("按 Enter 重新打开本地终端")}\x1b[0m`
    : `\x1b[90m${t("按 Enter 重新连接 · 右键页签可「编辑连接」修改配置")}\x1b[0m`;
  writeTab(tab.id, `\r\n\x1b[33m${t("[会话已结束] {reason}", { reason: payload.reason })}\x1b[0m\r\n${hint}\r\n\r\n`);
  setStatus(t("会话已断开：{title}", { title: tab.title }), "error");
  if (tabsState.activeId === tab.id) focusTab(tab.id);
}

/* ==================== 网络断开 / 恢复 ==================== */

/** 断网时被标记为「待网络恢复」的 SSH 页签 id：恢复时精准提示，不误伤本来就失败的页签 */
const netDownTabs = new Set<string>();

/** 监听系统网络状态：断开时把已连接的 SSH 页签转为待重连（本地终端不受影响），
 *  恢复时在终端里提示「按 Enter 重新连接」。 */
export function initNetworkWatch() {
  window.addEventListener("offline", () => {
    const affected = tabsState.list.filter((tb) => tb.kind !== "local" && tb.status === "connected");
    for (const tb of affected) {
      netDownTabs.add(tb.id);
      // 不清 sessionId：按 Enter 重连时统一由 reconnect() 关旧建新
      tb.status = "failed";
      writeTab(tb.id,
        `\r\n\x1b[33m${t("网络已断开，会话可能已失效")}\x1b[0m\r\n` +
        `\x1b[90m${t("网络恢复后会提示重新连接")}\x1b[0m\r\n\r\n`);
    }
    if (affected.length) setStatus(t("网络已断开"), "error");
  });
  window.addEventListener("online", () => {
    if (!netDownTabs.size) return;
    for (const id of [...netDownTabs]) {
      netDownTabs.delete(id);
      const tb = findTab(id);
      if (!tb || tb.kind === "local") continue;
      writeTab(tb.id, `\r\n\x1b[33m${t("网络已恢复，按 Enter 重新连接")}\x1b[0m\r\n\r\n`);
    }
    setStatus(t("网络已恢复，按 Enter 重新连接"), "ok");
  });
}

/** 供传输面板显示字节进度的公共格式化函数 */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const basename = (p: string) => p.split(/[\\/]/).pop() || p;

export type { ProgressPayload };
