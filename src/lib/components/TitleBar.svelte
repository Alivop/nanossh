<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { Button } from "$lib/components/ui/button";
  import { toggleTheme, openModal, setStatus } from "$lib/stores/ui.svelte";
  import { activeCount } from "$lib/stores/transfers.svelte";
  import { openSftp } from "$lib/stores/browser.svelte";
  import { toggleProfilesPanel, hoverOpen, hoverClose } from "$lib/panels";
  import { i18n, toggleLocale, t } from "$lib/i18n.svelte";

  const win = getCurrentWindow();
  let profilesBtn: HTMLButtonElement | null = $state(null);
  let uploadBtn: HTMLButtonElement | null = $state(null);
  const busy = $derived(activeCount() > 0);

  function onToggleLocale() {
    toggleLocale();
    setStatus(t("就绪")); // 旧状态文案是切换前的语言，重置为新语言的默认值
  }

  /** 标题栏空白处（不含按钮/输入框）才算"标题栏本身" */
  const INTERACTIVE = "button, a, input, select, textarea, [role='button'], [contenteditable='true']";
  function isChrome(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el?.closest || !el.closest(".titlebar")) return false;
    return !el.closest(INTERACTIVE);
  }

  /** 双击标题栏 = 最大化 / 还原。
   *  Tauri 内置的 data-tauri-drag-region 双击实现要求按下与抬起坐标完全一致（触控板轻微
   *  移动就失效，常常"点了没反应"），所以这里自己做：捕获阶段拦掉第 2 次 mousedown/mouseup，
   *  内置逻辑收不到就不会再切一次；单击拖动不受影响。 */
  let downSeq = 0;
  let stateAtDown: { seq: number; maximized: boolean } | null = null;

  function onDownCapture(e: MouseEvent) {
    if (e.detail !== 2 || !isChrome(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    const seq = ++downSeq;
    void win.isMaximized()
      .then((v) => { stateAtDown = { seq, maximized: v }; })
      .catch(() => { /* 浏览器预览等非 Tauri 环境忽略 */ });
  }

  function onUpCapture(e: MouseEvent) {
    if (e.detail === 2 && isChrome(e.target)) e.stopPropagation();
  }

  function onDblClick(e: MouseEvent) {
    if (!isChrome(e.target)) return;
    void (async () => {
      // 保险：万一内置双击没被拦住、已经把窗口切过一次（当前状态与按下时不同），这里不再反切回去。
      // seq 只认本次按下拿到的状态，避免上一次的双击结果被误用。
      const now = await win.isMaximized().catch(() => null);
      if (now !== null && stateAtDown?.seq === downSeq && now !== stateAtDown.maximized) return;
      await win.toggleMaximize().catch(() => {});
    })();
  }
</script>

<!-- 双击最大化只是桌面端的鼠标便利操作，键盘有菜单「缩放」，不需要额外 ARIA 角色 -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
  class="titlebar"
  onmousedowncapture={onDownCapture}
  onmouseupcapture={onUpCapture}
  ondblclick={onDblClick}
>
  <div class="titlebar__drag" data-tauri-drag-region></div>

  <div class="titlebar__left">
    <!-- 圆点与符号画在同一个 SVG 里：共用一次栅格化，符号永远落在圆心上（分开画时子像素误差会把符号顶偏） -->
    <button class="traffic traffic--close" title={t("关闭")} aria-label={t("关闭")} onclick={() => win.close()}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <circle class="traffic__dot" cx="6" cy="6" r="6" />
        <path class="traffic__glyph" d="M3.1 3.1 8.9 8.9M8.9 3.1 3.1 8.9" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>
    <button class="traffic traffic--min" title={t("最小化")} aria-label={t("最小化")} onclick={() => win.minimize()}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <circle class="traffic__dot" cx="6" cy="6" r="6" />
        <path class="traffic__glyph" d="M2.7 6H9.3" stroke-width="1" stroke-linecap="round" />
      </svg>
    </button>
    <button class="traffic traffic--max" title={t("最大化")} aria-label={t("最大化")} onclick={() => win.toggleMaximize()}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <circle class="traffic__dot" cx="6" cy="6" r="6" />
        <path class="traffic__glyph traffic__glyph--solid" d="M2.7 2.7H7.6L2.7 7.6Z" />
        <path class="traffic__glyph traffic__glyph--solid" d="M9.3 9.3H4.4L9.3 4.4Z" />
      </svg>
    </button>
  </div>

  <div class="titlebar__center"><span class="brand">NanoSSH</span></div>

  <div class="titlebar__right">
    <Button
      bind:ref={profilesBtn}
      id="btn-profiles"
      variant="ghost"
      size="icon-sm"
      title={t("已保存的连接")}
      aria-label={t("已保存的连接")}
      onclick={() => toggleProfilesPanel(profilesBtn!.getBoundingClientRect())}
    >☰</Button>

    <Button
      bind:ref={uploadBtn}
      id="btn-upload"
      variant="ghost"
      size="icon-sm"
      class="relative"
      title={t("点击打开文件浏览器 · 悬停查看后台传输")}
      aria-label={t("点击打开文件浏览器，悬停查看后台传输")}
      onclick={() => openSftp()}
      onmouseenter={() => hoverOpen("transfers", () => uploadBtn!.getBoundingClientRect())}
      onmouseleave={() => hoverClose("transfers")}
    >
      ⬆
      {#if busy}
        <span class="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-emerald-500"></span>
      {/if}
    </Button>

    <Button variant="ghost" size="icon-sm" title={t("切换明暗主题")} aria-label={t("切换明暗主题")} onclick={toggleTheme}>◐</Button>

    <Button
      variant="ghost"
      size="icon-sm"
      class="text-[11px] font-semibold tracking-wide"
      title={t("切换语言")}
      aria-label={t("切换语言")}
      onclick={onToggleLocale}
    >{i18n.locale === "zh" ? "EN" : "中"}</Button>

    <Button size="sm" onclick={() => openModal()}>＋ {t("新建连接")}</Button>
  </div>
</header>
