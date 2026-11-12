//! 顶部系统菜单（macOS 菜单栏）：按界面语言构建，只保留有实际动作的项。
//!
//! Tauri 默认菜单里的 Reload / 强制重载 / 开发者工具 / 后退前进等在桌面 SSH 客户端里
//! 没有意义，这里全部去掉；「编辑」只留文本编辑必需项（切换语言后原生菜单同步重建）。
//! 菜单点击不直接执行动作，统一 emit("app-menu", id)，由前端按 id 分发。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// 构建整套菜单：中英标签一致、项集合一致，由 `zh` 决定文案，
/// `cursor` 决定「光标样式」子菜单里哪一项打勾（bar / block / underline）
pub fn build<R: Runtime>(app: &AppHandle<R>, zh: bool, cursor: &str) -> tauri::Result<Menu<R>> {
    // 调试开关：NANOSSH_MENU_LANG=en 可在 debug 构建里强制英文（release 不受影响）
    #[cfg(debug_assertions)]
    let zh = match std::env::var("NANOSSH_MENU_LANG").as_deref() {
        Ok("en") => false,
        Ok("zh") => true,
        _ => zh,
    };
    let menu = build_inner(app, zh, cursor)?;
    #[cfg(debug_assertions)]
    if std::env::var("NANOSSH_MENU_DUMP").is_ok() {
        dump(&menu, 0);
    }
    Ok(menu)
}

#[cfg(debug_assertions)]
fn dump<R: Runtime>(menu: &Menu<R>, depth: usize) {
    use tauri::menu::MenuItemKind;
    let pad = "  ".repeat(depth);
    for item in menu.items().unwrap_or_default() {
        match &item {
            MenuItemKind::Submenu(sm) => {
                eprintln!("{pad}[{}]", sm.text().unwrap_or_default());
                for sub in sm.items().unwrap_or_default() {
                    dump_one(&sub, depth + 1);
                }
            }
            other => dump_one(other, depth),
        }
    }
}

#[cfg(debug_assertions)]
fn dump_one<R: Runtime>(item: &tauri::menu::MenuItemKind<R>, depth: usize) {
    use tauri::menu::MenuItemKind;
    let pad = "  ".repeat(depth);
    match item {
        MenuItemKind::MenuItem(mi) => {
            eprintln!("{pad}- {} <{}>", mi.text().unwrap_or_default(), mi.id().as_ref())
        }
        MenuItemKind::Predefined(p) => {
            let text = p.text().unwrap_or_default();
            if text.trim().is_empty() {
                eprintln!("{pad}- ---");
            } else {
                eprintln!("{pad}- [p] {text}");
            }
        }
        MenuItemKind::Check(ci) => eprintln!(
            "{pad}- [{}] {} <{}>",
            if ci.is_checked().unwrap_or(false) { "x" } else { " " },
            ci.text().unwrap_or_default(),
            ci.id().as_ref()
        ),
        MenuItemKind::Submenu(sm) => {
            eprintln!("{pad}- [sub] {}", sm.text().unwrap_or_default());
            for sub in sm.items().unwrap_or_default() {
                dump_one(&sub, depth + 1);
            }
        }
        _ => eprintln!("{pad}- <其他项>"),
    }
}

fn build_inner<R: Runtime>(app: &AppHandle<R>, zh: bool, cursor: &str) -> tauri::Result<Menu<R>> {
    let s = |zh_text: &'static str, en_text: &'static str| if zh { zh_text } else { en_text };

    // ---- 文件：只留三个真正的入口（新建连接 / 本地终端 / 关页签）----
    let new_conn = MenuItem::with_id(
        app,
        "new-connection",
        s("新建连接…", "New Connection…"),
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_local = MenuItem::with_id(
        app,
        "new-local",
        s("新建本地终端", "New Local Terminal"),
        true,
        Some("CmdOrCtrl+T"),
    )?;
    let sep_file = PredefinedMenuItem::separator(app)?;
    let close_tab = MenuItem::with_id(
        app,
        "close-tab",
        s("关闭页签", "Close Tab"),
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let file_menu = Submenu::with_items(
        app,
        s("文件", "File"),
        true,
        &[&new_conn, &new_local, &sep_file, &close_tab],
    )?;

    // ---- 编辑：输入框与终端粘贴都依赖这几项，一项不能少 ----
    let undo = PredefinedMenuItem::undo(app, Some(s("撤销", "Undo")))?;
    let redo = PredefinedMenuItem::redo(app, Some(s("重做", "Redo")))?;
    let sep_edit = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, Some(s("剪切", "Cut")))?;
    let copy = PredefinedMenuItem::copy(app, Some(s("复制", "Copy")))?;
    let paste = PredefinedMenuItem::paste(app, Some(s("粘贴", "Paste")))?;
    let select_all = PredefinedMenuItem::select_all(app, Some(s("全选", "Select All")))?;
    let edit_menu = Submenu::with_items(
        app,
        s("编辑", "Edit"),
        true,
        &[&undo, &redo, &sep_edit, &cut, &copy, &paste, &select_all],
    )?;

    // ---- 视图：本应用真正能切换的几样 + 终端字号 + 全屏 ----
    let theme = MenuItem::with_id(
        app,
        "toggle-theme",
        s("明暗主题", "Light / Dark Theme"),
        true,
        Some("CmdOrCtrl+Shift+D"),
    )?;
    let locale = MenuItem::with_id(
        app,
        "toggle-locale",
        s("切换语言", "Switch Language"),
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let sep_view1 = PredefinedMenuItem::separator(app)?;
    // 字号快捷键：⌘= / ⌘- / ⌘0（⌘+ 这种带 Shift 的组合由前端 keydown 兜底，
    // macOS 菜单等价键匹配不到 Shift 变体）
    let font_in = MenuItem::with_id(
        app,
        "font-in",
        s("放大字体", "Increase Font Size"),
        true,
        Some("CmdOrCtrl+="),
    )?;
    let font_out = MenuItem::with_id(
        app,
        "font-out",
        s("缩小字体", "Decrease Font Size"),
        true,
        Some("CmdOrCtrl+-"),
    )?;
    let font_reset = MenuItem::with_id(
        app,
        "font-reset",
        s("重置字号", "Reset Font Size"),
        true,
        Some("CmdOrCtrl+0"),
    )?;
    // 光标样式：三选一，打勾项由当前样式决定
    let cur_bar = CheckMenuItem::with_id(
        app,
        "cursor-bar",
        s("竖线", "Bar"),
        true,
        cursor == "bar",
        None::<&str>,
    )?;
    let cur_block = CheckMenuItem::with_id(
        app,
        "cursor-block",
        s("方块", "Block"),
        true,
        cursor == "block",
        None::<&str>,
    )?;
    let cur_underline = CheckMenuItem::with_id(
        app,
        "cursor-underline",
        s("下划线", "Underline"),
        true,
        cursor == "underline",
        None::<&str>,
    )?;
    let cursor_menu = Submenu::with_items(
        app,
        s("光标样式", "Cursor Style"),
        true,
        &[&cur_bar, &cur_block, &cur_underline],
    )?;
    let sep_view2 = PredefinedMenuItem::separator(app)?;
    let sftp = MenuItem::with_id(
        app,
        "open-sftp",
        s("文件浏览器", "File Browser"),
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let sep_view3 = PredefinedMenuItem::separator(app)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, Some(s("全屏", "Full Screen")))?;
    let view_menu = Submenu::with_items(
        app,
        s("视图", "View"),
        true,
        &[
            &theme,
            &locale,
            &sep_view1,
            &font_in,
            &font_out,
            &font_reset,
            &cursor_menu,
            &sep_view2,
            &sftp,
            &sep_view3,
            &fullscreen,
        ],
    )?;

    // ---- 窗口：只有最小化与缩放（关窗交给交通灯，⌘W 已分配给关页签）----
    let minimize = PredefinedMenuItem::minimize(app, Some(s("最小化", "Minimize")))?;
    let maximize = PredefinedMenuItem::maximize(app, Some(s("缩放", "Zoom")))?;
    let window_menu = Submenu::with_items(
        app,
        s("窗口", "Window"),
        true,
        &[&minimize, &maximize],
    )?;

    // macOS 第一项固定是应用菜单（关于/隐藏/退出）；其他平台没有这种约定，不塞这些项
    #[cfg(target_os = "macos")]
    {
        let about = PredefinedMenuItem::about(app, Some(s("关于 NanoSSH", "About NanoSSH")), None)?;
        let sep_app1 = PredefinedMenuItem::separator(app)?;
        let hide = PredefinedMenuItem::hide(app, Some(s("隐藏 NanoSSH", "Hide NanoSSH")))?;
        let hide_others = PredefinedMenuItem::hide_others(app, Some(s("隐藏其他", "Hide Others")))?;
        let show_all = PredefinedMenuItem::show_all(app, Some(s("显示全部", "Show All")))?;
        let sep_app2 = PredefinedMenuItem::separator(app)?;
        let quit = PredefinedMenuItem::quit(app, Some(s("退出 NanoSSH", "Quit NanoSSH")))?;
        let app_menu = Submenu::with_items(
            app,
            "NanoSSH",
            true,
            &[&about, &sep_app1, &hide, &hide_others, &show_all, &sep_app2, &quit],
        )?;
        Menu::with_items(
            app,
            &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &window_menu])
    }
}
