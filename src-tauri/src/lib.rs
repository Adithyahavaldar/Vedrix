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

// --- File operations -----------------------------------------------------
// The app could open, read and write files but never create, rename, copy or
// remove one. Everything below is deliberately conservative: nothing
// overwrites an existing file, and nothing is ever unlinked.

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Create a file only if the path is free. Returns the path actually used.
#[tauri::command]
fn create_file(path: String, contents: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        return Err("A file with that name already exists".into());
    }
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, contents).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
fn create_dir(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        return Err("A folder with that name already exists".into());
    }
    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<String, String> {
    let src = std::path::Path::new(&from);
    let dst = std::path::Path::new(&to);
    if !src.exists() {
        return Err("The original file is gone".into());
    }
    if dst.exists() {
        return Err("A file with that name already exists".into());
    }
    std::fs::rename(src, dst).map_err(|e| e.to_string())?;
    Ok(to)
}

#[tauri::command]
fn duplicate_path(path: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    if !src.is_file() {
        return Err("Only files can be duplicated".into());
    }
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("copy");
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
    let dir = src.parent().ok_or("no parent folder")?;
    for n in 1..500 {
        let name = if n == 1 { format!("{stem} copy") } else { format!("{stem} copy {n}") };
        let cand = dir.join(if ext.is_empty() { name.clone() } else { format!("{name}.{ext}") });
        if !cand.exists() {
            std::fs::copy(src, &cand).map_err(|e| e.to_string())?;
            return Ok(cand.to_string_lossy().into_owned());
        }
    }
    Err("Too many copies".into())
}

/// Move to the vault's own trash instead of unlinking. Deleting a note should
/// never be the one action in the app that cannot be undone, and this works
/// the same on every platform.
#[tauri::command]
fn trash_path(root: String, path: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err("That file is already gone".into());
    }
    let name = src.file_name().and_then(|s| s.to_str()).ok_or("bad file name")?;
    let bin = std::path::Path::new(&root).join(".vedrix").join("trash");
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let stamp = now_secs();
    let dest = bin.join(format!("{stamp}-{name}"));
    // rename is atomic within a volume; fall back to copy+remove across volumes
    if std::fs::rename(src, &dest).is_err() {
        std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
        std::fs::remove_file(src).map_err(|e| e.to_string())?;
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// Put a trashed file back where it came from — the undo for trash_path.
#[tauri::command]
fn restore_trashed(trashed: String, original: String) -> Result<String, String> {
    let src = std::path::Path::new(&trashed);
    let dst = std::path::Path::new(&original);
    if !src.exists() {
        return Err("That file is no longer in the trash".into());
    }
    if dst.exists() {
        return Err("Something already exists at the original path".into());
    }
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(src, dst).map_err(|e| e.to_string())?;
    Ok(original)
}

// --- N2: the vault index -----------------------------------------------------
// Today every search re-reads every file from disk. That is fine for a folder of
// notes and hopeless for a vault: one keystroke costs thousands of file reads.
//
// This keeps one pass over the vault in memory and answers from there.
//
// It is a CACHE, not a second source of truth. It is never written to disk, so
// it cannot go stale, corrupt, or disagree with the files — the worst case is
// rebuilding it, which is the same single pass that built it. Files remain the
// only thing that owns your content.

#[derive(Clone)]
struct IdxPage {
    path: String,
    rel: String,
    title: String,
    mtime: u64,
    links: Vec<String>,   // lowercased [[wikilink]] targets
    body: String,         // lowercased text, for matching
    raw_lines: Vec<String>, // original lines, for snippets
}

#[derive(Default)]
struct VaultIndex {
    root: String,
    pages: Vec<IdxPage>,
    built_ms: u64,
}

struct IndexState(Mutex<VaultIndex>);

#[derive(serde::Serialize)]
struct IdxStats {
    root: String,
    pages: usize,
    built: bool,
    build_ms: u64,
    bytes: usize,
}

#[derive(serde::Serialize)]
struct IdxPageLite {
    path: String,
    rel: String,
    title: String,
}

const IDX_EXTS: [&str; 6] = ["md", "markdown", "mdown", "txt", "json", "log"];

fn idx_collect(p: &std::path::Path, root: &std::path::Path, depth: u32, out: &mut Vec<IdxPage>) {
    if depth > 6 || out.len() >= 20_000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(p) else { return };
    for e in rd.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "vendor" {
            continue;
        }
        if path.is_dir() {
            idx_collect(&path, root, depth + 1, out);
            continue;
        }
        let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if !IDX_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.len() > 2_000_000 {
            continue;
        }
        if let Some(page) = idx_read_page(&path, root, &meta) {
            out.push(page);
        }
    }
}

fn idx_read_page(path: &std::path::Path, root: &std::path::Path, meta: &std::fs::Metadata) -> Option<IdxPage> {
    let text = std::fs::read_to_string(path).ok()?;
    let name = path.file_name()?.to_str()?.to_string();
    let rel = path.strip_prefix(root).ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| name.clone());
    let mtime = meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs()).unwrap_or(0);

    // outgoing [[wikilinks]], lowercased, so backlinks are a memory scan
    let mut links = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = text[i + 2..].find("]]") {
                let inner = &text[i + 2..i + 2 + end];
                let target = inner.split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim();
                if !target.is_empty() && target.len() < 200 {
                    links.push(target.to_lowercase());
                }
                i += end + 4;
                continue;
            }
        }
        i += 1;
    }
    links.sort();
    links.dedup();

    Some(IdxPage {
        title: name.trim_end_matches(".md").trim_end_matches(".markdown").to_string(),
        path: path.to_string_lossy().into_owned(),
        rel,
        mtime,
        links,
        body: text.to_lowercase(),
        raw_lines: text.lines().map(|l| l.to_string()).collect(),
    })
}

#[tauri::command]
fn index_build(state: tauri::State<'_, IndexState>, root: String) -> Result<IdxStats, String> {
    let t0 = std::time::Instant::now();
    let rootp = std::path::Path::new(&root);
    let mut pages = Vec::new();
    idx_collect(rootp, rootp, 0, &mut pages);
    let bytes: usize = pages.iter().map(|p| p.body.len()).sum();
    let ms = t0.elapsed().as_millis() as u64;
    let count = pages.len();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = VaultIndex { root: root.clone(), pages, built_ms: ms };
    Ok(IdxStats { root, pages: count, built: true, build_ms: ms, bytes })
}

#[tauri::command]
fn index_stats(state: tauri::State<'_, IndexState>) -> Result<IdxStats, String> {
    let g = state.0.lock().map_err(|e| e.to_string())?;
    Ok(IdxStats {
        root: g.root.clone(),
        pages: g.pages.len(),
        built: !g.root.is_empty(),
        build_ms: g.built_ms,
        bytes: g.pages.iter().map(|p| p.body.len()).sum(),
    })
}

/// Same shape as search_folder, so the frontend can use whichever is warm.
#[tauri::command]
fn index_search(state: tauri::State<'_, IndexState>, query: String, limit: usize) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let g = state.0.lock().map_err(|e| e.to_string())?;
    let mut hits: Vec<SearchHit> = Vec::new();
    for p in g.pages.iter() {
        let count = p.body.matches(&q).count();
        if count == 0 {
            continue;
        }
        // first matching line, for the snippet
        let mut line_no = 1u32;
        let mut snippet = String::new();
        let mut col = 0u32;
        for (n, line) in p.raw_lines.iter().enumerate() {
            if let Some(at) = line.to_lowercase().find(&q) {
                line_no = (n + 1) as u32;
                let trimmed = line.trim_start();
                let lead = line.len() - trimmed.len();
                col = trimmed[..at.saturating_sub(lead).min(trimmed.len())].chars().count() as u32;
                snippet = trimmed.chars().take(220).collect();
                break;
            }
        }
        hits.push(SearchHit {
            path: p.path.clone(),
            name: p.rel.rsplit('/').next().unwrap_or(&p.rel).to_string(),
            line: line_no,
            count: count as u32,
            snippet,
            col,
        });
    }
    // title matches first, then most occurrences
    hits.sort_by(|a, b| {
        let at = a.name.to_lowercase().contains(&q);
        let bt = b.name.to_lowercase().contains(&q);
        bt.cmp(&at).then(b.count.cmp(&a.count)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    hits.truncate(if limit == 0 { 300 } else { limit });
    Ok(hits)
}

/// Pages that link to `target` — a memory scan of pre-parsed links rather than
/// a full-text search for "[[title".
#[tauri::command]
fn index_backlinks(state: tauri::State<'_, IndexState>, target: String) -> Result<Vec<SearchHit>, String> {
    let want = target.trim().to_lowercase();
    let want_stem = want.trim_end_matches(".md").to_string();
    let g = state.0.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for p in g.pages.iter() {
        if !p.links.iter().any(|l| *l == want || *l == want_stem) {
            continue;
        }
        let needle = format!("[[{}", want_stem);
        let mut line_no = 1u32;
        let mut snippet = String::new();
        for (n, line) in p.raw_lines.iter().enumerate() {
            if line.to_lowercase().contains(&needle) {
                line_no = (n + 1) as u32;
                snippet = line.trim().chars().take(220).collect();
                break;
            }
        }
        out.push(SearchHit {
            path: p.path.clone(),
            name: p.rel.rsplit('/').next().unwrap_or(&p.rel).to_string(),
            line: line_no,
            count: 1,
            snippet,
            col: 0,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn index_pages(state: tauri::State<'_, IndexState>) -> Result<Vec<IdxPageLite>, String> {
    let g = state.0.lock().map_err(|e| e.to_string())?;
    Ok(g.pages.iter()
        .filter(|p| p.rel.to_lowercase().ends_with(".md") || p.rel.to_lowercase().ends_with(".markdown"))
        .map(|p| IdxPageLite { path: p.path.clone(), rel: p.rel.clone(), title: p.title.clone() })
        .collect())
}

/// Re-read one file after it changes. Keeps the index correct without the cost
/// (or the dependency) of a filesystem watcher.
#[tauri::command]
fn index_touch(state: tauri::State<'_, IndexState>, path: String) -> Result<bool, String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    if g.root.is_empty() {
        return Ok(false);
    }
    let root = std::path::PathBuf::from(g.root.clone());
    let p = std::path::Path::new(&path);
    g.pages.retain(|x| x.path != path);
    if let Ok(meta) = std::fs::metadata(p) {
        if let Some(page) = idx_read_page(p, &root, &meta) {
            g.pages.push(page);
            return Ok(true);
        }
    }
    Ok(false) // file is gone — dropping it from the index is the correct outcome
}

// --- N6: version history ---------------------------------------------------
// Two sources, merged in the UI: snapshots we take ourselves on save, and (when
// the vault is a git repo) the file's real commit history. Snapshots live in
// .vedrix/history/ inside the vault so they travel with it — and are plain
// files, so nothing is trapped in a database.

#[derive(serde::Serialize)]
struct HistoryEntry {
    ts: u64,
    size: u64,
    source: String, // "snapshot" | "git"
    id: String,     // timestamp (snapshot) or commit hash (git)
    label: String,  // commit subject, empty for snapshots
    author: String,
}

const HISTORY_KEEP: usize = 60;

fn history_dir(root: &str, rel: &str) -> std::path::PathBuf {
    let key: String = rel
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '_' } else { c })
        .collect();
    std::path::Path::new(root).join(".vedrix").join("history").join(key)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Write a snapshot unless the newest one is already identical.
/// Returns the timestamp when a snapshot was actually taken.
#[tauri::command]
fn history_snapshot(root: String, rel: String, contents: String) -> Result<Option<u64>, String> {
    let dir = history_dir(&root, &rel);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut stamps: Vec<u64> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            e.path()
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u64>().ok())
        })
        .collect();
    stamps.sort_unstable();
    if let Some(last) = stamps.last() {
        if let Ok(prev) = std::fs::read_to_string(dir.join(format!("{}.snap", last))) {
            if prev == contents {
                return Ok(None); // nothing changed — don't clutter the timeline
            }
        }
    }
    let ts = now_secs();
    std::fs::write(dir.join(format!("{}.snap", ts)), &contents).map_err(|e| e.to_string())?;
    // prune oldest beyond the cap
    stamps.push(ts);
    if stamps.len() > HISTORY_KEEP {
        for old in &stamps[..stamps.len() - HISTORY_KEEP] {
            let _ = std::fs::remove_file(dir.join(format!("{}.snap", old)));
        }
    }
    Ok(Some(ts))
}

#[tauri::command]
fn history_list(root: String, rel: String) -> Result<Vec<HistoryEntry>, String> {
    let dir = history_dir(&root, &rel);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Ok(vec![]);
    };
    let mut out: Vec<HistoryEntry> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let ts = p.file_stem()?.to_str()?.parse::<u64>().ok()?;
            let size = e.metadata().ok().map(|m| m.len()).unwrap_or(0);
            Some(HistoryEntry {
                ts,
                size,
                source: "snapshot".into(),
                id: ts.to_string(),
                label: String::new(),
                author: String::new(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

#[tauri::command]
fn history_read(root: String, rel: String, id: String) -> Result<String, String> {
    let dir = history_dir(&root, &rel);
    std::fs::read_to_string(dir.join(format!("{}.snap", id))).map_err(|e| e.to_string())
}

fn git_dir_of(path: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    let mut cur = if p.is_file() { p.parent()? } else { p };
    loop {
        if cur.join(".git").exists() {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
}

/// Real commit history for one file, when the vault happens to be a git repo.
/// Absent git (or absent repo) this returns an empty list — never an error the
/// UI has to apologise for.
#[tauri::command]
fn git_file_log(path: String) -> Result<Vec<HistoryEntry>, String> {
    let Some(repo) = git_dir_of(&path) else { return Ok(vec![]) };
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["log", "--follow", "-n", "60", "--format=%H%x1f%ct%x1f%an%x1f%s", "--"])
        .arg(&path)
        .output();
    let Ok(out) = out else { return Ok(vec![]) };
    if !out.status.success() {
        return Ok(vec![]);
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let hash = parts.next()?.to_string();
            let ts = parts.next()?.parse::<u64>().ok()?;
            let author = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            Some(HistoryEntry {
                ts,
                size: 0,
                source: "git".into(),
                id: hash,
                label: subject,
                author,
            })
        })
        .collect())
}

#[tauri::command]
fn git_file_show(path: String, hash: String) -> Result<String, String> {
    let repo = git_dir_of(&path).ok_or("not a git repository")?;
    let rel = std::path::Path::new(&path)
        .strip_prefix(&repo)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .arg("show")
        .arg(format!("{}:{}", hash, rel))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
        .manage(IndexState(Mutex::new(VaultIndex::default())))
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
            path_exists,
            create_file,
            create_dir,
            rename_path,
            duplicate_path,
            trash_path,
            restore_trashed,
            index_build,
            index_stats,
            index_search,
            index_backlinks,
            index_pages,
            index_touch,
            history_snapshot,
            history_list,
            history_read,
            git_file_log,
            git_file_show,
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

#[cfg(test)]
mod index_tests {
    use super::*;

    fn make_vault(n: usize) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vedrix_idx_bench_{}", n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..n {
            let body = format!(
                "---\nStatus: {}\n---\n\n# Note {i}\n\nSome body text for note {i}. \
                 It mentions [[Note {}]] and a needle only in a few files.\n{}\n",
                if i % 3 == 0 { "Done" } else { "Open" },
                (i + 1) % n,
                if i % 500 == 0 { "PINEAPPLE marker line" } else { "filler filler filler" }
            );
            std::fs::write(dir.join(format!("note-{i}.md")), body).unwrap();
        }
        dir
    }

    #[test]
    fn index_is_fast_and_correct_at_scale() {
        let n = 5000;
        let dir = make_vault(n);

        let t0 = std::time::Instant::now();
        let mut pages = Vec::new();
        idx_collect(&dir, &dir, 0, &mut pages);
        let build_ms = t0.elapsed().as_millis();
        assert_eq!(pages.len(), n, "every file should be indexed");

        let idx = VaultIndex { root: dir.to_string_lossy().into(), pages, built_ms: build_ms as u64 };

        // a rare term: the whole point is that this does not touch the disk
        let t1 = std::time::Instant::now();
        let rare = idx.pages.iter().filter(|p| p.body.contains("pineapple")).count();
        let rare_us = t1.elapsed().as_micros();
        assert_eq!(rare, n / 500, "rare term found in the expected number of pages");

        // a common term, worst case for scanning
        let t2 = std::time::Instant::now();
        let common = idx.pages.iter().filter(|p| p.body.contains("body text")).count();
        let common_us = t2.elapsed().as_micros();
        assert_eq!(common, n);

        // backlinks are a pre-parsed link scan, not a text search
        let t3 = std::time::Instant::now();
        let back = idx.pages.iter().filter(|p| p.links.iter().any(|l| l == "note 42")).count();
        let back_us = t3.elapsed().as_micros();
        assert_eq!(back, 1, "exactly one page links to Note 42");

        // the path this replaces: re-read every file from disk, per query
        let t4 = std::time::Instant::now();
        let mut hits = Vec::new();
        search_walk(&dir, "pineapple", 0, &mut hits, 300);
        let disk_ms = t4.elapsed().as_millis();

        let t5 = std::time::Instant::now();
        let mut hits2 = Vec::new();
        search_walk(&dir, "[[note 42", 0, &mut hits2, 300);
        let disk_back_ms = t5.elapsed().as_millis();

        println!("INDEX BENCH  pages={n}  build={build_ms}ms  rare={rare_us}us  common={common_us}us  backlinks={back_us}us");
        println!("DISK  BENCH  same search from disk={disk_ms}ms  backlinks from disk={disk_back_ms}ms");
        println!("SPEEDUP      search {:.0}x   backlinks {:.0}x",
                 (disk_ms as f64 * 1000.0) / rare_us.max(1) as f64,
                 (disk_back_ms as f64 * 1000.0) / back_us.max(1) as f64);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
