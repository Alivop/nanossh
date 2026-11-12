<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import EyeOffIcon from "@lucide/svelte/icons/eye-off";
  import { ui, closeModal, toast } from "$lib/stores/ui.svelte";
  import {
    profilesState, uid, upsertProfile, groupNames, normalizeGroup, DEFAULT_GROUP,
    groupToInput, inputToGroup,
  } from "$lib/stores/profiles.svelte";
  import { createTab, applyEditedConfig, findTab } from "$lib/stores/tabs.svelte";
  import { markRecent } from "$lib/stores/recent.svelte";
  import { t } from "$lib/i18n.svelte";
  import type { SshConfig } from "$lib/types";

  let form = $state({
    title: "", host: "", port: 22, username: "", password: "", privateKey: "",
  });
  let saveProfile = $state(true);
  let rememberPw = $state(false);
  let showPw = $state(false);
  let groupInput = $state<string>(DEFAULT_GROUP);
  let testResult = $state({ visible: false, text: "", ok: true });
  let testing = $state(false);

  // 弹窗每次打开重新初始化表单（ui.modal 是整体替换的对象）
  $effect(() => {
    if (!ui.modal.open) return;
    const c = ui.modal.prefill;
    form.title = c?.title ?? "";
    form.host = c?.host ?? "";
    form.port = c?.port ?? 22;
    form.username = c?.username ?? "";
    form.password = c?.password ?? "";
    form.privateKey = c?.privateKey ?? "";
    groupInput = groupToInput(normalizeGroup(ui.modal.group));
    saveProfile = true;
    showPw = false;
    const prof = profilesState.list.find((p) => p.id === ui.modal.profileId);
    rememberPw = !!prof?.rememberPassword;
    testResult = { visible: false, text: "", ok: true };
  });

  const finalGroup = $derived(inputToGroup(groupInput));
  const title = $derived(
    ui.modal.duplicate ? t("复制并编辑连接")
      : ui.modal.tabId ? t("编辑连接")
        : profilesState.list.some((p) => p.id === ui.modal.profileId) ? t("编辑已保存的连接")
          : t("新建 SSH 连接"),
  );

  function readCfg(): SshConfig {
    return {
      title: String(form.title).trim(),
      host: String(form.host).trim(),
      port: Number(form.port) || 22,
      username: String(form.username).trim(),
      password: String(form.password),
      privateKey: String(form.privateKey).trim(),
    };
  }

  function validate(cfg: SshConfig): string | null {
    if (!cfg.host || !cfg.username) return t("请填写主机和用户名");
    if (!cfg.password && !cfg.privateKey) return t("请填写密码或私钥路径");
    return null;
  }

  async function testConn() {
    const cfg = readCfg();
    const invalid = validate(cfg);
    if (invalid) {
      testResult = { visible: true, text: invalid, ok: false };
      return;
    }
    const { title: _ignored, ...sshConfig } = cfg;
    testing = true;
    testResult = { visible: true, text: t("正在连接并验证凭据…"), ok: true };
    try {
      const res = await invoke<string>("ssh_test", { config: { ...sshConfig, cols: 80, rows: 24 } });
      testResult = { visible: true, text: `✓ ${res}`, ok: true };
    } catch (err) {
      testResult = { visible: true, text: `✗ ${String(err)}`, ok: false };
    } finally {
      testing = false;
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const cfg = readCfg();
    const invalid = validate(cfg);
    if (invalid) return toast(invalid, true);

    const mode = { ...ui.modal };
    let profileId = mode.profileId;
    if (saveProfile) {
      if (!profileId) profileId = uid();
      upsertProfile({
        id: profileId,
        ...cfg,
        password: rememberPw ? cfg.password : "",
        rememberPassword: rememberPw,
        group: finalGroup,
      });
    }
    closeModal();

    if (mode.tabId) {
      const tab = findTab(mode.tabId);
      if (tab) await applyEditedConfig(tab, cfg, profileId);
      return;
    }
    if (!mode.connectAfterSave) return toast(t("连接已保存"));
    markRecent(profileId);  // 首页「最近连接」排序依据
    createTab(cfg, { profileId });
  }
</script>

<Dialog bind:open={ui.modal.open}>
  <DialogContent class="sm:max-w-md max-h-[calc(100vh-60px)] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription class="text-xs">
        {t("配置以 AES-256-GCM 加密保存在本机；密码默认不保存。")}
      </DialogDescription>
    </DialogHeader>

    <form class="grid gap-3" onsubmit={submit}>
      <Label class="grid gap-1">
        {t("页签标题")}
        <Input bind:value={form.title} placeholder={t("留空则使用 用户名@主机")} />
      </Label>

      <div class="grid grid-cols-[1fr_100px] gap-2">
        <Label class="grid gap-1">
          {t("主机")}
          <Input bind:value={form.host} required placeholder="192.168.1.10" />
        </Label>
        <Label class="grid gap-1">
          {t("端口")}
          <Input bind:value={form.port} type="number" min="1" max="65535" required />
        </Label>
      </div>

      <Label class="grid gap-1">
        {t("用户名")}
        <Input bind:value={form.username} required placeholder="root" />
      </Label>

      <Label class="grid gap-1">
        {t("密码")}
        <div class="flex gap-1">
          <Input
            bind:value={form.password}
            type={showPw ? "text" : "password"}
            placeholder={t("留空则使用私钥")}
            autocomplete="off"
          />
          <Button type="button" variant="ghost" size="icon" title={t("显示 / 隐藏密码")} onclick={() => (showPw = !showPw)}>
            {#if showPw}<EyeOffIcon />{:else}<EyeIcon />{/if}
          </Button>
        </div>
      </Label>

      <Label class="grid gap-1">
        {t("私钥文件路径")}
        <Input bind:value={form.privateKey} placeholder="~/.ssh/id_ed25519" />
      </Label>

      <Label class="grid gap-1">
        {t("分组")}
        <Input
          bind:value={groupInput}
          list="nanossh-group-options"
          placeholder={t("选择已有分组，或直接输入新分组名")}
          autocomplete="off"
          spellcheck="false"
        />
        <datalist id="nanossh-group-options">
          {#each groupNames() as g (g)}<option value={groupToInput(g)}></option>{/each}
        </datalist>
        <span class="text-[11px] font-normal text-muted-foreground">{t("留空归到「未分组」；连接列表按分组折叠展示。")}</span>
      </Label>

      <p class="text-[11px] leading-relaxed text-muted-foreground">
        {t("密码与私钥二选一。私钥支持 OpenSSH / PEM / PPK；路径中的 ~ 会展开为用户目录。")}
      </p>

      <div class="flex flex-col gap-2">
        <Label class="flex items-center gap-2 font-normal">
          <Checkbox bind:checked={saveProfile} /> {t("保存到连接列表")}
        </Label>
        <Label class="flex items-center gap-2 font-normal">
          <Checkbox bind:checked={rememberPw} /> {t("记住密码（AES-256 加密存本机）")}
        </Label>
      </div>

      <DialogFooter class="flex-row items-center gap-2">
        <!-- 测试结果放在底部左侧常驻位置：不新增一行，弹窗高度不会因测试而跳动 -->
        <div class="min-w-0 flex-1 text-left text-[11px] leading-tight">
          {#if testResult.visible}
            <span
              class={testResult.ok ? "line-clamp-2 break-all text-muted-foreground" : "line-clamp-2 break-all text-destructive"}
              title={testResult.text}
            >{testResult.text}</span>
          {/if}
        </div>
        <Button type="button" variant="ghost" onclick={closeModal}>{t("取消")}</Button>
        <Button type="button" variant="outline" disabled={testing} onclick={testConn}>
          {testing ? t("测试中…") : t("测试")}
        </Button>
        <Button type="submit">
          {ui.modal.connectAfterSave ? (ui.modal.tabId ? t("保存并重连") : t("保存并连接")) : t("保存")}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
