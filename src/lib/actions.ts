import { ui, closePanels } from "./stores/ui.svelte";
import { profileToConfig } from "./stores/profiles.svelte";
import { markRecent } from "./stores/recent.svelte";
import { createTab } from "./stores/tabs.svelte";
import type { Profile } from "./types";

/** 点击已保存连接：有凭据直接连；没密码则开页签并在页内询问，不弹连接对话框 */
export function connectProfile(p: Profile) {
  closePanels();
  const cfg = profileToConfig(p);
  const needPassword = !cfg.password && !cfg.privateKey;
  markRecent(p.id);  // 首页「最近连接」排序依据
  createTab(cfg, { askPassword: needPassword, profileId: p.id });
}
