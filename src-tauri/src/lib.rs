use std::sync::Mutex;
#[cfg(desktop)]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// Path delivered by macOS (file association / "Open With") before the
/// webview was ready to receive events. The frontend collects it on load.
struct PendingFile(Mutex<Option<String>>);

#[derive(serde::Serialize)]
struct MdFile {
    text: String,
    mtime: u64,
    path: String,
    name: String,
}

fn mtime_ms(path: &str) -> Result<u64, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta.modified().map_err(|e| e.to_string())?;
    Ok(modified
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64)
}

#[tauri::command]
fn read_md_file(path: String) -> Result<MdFile, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mtime = mtime_ms(&path)?;
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Ok(MdFile { text, mtime, path, name })
}

#[tauri::command]
fn stat_md_file(path: String) -> Result<u64, String> {
    mtime_ms(&path)
}

#[tauri::command]
fn take_pending_file(state: tauri::State<'_, PendingFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<u64, String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    mtime_ms(&path)
}

/// Binary file write (e.g. canvas PNG export). Text goes through write_file.
#[tauri::command]
fn write_bytes(path: String, contents: Vec<u8>) -> Result<u64, String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    mtime_ms(&path)
}

/// Open the native print panel (WKWebView ignores window.print(), so the
/// frontend calls this instead; "Save as PDF" lives in that panel).
#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.print().map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("printing is not supported on this platform".into())
    }
}

/// Mobile fallback for exports: Android has no native save dialog, so write
/// into a reachable app directory and tell the frontend where it went.
#[tauri::command]
fn save_export(app: tauri::AppHandle, filename: String, contents: String) -> Result<String, String> {
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Path to the library sidecar (projects/tags), in the OS app-data dir.
/// Keyed by file path; never written into the user's documents.
fn library_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.json"))
}

#[tauri::command]
fn read_library(app: tauri::AppHandle) -> Result<String, String> {
    let p = library_path(&app)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_library(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let p = library_path(&app)?;
    std::fs::write(&p, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn diag(msg: String) {
    use std::io::Write;
    println!("MVDIAG {}", msg); // routed to logcat on Android
    let path = std::env::temp_dir().join("mv-diag.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", msg);
    }
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    dir: bool,
    children: Vec<DirEntry>,
}

const TREE_EXTS: [&str; 12] = [
    "md", "markdown", "mdown", "pdf", "docx", "pptx", "xlsx", "xls", "csv", "txt", "json", "log",
];

fn walk_dir(p: &std::path::Path, depth: u32) -> Vec<DirEntry> {
    let mut out = vec![];
    if depth > 6 {
        return out;
    }
    let Ok(rd) = std::fs::read_dir(p) else { return out };
    let mut items: Vec<_> = rd.flatten().collect();
    items.sort_by_key(|e| (!e.path().is_dir(), e.file_name().to_ascii_lowercase()));
    for e in items {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "vendor" {
            continue;
        }
        if path.is_dir() {
            let children = walk_dir(&path, depth + 1);
            if !children.is_empty() {
                out.push(DirEntry {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    dir: true,
                    children,
                });
            }
        } else {
            let ext = path
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if TREE_EXTS.contains(&ext.as_str()) {
                out.push(DirEntry {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    dir: false,
                    children: vec![],
                });
            }
        }
    }
    out
}

#[tauri::command]
fn list_dir_tree(path: String) -> Result<Vec<DirEntry>, String> {
    Ok(walk_dir(std::path::Path::new(&path), 0))
}

// --- Folder-as-database scan (N3) ---
// One row per .md file directly inside the folder. Only the frontmatter block
// travels to the frontend — a 200-row database must not ship 200 whole
// documents across the IPC boundary just to draw a table.
#[derive(serde::Serialize)]
struct DbRow {
    path: String,
    name: String,
    mtime: u64,
    fm: String, // raw frontmatter block, "" when the file has none
}

fn head_frontmatter(text: &str) -> String {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !(t.starts_with("---\n") || t.starts_with("---\r\n")) {
        return String::new();
    }
    let after = t.find('\n').map(|i| i + 1).unwrap_or(0);
    let mut idx = after;
    for line in t[after..].split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed == "---" || trimmed == "..." {
            return t[..idx + line.len()].to_string();
        }
        idx += line.len();
    }
    String::new() // unterminated block — treat as no frontmatter
}

#[tauri::command]
fn scan_db(folder: String) -> Result<Vec<DbRow>, String> {
    let dir = std::path::Path::new(&folder);
    let rd = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "md" {
            continue;
        }
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // '_' is reserved for the schema file and templates; '.' for hidden
        if name.starts_with('_') || name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.len() > 4_000_000 {
            continue;
        }
        let content = std::fs::read_to_string(&p).unwrap_or_default();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(DbRow {
            path: p.to_string_lossy().to_string(),
            name,
            mtime,
            fm: head_frontmatter(&content),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// --- Vault-wide content search (native = fast, non-blocking) ---
#[derive(serde::Serialize)]
struct SearchHit {
    path: String,
    name: String,
    line: u32,       // 1-indexed line of the first match in the file
    count: u32,      // total matches in the file
    snippet: String, // the matching line, trimmed
    col: u32,        // 0-indexed byte offset of the match within the snippet
}

// Only text-like files are grep-able; binary formats (pdf/docx/…) are skipped.
const SEARCH_EXTS: [&str; 9] = ["md", "markdown", "mdown", "txt", "json", "log", "csv", "html", "htm"];

fn search_walk(p: &std::path::Path, q: &str, depth: u32, out: &mut Vec<SearchHit>, cap: usize) {
    if depth > 6 || out.len() >= cap {
        return;
    }
    let Ok(rd) = std::fs::read_dir(p) else { return };
    let mut items: Vec<_> = rd.flatten().collect();
    items.sort_by_key(|e| (!e.path().is_dir(), e.file_name().to_ascii_lowercase()));
    for e in items {
        if out.len() >= cap {
            return;
        }
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "vendor" {
            continue;
        }
        if path.is_dir() {
            search_walk(&path, q, depth + 1, out, cap);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !SEARCH_EXTS.contains(&ext.as_str()) {
            continue;
        }
        // skip anything over ~2 MB — huge files aren't what folks search for
        if e.metadata().map(|m| m.len() > 2_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let mut count = 0u32;
        let mut first: Option<(u32, String, u32)> = None;
        for (i, raw) in text.lines().enumerate() {
            let trimmed = raw.trim_start();
            let tl = trimmed.to_lowercase();
            if let Some(byte) = tl.find(q) {
                count += 1;
                if first.is_none() {
                    // char offset (not byte) so highlights line up with accented text
                    let col = tl[..byte].chars().count() as u32;
                    let snip: String = trimmed.chars().take(200).collect();
                    first = Some((i as u32 + 1, snip, col));
                }
            }
        }
        if let Some((line, snippet, col)) = first {
            out.push(SearchHit {
                path: path.to_string_lossy().into_owned(),
                name,
                line,
                count,
                snippet,
                col,
            });
        }
    }
}

#[tauri::command]
fn search_folder(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let mut hits = Vec::new();
    search_walk(std::path::Path::new(&root), &q, 0, &mut hits, 300);
    // most matches first, then alphabetical
    hits.sort_by(|a, b| b.count.cmp(&a.count).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(hits)
}

#[derive(serde::Serialize)]
struct AiHttpResp {
    status: u16,
    body: String,
}

/// Proxy an AI provider request through Rust — bypasses browser CORS and macOS
/// ATS (so http://localhost Ollama/LM Studio work), and keeps keys out of any
/// page context. Works with any provider (Anthropic, OpenAI-compatible, local).
#[tauri::command]
async fn ai_fetch(
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: String,
) -> Result<AiHttpResp, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).body(body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(AiHttpResp { status, body: text })
}

#[tauri::command]
fn open_externally(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &path]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&path);
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(PendingFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            read_md_file,
            stat_md_file,
            take_pending_file,
            read_file_bytes,
            write_file,
            write_bytes,
            search_folder,
            print_page,
            save_export,
            read_library,
            write_library,
            list_dir_tree,
            scan_db,
            open_externally,
            ai_fetch,
            diag
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ---- native menu bar (desktop only; mobile has no menu bar) ----
            #[cfg(desktop)]
            {
            let h = app.handle();
            let app_menu = Submenu::with_items(h, "Vedrix", true, &[
                &PredefinedMenuItem::about(h, None, Some(AboutMetadata::default()))?,
                &PredefinedMenuItem::separator(h)?,
                &MenuItem::with_id(h, "settings", "Settings…", true, Some("Cmd+,"))?,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::hide(h, None)?,
                &PredefinedMenuItem::hide_others(h, None)?,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::quit(h, None)?,
            ])?;
            let export_menu = Submenu::with_items(h, "Export", true, &[
                &MenuItem::with_id(h, "export-md", "As Markdown…", true, None::<&str>)?,
                &MenuItem::with_id(h, "export-html", "As HTML…", true, None::<&str>)?,
                &MenuItem::with_id(h, "export-csv", "As CSV…", true, None::<&str>)?,
                &PredefinedMenuItem::separator(h)?,
                &MenuItem::with_id(h, "print", "As PDF (via Print)…", true, None::<&str>)?,
            ])?;
            let file_menu = Submenu::with_items(h, "File", true, &[
                &MenuItem::with_id(h, "open", "Open…", true, Some("Cmd+O"))?,
                &MenuItem::with_id(h, "open-folder", "Open Folder…", true, Some("Cmd+Shift+O"))?,
                &PredefinedMenuItem::separator(h)?,
                &export_menu,
                &MenuItem::with_id(h, "print-doc", "Print…", true, Some("Cmd+P"))?,
                &PredefinedMenuItem::separator(h)?,
                &MenuItem::with_id(h, "close-tab", "Close Tab", true, Some("Cmd+W"))?,
            ])?;
            let edit_menu = Submenu::with_items(h, "Edit", true, &[
                &PredefinedMenuItem::undo(h, None)?,
                &PredefinedMenuItem::redo(h, None)?,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::cut(h, None)?,
                &PredefinedMenuItem::copy(h, None)?,
                &PredefinedMenuItem::paste(h, None)?,
                &PredefinedMenuItem::select_all(h, None)?,
                &PredefinedMenuItem::separator(h)?,
                &MenuItem::with_id(h, "find", "Find…", true, Some("Cmd+F"))?,
                &PredefinedMenuItem::separator(h)?,
                &MenuItem::with_id(h, "edit-mode", "Edit Document", true, Some("Cmd+E"))?,
            ])?;
            let view_menu = Submenu::with_items(h, "View", true, &[
                &MenuItem::with_id(h, "toggle-toc", "Toggle Sidebar", true, Some("Cmd+B"))?,
                &MenuItem::with_id(h, "mind-map", "Mind Map", true, Some("Cmd+M"))?,
                &MenuItem::with_id(h, "knowledge-graph", "Knowledge Graph", true, Some("Cmd+G"))?,
                &MenuItem::with_id(h, "ai-panel", "AI Assistant", true, Some("Cmd+J"))?,
                &PredefinedMenuItem::separator(h)?,
                &MenuItem::with_id(h, "zoom-in", "Zoom In", true, Some("Cmd+="))?,
                &MenuItem::with_id(h, "zoom-out", "Zoom Out", true, Some("Cmd+-"))?,
                &MenuItem::with_id(h, "zoom-fit", "Fit Width", true, Some("Cmd+0"))?,
                &PredefinedMenuItem::separator(h)?,
                &PredefinedMenuItem::fullscreen(h, None)?,
            ])?;
            let window_menu = Submenu::with_items(h, "Window", true, &[
                &PredefinedMenuItem::minimize(h, None)?,
                &PredefinedMenuItem::maximize(h, None)?,
            ])?;
            let help_menu = Submenu::with_items(h, "Help", true, &[
                &MenuItem::with_id(h, "shortcuts", "Keyboard Shortcuts", true, Some("Cmd+/"))?,
            ])?;
            let menu = Menu::with_items(h, &[
                &app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu,
            ])?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.clone());
            });
            }
            // Support `markdown-viewer <file>` from a terminal.
            if let Some(arg) = std::env::args().nth(1) {
                if std::path::Path::new(&arg).is_file() {
                    *app.state::<PendingFile>().0.lock().unwrap() = Some(arg);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS delivers double-clicked/"Open With" files as an Opened
            // event (Apple event), not argv. Stash the path for a fresh
            // launch AND emit for an already-running instance.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                if let Some(path) = urls.iter().filter_map(|u| u.to_file_path().ok()).next() {
                    let path = path.to_string_lossy().into_owned();
                    *app.state::<PendingFile>().0.lock().unwrap() = Some(path.clone());
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.emit("open-file", path);
                    }
                }
            }
        });
}
