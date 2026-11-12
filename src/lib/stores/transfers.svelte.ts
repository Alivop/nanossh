/** 后台传输队列：最多 20 条、加密缓存到 transfers.enc。
 *  Svelte 的 keyed each 会复用 DOM 节点，高频进度事件不会再打断暂停/删除按钮的点击。 */

import { invoke } from "@tauri-apps/api/core";
import { ui, toast, setStatus } from "./ui.svelte";
import { t } from "../i18n.svelte";
import { browserState, loadDir, selectedFiles } from "./browser.svelte";
import { basename, humanSize } from "./tabs.svelte";
import type { Transfer, ProgressPayload, DonePayload } from "../types";

export const TRANSFER_LIMIT = 20;
const TRANSFER_SAVE_DELAY = 250;
const TRANSFER_FIELDS = [
  "job", "kind", "label", "count", "index", "file", "percent", "sent", "total",
  "state", "ok", "failed", "error", "targetDir", "at",
] as const;

export const transfersState = $state({ list: [] as Transfer[] });

export const transferById = (job: string) => transfersState.list.find((t) => t.job === job);
export const activeCount = () =>
  transfersState.list.filter((t) => t.state === "running" || t.state === "paused").length;

const newJobId = () =>
  (crypto.randomUUID?.() || `job-${Date.now()}-${Math.random().toString(36).slice(2)}`);

let transferSaveTimer: ReturnType<typeof setTimeout> | undefined;

/** 运行 / 暂停中的任务永不淘汰，其余按新→旧保留到 20 条 */
export function trimTransfers(): number {
  const active = transfersState.list.filter((t) => t.state === "running" || t.state === "paused");
  const activeSet = new Set(active);
  const finished = transfersState.list.filter((t) => !activeSet.has(t));
  const keep = new Set<Transfer>([
    ...active,
    ...finished.slice(0, Math.max(0, TRANSFER_LIMIT - active.length)),
  ]);
  let removed = 0;
  for (let i = transfersState.list.length - 1; i >= 0; i--) {
    if (!keep.has(transfersState.list[i])) {
      transfersState.list.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/** 落盘快照只留展示字段，不写 outcomes；进度事件不写盘。
 *  入队 / 终态用 immediate 立即落盘，其余状态变更 250ms 防抖合并。 */
export function persistTransfers(immediate = false) {
  clearTimeout(transferSaveTimer);
  const flush = () => {
    trimTransfers();
    const snapshot = transfersState.list.map((t) =>
      Object.fromEntries(TRANSFER_FIELDS.map((k) => [k, t[k] ?? ""])));
    invoke("transfers_save", { json: JSON.stringify(snapshot) })
      .catch((e) => console.warn("传输记录保存失败：", e));
  };
  if (immediate) flush();
  else transferSaveTimer = setTimeout(flush, TRANSFER_SAVE_DELAY);
}

/** 存档字段兜底；后端 job 在重启后已失效，运行中的任务统一标记为「已中断」 */
export function normalizeTransfer(src: Partial<Transfer> | null): Transfer | null {
  if (!src || typeof src !== "object" || !src.job) return null;
  const active = src.state === "running" || src.state === "paused";
  const ended = ["done", "error", "canceled", "interrupted"];
  return {
    job: String(src.job),
    kind: src.kind === "download" ? "download" : "upload",
    label: String(src.label || t("传输任务")),
    count: Number(src.count) || 1,
    index: 0, file: "", sent: 0, total: 0,
    percent: active ? 0 : (Number(src.percent) || 0),
    state: active ? "interrupted" : (ended.includes(src.state || "") ? src.state! : "error"),
    ok: Number(src.ok) || 0,
    failed: Number(src.failed) || 0,
    error: active ? t("应用重启，传输未完成") : String(src.error || ""),
    targetDir: String(src.targetDir || ""),
    sessionId: null,
    outcomes: [],
    at: Number(src.at) || Date.now(),
  };
}

export async function initTransfers() {
  try {
    const saved = JSON.parse((await invoke("transfers_load")) || "[]");
    const restored = (Array.isArray(saved) ? saved : [])
      .map(normalizeTransfer).filter((t): t is Transfer => !!t).slice(0, TRANSFER_LIMIT);
    transfersState.list = restored;
  } catch (e) {
    console.warn("读取传输记录失败：", e);
  }
}

export async function toggleTransfer(tr: Transfer) {
  if (tr.state !== "running" && tr.state !== "paused") return;
  const pause = tr.state === "running";
  tr.state = pause ? "paused" : "running";
  persistTransfers();
  try {
    await invoke(pause ? "sftp_transfer_pause" : "sftp_transfer_resume", { job: tr.job });
  } catch (e) {
    toast(t("操作失败：{err}", { err: String(e) }), true);
  }
}

export async function removeTransfer(tr: Transfer) {
  if (tr.state === "running" || tr.state === "paused") {
    try { await invoke("sftp_transfer_cancel", { job: tr.job }); } catch { /* 已结束 */ }
  }
  const i = transfersState.list.indexOf(tr);
  if (i >= 0) transfersState.list.splice(i, 1);
  persistTransfers();
}

export function updateTransferProgress(p: ProgressPayload) {
  const tr = transferById(p.job);
  if (!tr || (tr.state !== "running" && tr.state !== "paused")) return;
  tr.index = p.index;
  tr.file = p.file;
  tr.sent = p.sent;
  tr.total = p.total;
  tr.percent = p.percent;
}

export function finishTransfer(p: DonePayload) {
  const tr = transferById(p.job);
  if (!tr) return;
  tr.ok = p.ok;
  tr.failed = p.failed;
  tr.outcomes = p.outcomes || [];
  tr.error = p.error || "";
  tr.state = p.canceled ? "canceled" : (p.error || p.failed ? "error" : "done");
  if (tr.state === "done") tr.percent = 100;
  if (tr.state === "error" && !tr.error) {
    const bad = tr.outcomes.find((o) => !o.ok);
    tr.error = bad ? t("{file}：{err}", { file: basename(bad.path), err: bad.error }) : t("传输失败");
  }
  persistTransfers(true);
  setStatus(t(tr.kind === "upload" ? "上传完成：{ok}/{count} 成功" : "下载完成：{ok}/{count} 成功", { ok: tr.ok, count: tr.count }), tr.state === "done" ? "ok" : "error");
  toast(t(tr.kind === "upload" ? "上传完成：{ok}/{count} 成功" : "下载完成：{ok}/{count} 成功", { ok: tr.ok, count: tr.count }), tr.state !== "done");
  // 文件传完后如果浏览器还停在原来的目录，顺手刷新目标栏
  if (ui.sftpOpen && browserState.sessionId === tr.sessionId) {
    void loadDir(tr.kind === "upload" ? "remote" : "local", tr.targetDir);
  }
}

/** 上传/下载只负责入队：后台 task 在 Rust 侧跑，弹窗关掉也不中断 */
export async function startTransfer(upload: boolean) {
  if (!browserState.sessionId || !browserState.tabId) {
    return toast(t("会话已切换或断开，请重新打开文件浏览器"), true);
  }
  const paths = selectedFiles(upload ? "local" : "remote");
  if (!paths.length) {
    const pickedDir = browserState[upload ? "local" : "remote"].selected.length > 0;
    return toast(pickedDir ? t("暂不支持目录递归传输，请选择文件") :
      (upload ? t("请先在左侧选中本地文件") : t("请先在右侧选中远端文件")), true);
  }
  await enqueueTransfer(upload, paths, upload ? browserState.remote.path : browserState.local.path);
}

/** 拖拽到窗口直接上传：绕过列表选中，直接把这组本地文件传到远端当前目录 */
export function enqueueUpload(paths: string[]): Promise<void> {
  if (!browserState.sessionId) return Promise.resolve();
  return enqueueTransfer(true, paths, browserState.remote.path);
}

/** 真正入队：建 job、插列表、调 Rust 后台任务；路径为空时由后端返回错误 */
async function enqueueTransfer(upload: boolean, paths: string[], targetDir: string) {
  if (!browserState.sessionId || !browserState.tabId) {
    return toast(t("会话已切换或断开，请重新打开文件浏览器"), true);
  }
  if (!targetDir) return toast(t("目标目录尚未就绪"), true);

  const job = newJobId();
  const tr: Transfer = {
    job,
    kind: upload ? "upload" : "download",
    label: paths.length === 1 ? basename(paths[0]) : t("{count} 个文件", { count: paths.length }),
    count: paths.length, index: 0, file: "", percent: 0, sent: 0, total: 0,
    state: "running", ok: 0, failed: 0, error: "", outcomes: [],
    targetDir, sessionId: browserState.sessionId, at: Date.now(),
  };
  transfersState.list.unshift(tr);
  persistTransfers(true);
  toast(upload ? t("已加入后台上传 · 悬停 ⬆ 查看进度") : t("已加入后台下载 · 悬停 ⬆ 查看进度"));
  try {
    await invoke(upload ? "sftp_upload" : "sftp_download", {
      id: browserState.sessionId,
      job,
      paths,
      dir: targetDir,
      overwrite: browserState.overwrite,
    });
  } catch (e) {
    const cur = transferById(job);
    if (!cur) return;
    cur.state = "error";
    cur.error = String(e);
    persistTransfers();
    toast(t("无法启动传输：{err}", { err: String(e) }), true);
  }
}

/** 面板里的说明文字，供组件直接渲染 */
export function transferMeta(tr: Transfer): string {
  if (tr.state === "done") return t("完成 {ok}/{count} · {dir}", { ok: tr.ok, count: tr.count, dir: tr.targetDir });
  if (tr.state === "canceled") return t("已取消 · {ok}/{count} 已完成", { ok: tr.ok, count: tr.count });
  if (tr.state === "interrupted") return t("已中断 · {ok}/{count} 已完成（应用重启）", { ok: tr.ok, count: tr.count });
  if (tr.state === "error") return tr.error || t("传输失败");
  if (tr.state === "paused") return t("已暂停 · {index}/{count} {file}", { index: tr.index + 1, count: tr.count, file: tr.file });
  return `${tr.index + 1}/${tr.count} ${tr.file || t("准备中…")} · ${humanSize(tr.sent)} / ${humanSize(tr.total)}`;
}
