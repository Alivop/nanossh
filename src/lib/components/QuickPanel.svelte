<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import SearchIcon from "@lucide/svelte/icons/search";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import {
    ui, openModal, cancelPanelTimers, schedulePanelClose, toast,
  } from "$lib/stores/ui.svelte";
  import {
    profilesState, filteredProfiles, groupedProfiles, defaultTitle, groupLabel,
  } from "$lib/stores/profiles.svelte";
  import { openLocalTerminal } from "$lib/stores/tabs.svelte";
  import { connectProfile } from "$lib/actions";
  import { closeQuickPanel } from "$lib/panels";
  import { t } from "$lib/i18n.svelte";

  let shown = $derived(filteredProfiles(profilesState.quickQuery));
  let groups = $derived(groupedProfiles(shown));
  let searchEl: HTMLInputElement | null = $state(null);

  $effect(() => { if (ui.panels.quick) searchEl?.focus(); });

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = filteredProfiles(profilesState.quickQuery)[0];
      if (first) connectProfile(first);
      else toast(t("没有匹配的连接"));
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeQuickPanel();
    }
  }
</script>

{#if ui.panels.quick}
  <div
    id="panel-quick"
    class="float-panel"
    style={`top:${ui.panelPos.quick.top}px;left:${ui.panelPos.quick.left}px;width:320px`}
    onmouseenter={cancelPanelTimers}
    onmouseleave={() => schedulePanelClose(closeQuickPanel, ["tab-add", "panel-quick"])}
    role="dialog"
    tabindex="-1"
    aria-label={t("新建会话")}
  >
    <div class="float-panel__head"><span>{t("新建会话")}</span></div>

    <div class="grid gap-1 p-2">
      <Button variant="ghost" size="sm" class="justify-start" onclick={() => { closeQuickPanel(); openModal(); }}>
        <span class="w-5 text-center">＋</span> {t("新建 SSH 连接")}
      </Button>
      <Button variant="ghost" size="sm" class="justify-start" onclick={() => { closeQuickPanel(); openLocalTerminal(); }}>
        <span class="w-5 text-center font-mono">&gt;_</span> {t("本地终端")}
      </Button>
    </div>

    <div class="relative px-2 pb-2">
      <SearchIcon class="absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        bind:ref={searchEl}
        bind:value={profilesState.quickQuery}
        class="pl-8"
        type="search"
        placeholder={t("快捷连接：搜索已保存会话")}
        autocomplete="off"
        spellcheck="false"
        onkeydown={onSearchKey}
      />
    </div>

    <div class="float-panel__body">
      {#if !shown.length}
        <div class="p-3 text-center text-xs text-muted-foreground">
          {profilesState.list.length
            ? t("没有匹配「{query}」的连接", { query: profilesState.quickQuery })
            : t("还没有保存的连接")}
        </div>
      {:else}
        {#each groups as g (g.name)}
          <div class="group-head">
            <FolderIcon class="size-3" />
            <span>{groupLabel(g.name)}</span>
            <span class="group-head__count">{g.items.length}</span>
          </div>
          {#each g.items as p (p.id)}
            <button
              class="profile-row w-full"
              title={t("点击直接连接")}
              onclick={() => connectProfile(p)}
            >
              <span class="profile-row__info">
                <span class="profile-row__name">{defaultTitle(p)}</span>
                <span class="profile-row__meta">{p.username}@{p.host}:{p.port || 22}</span>
              </span>
            </button>
          {/each}
        {/each}
      {/if}
    </div>
  </div>
{/if}
