/** 终端光标样式偏好。
 *
 *  单独成文件是为了避免循环依赖：i18n 重建原生菜单时要读当前样式（菜单里打勾），
 *  tabs 要读它来创建终端，而本文件不依赖任何其它 store。
 *
 *  xterm 的块状光标会把整个字符格涂满，中文字体下显得特别宽，所以默认改成竖线。
 */

export type CursorStyle = "bar" | "block" | "underline";

const KEY = "nanossh-cursor-style";

/** 竖线宽度（CSS px）：2px 在 Retina 上清晰，又不会糊住字符 */
export const CURSOR_BAR_WIDTH = 2;

export const CURSOR_STYLES: CursorStyle[] = ["bar", "block", "underline"];

function read(): CursorStyle {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "bar" || v === "block" || v === "underline") return v;
  } catch { /* 隐私模式等读取失败时用默认值 */ }
  return "bar";
}

/** 当前光标样式：新页签按它创建，切换时同步已打开的所有终端 */
export const cursorState = $state<{ style: CursorStyle }>({ style: read() });

/** 只落盘 + 更新状态（应用终端效果由 tabs 的 applyCursorStyle 负责） */
export function saveCursorStyle(style: CursorStyle) {
  cursorState.style = style;
  try { localStorage.setItem(KEY, style); } catch { /* 忽略 */ }
}
