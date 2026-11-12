/** 已保存连接：Rust 侧 AES-256-GCM 加密文件 + 分组管理。
 *  前端拿到的始终是明文 JSON，明文永不落盘；旧版 localStorage 数据一次性迁移。 */

import { invoke } from "@tauri-apps/api/core";
import { toast } from "./ui.svelte";
import { t } from "../i18n.svelte";
import type { Profile, SshConfig } from "../types";

export const DEFAULT_GROUP = "未分组";
/** 「未分组」在英文界面的显示名；保存值恒为中文 DEFAULT_GROUP，展示层才翻译 */
const DEFAULT_GROUP_EN = "Ungrouped";
const LEGACY_PROFILES_KEY = "nanossh-profiles";

export const profilesState = $state({
  list: [] as Profile[],
  manageQuery: "",
  quickQuery: "",
  /** 管理面板里被折叠的分组名 */
  collapsed: [] as string[],
});

export const uid = () =>
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const defaultTitle = (p: Profile | SshConfig) =>
  p.title?.trim() || `${p.username}@${p.host}`;

export const normalizeGroup = (g: unknown) =>
  (typeof g === "string" && g.trim()) || DEFAULT_GROUP;

/** 分组名展示：默认分组按当前语言显示，自定义分组是用户数据、原样展示 */
export const groupLabel = (name: string) =>
  name === DEFAULT_GROUP ? t("未分组") : name;

/** 数据值 → 分组输入框初值：默认分组显示为当前语言的标签，其余原样 */
export const groupToInput = (g: string) => groupLabel(g);

/** 分组输入框值 → 数据值：空 / 两种语言的默认标签都归一到 DEFAULT_GROUP */
export function inputToGroup(v: string): string {
  const s = v.trim();
  if (!s || s === DEFAULT_GROUP || s === DEFAULT_GROUP_EN) return DEFAULT_GROUP;
  return s;
}

export function profileToConfig(p: Profile): SshConfig {
  return {
    title: p.title || "",
    host: p.host || "",
    port: p.port || 22,
    username: p.username || "",
    password: p.password || "",
    privateKey: p.privateKey || "",
  };
}

/** 搜索：名称 / 主机 / 用户名 / 端口 / 私钥 / 分组名，忽略大小写 */
export function filteredProfiles(query: string, list: Profile[] = profilesState.list): Profile[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    [defaultTitle(p), p.host, p.username, String(p.port || 22), p.privateKey || "", normalizeGroup(p.group)]
      .some((v) => v.toLowerCase().includes(q))
  );
}

/** 按分组归类：自定义分组按名称排序，「未分组」恒排最后 */
export function groupedProfiles(list: Profile[]): { name: string; items: Profile[] }[] {
  const map = new Map<string, Profile[]>();
  for (const p of list) {
    const g = normalizeGroup(p.group);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(p);
  }
  const names = [...map.keys()].sort((a, b) => {
    if (a === DEFAULT_GROUP) return 1;
    if (b === DEFAULT_GROUP) return -1;
    return a.localeCompare(b, "zh-CN");
  });
  return names.map((name) => ({ name, items: map.get(name)! }));
}

/** 所有已用过的分组名（新建弹窗下拉用），保证「未分组」始终在列 */
export function groupNames(): string[] {
  const names = new Set<string>(profilesState.list.map((p) => normalizeGroup(p.group)));
  names.add(DEFAULT_GROUP);
  return [...names].sort((a, b) => {
    if (a === DEFAULT_GROUP) return 1;
    if (b === DEFAULT_GROUP) return -1;
    return a.localeCompare(b, "zh-CN");
  });
}

export function toggleGroup(name: string) {
  const i = profilesState.collapsed.indexOf(name);
  if (i >= 0) profilesState.collapsed.splice(i, 1);
  else profilesState.collapsed.push(name);
}

/** 全量覆盖写加密文件；失败只提示，不阻断 UI */
export function persistProfiles() {
  invoke("profiles_save", { json: JSON.stringify(profilesState.list) })
    .catch((e) => toast(t("连接保存失败：{err}", { err: String(e) }), true));
}

export function upsertProfile(p: Profile) {
  const i = profilesState.list.findIndex((x) => x.id === p.id);
  if (i >= 0) profilesState.list[i] = { ...profilesState.list[i], ...p };
  else profilesState.list.unshift(p); // 新保存的放在最前面
  persistProfiles();
}

/** 组内拖动排序：把 dragId 移到 beforeId 前面（beforeId 为 null = 移到本组末尾）。
 *  分组展示按 list 顺序组内收集，所以在扁平数组里挪到目标成员旁边即可，不影响其他分组。 */
export function reorderProfile(dragId: string, beforeId: string | null) {
  const list = profilesState.list;
  const from = list.findIndex((p) => p.id === dragId);
  if (from < 0) return;
  const group = normalizeGroup(list[from].group);
  const memberIdx = list
    .map((p, i) => ({ id: p.id, i, g: normalizeGroup(p.group) }))
    .filter((x) => x.g === group);
  let to: number;
  if (beforeId) {
    const t = memberIdx.find((m) => m.id === beforeId);
    if (!t) return;
    to = t.i;
  } else {
    const last = memberIdx[memberIdx.length - 1];
    if (last.id === dragId) return; // 已在组末
    to = last.i + 1;
  }
  if (to === from || to === from + 1) return; // 原地 / 相邻，无需移动
  const [item] = list.splice(from, 1);
  list.splice(from < to ? to - 1 : to, 0, item);
  persistProfiles();
}

export function removeProfile(id: string) {
  const i = profilesState.list.findIndex((p) => p.id === id);
  if (i >= 0) profilesState.list.splice(i, 1);
  persistProfiles();
}

/** 复制出新连接（新 id、标题加「副本/copy」、继承分组），由调用方再打开编辑弹窗 */
export function duplicateProfile(p: Profile): Profile {
  const dup: Profile = {
    ...p,
    id: uid(),
    title: `${defaultTitle(p)} ${t("副本")}`,
    group: normalizeGroup(p.group),
  };
  upsertProfile(dup);
  return dup;
}

/** 页内密码输入勾选「记住」时，把密码加密写回这条连接 */
export function rememberPassword(profileId: string | null, password: string) {
  if (!profileId) return;
  const p = profilesState.list.find((x) => x.id === profileId);
  if (!p) return;
  p.password = password;
  p.rememberPassword = true;
  persistProfiles();
}

/** 启动时解密读取；旧数据补齐 group 字段，旧 localStorage 明文一次性迁移 */
export async function initProfiles() {
  try {
    const parsed = JSON.parse((await invoke("profiles_load")) || "[]");
    let list: Profile[] = Array.isArray(parsed) ? parsed : [];
    if (!list.length) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) || "[]");
      if (Array.isArray(legacy) && legacy.length) {
        list = legacy;
        localStorage.removeItem(LEGACY_PROFILES_KEY);
        toast(t("已将旧版连接迁移到加密存储"));
      }
    }
    let changed = false;
    list = list.map((p) => {
      const g = normalizeGroup(p.group);
      if (g !== p.group) changed = true;
      return { ...p, group: g };
    });
    profilesState.list = list;
    if (changed && list.length) await invoke("profiles_save", { json: JSON.stringify(list) });
  } catch (e) {
    toast(t("读取已保存的连接失败：{err}", { err: String(e) }), true);
    profilesState.list = [];
  }
}
