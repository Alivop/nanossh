<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import XIcon from "@lucide/svelte/icons/x";
  import { ui } from "$lib/stores/ui.svelte";
  import { browserState, closeSftp } from "$lib/stores/browser.svelte";
  import { startTransfer } from "$lib/stores/transfers.svelte";
  import { t } from "$lib/i18n.svelte";
  import DirPane from "./DirPane.svelte";
</script>

{#if ui.sftpOpen}
  <div class="modal-layer modal-layer--sftp">
    <div class="modal-card modal-card--wide">
      <div class="flex items-center gap-3">
        <h2>{t("SFTP 文件传输")}</h2>
        <span class="flex-1 truncate text-xs text-muted-foreground">{browserState.target}</span>
        <Button variant="ghost" size="icon-xs" title={t("关闭")} aria-label={t("关闭")} onclick={closeSftp}><XIcon /></Button>
      </div>

      <div class="mt-3 flex items-center gap-5">
        <Label class="flex items-center gap-2 font-normal">
          <Checkbox bind:checked={browserState.overwrite} /> {t("覆盖同名文件")}
        </Label>
        <Label class="flex items-center gap-2 font-normal">
          <Checkbox bind:checked={browserState.showHidden} /> {t("显示隐藏文件")}
        </Label>
      </div>

      <div class="sftp-browser">
        <DirPane side="local" title={t("本地")} />

        <div class="sftp-transfer">
          <Button size="sm" title={t("把左侧选中的文件上传到右侧当前目录")} onclick={() => startTransfer(true)}>{t("上传 →")}</Button>
          <Button variant="outline" size="sm" title={t("把右侧选中的文件下载到左侧当前目录")} onclick={() => startTransfer(false)}>{t("← 下载")}</Button>
          <span class="sftp-transfer__hint">
            {t("选中文件后传输")}<br />{t("点击目录进入")}<br />{t("Ctrl / ⌘ 多选")}
          </span>
        </div>

        <DirPane side="remote" title={t("远程")} />
      </div>

      <div class="mt-3 flex justify-end">
        <Button variant="ghost" size="sm" onclick={closeSftp}>{t("关闭")}</Button>
      </div>
    </div>
  </div>
{/if}
