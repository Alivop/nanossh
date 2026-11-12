<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { openModal } from "$lib/stores/ui.svelte";
  import { profilesState, defaultTitle, normalizeGroup, DEFAULT_GROUP } from "$lib/stores/profiles.svelte";
  import { recentProfiles } from "$lib/stores/recent.svelte";
  import { tabsState } from "$lib/stores/tabs.svelte";
  import { connectProfile } from "$lib/actions";
  import { t } from "$lib/i18n.svelte";

  /** 首页只列最近用过的 3 条连接，历史不足时按保存顺序补齐 */
  let recent = $derived(recentProfiles(profilesState.list, 3));
</script>

{#if tabsState.list.length === 0}
  <section class="empty">
    <div class="text-4xl font-mono text-muted-foreground/60">&gt;_</div>
    <h1 class="text-lg font-semibold text-foreground">{t("还没有会话")}</h1>
    <p>{t("新建连接后可在多个页签间切换，切换不会中断 SSH 会话")}</p>
    <Button size="sm" onclick={() => openModal()}>＋ {t("新建连接")}</Button>

    {#if recent.length}
      <div class="mt-2 flex flex-col items-center gap-1.5">
        <span class="text-[11px] text-muted-foreground/70">{t("最近连接")}</span>
        <div class="flex max-w-[560px] flex-wrap justify-center gap-2">
          {#each recent as p (p.id)}
            <button
              class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
              title={`${p.username}@${p.host}:${p.port || 22}`}
              onclick={() => connectProfile(p)}
            >
              {defaultTitle(p)}
              {#if normalizeGroup(p.group) !== DEFAULT_GROUP}
                <Badge variant="secondary" class="px-1 py-0 text-[10px]">{normalizeGroup(p.group)}</Badge>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="mt-4 flex flex-col gap-1 text-center text-[11px] leading-relaxed text-muted-foreground/80">
      <span>{t("双击页签 → 克隆会话（原名 + 副本1、副本2…）")}</span>
      <span>{t("悬停页签 → 点击按钮复制标题")}</span>
      <span>{t("右键页签 → 克隆 / 编辑 / 重连")}</span>
      <span>{t("点击 ＋ → 新建本地终端 · 悬停 ＋ → 快捷连接")}</span>
      <span>{t("连接失败 → 按 Enter 重连")}</span>
      <span>{t("标题栏 ⬆ → 双栏文件浏览器 · 悬停 ⬆ → 后台传输")}</span>
      <span class="font-mono">{t("字号：⌘= 或 ⌘+ 放大 · ⌘- 或 ⌘_ 缩小 · ⌘0 重置")}</span>
    </div>
  </section>
{/if}
