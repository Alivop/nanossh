/** 轻量 i18n：中文原文即 key（zh 模式直接返回原文），en 模式查词典；
 *  支持 {name} 插值。locale 存 localStorage，切语言即时生效（模板里调用 t() 会因
 *  读取 i18n.locale 而建立响应式依赖）。模块不 import 任何业务 store，避免循环依赖；
 *  唯一的例外是 cursor.svelte（零依赖的纯偏好状态，重建菜单时需要读当前光标样式）。 */

import { invoke } from "@tauri-apps/api/core";
import { cursorState } from "./stores/cursor.svelte";

export type Locale = "zh" | "en";
const LOCALE_KEY = "nanossh-locale";

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch { /* 忽略 */ }
  return "zh";
}

export const i18n = $state({ locale: initialLocale() });

/** 让顶部原生菜单跟随界面语言与光标样式：Rust 侧按 (locale, 光标样式) 整份重建 */
export function syncAppMenu() {
  void invoke("set_app_menu", { locale: i18n.locale, cursorStyle: cursorState.style }).catch(() => {
    /* 浏览器预览等非 Tauri 环境调用失败：菜单本就不存在，忽略 */
  });
}

export function toggleLocale() {
  i18n.locale = i18n.locale === "zh" ? "en" : "zh";
  try { localStorage.setItem(LOCALE_KEY, i18n.locale); } catch { /* 忽略 */ }
  syncAppMenu();
}

/** 按当前语言格式化时间戳（传输面板用） */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(i18n.locale === "en" ? "en-US" : "zh-CN");
}

const EN: Record<string, string> = {
  // ---- 通用 ----
  "关闭": "Close",
  "取消": "Cancel",
  "保存": "Save",
  "编辑": "Edit",
  "删除": "Delete",
  "刷新": "Refresh",
  "连接": "Connect",
  "复制": "Copy",
  "粘贴": "Paste",
  "读取剪贴板失败，请检查权限": "Failed to read the clipboard; check permission",
  "就绪": "Ready",
  "未分组": "Ungrouped",
  "切换语言": "Switch language",

  // ---- 标题栏 / 交通灯 ----
  "最小化": "Minimize",
  "最大化": "Zoom",
  "已保存的连接": "Saved connections",
  "点击打开文件浏览器 · 悬停查看后台传输": "Click to open file browser · Hover for transfers",
  "点击打开文件浏览器，悬停查看后台传输": "Click to open the file browser; hover to view transfers",
  "切换明暗主题": "Toggle light/dark theme",
  "新建连接": "New connection",

  // ---- 终端字号 ----
  "字号 {n}px": "Font size {n}px",
  "字号恢复默认 {n}px": "Font size reset to {n}px",
  "已是最大字号 {n}px": "Already at the largest font size ({n}px)",
  "已是最小字号 {n}px": "Already at the smallest font size ({n}px)",
  "字号：⌘= 或 ⌘+ 放大 · ⌘- 或 ⌘_ 缩小 · ⌘0 重置":
    "Font size: ⌘= or ⌘+ larger · ⌘- or ⌘_ smaller · ⌘0 reset",

  // ---- 终端光标 ----
  "竖线": "Bar",
  "方块": "Block",
  "下划线": "Underline",
  "光标样式：{s}": "Cursor style: {s}",
  "最近连接": "Recent connections",

  // ---- 页签栏 ----
  "克隆自「{title}」": "Cloned from \u201c{title}\u201d",
  "已连接": "Connected",
  "连接失败，按 Enter 重新连接": "Connection failed; press Enter to reconnect",
  "连接中": "Connecting",
  "未连接 · 切换到此页签时自动连接": "Not connected — connects automatically when you switch to this tab",
  "副本{n}": "copy {n}",
  "复制标题": "Copy title",
  "关闭页签": "Close tab",
  "点击新建本地终端 · 悬停查看快捷新建": "Click for a local terminal · Hover for quick connect",
  "点击新建本地终端，悬停查看快捷新建": "Click for a local terminal; hover for quick connect",

  // ---- 空状态 ----
  "还没有会话": "No sessions yet",
  "新建连接后可在多个页签间切换，切换不会中断 SSH 会话": "Open a connection, then switch between tabs without dropping the SSH session",
  "双击页签 → 克隆会话（原名 + 副本1、副本2…）": "Double-click a tab → clone session (title + copy 1, copy 2…)",
  "悬停页签 → 点击按钮复制标题": "Hover a tab → copy-title button",
  "右键页签 → 克隆 / 编辑 / 重连": "Right-click a tab → clone / edit / reconnect",
  "点击 ＋ → 新建本地终端 · 悬停 ＋ → 快捷连接": "Click ＋ → local terminal · Hover ＋ → quick connect",
  "连接失败 → 按 Enter 重连": "Connection failed → press Enter to reconnect",
  "标题栏 ⬆ → 双栏文件浏览器 · 悬停 ⬆ → 后台传输": "Title bar ⬆ → dual-pane file browser · Hover ⬆ → transfers",

  // ---- 新建/编辑连接弹窗 ----
  "复制并编辑连接": "Duplicate and edit connection",
  "编辑连接": "Edit connection",
  "编辑已保存的连接": "Edit saved connection",
  "新建 SSH 连接": "New SSH connection",
  "请填写主机和用户名": "Host and username are required",
  "请填写密码或私钥路径": "Password or private key path is required",
  "正在连接并验证凭据…": "Connecting and verifying credentials…",
  "连接已保存": "Connection saved",
  "配置以 AES-256-GCM 加密保存在本机；密码默认不保存。": "Profiles are stored locally, encrypted with AES-256-GCM; passwords are not saved by default.",
  "页签标题": "Tab title",
  "留空则使用 用户名@主机": "Leave blank for username@host",
  "主机": "Host",
  "端口": "Port",
  "用户名": "Username",
  "密码": "Password",
  "留空则使用私钥": "Leave blank to use the private key",
  "显示 / 隐藏密码": "Show / hide password",
  "私钥文件路径": "Private key path",
  "分组": "Group",
  "选择已有分组，或直接输入新分组名": "Pick an existing group or type a new name",
  "留空归到「未分组」；连接列表按分组折叠展示。": "Leave blank for Ungrouped; the connection list collapses by group.",
  "密码与私钥二选一。私钥支持 OpenSSH / PEM / PPK；路径中的 ~ 会展开为用户目录。": "Password or private key (either one). Keys support OpenSSH / PEM / PPK; ~ expands to the home directory.",
  "保存到连接列表": "Save to connection list",
  "记住密码（AES-256 加密存本机）": "Remember password (AES-256, stored locally)",
  "测试中…": "Testing…",
  "测试": "Test",
  "保存并重连": "Save & reconnect",
  "保存并连接": "Save & connect",

  // ---- 页内密码输入 ----
  "请先输入密码": "Enter the password first",
  "密码已加密保存": "Password saved (encrypted)",
  "需要密码": "Password required",
  "已保存的连接「{title}」没有保存密码，输入密码即可直接连接。": "Saved connection \u201c{title}\u201d has no stored password; enter it to connect.",
  "输入 SSH 密码": "Enter SSH password",
  "隐藏密码": "Hide password",
  "显示密码": "Show password",
  "记住密码（加密保存到此连接）": "Remember password (encrypted into this connection)",
  "密码仅用于本次连接，不会写入连接列表（除非勾选记住）。": "Used only for this connection; not saved unless Remember is checked.",

  // ---- 已保存连接面板 / 快捷面板 ----
  "没有匹配的连接": "No matching connections",
  "已删除连接": "Connection deleted",
  "再次点击删除按钮以确认": "Click delete again to confirm",
  "已复制连接，修改后保存即可": "Connection duplicated; edit and save",
  "搜索名称 / 主机 / 用户名 / 分组": "Search name / host / username / group",
  "点击条目即可连接；可上下拖动排序。关键词可匹配分组名，回车直连第一条。复制图标可复制出一份新连接并直接编辑。配置以 AES-256-GCM 加密保存在本机。": "Click an entry to connect; drag entries up or down to reorder. Keywords also match group names; Enter connects to the first match. The copy icon duplicates a connection for editing. Stored locally, encrypted with AES-256-GCM.",
  "还没有保存的连接。新建连接时勾选「保存到连接列表」即可。": "No saved connections yet. Check \u201cSave to connection list\u201d when creating one.",
  "没有匹配「{query}」的连接": "No connections matching \u201c{query}\u201d",
  "折叠 / 展开分组": "Collapse / expand group",
  "点击直接连接；可上下拖动排序；右侧图标可复制 / 编辑 / 删除": "Click to connect; drag up or down to reorder; icons on the right: duplicate / edit / delete",
  " · 需填密码": " · password needed",
  "复制为新连接并编辑": "Duplicate as a new connection and edit",
  "再次点击确认删除": "Click again to confirm delete",
  "新建会话": "New session",
  "本地终端": "Local terminal",
  "快捷连接：搜索已保存会话": "Quick connect: search saved sessions",
  "还没有保存的连接": "No saved connections yet",
  "点击直接连接": "Click to connect",

  // ---- SFTP 文件浏览器 ----
  "SFTP 文件传输": "SFTP File Transfer",
  "覆盖同名文件": "Overwrite existing files",
  "显示隐藏文件": "Show hidden files",
  "本地": "Local",
  "远程": "Remote",
  "上传 →": "Upload →",
  "← 下载": "← Download",
  "把左侧选中的文件上传到右侧当前目录": "Upload the selected left files into the current right directory",
  "把右侧选中的文件下载到左侧当前目录": "Download the selected right files into the current left directory",
  "选中文件后传输": "Select files to transfer",
  "点击目录进入": "Click a directory to enter",
  "Ctrl / ⌘ 多选": "Ctrl / ⌘ multi-select",
  "上级目录": "Parent directory",
  "本机主目录": "Local home directory",
  "远端默认目录": "Remote default directory",
  "主目录": "Home directory",
  "输入绝对路径后回车跳转": "Type an absolute path and press Enter",
  "正在读取目录…": "Loading directory…",
  "只含隐藏文件（可勾选「显示隐藏文件」）": "Only hidden files (check \u201cShow hidden files\u201d)",
  "空目录": "Empty directory",
  "目录": "Dir",

  // ---- 文件浏览器的排序与搜索 ----
  "搜索": "Search",
  "按文件名过滤当前目录（Esc 清空）": "Filter current directory by name (Esc to clear)",
  "名称": "Name",
  "大小": "Size",
  "点击按名称排序（再点一次换方向）": "Sort by name (click again to reverse)",
  "点击按大小排序（再点一次换方向）": "Sort by size (click again to reverse)",
  "点击按修改时间排序（再点一次换方向）": "Sort by modified time (click again to reverse)",
  "修改时间": "Modified",
  "没有匹配的文件": "No matching files",

  // ---- 拖拽上传 ----
  "松开鼠标上传 {n} 个文件": "Release to upload {n} file(s)",
  "当前没有已连接的 SSH 会话，无法上传拖入的文件": "No connected SSH session; dropped files cannot be uploaded",
  "拖入的都是目录，暂不支持目录上传": "Only folders were dropped; folder upload is not supported yet",
  "已跳过 {n} 个目录（暂不支持目录上传）": "Skipped {n} folder(s) (folder upload is not supported yet)",

  // ---- 后台传输面板 ----
  "后台传输": "Background transfers",
  "项进行中": "active",
  "暂无传输任务": "No transfers",
  "暂停": "Pause",
  "继续": "Resume",
  "取消并删除": "Cancel and remove",
  "从列表移除": "Remove from list",
  "删除任务": "Delete task",
  "打开文件浏览器": "Open file browser",

  // ---- 右键菜单 ----
  "克隆本地终端": "Clone local terminal",
  "克隆会话（复制页签）": "Clone session (duplicate tab)",
  "文件传输…（SFTP）": "File transfer… (SFTP)",
  "重新打开本地终端": "Reopen local terminal",
  "重新连接": "Reconnect",

  // ---- tabs store：状态栏 / 提示 / 终端内嵌文案 ----
  "发送失败：{err}": "Send failed: {err}",
  "本地终端启动失败：{err}": "Local terminal failed to start: {err}",
  "按 Enter 重新打开本地终端": "Press Enter to reopen the local terminal",
  "连接失败：{err}": "Connection failed: {err}",
  "按 Enter 重新连接 · 右键页签可「编辑连接」修改配置": "Press Enter to reconnect · right-click the tab to edit the connection",
  "正在启动本地终端…": "Starting local terminal…",
  "正在连接 {user}@{host}…": "Connecting {user}@{host}…",
  "本地终端已就绪": "Local terminal ready",
  "已连接 {user}@{host}": "Connected to {user}@{host}",
  "本地终端已启动": "Local terminal started",
  "已连接：{title}": "Connected: {title}",
  "本地终端启动失败": "Local terminal failed to start",
  "连接失败：{title}": "Connection failed: {title}",
  "正在重新打开本地终端…": "Reopening local terminal…",
  "正在重新连接…": "Reconnecting…",
  "已连接 {title}": "Connected {title}",
  "已克隆会话：{title}": "Session cloned: {title}",
  "已复制标题：{title}": "Title copied: {title}",
  "复制失败，请检查剪贴板权限": "Copy failed; check clipboard permission",
  "[会话已结束] {reason}": "[Session ended] {reason}",
  "会话已断开：{title}": "Session disconnected: {title}",
  "网络已断开": "Network lost",
  "网络已断开，会话可能已失效": "Network lost; sessions may be dead",
  "网络恢复后会提示重新连接": "You'll be prompted to reconnect when the network is back",
  "网络已恢复，按 Enter 重新连接": "Network restored — press Enter to reconnect",

  // ---- profiles store ----
  "副本": "copy",
  "连接保存失败：{err}": "Failed to save connection: {err}",
  "已将旧版连接迁移到加密存储": "Legacy connections migrated to encrypted storage",
  "读取已保存的连接失败：{err}": "Failed to load saved connections: {err}",

  // ---- transfers store ----
  "操作失败：{err}": "Operation failed: {err}",
  "{file}：{err}": "{file}: {err}",
  "传输失败": "Transfer failed",
  "上传完成：{ok}/{count} 成功": "Upload complete: {ok}/{count} succeeded",
  "下载完成：{ok}/{count} 成功": "Download complete: {ok}/{count} succeeded",
  "会话已切换或断开，请重新打开文件浏览器": "Session switched or closed; reopen the file browser",
  "暂不支持目录递归传输，请选择文件": "Recursive directory transfer is not supported; select files",
  "请先在左侧选中本地文件": "Select local files on the left first",
  "请先在右侧选中远端文件": "Select remote files on the right first",
  "目标目录尚未就绪": "Target directory not ready",
  "{count} 个文件": "{count} files",
  "已加入后台上传 · 悬停 ⬆ 查看进度": "Upload queued · hover ⬆ for progress",
  "已加入后台下载 · 悬停 ⬆ 查看进度": "Download queued · hover ⬆ for progress",
  "无法启动传输：{err}": "Failed to start transfer: {err}",
  "完成 {ok}/{count} · {dir}": "Done {ok}/{count} · {dir}",
  "已取消 · {ok}/{count} 已完成": "Canceled · {ok}/{count} done",
  "已中断 · {ok}/{count} 已完成（应用重启）": "Interrupted · {ok}/{count} done (app restarted)",
  "已暂停 · {index}/{count} {file}": "Paused · {index}/{count} {file}",
  "准备中…": "Preparing…",
  "传输任务": "Transfer",

  // ---- browser store ----
  "无法打开目录：{err}": "Failed to open directory: {err}",
  "请先打开一个 SSH 会话": "Open an SSH session first",
  "本地终端没有远端目录，请先切换到 SSH 页签": "A local terminal has no remote side; switch to an SSH tab first",
  "当前 SSH 会话未连接，请先连接成功再传输文件": "The SSH session is not connected; connect before transferring files",
  "目标会话：{title}（{user}@{host}）": "Target session: {title} ({user}@{host})",
  "应用重启，传输未完成": "App restarted; transfer was not completed",
};

export function t(src: string, params?: Record<string, string | number>): string {
  let out = i18n.locale === "en" ? (EN[src] ?? src) : src;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}
