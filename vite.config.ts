import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const LIB = path.resolve("./src/lib");

// Tauri 固定从 1420 端口加载前端；忽略 src-tauri 避免 Rust 编译产物触发前端热更新
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: [
      // shadcn-svelte 组件源码固定写 $lib/utils.js，这里钉到实际的 .ts 文件
      { find: /^\$lib\/utils\.js$/, replacement: `${LIB}/utils.ts` },
      // $lib/stores/xxx.svelte 与 $lib/i18n.svelte 是 Svelte 5 runes 模块，真实文件名为 *.svelte.ts
      { find: /^\$lib\/i18n\.svelte$/, replacement: `${LIB}/i18n.svelte.ts` },
      { find: /^\$lib\/(stores\/[^.]+)\.svelte$/, replacement: `${LIB}/$1.svelte.ts` },
      { find: /^\$lib\/(.*)$/, replacement: `${LIB}/$1` },
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
