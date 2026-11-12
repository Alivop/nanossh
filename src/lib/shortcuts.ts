/** 键盘兜底：终端字号快捷键。
 *
 *  原生菜单加速键处理的是不带 Shift 的组合（⌘= / ⌘- / ⌘0），而用户按 ⌘+ 时实际是
 *  ⌘⇧=（macOS 的菜单等价键按字符匹配，匹配不到带 Shift 的变体）。这里在 webview 里补上
 *  这些组合：菜单命中时事件不会下发到 webview，所以两边永远不会重复触发。
 */

import { zoomFont, resetFont } from "./stores/tabs.svelte";

/** Shift 变体与小键盘的加/减号（macOS 用 ⌘，其他平台用 Ctrl） */
export function initShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (e.altKey || !(e.metaKey || e.ctrlKey)) return;
    switch (e.code) {
      case "Equal":          // ⌘⇧= → ⌘+
        if (!e.shiftKey) return; // 不带 Shift 的交由原生菜单加速键
        e.preventDefault();
        zoomFont(1);
        break;
      case "Minus":          // ⌘⇧- → ⌘_
        if (!e.shiftKey) return;
        e.preventDefault();
        zoomFont(-1);
        break;
      case "Digit0":         // ⌘⇧0 → ⌘)
        if (!e.shiftKey) return;
        e.preventDefault();
        resetFont();
        break;
      case "NumpadAdd":
        e.preventDefault();
        zoomFont(1);
        break;
      case "NumpadSubtract":
        e.preventDefault();
        zoomFont(-1);
        break;
      default:
        break;
    }
  });
}
