/** 首页「最近连接」：记录每个已保存连接最后一次被打开的时间（只存 localStorage，
 *  只用于首页展示排序，不影响「已保存的连接」面板里按分组的原始顺序）。 */

import type { Profile } from "../types";

const KEY = "nanossh-recent-conns";
/** 最多保留 50 条，避免长期使用后 localStorage 无限增长 */
const KEEP = 50;

function load(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [id, ts] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof ts === "number" && Number.isFinite(ts)) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

export const recentState = $state({ at: load() as Record<string, number> });

/** 打开某条已保存连接时调用（页签内密码连接、编辑后重连都算一次） */
export function markRecent(profileId: string | null | undefined) {
  if (!profileId) return;
  recentState.at[profileId] = Date.now();
  const ids = Object.keys(recentState.at)
    .sort((a, b) => recentState.at[b] - recentState.at[a])
    .slice(0, KEEP);
  const next: Record<string, number> = {};
  for (const id of ids) next[id] = recentState.at[id];
  recentState.at = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
}

/** 最近用过的 n 条连接；历史不足时用列表里其余连接按原顺序补齐 */
export function recentProfiles(list: Profile[], limit: number): Profile[] {
  const used = list
    .filter((p) => recentState.at[p.id])
    .sort((a, b) => recentState.at[b.id] - recentState.at[a.id])
    .slice(0, limit);
  if (used.length >= limit) return used;
  const picked = new Set(used.map((p) => p.id));
  for (const p of list) {
    if (used.length >= limit) break;
    if (!picked.has(p.id)) used.push(p);
  }
  return used;
}
