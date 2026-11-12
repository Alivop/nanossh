import { mount } from "svelte";
import { listen } from "@tauri-apps/api/event";
import App from "./App.svelte";
import "./app.css";
import { applyTheme } from "$lib/stores/ui.svelte";
import { initProfiles } from "$lib/stores/profiles.svelte";
import { handleSshData, handleSshClosed, initNetworkWatch, restoreTabs } from "$lib/stores/tabs.svelte";
import {
  initTransfers, updateTransferProgress, finishTransfer,
} from "$lib/stores/transfers.svelte";
import { initAppMenu } from "$lib/app-menu";
import { initShortcuts } from "$lib/shortcuts";
import { initDragDrop } from "$lib/stores/dnd.svelte";
import { syncAppMenu } from "$lib/i18n.svelte";
import type { ProgressPayload, DonePayload } from "$lib/types";

applyTheme();
document.title = "NanoSSH";

const app = mount(App, { target: document.getElementById("app")! });

/* Rust 侧事件统一在这里订阅，转交给对应 store */
listen("ssh-data", ({ payload }) => handleSshData(payload as { id: string; data: string }));
listen("ssh-closed", ({ payload }) => handleSshClosed(payload as { id: string; reason: string }));
listen("sftp-progress", ({ payload }) => updateTransferProgress(payload as ProgressPayload));
listen("sftp-transfer-done", ({ payload }) => finishTransfer(payload as DonePayload));

initAppMenu();           // 顶部菜单点击 → store；并按已存语言重建菜单
syncAppMenu();
void initProfiles()     // 解密读取本机连接配置（含分组归一化）
  .then(() => restoreTabs());  // 连接配置就绪后恢复上次的页签（只自动连接活动页签）
void initTransfers();    // 解密读取传输记录（最近 20 条）
initNetworkWatch();      // 断网/恢复：SSH 页签转待重连并提示按 Enter
initShortcuts();         // ⌘+ / ⌘- / ⌘0 字号快捷键（带 Shift 的组合菜单匹配不到）
initDragDrop();          // 拖文件到窗口 → 直接上传到远端当前目录

export default app;
