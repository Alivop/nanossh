<script lang="ts">
  import { ui } from "$lib/stores/ui.svelte";
</script>

<footer class="statusbar">
  <span
    class="statusbar__dot"
    class:is-ok={ui.statusKind === "ok"}
    class:is-error={ui.statusKind === "error"}
  ></span>
  <span>{ui.statusText}</span>
  <span class="statusbar__spacer"></span>
  <span>NanoSSH · Tauri 2 · Svelte 5 · shadcn-svelte · xterm.js</span>
</footer>
