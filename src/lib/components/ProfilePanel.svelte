<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import TrashIcon from "@lucide/svelte/icons/trash-2";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import SearchIcon from "@lucide/svelte/icons/search";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import {
    ui, openModal, toast, cancelPanelTimers, schedulePanelClose,
  } from "$lib/stores/ui.svelte";
  import {
    profilesState, filteredProfiles, groupedProfiles, defaultTitle, normalizeGroup,
    removeProfile, duplicateProfile, toggleGroup, profileToConfig, groupLabel,
    reorderProfile,
  } from "$lib/stores/profiles.svelte";
  import { connectProfile } from "$lib/actions";
  import { closeProfilesPanel } from "$lib/panels";
  import { t } from "$lib/i18n.svelte";

  let shown = $derived(filteredProfiles(profilesState.manageQuery));
  let groups = $derived(groupedProfiles(shown));
  let confirmId = $state<string | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let searchEl: HTMLInputElement | null = $state(null);

  $effect(() => { if (ui.panels.profiles) searchEl?.focus(); });

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = filteredProfiles(profilesState.manageQuery)[0];
      if (first) connectProfile(first);
      else toast(t("没有匹配的连接"));
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeProfilesPanel();
    }
  }

  function onDelete(id: string) {
    if (confirmId === id) {
      clearTimeout(confirmTimer);
      confirmId = null;
      removeProfile(id);
      toast(t("已删除连接"));
      return;
    }
    confirmId = id;
    toast(t("再次点击删除按钮以确认"));
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => (confirmId = null), 3000);
  }

  function onDuplicate(p: (typeof profilesState.list)[number]) {
    const dup = duplicateProfile(p);
    closeProfilesPanel();
    openModal({
      profileId: dup.id,
      connectAfterSave: false,
      duplicate: true,
      prefill: profileToConfig(dup),
      group: normalizeGroup(dup.group),
    });
    toast(t("已复制连接，修改后保存即可"));
  }

  function onEdit(p: (typeof profilesState.list)[number]) {
    closeProfilesPanel();
    openModal({
      profileId: p.id,
      connectAfterSave: false,
      prefill: profileToConfig(p),
      group: normalizeGroup(p.group),
    });
  }

  /* ---------- 拖动连接排序（指针自实现，与页签拖动同一套模式） ----------
   *  按下记录候选；移动超过 5px 才算拖动（不影响点击连接）；只在本组内换位
   *  （跨组拖动不改变分组）。搜索过滤中禁用排序，避免看不见的条目被挪动。 */

  let press = $state({ x: 0, y: 0, id: "" });
  let dragId: string | null = $state(null);
  let dropY: number | null = $state(null);
  let dropBefore: string | null = null;
  let rowRects: { top: number; bottom: number; id: string }[] = [];
  let bodyEl: HTMLElement | null = null;
  let draggedThisPress = false;

  function onRowMouseDown(e: MouseEvent, id: string) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // 操作图标区域不发起拖动
    if (profilesState.manageQuery.trim()) return; // 搜索过滤中不可排序
    press = { x: e.clientX, y: e.clientY, id };
    draggedThisPress = false;
  }

  function onRowClick(p: (typeof profilesState.list)[number]) {
    if (draggedThisPress) return; // 拖动刚结束，这次 click 不算连接
    connectProfile(p);
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!press.id) return;
    if (!dragId) {
      if (Math.abs(e.clientX - press.x) < 5 && Math.abs(e.clientY - press.y) < 5) return;
      bodyEl = document.querySelector("#panel-profiles .float-panel__body");
      const src = bodyEl?.querySelector(`.profile-row[data-id="${press.id}"]`) as HTMLElement | null;
      if (!bodyEl || !src) { press.id = ""; return; }
      const group = src.dataset.group || "";
      rowRects = [...bodyEl.querySelectorAll(`.profile-row[data-group="${CSS.escape(group)}"]`)]
        .map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, id: (el as HTMLElement).dataset.id || "" };
        });
      if (rowRects.length < 2) { press.id = ""; return; } // 组内不足两条，没得排
      dragId = press.id;
      draggedThisPress = true;
    }
    e.preventDefault();
    // 列表超高出现滚动时，指针贴近上下边缘自动滚
    const br = bodyEl!.getBoundingClientRect();
    if (e.clientY > br.bottom - 20) bodyEl!.scrollTop += 10;
    else if (e.clientY < br.top + 20) bodyEl!.scrollTop -= 10;
    // 插入缝：指针在某行中点上方 = 插到它前面，全在下方 = 追加到组末
    let gap = rowRects.length;
    for (let i = 0; i < rowRects.length; i++) {
      if (e.clientY < (rowRects[i].top + rowRects[i].bottom) / 2) { gap = i; break; }
    }
    dropBefore = gap < rowRects.length ? rowRects[gap].id : null;
    const gapY = gap === 0 ? rowRects[0].top
      : gap >= rowRects.length ? rowRects[rowRects.length - 1].bottom
      : rowRects[gap].top;
    dropY = gapY - br.top + bodyEl!.scrollTop;
  }

  function endDrag(apply: boolean) {
    if (apply && dragId) reorderProfile(dragId, dropBefore);
    dragId = null;
    dropY = null;
    dropBefore = null;
    press.id = "";
    // click 在 mouseup 之后触发：等它先跳过，再复位标记
    setTimeout(() => (draggedThisPress = false), 0);
  }

  function onWindowMouseUp() {
    if (dragId || press.id) endDrag(true);
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && dragId) endDrag(false); // Esc 放弃本次拖动
  }
</script>

{#if ui.panels.profiles}
  <div
    id="panel-profiles"
    class="float-panel"
    style={`top:${ui.panelPos.profiles.top}px;left:${ui.panelPos.profiles.left}px;width:360px`}
    onmouseenter={cancelPanelTimers}
    onmouseleave={() => schedulePanelClose(closeProfilesPanel, ["btn-profiles", "panel-profiles"])}
    role="dialog"
    tabindex="-1"
    aria-label={t("已保存的连接")}
  >
    <div class="float-panel__head">
      <span>{t("已保存的连接")}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        class="ml-auto"
        title={t("新建连接")}
        aria-label={t("新建连接")}
        onclick={() => { closeProfilesPanel(); openModal(); }}
      ><PlusIcon /></Button>
    </div>

    <div class="relative px-2 pt-2">
      <SearchIcon class="absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        bind:ref={searchEl}
        bind:value={profilesState.manageQuery}
        class="pl-8"
        type="search"
        placeholder={t("搜索名称 / 主机 / 用户名 / 分组")}
        autocomplete="off"
        spellcheck="false"
        onkeydown={onSearchKey}
      />
    </div>

    <p class="px-3 pt-1.5 pb-1 text-[11px] leading-relaxed text-muted-foreground">
      {t("点击条目即可连接；可上下拖动排序。关键词可匹配分组名，回车直连第一条。复制图标可复制出一份新连接并直接编辑。配置以 AES-256-GCM 加密保存在本机。")}
    </p>

    <div class="float-panel__body">
      {#if !profilesState.list.length}
        <div class="p-4 text-center text-xs text-muted-foreground">
          {t("还没有保存的连接。新建连接时勾选「保存到连接列表」即可。")}
        </div>
      {:else if !shown.length}
        <div class="p-4 text-center text-xs text-muted-foreground">
          {t("没有匹配「{query}」的连接", { query: profilesState.manageQuery })}
        </div>
      {:else}
        {#each groups as g (g.name)}
          <button class="group-head" onclick={() => toggleGroup(g.name)} title={t("折叠 / 展开分组")}>
            {#if profilesState.collapsed.includes(g.name)}
              <ChevronRightIcon class="size-3" />
            {:else}
              <ChevronDownIcon class="size-3" />
            {/if}
            <FolderIcon class="size-3" />
            <span>{groupLabel(g.name)}</span>
            <span class="group-head__count">{g.items.length}</span>
          </button>

          {#if !profilesState.collapsed.includes(g.name)}
            {#each g.items as p (p.id)}
              <div
                class="profile-row"
                class:is-drag-source={p.id === dragId}
                data-id={p.id}
                data-group={g.name}
                title={t("点击直接连接；可上下拖动排序；右侧图标可复制 / 编辑 / 删除")}
                role="button"
                tabindex="0"
                onmousedown={(e) => onRowMouseDown(e, p.id)}
                onclick={() => onRowClick(p)}
                onkeydown={(e) => e.key === "Enter" && connectProfile(p)}
              >
                <div class="profile-row__info">
                  <span class="profile-row__name">{defaultTitle(p)}</span>
                  <span class="profile-row__meta">
                    {p.username}@{p.host}:{p.port || 22}{p.password || p.privateKey ? "" : t(" · 需填密码")}
                  </span>
                </div>
                <div class="profile-row__ops">
                  <Button
                    variant="ghost" size="icon-xs"
                    title={t("复制为新连接并编辑")} aria-label={t("复制为新连接并编辑")}
                    onclick={(e) => { e.stopPropagation(); onDuplicate(p); }}
                  ><CopyIcon /></Button>
                  <Button
                    variant="ghost" size="icon-xs"
                    title={t("编辑")} aria-label={t("编辑")}
                    onclick={(e) => { e.stopPropagation(); onEdit(p); }}
                  ><PencilIcon /></Button>
                  <Button
                    variant="ghost" size="icon-xs"
                    class={confirmId === p.id ? "text-destructive" : ""}
                    title={confirmId === p.id ? t("再次点击确认删除") : t("删除")}
                    aria-label={t("删除")}
                    onclick={(e) => { e.stopPropagation(); onDelete(p.id); }}
                  ><TrashIcon /></Button>
                </div>
              </div>
            {/each}
          {/if}
        {/each}
      {/if}

      {#if dropY !== null}
        <div class="profile-drop-ind" style="top: {dropY}px"></div>
      {/if}
    </div>
  </div>
{/if}

<svelte:window onmousemove={onWindowMouseMove} onmouseup={onWindowMouseUp} onkeydown={onWindowKeyDown} />
