/** 拖文件到窗口直接上传。
 *
 *  macOS WebView 的 HTML5 drop 事件被 Tauri 的 dragDrop 接管，DOM 收不到拖放，
 *  这里走 getCurrentWebview().onDragDropEvent（tauri://drag-enter/over/drop/leave）。
 *  拖入时全窗显示覆盖提示；松开上传到「远端当前目录」——SFTP 浏览器没开时，
 *  只要活动页签是已连接的 SSH 会话就自动打开浏览器再传。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ui, toast } from "./ui.svelte";
import { t } from "../i18n.svelte";
import { browserState, openSftp, resolveRemoteCwd } from "./browser.svelte";
import { enqueueUpload } from "./transfers.svelte";
import { activeTab } from "./tabs.svelte";

export const dndState = $state({ active: false, count: 0, target: "" });

/** 有没有可投放的会话；返回提示用的目标目录描述，不可投放时返回 null。
 *  SFTP 已开就是它的当前目录；未开时解析终端 shell 的 cwd（探测失败回落默认目录） */
async function dropTarget(): Promise<string | null> {
  if (ui.sftpOpen && browserState.sessionId) {
    return browserState.remote.path || t("远端默认目录");
  }
  const tab = activeTab();
  if (tab && tab.kind === "ssh" && tab.status === "connected" && tab.sessionId) {
    return (await resolveRemoteCwd(tab)) || t("远端默认目录");
  }
  return null;
}

/** 能否投放：SFTP 已开，或活动页签是已连接的 SSH 会话（同步判断，不探测） */
function canDrop(): boolean {
  if (ui.sftpOpen && browserState.sessionId) return true;
  const tab = activeTab();
  return !!tab && tab.kind === "ssh" && tab.status === "connected" && !!tab.sessionId;
}

async function onDrop(paths: string[]) {
  if (!canDrop()) {
    return toast(t("当前没有已连接的 SSH 会话，无法上传拖入的文件"), true);
  }
  // SFTP 未打开：先打开（顺带加载远端目录），入队时才有 remote.path 可用
  if (!ui.sftpOpen) await openSftp();

  // 过滤目录：path_kinds 与 paths 同序，true = 目录（暂不支持递归上传）
  let files = paths;
  let dirs = 0;
  try {
    const kinds = await invoke<boolean[]>("path_kinds", { paths });
    dirs = kinds.filter(Boolean).length;
    files = paths.filter((_, i) => !kinds[i]);
  } catch { /* 判断失败就原样交给后端，让上传流程报具体错误 */ }

  if (!files.length) {
    return toast(t("拖入的都是目录，暂不支持目录上传"), true);
  }
  if (dirs) toast(t("已跳过 {n} 个目录（暂不支持目录上传）", { n: dirs }));
  await enqueueUpload(files);
}

/** main.ts 启动时调用一次；浏览器预览等非 Tauri 环境没有该事件，直接忽略 */
export function initDragDrop() {
  void getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    switch (payload.type) {
      case "enter": {
        if (!payload.paths.length) break;
        const target = await dropTarget();
        dndState.active = !!target;
        dndState.count = payload.paths.length;
        dndState.target = target ?? "";
        break;
      }
      case "drop":
        dndState.active = false;
        if (payload.paths.length) void onDrop(payload.paths);
        break;
      case "leave":
        dndState.active = false;
        break;
      // over 只带 position：保持 enter 时算好的提示，避免每次移动都重算
      default:
        break;
    }
  }).catch(() => { /* 非 Tauri 环境：无拖放事件 */ });
}
