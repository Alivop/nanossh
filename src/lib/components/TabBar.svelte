<script lang="ts">
  import CopyIcon from "@lucide/svelte/icons/copy";
  import XIcon from "@lucide/svelte/icons/x";
  import { ui, showContextMenu } from "$lib/stores/ui.svelte";
  import {
    tabsState, activateTab, closeTab, cloneTab, copyTitle, openLocalTerminal, moveTabTo,
  } from "$lib/stores/tabs.svelte";
  import { hoverOpen, hoverClose } from "$lib/panels";
  import { t } from "$lib/i18n.svelte";

  let addBtn: HTMLButtonElement;

  function onTabClick(e: MouseEvent, id: string) {
    const el = e.target as HTMLElement;
    if (el.closest("button")) return;
    if (draggedThisPress) return; // 拖动排序刚结束，这次 click 不算切换页签
    activateTab(id);
  }

  function onTabDblClick(e: MouseEvent, id: string) {
    const el = e.target as HTMLElement;
    if (el.closest("button")) return;
    if (draggedThisPress) return;
    const tab = tabsState.list.find((x) => x.id === id);
    if (tab) cloneTab(tab);
  }

  function onTabContext(e: MouseEvent, id: string) {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, id);
  }

  /* ---------- 拖动页签排序（指针自实现：Tauri dragDrop 接管下 HTML5 DnD 不可靠） ----------
   *  按下记录候选；移动超过 5px 才算拖动（不影响单击切换/双击克隆）；拖动开始时快照
   *  各页签边界，按指针 x 算插入缝并显示指示条，松开时调 moveTabTo 落位。 */

  let press = $state({ x: 0, y: 0, id: "" });
  let dragId: string | null = $state(null);
  let dropX: number | null = $state(null);
  let dropIdx = 0;
  let rects: { left: number; right: number }[] = [];
  let listEl: HTMLElement | null = null;
  let draggedThisPress = false;

  function onTabMouseDown(e: MouseEvent, id: string) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // 按钮区域不发起拖动
    press = { x: e.clientX, y: e.clientY, id };
    draggedThisPress = false;
  }

  /** 插入缝编号 0..n：指针在某页签中点左侧 = 插到它前面，全在最右 = 追加到末尾 */
  function gapIndexAt(x: number): number {
    for (let i = 0; i < rects.length; i++) {
      if (x < (rects[i].left + rects[i].right) / 2) return i;
    }
    return rects.length;
  }

  function gapXOf(idx: number): number {
    if (idx <= 0) return rects[0].left;
    if (idx >= rects.length) return rects[rects.length - 1].right;
    return rects[idx].left;
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!press.id) return;
    if (!dragId) {
      if (Math.abs(e.clientX - press.x) < 5 && Math.abs(e.clientY - press.y) < 5) return;
      listEl = document.querySelector(".tabbar__list");
      const els = [...(listEl?.querySelectorAll(".tab") ?? [])] as HTMLElement[];
      if (!els.some((el) => el.dataset.tabId === press.id)) { press.id = ""; return; }
      rects = els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      dragId = press.id;
      draggedThisPress = true;
    }
    e.preventDefault();
    // 页签多到滚动时，指针贴近两端自动滚
    const lr = listEl!.getBoundingClientRect();
    if (e.clientX > lr.right - 24) listEl!.scrollLeft += 12;
    else if (e.clientX < lr.left + 24) listEl!.scrollLeft -= 12;
    dropIdx = gapIndexAt(e.clientX);
    dropX = gapXOf(dropIdx) - lr.left + listEl!.scrollLeft;
  }

  function endDrag(apply: boolean) {
    if (apply && dragId) moveTabTo(dragId, dropIdx);
    dragId = null;
    dropX = null;
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

<svelte:window onmousemove={onWindowMouseMove} onmouseup={onWindowMouseUp} onkeydown={onWindowKeyDown} />

<nav class="tabbar">
  <div class="tabbar__list">
    {#each tabsState.list as tab (tab.id)}
      <div
        class={tab.id === tabsState.activeId ? "tab is-active" : "tab"}
        class:is-disconnected={tab.status === "failed"}
        class:is-drag-source={tab.id === dragId}
        data-tab-id={tab.id}
        title={tab.cloneFrom ? t("克隆自「{title}」", { title: tab.title }) : tab.title}
        role="tab"
        aria-selected={tab.id === tabsState.activeId}
        tabindex="0"
        onmousedown={(e) => onTabMouseDown(e, tab.id)}
        onclick={(e) => onTabClick(e, tab.id)}
        ondblclick={(e) => onTabDblClick(e, tab.id)}
        oncontextmenu={(e) => onTabContext(e, tab.id)}
        onkeydown={(e) => e.key === "Enter" && activateTab(tab.id)}
      >
        <span
          class="tab__state"
          class:is-connecting={tab.status === "connecting" || tab.status === "need-password" || tab.status === "restored"}
          title={tab.status === "failed" ? t("连接失败，按 Enter 重新连接")
            : tab.status === "connected" ? t("已连接")
            : tab.status === "restored" ? t("未连接 · 切换到此页签时自动连接")
            : t("连接中")}
        ></span>
        <span class="tab__title">{tab.title}</span>
        <span class="tab__ops">
          <button
            class="inline-flex size-5 items-center justify-center rounded hover:bg-muted"
            title={t("复制标题")}
            aria-label={t("复制标题")}
            onclick={(e) => { e.stopPropagation(); copyTitle(tab); }}
          ><CopyIcon class="size-3" /></button>
          <button
            class="inline-flex size-5 items-center justify-center rounded hover:bg-muted"
            title={t("关闭页签")}
            aria-label={t("关闭页签")}
            onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
          ><XIcon class="size-3" /></button>
        </span>
      </div>
    {/each}

    <!-- 拖动排序的插入位置指示条（列表坐标，跟随滚动） -->
    {#if dropX !== null}
      <div class="tab-drop-ind" style="left: {dropX}px"></div>
    {/if}

    <!-- ＋ 跟在最新一个页签的右边（放在列表内部，随页签一起排）；列表本身 flex-end，
         与页签同高 29px，垂直中心自然和页签严丝合缝 -->
    <button
      id="tab-add"
      class="relative z-10 flex h-[29px] w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      title={t("点击新建本地终端 · 悬停查看快捷新建")}
      aria-label={t("点击新建本地终端，悬停查看快捷新建")}
      bind:this={addBtn}
      onclick={openLocalTerminal}
      onmouseenter={() => hoverOpen("quick", () => addBtn.getBoundingClientRect())}
      onmouseleave={() => hoverClose("quick")}
    >＋</button>
  </div>
</nav>
