<script lang="ts">
  import { onMount } from "svelte";
  import { registerTerminal, disposeTerminal } from "$lib/stores/tabs.svelte";
  import type { Tab } from "$lib/types";
  import PasswordPrompt from "./PasswordPrompt.svelte";

  let { tab, active }: { tab: Tab; active: boolean } = $props();
  let host: HTMLDivElement;

  onMount(() => {
    // xterm 只在挂载时创建一次；切换页签只切 class，终端实例与 SSH 会话都保持存活
    void registerTerminal(tab.id, host);
    return () => disposeTerminal(tab.id);
  });
</script>

<div class={active ? "pane is-active" : "pane"}>
  <div class="h-full w-full" bind:this={host}></div>
  {#if tab.status === "need-password"}
    <PasswordPrompt {tab} />
  {/if}
</div>
