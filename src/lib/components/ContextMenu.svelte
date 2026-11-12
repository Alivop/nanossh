<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Separator } from "$lib/components/ui/separator";
  import { ui, hideContextMenu, openModal, copyText, toast } from "$lib/stores/ui.svelte";
  import { profilesState, normalizeGroup } from "$lib/stores/profiles.svelte";
  import {
    findTab, cloneTab, reconnect, terminalSelection, pasteToTerminal,
  } from "$lib/stores/tabs.svelte";
  import { openSftp } from "$lib/stores/browser.svelte";
  import { t } from "$lib/i18n.svelte";

  let tab = $derived(findTab(ui.contextMenu.tabId));

  function run(fn: () => void) {
    hideContextMenu();
    fn();
  }

  function edit() {
    if (!tab) return;
    const tb = tab;
    const profile = profilesState.list.find((p) => p.id === tb.profileId);
    run(() => openModal({
      tabId: tb.id,
      profileId: tb.profileId,
      connectAfterSave: true,
      prefill: { ...tb.config },
      group: normalizeGroup(profile?.group),
    }));
  }

  /** 终端菜单：复制选区 / 粘贴到终端（走 xterm.paste，等价于键入） */
  function copySelection() {
    const text = terminalSelection(ui.contextMenu.tabId);
    if (!text) return;
    void copyText(text).then((ok) => { if (!ok) toast(t("复制失败，请检查剪贴板权限"), true); });
  }

  async function pasteIntoTerminal() {
    try {
      const text = await navigator.clipboard.readText();
      pasteToTerminal(ui.contextMenu.tabId, text);
    } catch {
      toast(t("读取剪贴板失败，请检查权限"), true);
    }
  }
</script>

<!-- 「复制标题」「关闭页签」不进页签菜单：页签悬停已有专用按钮（复制图标 / ×）；
     终端右键只留复制 / 粘贴，其余区域由 App 统一屏蔽 WebView 默认菜单 -->
{#if ui.contextMenu.open && tab}
  <div
    class="context-menu"
    style={`left:${ui.contextMenu.x}px;top:${ui.contextMenu.y}px`}
  >
    {#if ui.contextMenu.kind === "terminal"}
      <Button
        variant="ghost" size="sm" class="w-full justify-start"
        disabled={!ui.contextMenu.canCopy}
        onclick={() => run(copySelection)}
      >{t("复制")}</Button>
      <Button variant="ghost" size="sm" class="w-full justify-start" onclick={() => run(() => void pasteIntoTerminal())}>
        {t("粘贴")}
      </Button>
    {:else}
      <Button variant="ghost" size="sm" class="w-full justify-start" onclick={() => run(() => cloneTab(tab!))}>
        {tab.kind === "local" ? t("克隆本地终端") : t("克隆会话（复制页签）")}
      </Button>

      <Separator class="my-1" />

      {#if tab.kind !== "local"}
        <Button variant="ghost" size="sm" class="w-full justify-start" onclick={edit}>{t("编辑连接")}</Button>
        <Button variant="ghost" size="sm" class="w-full justify-start" onclick={() => run(() => openSftp(tab!))}>{t("文件传输…（SFTP）")}</Button>
      {/if}
      <Button variant="ghost" size="sm" class="w-full justify-start" onclick={() => run(() => reconnect(tab!))}>
        {tab.kind === "local" ? t("重新打开本地终端") : t("重新连接")}
      </Button>
    {/if}
  </div>
{/if}
