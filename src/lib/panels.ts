/** 三个悬停/点击面板的开关与定位，供触发按钮和面板组件共用 */

import {
  ui, cancelPanelTimers, schedulePanelOpen, schedulePanelClose,
} from "./stores/ui.svelte";
import { profilesState } from "./stores/profiles.svelte";
import { restoreTerminalFocus } from "./stores/tabs.svelte";

const PANEL_WIDTH = 340;

function place(which: "profiles" | "quick" | "transfers", r: DOMRect, width = PANEL_WIDTH) {
  const w = Math.min(width, window.innerWidth - 24);
  ui.panelPos[which] = {
    top: r.bottom + 6,
    left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 12)),
  };
}

function closeAllExcept(which: "profiles" | "quick" | "transfers") {
  ui.panels.profiles = which === "profiles";
  ui.panels.quick = which === "quick";
  ui.panels.transfers = which === "transfers";
}

function afterClose() {
  restoreTerminalFocus();
}

/* ---------- ☰ 已保存的连接（点击切换） ---------- */
export function toggleProfilesPanel(rect: DOMRect) {
  cancelPanelTimers();
  if (ui.panels.profiles) return closeProfilesPanel();
  if (ui.modal.open) return;
  closeAllExcept("profiles");
  place("profiles", rect, 360);
  profilesState.manageQuery = "";
}

export function closeProfilesPanel() {
  if (!ui.panels.profiles) return;
  ui.panels.profiles = false;
  profilesState.manageQuery = "";
  afterClose();
}

/* ---------- ＋ 快捷新建（悬停 120ms 打开） ---------- */
export function showQuickPanel(rect: DOMRect) {
  if (ui.modal.open) return;
  closeAllExcept("quick");
  place("quick", rect, 320);
  // ＋ 在页签栏最右，面板右缘对齐按钮右缘向左展开（place 里已按 r.right - w 定位并夹在窗口内）
  profilesState.quickQuery = "";
}

export function closeQuickPanel() {
  cancelPanelTimers();
  if (!ui.panels.quick) return;
  ui.panels.quick = false;
  profilesState.quickQuery = "";
  afterClose();
}

/* ---------- ⬆ 后台传输（悬停 120ms 打开） ---------- */
export function showTransferPanel(rect: DOMRect) {
  if (ui.modal.open) return;
  closeAllExcept("transfers");
  place("transfers", rect, 380);
}

export function closeTransferPanel() {
  cancelPanelTimers();
  if (!ui.panels.transfers) return;
  ui.panels.transfers = false;
  afterClose();
}

/* ---------- 悬停定时器包装 ---------- */
export function hoverOpen(which: "quick" | "transfers", rect: () => DOMRect) {
  if (ui.panels[which]) return cancelPanelTimers();
  const fn = which === "quick" ? showQuickPanel : showTransferPanel;
  schedulePanelOpen(() => fn(rect()));
}

export function hoverClose(which: "quick" | "transfers") {
  const fn = which === "quick" ? closeQuickPanel : closeTransferPanel;
  const btnId = which === "quick" ? "tab-add" : "btn-upload";
  const panelId = which === "quick" ? "panel-quick" : "panel-transfer";
  schedulePanelClose(fn, [btnId, panelId]);
}
