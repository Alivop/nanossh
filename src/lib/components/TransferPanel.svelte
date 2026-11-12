<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Progress } from "$lib/components/ui/progress";
  import { Badge } from "$lib/components/ui/badge";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import PlayIcon from "@lucide/svelte/icons/play";
  import XIcon from "@lucide/svelte/icons/x";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
  import {
    ui, cancelPanelTimers, schedulePanelClose,
  } from "$lib/stores/ui.svelte";
  import {
    transfersState, activeCount, toggleTransfer, removeTransfer, transferMeta,
  } from "$lib/stores/transfers.svelte";
  import { openSftp } from "$lib/stores/browser.svelte";
  import { closeTransferPanel } from "$lib/panels";
  import { t, formatTime } from "$lib/i18n.svelte";

  const busy = $derived(activeCount());
</script>

{#if ui.panels.transfers}
  <div
    id="panel-transfer"
    class="float-panel float-panel--wide"
    style={`top:${ui.panelPos.transfers.top}px;left:${ui.panelPos.transfers.left}px`}
    onmouseenter={cancelPanelTimers}
    onmouseleave={() => schedulePanelClose(closeTransferPanel, ["btn-upload", "panel-transfer"])}
    role="dialog"
    tabindex="-1"
    aria-label={t("后台传输")}
  >
    <div class="float-panel__head">
      <span>{t("后台传输")}</span>
      {#if busy}<Badge variant="secondary">{busy} {t("项进行中")}</Badge>{/if}
    </div>

    <div class="transfer-list">
      {#if !transfersState.list.length}
        <div class="p-6 text-center text-xs text-muted-foreground">{t("暂无传输任务")}</div>
      {/if}
      {#each transfersState.list as tr (tr.job)}
        <div
          class={`transfer-item is-${tr.state}`}
          title={tr.at ? formatTime(tr.at) : ""}
        >
          <div class="transfer-item__top">
            {#if tr.kind === "upload"}<ArrowUpIcon class="size-3.5 text-muted-foreground" />{:else}<ArrowDownIcon class="size-3.5 text-muted-foreground" />{/if}
            <span class="transfer-item__name">{tr.label}</span>
            <span class="flex items-center gap-0.5">
              {#if tr.state === "running" || tr.state === "paused"}
                <Button
                  variant="ghost" size="icon-xs"
                  title={tr.state === "running" ? t("暂停") : t("继续")}
                  aria-label={tr.state === "running" ? t("暂停") : t("继续")}
                  onclick={() => toggleTransfer(tr)}
                >
                  {#if tr.state === "running"}<PauseIcon />{:else}<PlayIcon />{/if}
                </Button>
              {/if}
              <Button
                variant="ghost" size="icon-xs"
                title={tr.state === "running" || tr.state === "paused" ? t("取消并删除") : t("从列表移除")}
                aria-label={t("删除任务")}
                onclick={() => removeTransfer(tr)}
              ><XIcon /></Button>
            </span>
          </div>
          <div class="transfer-item__meta">{transferMeta(tr)}</div>
          <Progress value={tr.percent} max={100} class="h-1" />
        </div>
      {/each}
    </div>

    <div class="float-panel__foot">
      <Button
        variant="ghost" size="sm" class="w-full justify-start"
        onclick={() => { closeTransferPanel(); openSftp(); }}
      ><FolderOpenIcon /> {t("打开文件浏览器")}</Button>
    </div>
  </div>
{/if}
