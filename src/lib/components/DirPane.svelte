<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import FileIcon from "@lucide/svelte/icons/file";
  import CornerUpLeftIcon from "@lucide/svelte/icons/corner-up-left";
  import HomeIcon from "@lucide/svelte/icons/house";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import {
    sideState, visibleEntries, loadDir, clickEntry, parentPath, setSort,
    type Side,
  } from "$lib/stores/browser.svelte";
  import { humanSize } from "$lib/stores/tabs.svelte";
  import { t, i18n } from "$lib/i18n.svelte";

  let { side, title }: { side: Side; title: string } = $props();
  let st = $derived(sideState(side));
  let entries = $derived(visibleEntries(side));
  let pathInput = $state("");

  // 目录加载成功后同步路径框；用户输入时不回写 store
  $effect(() => { pathInput = sideState(side).path; });

  function onRowClick(e: MouseEvent, path: string) {
    if (e.detail > 1) return; // 双击的第二下不重复处理，避免连进两层目录
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    void clickEntry(side, path, multi);
  }

  /** 修改时间列：年-月-日 时:分；0 或缺失显示 —（远端个别服务器拿不到时间） */
  function formatMtime(ts: number | undefined): string {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleString(
      i18n.locale === "en" ? "en-US" : "zh-CN",
      { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" },
    );
  }
</script>

<section class="sftp-pane">
  <div class="sftp-pane__head">
    <span class="sftp-pane__title">{title}</span>
    <Button variant="ghost" size="icon-xs" title={t("上级目录")} aria-label={t("上级目录")} onclick={() => loadDir(side, parentPath(st.path))}>
      <CornerUpLeftIcon />
    </Button>
    <Button variant="ghost" size="icon-xs" title={side === "local" ? t("本机主目录") : t("远端默认目录")} aria-label={t("主目录")} onclick={() => loadDir(side, "")}>
      <HomeIcon />
    </Button>
    <Button variant="ghost" size="icon-xs" title={t("刷新")} aria-label={t("刷新")} onclick={() => loadDir(side, st.path)}>
      <RefreshCwIcon />
    </Button>
  </div>

  <Input
    bind:value={pathInput}
    title={t("输入绝对路径后回车跳转")}
    spellcheck="false"
    autocomplete="off"
    onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); loadDir(side, pathInput.trim()); } }}
  />

  <div class="relative">
    <SearchIcon class="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    <Input
      class="sftp-search pl-7"
      bind:value={st.search}
      placeholder={t("搜索")}
      title={t("按文件名过滤当前目录（Esc 清空）")}
      spellcheck="false"
      autocomplete="off"
      onkeydown={(e) => { if (e.key === "Escape") { e.preventDefault(); st.search = ""; } }}
    />
  </div>

  <div class="sftp-cols">
    <button
      type="button"
      class={st.sort.key === "name" ? "is-active" : ""}
      title={t("点击按名称排序（再点一次换方向）")}
      onclick={() => setSort(side, "name")}
    >
      {t("名称")}{st.sort.key === "name" ? (st.sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </button>
    <button
      type="button"
      class={st.sort.key === "size" ? "is-active" : ""}
      title={t("点击按大小排序（再点一次换方向）")}
      onclick={() => setSort(side, "size")}
    >
      {t("大小")}{st.sort.key === "size" ? (st.sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </button>
    <button
      type="button"
      class={st.sort.key === "time" ? "is-active" : ""}
      title={t("点击按修改时间排序（再点一次换方向）")}
      onclick={() => setSort(side, "time")}
    >
      {t("修改时间")}{st.sort.key === "time" ? (st.sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </button>
  </div>

  <div class="sftp-list">
    {#if st.error}
      <div class="p-3 text-xs text-destructive">{st.error}</div>
    {:else if st.loading}
      <div class="p-3 text-xs text-muted-foreground">{t("正在读取目录…")}</div>
    {:else if !entries.length}
      <div class="p-3 text-xs text-muted-foreground">
        {st.search ? t("没有匹配的文件") :
          st.entries.length ? t("只含隐藏文件（可勾选「显示隐藏文件」）") : t("空目录")}
      </div>
    {:else}
      {#each entries as e (e.path)}
        <div
          class={st.selected.includes(e.path) ? "sftp-row is-selected" : "sftp-row"}
          title={e.path}
          role="button"
          tabindex="0"
          onclick={(ev) => onRowClick(ev, e.path)}
          onkeydown={(ev) => ev.key === "Enter" && clickEntry(side, e.path, false)}
        >
          <span class="sftp-row__icon">
            {#if e.isDir}<FolderIcon class="size-4" />{:else}<FileIcon class="size-4" />{/if}
          </span>
          <span class="sftp-row__name">{e.name}</span>
          <span class="sftp-row__meta">{e.isDir ? t("目录") : humanSize(e.size)}</span>
          <span class="sftp-row__time">{formatMtime(e.mtime)}</span>
        </div>
      {/each}
    {/if}
  </div>
</section>
