<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
</script>

<div class="toasts">
  {#each ui.toasts as t (t.id)}
    <div class={t.error ? "toast is-error" : "toast"}>{t.message}</div>
  {/each}
</div>
