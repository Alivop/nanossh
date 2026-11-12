<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import EyeOffIcon from "@lucide/svelte/icons/eye-off";
  import { submitPassword, closeTab } from "$lib/stores/tabs.svelte";
  import { rememberPassword } from "$lib/stores/profiles.svelte";
  import { toast } from "$lib/stores/ui.svelte";
  import { t } from "$lib/i18n.svelte";
  import type { Tab } from "$lib/types";

  let { tab }: { tab: Tab } = $props();
  let password = $state("");
  let show = $state(false);
  let remember = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => { inputEl?.focus(); });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!password) {
      toast(t("请先输入密码"), true);
      inputEl?.focus();
      return;
    }
    if (remember) {
      rememberPassword(tab.profileId, password);
      toast(t("密码已加密保存"));
    }
    await submitPassword(tab, password);
  }
</script>

<div class="pw-layer">
  <form class="pw-card grid gap-3" onsubmit={submit}>
    <div class="flex items-center gap-2 text-sm font-semibold">
      <EyeOffIcon class="size-4 text-muted-foreground" /> {t("需要密码")}
    </div>
    <p class="text-xs text-muted-foreground">
      {t("已保存的连接「{title}」没有保存密码，输入密码即可直接连接。", { title: tab.title })}
    </p>

    <Label class="grid gap-1">
      {t("密码")}
      <div class="flex gap-1">
        <Input
          bind:ref={inputEl}
          bind:value={password}
          type={show ? "text" : "password"}
          placeholder={t("输入 SSH 密码")}
          autocomplete="off"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={show ? t("隐藏密码") : t("显示密码")}
          onclick={() => (show = !show)}
        >
          {#if show}<EyeOffIcon />{:else}<EyeIcon />{/if}
        </Button>
      </div>
    </Label>

    <Label class="flex items-center gap-2 text-xs font-normal">
      <Checkbox bind:checked={remember} />
      {t("记住密码（加密保存到此连接）")}
    </Label>

    <div class="flex justify-end gap-2 pt-1">
      <Button type="button" variant="ghost" onclick={() => closeTab(tab.id)}>{t("取消")}</Button>
      <Button type="submit">{t("连接")}</Button>
    </div>
    <p class="text-[11px] text-muted-foreground">
      {t("密码仅用于本次连接，不会写入连接列表（除非勾选记住）。")}
    </p>
  </form>
</div>
