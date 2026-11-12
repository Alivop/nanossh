<script lang="ts">
  import TitleBar from "$lib/components/TitleBar.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import TerminalView from "$lib/components/TerminalView.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import ProfilePanel from "$lib/components/ProfilePanel.svelte";
  import QuickPanel from "$lib/components/QuickPanel.svelte";
  import TransferPanel from "$lib/components/TransferPanel.svelte";
  import ConnectDialog from "$lib/components/ConnectDialog.svelte";
  import SftpBrowser from "$lib/components/SftpBrowser.svelte";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ui, hideContextMenu, showTerminalMenu } from "$lib/stores/ui.svelte";
  import { tabsState, refreshTheme, terminalSelection } from "$lib/stores/tabs.svelte";
  import { dndState } from "$lib/stores/dnd.svelte";
  import { closeProfilesPanel, closeQuickPanel, closeTransferPanel } from "$lib/panels";
  import { t } from "$lib/i18n.svelte";

  // 最大化/全屏时收回窗口圆角（透明窗口下四角会露出桌面）
  $effect(() => {
    const win = getCurrentWindow();
    let stop: (() => void) | undefined;
    const sync = () => {
      win.isMaximized().then((v) => document.documentElement.classList.toggle("is-maximized", v)).catch(() => {});
    };
    sync();
    win.onResized(sync).then((fn) => (stop = fn)).catch(() => {});
    return () => stop?.();
  });

  // 明暗主题切换时把所有已挂载的 xterm 一起换色
  $effect(() => {
    void ui.theme;
    refreshTheme();
  });

  function onGlobalClick(e: MouseEvent) {
    const el = e.target as HTMLElement;
    hideContextMenu();
    if (!el.closest("#panel-profiles") && !el.closest("#btn-profiles")) closeProfilesPanel();
    if (!el.closest("#panel-quick") && !el.closest("#tab-add")) closeQuickPanel();
    if (!el.closest("#panel-transfer") && !el.closest("#btn-upload")) closeTransferPanel();
  }

  /** 右键策略：页签有自己的菜单；终端给「复制/粘贴」；输入框保留系统编辑菜单；
   *  其余区域一律屏蔽 WebView 默认菜单（Reload / 检查元素之类对桌面应用毫无意义）。 */
  function onContextMenu(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el.closest(".tab")) return; // TabBar 内已 preventDefault 并弹页签菜单
    if (el.closest(".xterm")) {
      e.preventDefault();
      const id = tabsState.activeId;
      if (!id) return;
      showTerminalMenu(e.clientX, e.clientY, id, !!terminalSelection(id));
      return;
    }
    if (el.closest("input, textarea, [contenteditable='true']")) return;
    e.preventDefault();
    hideContextMenu();
  }
</script>

<svelte:window onclick={onGlobalClick} oncontextmenu={onContextMenu} />

<div class="app-shell">
  <TitleBar />
  <TabBar />
  <main class="workspace">
    {#each tabsState.list as tab (tab.id)}
      <TerminalView {tab} active={tab.id === tabsState.activeId} />
    {/each}
    <EmptyState />
  </main>
  <StatusBar />
</div>

<ProfilePanel />
<QuickPanel />
<TransferPanel />
<ConnectDialog />
<SftpBrowser />
<ContextMenu />

<!-- 拖文件进窗口时的投放提示：pointer-events:none，真正的 drop 由 Tauri 拖放事件接住 -->
{#if dndState.active}
  <div class="drop-overlay">
    <div class="drop-overlay__card">
      <UploadIcon class="size-6" />
      <span>{t("松开鼠标上传 {n} 个文件", { n: dndState.count })}</span>
      <span class="drop-overlay__dir" title={dndState.target}>→ {dndState.target}</span>
    </div>
  </div>
{/if}
<Toasts />
