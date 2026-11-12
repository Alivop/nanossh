/** 全局 UI 状态：主题、状态栏、轻提示、面板/弹窗/右键菜单的开关。
 *  不 import 任何业务 store，避免循环依赖；需要恢复终端焦点时由调用方显式处理。 */

import type { SshConfig } from "../types";
import { t } from "../i18n.svelte";

const THEME_KEY = "nanossh-theme";
export type Theme = "dark" | "light";

export interface ToastItem {
  id: number;
  message: string;
  error: boolean;
}

export interface ModalState {
  open: boolean;
  profileId: string | null;
  tabId: string | null;
  connectAfterSave: boolean;
  duplicate: boolean;
  prefill: SshConfig | null;
  /** 编辑时预选的分组 */
  group: string;
}

function initialTheme(): Theme {
  try {
    // 兼容更早版本 SSHTabs 的主题键
    const saved = localStorage.getItem(THEME_KEY) || localStorage.getItem("sshtabs-theme");
    return saved === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export const ui = $state({
  theme: initialTheme(),
  statusText: t("就绪"),
  statusKind: "" as "" | "ok" | "error",
  toasts: [] as ToastItem[],
  panels: { profiles: false, quick: false, transfers: false },
  sftpOpen: false,
  modal: {
    open: false,
    profileId: null,
    tabId: null,
    connectAfterSave: true,
    duplicate: false,
    prefill: null,
    group: "未分组",
  } as ModalState,
  contextMenu: {
    open: false,
    x: 0,
    y: 0,
    tabId: null as string | null,
    /** tab=页签菜单（克隆/编辑/传输/重连）；terminal=终端菜单（复制/粘贴） */
    kind: "tab" as "tab" | "terminal",
    /** 终端菜单里「复制」是否可用（右键时有选区才亮） */
    canCopy: false,
  },
  /** 悬停面板按触发按钮的 rect 定位 */
  panelPos: {
    profiles: { top: 0, left: 0 },
    quick: { top: 0, left: 0 },
    transfers: { top: 0, left: 0 },
  },
});

let toastSeq = 0;

export function applyTheme() {
  const root = document.documentElement;
  root.classList.toggle("dark", ui.theme === "dark");
  root.dataset.theme = ui.theme;
  try { localStorage.setItem(THEME_KEY, ui.theme); } catch { /* 忽略 */ }
}

export function toggleTheme() {
  ui.theme = ui.theme === "dark" ? "light" : "dark";
  applyTheme();
}

export function toast(message: string, error = false) {
  const id = ++toastSeq;
  ui.toasts.push({ id, message, error });
  setTimeout(() => {
    const i = ui.toasts.findIndex((t) => t.id === id);
    if (i >= 0) ui.toasts.splice(i, 1);
  }, 2400);
}

export function setStatus(text: string, kind: "" | "ok" | "error" = "") {
  ui.statusText = text;
  ui.statusKind = kind;
}

export function closePanels() {
  ui.panels.profiles = false;
  ui.panels.quick = false;
  ui.panels.transfers = false;
}

export function openModal(options: Partial<ModalState> = {}) {
  closePanels();
  ui.sftpOpen = false;
  hideContextMenu();
  ui.modal = {
    open: true,
    profileId: options.profileId ?? null,
    tabId: options.tabId ?? null,
    connectAfterSave: options.connectAfterSave ?? true,
    duplicate: options.duplicate ?? false,
    prefill: options.prefill ?? null,
    group: options.group ?? "未分组",
  };
}

export function closeModal() {
  ui.modal.open = false;
}

export function showContextMenu(x: number, y: number, tabId: string) {
  ui.contextMenu = {
    open: true,
    x: Math.min(x, Math.max(0, window.innerWidth - 200)),
    y: Math.min(y, Math.max(0, window.innerHeight - 260)),
    tabId,
    kind: "tab",
    canCopy: false,
  };
}

/** 终端右键：复制（有选区才可用）/ 粘贴 */
export function showTerminalMenu(x: number, y: number, tabId: string, canCopy: boolean) {
  ui.contextMenu = {
    open: true,
    x: Math.min(x, Math.max(0, window.innerWidth - 160)),
    y: Math.min(y, Math.max(0, window.innerHeight - 100)),
    tabId,
    kind: "terminal",
    canCopy,
  };
}

export function hideContextMenu() {
  ui.contextMenu.open = false;
}

/* ---------- 悬停面板共用定时器（触发按钮与面板之间留一小段空隙） ---------- */
let hoverOpenTimer: ReturnType<typeof setTimeout> | undefined;
let hoverCloseTimer: ReturnType<typeof setTimeout> | undefined;

export function schedulePanelOpen(fn: () => void, delay = 120) {
  clearTimeout(hoverOpenTimer);
  clearTimeout(hoverCloseTimer);
  hoverOpenTimer = setTimeout(fn, delay);
}

export function schedulePanelClose(fn: () => void, guardIds: string[], delay = 260) {
  clearTimeout(hoverOpenTimer);
  clearTimeout(hoverCloseTimer);
  hoverCloseTimer = setTimeout(() => {
    if (guardIds.some((id) => document.getElementById(id)?.matches(":hover"))) return;
    fn();
  }, delay);
}

export function cancelPanelTimers() {
  clearTimeout(hoverOpenTimer);
  clearTimeout(hoverCloseTimer);
}

/** 复制文本：优先 WebView 剪贴板，失败降级到 execCommand */
export async function copyText(text: string): Promise<boolean> {
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
