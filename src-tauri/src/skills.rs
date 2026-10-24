//! Umiejętności (skille) AgentOS w formacie SKILL.md — zgodnym z Claude i Codex.
//! Wyszukiwanie w katalogach i na GitHubie, podgląd z analizą ryzyka,
//! instalacja globalna lub w projekcie, import z folderu, odczyt przez agenta.
//! Skrypty ze skilli nigdy nie są uruchamiane automatycznie.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::task::JoinSet;
use url::Url;
use walkdir::WalkDir;

const MANIFEST: &str = ".agentos-skill.json";
const PROJECT_DIRS: &[&str] = &[".agentos/skills", ".claude/skills", ".agents/skills"];
const MAX_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
const RATE: &str = "Wyczerpano limit zapytań GitHuba bez logowania. Spróbuj za kilka minut albo dodaj token GitHub (ekran Umiejętności → Źródła i token).";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    source: String,
    repo: String,
    git_ref: String,
    path: String,
    installed_at: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    key: String,
    scope: String,
    slug: String,
    name: String,
    description: String,
    dir: String,
    location: String,
    source: Option<String>,
    repo: Option<String>,
    git_ref: Option<String>,
    repo_path: Option<String>,
    file_count: usize,
    has_scripts: bool,
    removable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkill {
    repo: String,
    git_ref: String,
    dir: String,
    name: String,
    description: String,
    file_count: usize,
    total_bytes: u64,
    has_scripts: bool,
    url: String,
    origin: String,
}

#[derive(Clone)]
struct Blob {
    path: String,
    size: u64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------- SKILL.md ----------

pub fn parse_frontmatter(text: &str) -> (HashMap<String, String>, String) {
    let t = text.trim_start_matches('\u{feff}');
    let mut map = HashMap::new();
    if !t.starts_with("---") {
        return (map, t.to_string());
    }
    let rest = &t[3..];
    let Some(end) = rest.find("\n---") else { return (map, t.to_string()) };
    let header = &rest[..end];
    let after = &rest[end + 4..];
    let body = after.split_once('\n').map(|(_, b)| b).unwrap_or("").to_string();
    let mut current: Option<String> = None;
    for line in header.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(key) = &current {
                let entry = map.entry(key.clone()).or_insert_with(String::new);
                if !entry.is_empty() {
                    entry.push(' ');
                }
                entry.push_str(line.trim());
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_string();
            let mut value = value.trim().to_string();
            if matches!(value.as_str(), ">" | "|" | ">-" | "|-") {
                value.clear();
            }
            let value = value.trim_matches('"').trim_matches('\'').to_string();
            map.insert(key.clone(), value);
            current = Some(key);
        }
    }
    (map, body)
}

fn is_script(path: &str) -> bool {
    let lower = path.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    matches!(ext, "sh" | "bash" | "zsh" | "py" | "js" | "mjs" | "cjs" | "ts" | "rb" | "pl" | "ps1" | "applescript" | "scpt" | "command" | "php" | "lua")
        || lower.contains("/bin/")
}

fn safe_slug(raw: &str) -> String {
    let slug: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "skill".to_string() } else { slug.chars().take(64).collect() }
}

fn global_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills");
    fs::create_dir_all(&dir).map_err(|e| format!("Nie można utworzyć folderu umiejętności: {e}"))?;
    Ok(dir)
}

fn read_skill_dir(dir: &Path, scope: &str, location: &str, key: String, removable: bool) -> Option<InstalledSkill> {
    let skill_md = ["SKILL.md", "skill.md", "Skill.md"].iter().map(|n| dir.join(n)).find(|p| p.is_file())?;
    let text = fs::read_to_string(&skill_md).ok()?;
    let (fm, _) = parse_frontmatter(&text);
    let manifest: Option<Manifest> = fs::read(dir.join(MANIFEST)).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let slug = dir.file_name()?.to_string_lossy().to_string();
    let mut file_count = 0;
    let mut has_scripts = false;
    for entry in WalkDir::new(dir).max_depth(6).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).take(2000) {
        if entry.file_name() == MANIFEST {
            continue;
        }
        file_count += 1;
        if is_script(&entry.path().to_string_lossy()) {
            has_scripts = true;
        }
    }
    Some(InstalledSkill {
        key,
        scope: scope.to_string(),
        name: fm.get("name").filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| slug.clone()),
        description: fm.get("description").cloned().unwrap_or_default(),
        slug,
        dir: dir.to_string_lossy().to_string(),
        location: location.to_string(),
        source: manifest.as_ref().map(|m| m.source.clone()),
        repo: manifest.as_ref().map(|m| m.repo.clone()),
        git_ref: manifest.as_ref().map(|m| m.git_ref.clone()),
        repo_path: manifest.as_ref().map(|m| m.path.clone()),
        file_count,
        has_scripts,
        removable,
    })
}

fn child_dirs(base: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(base)
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(true)).collect())
        .unwrap_or_default();
    dirs.sort();
    dirs
}

/// Zainstalowane umiejętności: globalne i (jeśli podano) z folderu projektu.
#[tauri::command]
pub fn skill_list(app: tauri::AppHandle, project_path: Option<String>) -> Result<Vec<InstalledSkill>, String> {
    let mut out = Vec::new();
    for dir in child_dirs(&global_dir(&app)?) {
        let slug = dir.file_name().unwrap().to_string_lossy().to_string();
        if let Some(skill) = read_skill_dir(&dir, "global", "AgentOS", format!("global/{slug}"), true) {
            out.push(skill);
        }
    }
    if let Some(path) = project_path.filter(|p| !p.trim().is_empty()) {
        if let Ok(root) = fs::canonicalize(&path) {
            for location in PROJECT_DIRS {
                for dir in child_dirs(&root.join(location)) {
                    let slug = dir.file_name().unwrap().to_string_lossy().to_string();
                    if let Some(skill) = read_skill_dir(&dir, "project", location, format!("{location}/{slug}"), *location == ".agentos/skills") {
                        out.push(skill);
                    }
                }
            }
        }
    }
    Ok(out)
}

fn resolve_key(app: &tauri::AppHandle, project_path: &Option<String>, key: &str) -> Result<PathBuf, String> {
    let (prefix, slug) = key.rsplit_once('/').ok_or("Nieprawidłowy identyfikator umiejętności.")?;
    if slug.is_empty() || slug.starts_with('.') || slug.contains('\\') {
        return Err("Nieprawidłowa nazwa umiejętności.".to_string());
    }
    if prefix == "global" {
        return Ok(global_dir(app)?.join(slug));
    }
    if !PROJECT_DIRS.contains(&prefix) {
        return Err("Nieznane położenie umiejętności.".to_string());
    }
    let root = project_path.as_ref().filter(|p| !p.is_empty()).ok_or("Ta umiejętność należy do projektu, a rozmowa nie ma projektu.")?;
    let root = fs::canonicalize(root).map_err(|_| "Folder projektu jest niedostępny.".to_string())?;
    Ok(root.join(prefix).join(slug))
}

fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = base.to_path_buf();
    for c in Path::new(rel.trim()).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err("Ścieżka wychodzi poza folder umiejętności.".to_string()),
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContent {
    dir: String,
    content: String,
    files: Vec<String>,
}

/// Treść SKILL.md (albo innego pliku umiejętności) i lista jej plików.
#[tauri::command]
pub fn skill_read(app: tauri::AppHandle, project_path: Option<String>, key: String, file: Option<String>) -> Result<SkillContent, String> {
    let dir = resolve_key(&app, &project_path, &key)?;
    if !dir.is_dir() {
        return Err("Ta umiejętność nie jest już zainstalowana.".to_string());
    }
    let target = match file.as_deref().filter(|f| !f.trim().is_empty()) {
        Some(f) => safe_join(&dir, f)?,
        None => ["SKILL.md", "skill.md", "Skill.md"].iter().map(|n| dir.join(n)).find(|p| p.is_file()).ok_or("Brak pliku SKILL.md.")?,
    };
    let bytes = fs::read(&target).map_err(|_| "Nie ma takiego pliku w umiejętności.".to_string())?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err("To plik binarny — można go użyć poleceniem, ale nie odczytać jako tekst.".to_string());
    }
    let mut content = String::from_utf8_lossy(&bytes).to_string();
    if content.chars().count() > 60_000 {
        content = content.chars().take(60_000).collect::<String>() + "\n[… obcięto]";
    }
    let files = WalkDir::new(&dir)
        .max_depth(6)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.file_name() != MANIFEST)
        .take(300)
        .map(|e| e.path().strip_prefix(&dir).unwrap_or(e.path()).to_string_lossy().to_string())
        .collect();
    Ok(SkillContent { dir: dir.to_string_lossy().to_string(), content, files })
}

/// Usuwa umiejętność zainstalowaną przez AgentOS (globalnie lub w .agentos/skills).
#[tauri::command]
pub fn skill_remove(app: tauri::AppHandle, project_path: Option<String>, key: String) -> Result<(), String> {
    if !(key.starts_with("global/") || key.starts_with(".agentos/skills/")) {
        return Err("Tę umiejętność dodano spoza AgentOS — usuń jej folder ręcznie albo ją wyłącz.".to_string());
    }
    let dir = resolve_key(&app, &project_path, &key)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Nie udało się usunąć: {e}"))?;
    }
    Ok(())
}

// ---------- GitHub ----------

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent("AgentOS-skills/0.2")
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())
}

fn token() -> Option<String> {
    crate::get_provider_key("github").ok().flatten()
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        "Brak połączenia z GitHubem. Wyszukiwanie i pobieranie wymaga internetu — zainstalowane umiejętności działają bez niego.".to_string()
    } else {
        format!("Błąd sieci: {e}")
    }
}

async fn gh_json(client: &Client, url: &Url) -> Result<Value, String> {
    let mut req = client.get(url.clone()).header("accept", "application/vnd.github+json");
    if let Some(t) = token() {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(net_err)?;
    let status = resp.status();
    let remaining = resp.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()).map(str::to_string);
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let message = body["message"].as_str().unwrap_or("").to_string();
    match status.as_u16() {
        403 | 429 if remaining.as_deref() == Some("0") || message.to_lowercase().contains("rate limit") => Err(RATE.to_string()),
        401 => Err("Token GitHub jest nieprawidłowy albo wygasł.".to_string()),
        404 => Err("Nie znaleziono repozytorium albo ścieżki na GitHubie. Sprawdź adres — repozytoria prywatne wymagają tokenu.".to_string()),
        422 => Err("GitHub odrzucił zapytanie wyszukiwania. Spróbuj prostszych słów.".to_string()),
        code => Err(format!("GitHub zwrócił błąd {code}: {message}")),
    }
}

fn api_url(path: &str) -> Url {
    Url::parse(&format!("https://api.github.com/{path}")).expect("poprawny adres API")
}

fn raw_url(repo: &str, git_ref: &str, path: &str) -> Result<Url, String> {
    let mut u = Url::parse("https://raw.githubusercontent.com/").unwrap();
    {
        let mut seg = u.path_segments_mut().map_err(|_| "Błędny adres.".to_string())?;
        seg.clear();
        for part in repo.split('/') {
            seg.push(part);
        }
        for part in git_ref.split('/') {
            seg.push(part);
        }
        for part in path.split('/') {
            seg.push(part);
        }
    }
    Ok(u)
}

async fn raw_get(client: &Client, repo: &str, git_ref: &str, path: &str) -> Result<Vec<u8>, String> {
    let mut req = client.get(raw_url(repo, git_ref, path)?);
    if let Some(t) = token() {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(net_err)?;
    if !resp.status().is_success() {
        return Err(format!("Nie udało się pobrać {path} ({}).", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(net_err)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("Plik {path} jest zbyt duży."));
    }
    Ok(bytes.to_vec())
}

fn tree_cache() -> &'static Mutex<HashMap<String, (Instant, String, Arc<Vec<Blob>>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String, Arc<Vec<Blob>>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn md_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn repo_tree(client: &Client, repo: &str, want_ref: Option<String>) -> Result<(String, Arc<Vec<Blob>>), String> {
    let key = format!("{repo}@{}", want_ref.clone().unwrap_or_default());
    if let Some((at, r, b)) = tree_cache().lock().unwrap().get(&key).cloned() {
        if at.elapsed() < Duration::from_secs(600) {
            return Ok((r, b));
        }
    }
    let git_ref = match want_ref {
        Some(r) => r,
        None => {
            let info = gh_json(client, &api_url(&format!("repos/{repo}"))).await?;
            info["default_branch"].as_str().unwrap_or("main").to_string()
        }
    };
    let tree = gh_json(client, &api_url(&format!("repos/{repo}/git/trees/{git_ref}?recursive=1"))).await?;
    let blobs: Vec<Blob> = tree["tree"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|e| e["type"] == "blob")
                .filter_map(|e| Some(Blob { path: e["path"].as_str()?.to_string(), size: e["size"].as_u64().unwrap_or(0) }))
                .collect()
        })
        .unwrap_or_default();
    let blobs = Arc::new(blobs);
    tree_cache().lock().unwrap().insert(key, (Instant::now(), git_ref.clone(), blobs.clone()));
    Ok((git_ref, blobs))
}

fn valid_repo_part(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn parent_dir(path: &str) -> String {
    path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
}

/// Adres GitHub (repozytorium, folder, plik SKILL.md, raw) albo „właściciel/repo”.
pub fn parse_source(raw: &str) -> Result<(String, Option<String>, String), String> {
    let s = raw.trim().trim_end_matches('/');
    let err = || "Podaj adres GitHub, np. https://github.com/właściciel/repo albo link do folderu z plikiem SKILL.md.".to_string();
    let strip_skill = |p: String| if p.to_lowercase().ends_with("skill.md") { parent_dir(&p) } else { p };
    let (repo, git_ref, path) = if let Some(rest) = s.strip_prefix("https://raw.githubusercontent.com/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() < 3 {
            return Err(err());
        }
        (format!("{}/{}", parts[0], parts[1]), Some(parts[2].to_string()), strip_skill(parts[3..].join("/")))
    } else if let Some(rest) = ["https://github.com/", "http://github.com/", "github.com/", "https://www.github.com/"].iter().find_map(|p| s.strip_prefix(p)) {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() < 2 {
            return Err(err());
        }
        let repo = format!("{}/{}", parts[0], parts[1].trim_end_matches(".git"));
        if parts.len() >= 4 && (parts[2] == "tree" || parts[2] == "blob") {
            (repo, Some(parts[3].to_string()), strip_skill(parts[4..].join("/")))
        } else {
            (repo, None, String::new())
        }
    } else {
        let parts: Vec<&str> = s.split('/').collect();
        if parts.len() != 2 {
            return Err(err());
        }
        (format!("{}/{}", parts[0], parts[1]), None, String::new())
    };
    let mut it = repo.split('/');
    if !(it.next().map(valid_repo_part).unwrap_or(false) && it.next().map(valid_repo_part).unwrap_or(false)) {
        return Err(err());
    }
    Ok((repo, git_ref, path))
}

fn skill_dirs(blobs: &[Blob], sub: &str) -> Vec<String> {
    let mut dirs: Vec<String> = blobs
        .iter()
        .filter(|b| b.path.rsplit('/').next().map(|n| n.eq_ignore_ascii_case("skill.md")).unwrap_or(false))
        .map(|b| parent_dir(&b.path))
        .filter(|d| sub.is_empty() || d == sub || d.starts_with(&format!("{sub}/")))
        .filter(|d| !d.split('/').any(|p| p == "node_modules"))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    dirs.sort();
    dirs
}

fn files_under<'a>(blobs: &'a [Blob], dir: &str) -> Vec<&'a Blob> {
    blobs.iter().filter(|b| dir.is_empty() || b.path.starts_with(&format!("{dir}/"))).collect()
}

fn skill_md_path(blobs: &[Blob], dir: &str) -> Option<String> {
    files_under(blobs, dir)
        .into_iter()
        .find(|b| parent_dir(&b.path) == dir && b.path.rsplit('/').next().map(|n| n.eq_ignore_ascii_case("skill.md")).unwrap_or(false))
        .map(|b| b.path.clone())
}

async fn fetch_skill_md(client: &Client, repo: &str, git_ref: &str, path: &str) -> Result<String, String> {
    let key = format!("{repo}@{git_ref}:{path}");
    if let Some(text) = md_cache().lock().unwrap().get(&key).cloned() {
        return Ok(text);
    }
    let text = String::from_utf8_lossy(&raw_get(client, repo, git_ref, path).await?).to_string();
    md_cache().lock().unwrap().insert(key, text.clone());
    Ok(text)
}

async fn build_remote(client: Client, repo: String, git_ref: String, dir: String, blobs: Arc<Vec<Blob>>, origin: String) -> Option<RemoteSkill> {
    let md_path = skill_md_path(&blobs, &dir)?;
    let text = fetch_skill_md(&client, &repo, &git_ref, &md_path).await.ok()?;
    let (fm, _) = parse_frontmatter(&text);
    let files = files_under(&blobs, &dir);
    let fallback = if dir.is_empty() { repo.rsplit('/').next().unwrap_or("skill").to_string() } else { dir.rsplit('/').next().unwrap_or("skill").to_string() };
    Some(RemoteSkill {
        url: if dir.is_empty() { format!("https://github.com/{repo}") } else { format!("https://github.com/{repo}/tree/{git_ref}/{dir}") },
        name: fm.get("name").filter(|v| !v.is_empty()).cloned().unwrap_or(fallback),
        description: fm.get("description").cloned().unwrap_or_default(),
        file_count: files.len(),
        total_bytes: files.iter().map(|b| b.size).sum(),
        has_scripts: files.iter().any(|b| is_script(&b.path)),
        repo,
        git_ref,
        dir,
        origin,
    })
}

async fn build_many(client: &Client, repo: &str, git_ref: &str, dirs: Vec<String>, blobs: Arc<Vec<Blob>>, origin: &str) -> Vec<RemoteSkill> {
    let mut set = JoinSet::new();
    for dir in dirs.into_iter().take(150) {
        set.spawn(build_remote(client.clone(), repo.to_string(), git_ref.to_string(), dir, blobs.clone(), origin.to_string()));
    }
    let mut out = Vec::new();
    while let Some(result) = set.join_next().await {
        if let Ok(Some(skill)) = result {
            out.push(skill);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoHit {
    repo: String,
    description: String,
    stars: u64,
    url: String,
    updated: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    catalog: Vec<RemoteSkill>,
    community: Vec<RemoteSkill>,
    repos: Vec<RepoHit>,
    errors: Vec<String>,
    used_token: bool,
}

fn score(skill: &RemoteSkill, tokens: &[String]) -> usize {
    let hay = format!("{} {} {}", skill.name, skill.description, skill.dir).to_lowercase();
    tokens.iter().filter(|t| hay.contains(t.as_str())).count()
}

/// Szuka umiejętności w katalogach (źródłach) i — przy zapytaniu — na GitHubie.
#[tauri::command]
pub async fn skill_search(query: String, sources: Vec<String>) -> Result<SearchResult, String> {
    let client = client()?;
    let tokens: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_string).collect();
    let mut result = SearchResult { catalog: vec![], community: vec![], repos: vec![], errors: vec![], used_token: token().is_some() };
    for source in sources.iter().take(12) {
        match parse_source(source) {
            Ok((repo, want_ref, sub)) => match repo_tree(&client, &repo, want_ref).await {
                Ok((git_ref, blobs)) => {
                    let dirs = skill_dirs(&blobs, &sub);
                    let mut found = build_many(&client, &repo, &git_ref, dirs, blobs, "catalog").await;
                    if !tokens.is_empty() {
                        found.retain(|s| score(s, &tokens) > 0);
                        found.sort_by_key(|s| std::cmp::Reverse(score(s, &tokens)));
                    }
                    result.catalog.extend(found);
                }
                Err(e) => result.errors.push(format!("{repo}: {e}")),
            },
            Err(e) => result.errors.push(format!("{source}: {e}")),
        }
    }
    if tokens.is_empty() {
        return Ok(result);
    }
    let known: HashSet<String> = result.catalog.iter().map(|s| format!("{}/{}", s.repo, s.dir)).collect();
    if result.used_token {
        let url = Url::parse_with_params("https://api.github.com/search/code", &[("q", format!("{query} filename:SKILL.md")), ("per_page", "25".to_string())]).unwrap();
        match gh_json(&client, &url).await {
            Ok(body) => {
                let mut set = JoinSet::new();
                for item in body["items"].as_array().cloned().unwrap_or_default() {
                    let Some(repo) = item.pointer("/repository/full_name").and_then(Value::as_str).map(str::to_string) else { continue };
                    let Some(path) = item["path"].as_str().map(str::to_string) else { continue };
                    let git_ref = item["url"].as_str().and_then(|u| Url::parse(u).ok()).and_then(|u| u.query_pairs().find(|(k, _)| k == "ref").map(|(_, v)| v.to_string())).unwrap_or_else(|| "HEAD".to_string());
                    let dir = parent_dir(&path);
                    if known.contains(&format!("{repo}/{dir}")) {
                        continue;
                    }
                    let client = client.clone();
                    set.spawn(async move {
                        let text = fetch_skill_md(&client, &repo, &git_ref, &path).await.ok()?;
                        let (fm, _) = parse_frontmatter(&text);
                        Some(RemoteSkill {
                            url: format!("https://github.com/{repo}/blob/{git_ref}/{path}"),
                            name: fm.get("name").filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| dir.rsplit('/').next().unwrap_or("skill").to_string()),
                            description: fm.get("description").cloned().unwrap_or_default(),
                            file_count: 0,
                            total_bytes: 0,
                            has_scripts: false,
                            repo,
                            git_ref,
                            dir,
                            origin: "community".to_string(),
                        })
                    });
                }
                while let Some(r) = set.join_next().await {
                    if let Ok(Some(skill)) = r {
                        result.community.push(skill);
                    }
                }
            }
            Err(e) => result.errors.push(format!("Wyszukiwanie plików SKILL.md: {e}")),
        }
    }
    let url = Url::parse_with_params(
        "https://api.github.com/search/repositories",
        &[("q", format!("{query} skill")), ("sort", "stars".to_string()), ("order", "desc".to_string()), ("per_page", "12".to_string())],
    )
    .unwrap();
    match gh_json(&client, &url).await {
        Ok(body) => {
            for item in body["items"].as_array().cloned().unwrap_or_default() {
                result.repos.push(RepoHit {
                    repo: item["full_name"].as_str().unwrap_or_default().to_string(),
                    description: item["description"].as_str().unwrap_or_default().to_string(),
                    stars: item["stargazers_count"].as_u64().unwrap_or(0),
                    url: item["html_url"].as_str().unwrap_or_default().to_string(),
                    updated: item["pushed_at"].as_str().unwrap_or_default().chars().take(10).collect(),
                });
            }
        }
        Err(e) => result.errors.push(format!("Wyszukiwanie repozytoriów: {e}")),
    }
    Ok(result)
}

/// Znajduje wszystkie umiejętności pod podanym adresem.
#[tauri::command]
pub async fn skill_inspect(source: String) -> Result<Vec<RemoteSkill>, String> {
    let client = client()?;
    let (repo, want_ref, sub) = parse_source(&source)?;
    let (git_ref, blobs) = repo_tree(&client, &repo, want_ref).await?;
    let dirs = skill_dirs(&blobs, &sub);
    if dirs.is_empty() {
        return Err("Pod tym adresem nie ma pliku SKILL.md — to nie wygląda na umiejętność.".to_string());
    }
    Ok(build_many(&client, &repo, &git_ref, dirs, blobs, "url").await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    path: String,
    size: u64,
    script: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPreview {
    skill: RemoteSkill,
    content: String,
    files: Vec<PreviewFile>,
    risks: Vec<String>,
    blocked: Option<String>,
}

const RISK_PATTERNS: &[(&[&str], &str)] = &[
    (&["curl ", "wget "], "pobiera dane z internetu"),
    (&["| sh", "| bash", "|sh", "|bash", "| zsh"], "uruchamia pobrany kod w powłoce"),
    (&["rm -rf", "rm -fr"], "usuwa pliki rekursywnie"),
    (&["sudo "], "wymaga uprawnień administratora"),
    (&["~/.ssh", ".ssh/id_"], "odwołuje się do kluczy SSH"),
    (&["security find-", "keychain"], "odwołuje się do pęku kluczy macOS"),
    (&["osascript", "tell application"], "steruje aplikacjami macOS"),
    (&["base64 -d", "base64 --decode", "b64decode", "atob("], "dekoduje ukryte dane (base64)"),
    (&["eval(", "exec(", "os.system(", "subprocess"], "uruchamia polecenia lub dynamiczny kod"),
    (&["ignore previous instructions", "ignore all previous", "disregard previous", "zignoruj poprzednie"], "próbuje nadpisać instrukcje agenta"),
    (&["launchctl", "crontab", "loginitems"], "instaluje zadania działające w tle"),
    (&["chmod +x", "chmod 777"], "zmienia uprawnienia plików"),
    (&["api_key", "apikey", "access_token", "password"], "odwołuje się do kluczy lub haseł"),
];

fn scan_text(path: &str, text: &str, risks: &mut Vec<String>) {
    let mut seen = HashSet::new();
    for (number, line) in text.lines().enumerate() {
        let lower = line.to_lowercase();
        for (patterns, label) in RISK_PATTERNS {
            if patterns.iter().any(|p| lower.contains(p)) && seen.insert(*label) {
                risks.push(format!("{path}:{} — {label}", number + 1));
            }
        }
    }
}

/// Pełny podgląd jednej umiejętności przed instalacją: treść, pliki, ryzyka.
#[tauri::command]
pub async fn skill_preview(repo: String, git_ref: String, dir: String) -> Result<SkillPreview, String> {
    let client = client()?;
    let (git_ref, blobs) = repo_tree(&client, &repo, Some(git_ref)).await?;
    let md_path = skill_md_path(&blobs, &dir).ok_or("W tym folderze nie ma pliku SKILL.md.")?;
    let skill = build_remote(client.clone(), repo.clone(), git_ref.clone(), dir.clone(), blobs.clone(), "preview".to_string())
        .await
        .ok_or("Nie udało się odczytać SKILL.md.")?;
    let content = fetch_skill_md(&client, &repo, &git_ref, &md_path).await?;
    let files_all = files_under(&blobs, &dir);
    let total: u64 = files_all.iter().map(|b| b.size).sum();
    let blocked = if files_all.len() > MAX_FILES {
        Some(format!("Umiejętność ma {} plików (limit {MAX_FILES}). To raczej całe repozytorium niż pojedyncza umiejętność.", files_all.len()))
    } else if total > MAX_TOTAL_BYTES {
        Some(format!("Umiejętność zajmuje {:.1} MB (limit {} MB).", total as f64 / 1e6, MAX_TOTAL_BYTES / 1024 / 1024))
    } else if let Some(big) = files_all.iter().find(|b| b.size > MAX_FILE_BYTES) {
        Some(format!("Plik {} jest większy niż 5 MB.", big.path))
    } else {
        None
    };
    let mut risks = Vec::new();
    let strip = |p: &str| p.strip_prefix(&format!("{dir}/")).unwrap_or(p).to_string();
    scan_text(&strip(&md_path), &content, &mut risks);
    let mut to_scan: Vec<&Blob> = files_all.iter().copied().filter(|b| b.path != md_path && b.size < 300_000 && (is_script(&b.path) || b.path.ends_with(".md") || b.path.ends_with(".txt"))).collect();
    to_scan.sort_by_key(|b| !is_script(&b.path));
    let mut set = JoinSet::new();
    for blob in to_scan.into_iter().take(30) {
        let (client, repo, git_ref, path) = (client.clone(), repo.clone(), git_ref.clone(), blob.path.clone());
        set.spawn(async move { raw_get(&client, &repo, &git_ref, &path).await.ok().map(|b| (path, String::from_utf8_lossy(&b).to_string())) });
    }
    while let Some(r) = set.join_next().await {
        if let Ok(Some((path, text))) = r {
            scan_text(&strip(&path), &text, &mut risks);
        }
    }
    risks.truncate(40);
    let files = files_all.iter().map(|b| PreviewFile { path: strip(&b.path), size: b.size, script: is_script(&b.path) }).collect();
    Ok(SkillPreview { skill, content, files, risks, blocked })
}

fn target_base(app: &tauri::AppHandle, scope: &str, project_path: &Option<String>) -> Result<PathBuf, String> {
    if scope == "global" {
        return global_dir(app);
    }
    let root = project_path.as_ref().filter(|p| !p.is_empty()).ok_or("Wybierz projekt, aby zainstalować w nim umiejętność.")?;
    let root = fs::canonicalize(root).map_err(|_| "Folder projektu jest niedostępny.".to_string())?;
    let base = root.join(".agentos/skills");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn finish_install(staging: &Path, target: &Path, overwrite: bool) -> Result<(), String> {
    if target.exists() {
        if !overwrite {
            let _ = fs::remove_dir_all(staging);
            return Err("EXISTS: Umiejętność o tej nazwie jest już zainstalowana.".to_string());
        }
        fs::remove_dir_all(target).map_err(|e| format!("Nie udało się zastąpić poprzedniej wersji: {e}"))?;
    }
    fs::rename(staging, target).map_err(|e| format!("Nie udało się zakończyć instalacji: {e}"))
}

/// Pobiera umiejętność z GitHuba i instaluje ją globalnie albo w projekcie.
#[tauri::command]
pub async fn skill_install(
    app: tauri::AppHandle,
    repo: String,
    git_ref: String,
    dir: String,
    scope: String,
    project_path: Option<String>,
    overwrite: bool,
) -> Result<InstalledSkill, String> {
    let client = client()?;
    let (git_ref, blobs) = repo_tree(&client, &repo, Some(git_ref)).await?;
    skill_md_path(&blobs, &dir).ok_or("W tym folderze nie ma pliku SKILL.md.")?;
    let files: Vec<Blob> = files_under(&blobs, &dir).into_iter().cloned().collect();
    if files.len() > MAX_FILES || files.iter().map(|b| b.size).sum::<u64>() > MAX_TOTAL_BYTES || files.iter().any(|b| b.size > MAX_FILE_BYTES) {
        return Err("Umiejętność przekracza limity rozmiaru — instalacja wstrzymana.".to_string());
    }
    let base = target_base(&app, &scope, &project_path)?;
    let slug = safe_slug(if dir.is_empty() { repo.rsplit('/').next().unwrap_or("skill") } else { dir.rsplit('/').next().unwrap_or("skill") });
    let target = base.join(&slug);
    let staging = base.join(format!(".tmp-{slug}-{}", now_secs()));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let mut set = JoinSet::new();
    for blob in files {
        let rel = if dir.is_empty() { blob.path.clone() } else { blob.path.strip_prefix(&format!("{dir}/")).unwrap_or(&blob.path).to_string() };
        let (client, repo, git_ref) = (client.clone(), repo.clone(), git_ref.clone());
        set.spawn(async move { raw_get(&client, &repo, &git_ref, &blob.path).await.map(|bytes| (rel, bytes)) });
    }
    while let Some(result) = set.join_next().await {
        let outcome = result.map_err(|e| e.to_string()).and_then(|r| r).and_then(|(rel, bytes)| {
            let path = safe_join(&staging, &rel)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&path, bytes).map_err(|e| e.to_string())
        });
        if let Err(e) = outcome {
            set.abort_all();
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("Instalacja przerwana: {e}"));
        }
    }
    let manifest = Manifest {
        source: if dir.is_empty() { format!("https://github.com/{repo}") } else { format!("https://github.com/{repo}/tree/{git_ref}/{dir}") },
        repo,
        git_ref,
        path: dir,
        installed_at: now_secs(),
    };
    fs::write(staging.join(MANIFEST), serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    finish_install(&staging, &target, overwrite)?;
    let key = if scope == "global" { format!("global/{slug}") } else { format!(".agentos/skills/{slug}") };
    read_skill_dir(&target, if scope == "global" { "global" } else { "project" }, if scope == "global" { "AgentOS" } else { ".agentos/skills" }, key, true)
        .ok_or_else(|| "Zainstalowano, ale nie udało się odczytać SKILL.md.".to_string())
}

fn copy_skill_dir(source: &Path, staging: &Path) -> Result<(), String> {
    let mut count = 0usize;
    let mut total = 0u64;
    let walker = WalkDir::new(source).follow_links(false).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !(name == ".git" || name == "node_modules" || name == ".DS_Store" || name == "__pycache__")
    });
    for entry in walker.filter_map(Result::ok).filter(|e| e.file_type().is_file()) {
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        count += 1;
        total += size;
        if count > MAX_FILES || total > MAX_TOTAL_BYTES || size > MAX_FILE_BYTES {
            return Err(format!("Folder {} przekracza limity rozmiaru umiejętności.", source.display()));
        }
        let rel = entry.path().strip_prefix(source).map_err(|e| e.to_string())?;
        let dest = staging.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Importuje umiejętność (albo folder z wieloma umiejętnościami) z dysku.
#[tauri::command]
pub fn skill_import_local(app: tauri::AppHandle, path: String, scope: String, project_path: Option<String>, overwrite: bool) -> Result<Vec<InstalledSkill>, String> {
    let source = fs::canonicalize(&path).map_err(|_| "Wybrany folder nie istnieje.".to_string())?;
    let has_md = |p: &Path| ["SKILL.md", "skill.md", "Skill.md"].iter().any(|n| p.join(n).is_file());
    let candidates: Vec<PathBuf> = if has_md(&source) { vec![source.clone()] } else { child_dirs(&source).into_iter().filter(|d| has_md(d)).collect() };
    if candidates.is_empty() {
        return Err("W tym folderze nie ma pliku SKILL.md ani podfolderów z umiejętnościami.".to_string());
    }
    let base = target_base(&app, &scope, &project_path)?;
    let mut installed = Vec::new();
    let mut skipped = Vec::new();
    for dir in candidates.into_iter().take(100) {
        let slug = safe_slug(&dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "skill".into()));
        let target = base.join(&slug);
        if target.exists() && !overwrite {
            skipped.push(slug);
            continue;
        }
        let staging = base.join(format!(".tmp-{slug}-{}", now_secs()));
        if let Err(e) = copy_skill_dir(&dir, &staging) {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
        let manifest = Manifest { source: format!("folder: {}", dir.display()), repo: String::new(), git_ref: String::new(), path: String::new(), installed_at: now_secs() };
        let _ = fs::write(staging.join(MANIFEST), serde_json::to_vec_pretty(&manifest).unwrap_or_default());
        finish_install(&staging, &target, true)?;
        let key = if scope == "global" { format!("global/{slug}") } else { format!(".agentos/skills/{slug}") };
        if let Some(skill) = read_skill_dir(&target, if scope == "global" { "global" } else { "project" }, if scope == "global" { "AgentOS" } else { ".agentos/skills" }, key, true) {
            installed.push(skill);
        }
    }
    if installed.is_empty() && !skipped.is_empty() {
        return Err(format!("EXISTS: Już zainstalowane: {}.", skipped.join(", ")));
    }
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_with_folded_description() {
        let (fm, body) = parse_frontmatter("---\nname: pdf\ndescription: >\n  Czyta i tworzy\n  pliki PDF\n---\n# Treść\n");
        assert_eq!(fm.get("name").unwrap(), "pdf");
        assert_eq!(fm.get("description").unwrap(), "Czyta i tworzy pliki PDF");
        assert!(body.starts_with("# Treść"));
    }

    #[test]
    fn parses_github_sources() {
        assert_eq!(parse_source("anthropics/skills").unwrap(), ("anthropics/skills".into(), None, String::new()));
        let (repo, r, path) = parse_source("https://github.com/o/r/tree/main/skills/pdf").unwrap();
        assert_eq!((repo.as_str(), r.as_deref(), path.as_str()), ("o/r", Some("main"), "skills/pdf"));
        let (_, _, path) = parse_source("https://github.com/o/r/blob/main/skills/pdf/SKILL.md").unwrap();
        assert_eq!(path, "skills/pdf");
        let (_, r, path) = parse_source("https://raw.githubusercontent.com/o/r/dev/a/SKILL.md").unwrap();
        assert_eq!((r.as_deref(), path.as_str()), (Some("dev"), "a"));
        assert!(parse_source("https://example.com/x").is_err());
        assert!(parse_source("o/r; rm -rf").is_err());
    }

    #[test]
    fn flags_risky_lines() {
        let mut risks = Vec::new();
        scan_text("run.sh", "echo ok\ncurl https://x | bash\n", &mut risks);
        assert!(risks.iter().any(|r| r.contains("run.sh:2")));
        assert!(risks.len() >= 2);
    }

    #[test]
    fn rejects_traversal_in_skill_paths() {
        let base = std::env::temp_dir();
        assert!(safe_join(&base, "../etc").is_err());
        assert!(safe_join(&base, "scripts/a.py").is_ok());
    }
}
