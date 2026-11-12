/** 顶部原生菜单的事件分发：Rust 侧菜单项点击后只 emit("app-menu", id)，
 *  具体动作在这里按 id 落到对应 store（菜单本身由 Rust 按语言构建）。 */

import { listen } from "@tauri-apps/api/event";
import { openModal, toggleTheme, toast } from "./stores/ui.svelte";
import { activeTab, closeTab, openLocalTerminal, zoomFont, resetFont, applyCursorStyle } from "./stores/tabs.svelte";
import { openSftp } from "./stores/browser.svelte";
import { toggleLocale, syncAppMenu, t } from "./i18n.svelte";
import type { CursorStyle } from "./stores/cursor.svelte";

/** 切换光标样式：作用于所有终端，再重建菜单把勾选挪到新项上 */
function setCursor(style: CursorStyle, label: string) {
  applyCursorStyle(style);
  toast(t("光标样式：{s}", { s: t(label) }));
  syncAppMenu();
}

const actions: Record<string, () => void> = {
  "new-connection": () => openModal(),
  "new-local": () => openLocalTerminal(),
  "close-tab": () => {
    const tab = activeTab();
    if (tab) void closeTab(tab.id);
  },
  "toggle-theme": () => toggleTheme(),
  "toggle-locale": () => toggleLocale(),
  "open-sftp": () => {
    const tab = activeTab();
    if (tab) openSftp(tab);
  },
  "font-in": () => zoomFont(1),
  "font-out": () => zoomFont(-1),
  "font-reset": () => resetFont(),
  "cursor-bar": () => setCursor("bar", "竖线"),
  "cursor-block": () => setCursor("block", "方块"),
  "cursor-underline": () => setCursor("underline", "下划线"),
};

/** 订阅菜单事件（非 Tauri 环境如浏览器预览里 listen 会失败，直接忽略） */
export function initAppMenu() {
  void listen<string>("app-menu", ({ payload }) => actions[payload]?.()).catch(() => {});
}
