import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-svelte 组件统一使用的类名合并工具 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* shadcn-svelte 组件源码统一从 $lib/utils.js 导入的工具类型。
   这里用宽松定义，避免为了 3 个纯类型额外依赖 pnpm 的间接包 svelte-toolbelt。 */
export type WithElementRef<T, E = HTMLElement | null> = T & { ref?: E };
export type WithoutChild<T> = Omit<T, "children">;
export type WithoutChildren<T> = Omit<T, "children">;
export type WithoutChildrenOrChild<T> = Omit<T, "children" | "child">;
