/** SFTP 双栏文件浏览器：零侵入，不向交互终端写任何字符。
 *  远端默认目录由后端 sftp_list("") 的 canonicalize(".") 给出，本地取上次目录 / HOME。 */

import { invoke } from "@tauri-apps/api/core";
import { ui, toast, closePanels, closeModal } from "./ui.svelte";
import { t } from "../i18n.svelte";
import { activeTab, tabsState } from "./tabs.svelte";
import type { DirListing, FsEntry, Tab } from "../types";

const SFTP_LOCAL_DIR_KEY = "nanossh-sftp-local-dir";
const SFTP_SORT_KEY = "nanossh-sftp-sort";

export type SortKey = "name" | "size" | "time";
export type SortDir = "asc" | "desc";
export interface SortState { key: SortKey; dir: SortDir; }

const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

const isSort = (v: unknown): v is SortState =>
  !!v && (v as SortState).key !== undefined && (v as SortState).dir !== undefined;

/** 两侧各自记住排序；兼容旧版单份排序（迁移成两边同值） */
function readSorts(): { local: SortState; remote: SortState } {
  try {
    const v = JSON.parse(localStorage.getItem(SFTP_SORT_KEY) || "");
    if (isSort(v?.local) && isSort(v?.remote)) return { local: v.local, remote: v.remote };
    if (isSort(v)) return { local: v, remote: v };
  } catch { /* 首次使用或数据损坏时用默认 */ }
  return { local: { ...DEFAULT_SORT }, remote: { ...DEFAULT_SORT } };
}

function saveSorts() {
  try {
    localStorage.setItem(SFTP_SORT_KEY, JSON.stringify({
      local: browserState.local.sort, remote: browserState.remote.sort,
    }));
  } catch { /* 忽略 */ }
}

interface SideState {
  path: string;
  home: string;
  entries: FsEntry[];
  selected: string[];
  search: string;
  sort: SortState;
  loading: boolean;
  error: string;
}

const savedSorts = readSorts();
const emptySide = (sort: SortState): SideState => ({
  path: "", home: "", entries: [], selected: [], search: "", sort, loading: false, error: "",
});

export const browserState = $state({
  sessionId: null as string | null,
  tabId: null as string | null,
  target: "",
  overwrite: true,
  showHidden: false,
  local: emptySide(savedSorts.local),
  remote: emptySide(savedSorts.remote),
});

export type Side = "local" | "remote";
export const sideState = (side: Side): SideState => browserState[side];

/** 取上级目录：兼容 Unix `/` 与 Windows `C:\` */
export function parentPath(path: string): string {
  const win = /^[A-Za-z]:/.test(path);
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return win ? path : "/";
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return win ? `${trimmed.slice(0, 2)}\\` : "/";
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

export function visibleEntries(side: Side): FsEntry[] {
  const st = sideState(side);
  const base = browserState.showHidden ? st.entries : st.entries.filter((e) => !e.name.startsWith("."));
  const q = st.search.trim().toLowerCase();
  const filtered = q ? base.filter((e) => e.name.toLowerCase().includes(q)) : base;
  return filtered.sort((a, b) => cmpEntries(a, b, st.sort));
}

/** 排序规则：严格按所选列排，文件与目录混排（名称数字感知 a2 < a10，大小按字节，修改时间按秒） */
function cmpEntries(a: FsEntry, b: FsEntry, sort: SortState): number {
  let v: number;
  if (sort.key === "size") v = a.size - b.size;
  else if (sort.key === "time") v = (a.mtime ?? 0) - (b.mtime ?? 0);
  else v = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return sort.dir === "asc" ? v : -v;
}

/** 点击列头：同一列再点一次换方向，换列则回到升序（两侧互不影响，各自记住） */
export function setSort(side: Side, key: SortKey) {
  const st = sideState(side);
  if (st.sort.key === key) {
    st.sort.dir = st.sort.dir === "asc" ? "desc" : "asc";
  } else {
    st.sort.key = key;
    st.sort.dir = "asc";
  }
  saveSorts();
}

/** 返回是否成功；失败时清空旧条目并显示原因，避免把上一次目录误当成当前目录 */
export async function loadDir(side: Side, path: string): Promise<boolean> {
  const st = sideState(side);
  st.loading = true;
  st.error = "";
  try {
    const cmd = side === "local" ? "local_list" : "sftp_list";
    const args = side === "local"
      ? { path: path || "" }
      : { id: browserState.sessionId, path: path || "" };
    const listing = await invoke<DirListing>(cmd, args);
    st.path = listing.path;
    st.home = listing.home;
    st.entries = listing.entries;
    st.selected = [];
    if (side === "local") {
      try { localStorage.setItem(SFTP_LOCAL_DIR_KEY, st.path); } catch { /* 忽略 */ }
    }
    return true;
  } catch (err) {
    st.entries = [];
    st.selected = [];
    st.path = path || "";
    st.error = t("无法打开目录：{err}", { err: String(err) });
    return false;
  } finally {
    st.loading = false;
  }
}

/** 单击目录即进入；Ctrl/⌘/Shift 多选时只切换选中、不跳转 */
export async function clickEntry(side: Side, path: string, multi: boolean) {
  const st = sideState(side);
  const entry = st.entries.find((e) => e.path === path);
  if (multi) {
    const i = st.selected.indexOf(path);
    if (i >= 0) st.selected.splice(i, 1);
    else st.selected.push(path);
    return;
  }
  st.selected = [path];
  if (entry?.isDir) await loadDir(side, entry.path);
}

export function selectedFiles(side: Side): string[] {
  const st = sideState(side);
  if (!st.selected.length) return [];
  return st.entries
    .filter((e) => st.selected.includes(e.path) && !e.isDir)
    .map((e) => e.path);
}

/** 解析 SSH 页签交互 shell 的当前目录（不向终端写任何字符）：
 *  优先用 shell 自己通过 OSC 1337 上报的 tab.cwd（有 shell integration 时每条
 *  提示符都会刷新）；没有则在同一条 SSH 连接上开 exec 通道，用 /proc 找到该
 *  pty 的会话首进程并 readlink 它的 cwd（见后端 ssh_cwd）。拿不到返回空串。 */
export async function resolveRemoteCwd(tab: Tab): Promise<string> {
  if (tab.cwd) return tab.cwd;
  if (tab.kind !== "ssh" || !tab.sessionId) return "";
  try {
    return (await invoke<string>("ssh_cwd", { id: tab.sessionId })) || "";
  } catch { /* 探测失败（非 Linux 远端等）回落到家目录 */ return ""; }
}

export async function openSftp(tab?: Tab) {
  const target = tab ?? activeTab();
  if (!target) return toast(t("请先打开一个 SSH 会话"), true);
  if (target.kind === "local") return toast(t("本地终端没有远端目录，请先切换到 SSH 页签"), true);
  if (target.status !== "connected" || !target.sessionId) {
    return toast(t("当前 SSH 会话未连接，请先连接成功再传输文件"), true);
  }
  closePanels();
  closeModal();
  browserState.sessionId = target.sessionId;
  browserState.tabId = target.id;
  browserState.target = t("目标会话：{title}（{user}@{host}）", { title: target.title, user: target.config.username, host: target.config.host });
  browserState.overwrite = true;
  browserState.showHidden = false;
  // 重开浏览器时重置目录与搜索，但保留两侧各自的排序偏好
  const keepSorts = { local: { ...browserState.local.sort }, remote: { ...browserState.remote.sort } };
  browserState.local = emptySide(keepSorts.local);
  browserState.remote = emptySide(keepSorts.remote);
  ui.sftpOpen = true;

  // 远端起始目录：跟随终端里 cd 的位置（OSC 上报或 exec 探测），拿不到才落到默认目录
  const cwd = await resolveRemoteCwd(target);
  const localTab = [...tabsState.list].reverse().find((t) => t.kind === "local" && t.cwd);
  const localStart = localTab?.cwd || localStorage.getItem(SFTP_LOCAL_DIR_KEY) || "";
  const [okLocal, okRemote] = await Promise.all([
    loadDir("local", localStart),
    loadDir("remote", cwd),
  ]);
  if (!okLocal) await loadDir("local", "");
  if (cwd && !okRemote) {
    await loadDir("remote", "");
  }
}

export function closeSftp() {
  ui.sftpOpen = false;
}
