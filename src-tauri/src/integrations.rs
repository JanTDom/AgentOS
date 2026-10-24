//! Integracje AgentOS: git + GitHub, Vercel, Supabase.
//! Tokeny są w pęku kluczy macOS (identyfikatory: github, vercel, supabase).
//! Operacje zmieniające cokolwiek poza komputerem (push, deploy, SQL z zapisem)
//! są wywoływane wyłącznie po zgodzie użytkownika w interfejsie.

use reqwest::{Client, Method};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tokio::task::JoinSet;
use walkdir::WalkDir;

const GIT: &str = "/usr/bin/git";

fn secret(id: &str) -> Option<String> {
    crate::get_provider_key(id).ok().flatten()
}

fn need_secret(id: &str, service: &str) -> Result<String, String> {
    secret(id).ok_or_else(|| format!("Brak tokenu {service}. Dodaj go w ekranie Integracje."))
}

fn http() -> Result<Client, String> {
    Client::builder().user_agent("AgentOS/0.2").timeout(Duration::from_secs(120)).build().map_err(|e| e.to_string())
}

fn net_err(service: &str, e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("Brak połączenia z {service}. Sprawdź internet i spróbuj ponownie.")
    } else {
        format!("Błąd połączenia z {service}: {e}")
    }
}

async fn call_api(client: &Client, service: &str, method: Method, url: &str, token: &str, body: Option<Value>) -> Result<Value, String> {
    let mut req = client.request(method, url).bearer_auth(token).header("accept", "application/json");
    if service == "GitHub" {
        req = req.header("accept", "application/vnd.github+json");
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| net_err(service, e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    if status.is_success() {
        return Ok(value);
    }
    let message = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| text.chars().take(300).collect());
    Err(match status.as_u16() {
        401 => format!("{service} odrzucił token (401). Sprawdź go w ekranie Integracje."),
        403 => format!("{service}: brak uprawnień (403). {message}"),
        404 => format!("{service}: nie znaleziono (404). {message}"),
        429 => format!("{service}: przekroczono limit zapytań (429). Spróbuj za chwilę."),
        code => format!("{service} zwrócił błąd {code}: {message}"),
    })
}

fn root_of(project_path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(project_path).map_err(|_| "Folder projektu jest niedostępny.".to_string())
}

// ---------- git ----------

fn git_cmd(root: &Path, args: &[&str], auth_header: Option<&str>) -> Result<String, String> {
    if !Path::new(GIT).exists() {
        return Err("Brak programu git. Zainstaluj narzędzia Xcode: w Terminalu wpisz xcode-select --install.".to_string());
    }
    let mut cmd = Command::new(GIT);
    cmd.current_dir(root).env("GIT_TERMINAL_PROMPT", "0").args(["-c", "core.quotepath=off"]);
    if let Some(header) = auth_header {
        cmd.args(["-c", &format!("http.https://github.com/.extraheader=AUTHORIZATION: basic {header}")]);
    }
    let output = cmd.args(args).output().map_err(|e| format!("Nie udało się uruchomić git: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(if stdout.trim().is_empty() { stderr } else { stdout })
    } else {
        let msg = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(msg.trim().chars().take(1500).collect())
    }
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn github_auth_header() -> Option<String> {
    secret("github").map(|t| base64(format!("x-access-token:{t}").as_bytes()))
}

/// owner/repo z adresu zdalnego GitHuba (https albo ssh).
pub fn github_repo_from_remote(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = u.strip_prefix("https://github.com/").or_else(|| u.strip_prefix("git@github.com:")).or_else(|| u.strip_prefix("ssh://git@github.com/"))?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() { Some(format!("{}/{}", parts[0], parts[1])) } else { None }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    branch: String,
    remote: Option<String>,
    github_repo: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
    last_commit: Option<String>,
    sensitive: Vec<String>,
}

fn is_sensitive(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    (name.starts_with(".env") && name != ".env.example" && name != ".env.sample")
        || name.ends_with(".pem")
        || name.ends_with(".p12")
        || name.ends_with(".key")
        || name == "id_rsa"
        || name == "id_ed25519"
        || name.contains("credentials")
        || name == "service-account.json"
}

fn read_status(root: &Path) -> Result<GitStatus, String> {
    if !root.join(".git").exists() {
        return Ok(GitStatus { is_repo: false, branch: String::new(), remote: None, github_repo: None, upstream: None, ahead: 0, behind: 0, files: vec![], last_commit: None, sensitive: vec![] });
    }
    let porcelain = git_cmd(root, &["status", "--porcelain=v1", "-b", "-uall"], None)?;
    let mut lines = porcelain.lines();
    let head = lines.next().unwrap_or("").trim_start_matches("## ").to_string();
    let (branch_part, tracking) = head.split_once(" [").map(|(a, b)| (a.to_string(), b.trim_end_matches(']').to_string())).unwrap_or((head.clone(), String::new()));
    let (branch, upstream) = branch_part.split_once("...").map(|(a, b)| (a.to_string(), Some(b.to_string()))).unwrap_or((branch_part.trim_start_matches("No commits yet on ").to_string(), None));
    let num = |key: &str| tracking.split(", ").find_map(|p| p.strip_prefix(key).and_then(|n| n.trim().parse().ok())).unwrap_or(0);
    let files: Vec<GitFile> = lines
        .filter(|l| l.len() > 3)
        .map(|l| {
            let code = &l[..2];
            let path = l[3..].trim_matches('"').to_string();
            let status = match code.trim() {
                "??" => "nowy",
                "A" | "AM" => "dodany",
                "D" | " D" => "usunięty",
                "R" | "RM" => "przeniesiony",
                _ => "zmieniony",
            };
            GitFile { path, status: status.to_string() }
        })
        .collect();
    let remote = git_cmd(root, &["remote", "get-url", "origin"], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let sensitive = files.iter().filter(|f| is_sensitive(&f.path)).map(|f| f.path.clone()).collect();
    Ok(GitStatus {
        is_repo: true,
        github_repo: remote.as_deref().and_then(github_repo_from_remote),
        remote,
        branch,
        upstream,
        ahead: num("ahead "),
        behind: num("behind "),
        files,
        last_commit: git_cmd(root, &["log", "-1", "--format=%h · %s · %cr"], None).ok().map(|s| s.trim().to_string()),
        sensitive,
    })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(project_path: String) -> Result<GitStatus, String> {
    let root = root_of(&project_path)?;
    blocking(move || read_status(&root)).await
}

#[tauri::command]
pub async fn git_init(project_path: String) -> Result<String, String> {
    let root = root_of(&project_path)?;
    blocking(move || {
        git_cmd(&root, &["init", "-b", "main"], None)?;
        let ignore = root.join(".gitignore");
        if !ignore.exists() {
            fs::write(&ignore, "node_modules/\n.env\n.env.*\n!.env.example\n.DS_Store\ndist/\nbuild/\n.vercel/\n").map_err(|e| e.to_string())?;
        }
        Ok("Włączono historię wersji (git) i dodano .gitignore chroniący pliki z hasłami.".to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(project_path: String, message: String, author_name: Option<String>, author_email: Option<String>, allow_sensitive: bool) -> Result<String, String> {
    let root = root_of(&project_path)?;
    if message.trim().is_empty() {
        return Err("Podaj opis zmian.".to_string());
    }
    blocking(move || {
        let status = read_status(&root)?;
        if !status.is_repo {
            return Err("Projekt nie ma jeszcze historii wersji (git).".to_string());
        }
        if status.files.is_empty() {
            return Err("Brak zmian do zatwierdzenia.".to_string());
        }
        if !status.sensitive.is_empty() && !allow_sensitive {
            return Err(format!("SENSITIVE: Wśród zmian są pliki, które mogą zawierać hasła lub klucze: {}. Dodaj je do .gitignore albo potwierdź świadomie.", status.sensitive.join(", ")));
        }
        git_cmd(&root, &["add", "-A"], None)?;
        let has_identity = git_cmd(&root, &["config", "user.email"], None).map(|s| !s.trim().is_empty()).unwrap_or(false);
        let mut args: Vec<String> = Vec::new();
        if !has_identity {
            args.extend(["-c".into(), format!("user.name={}", author_name.unwrap_or_else(|| "AgentOS".into())), "-c".into(), format!("user.email={}", author_email.unwrap_or_else(|| "agentos@localhost".into()))]);
        }
        args.extend(["commit".into(), "-m".into(), message.trim().to_string()]);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git_cmd(&root, &refs, None)?;
        Ok(git_cmd(&root, &["log", "-1", "--format=%h %s"], None)?.trim().to_string())
    })
    .await
}

#[tauri::command]
pub async fn git_branch(project_path: String, name: String) -> Result<String, String> {
    let root = root_of(&project_path)?;
    let clean: String = name.trim().chars().map(|c| if c.is_alphanumeric() || "-_/.".contains(c) { c } else { '-' }).collect();
    if clean.is_empty() || clean.starts_with('-') {
        return Err("Nieprawidłowa nazwa gałęzi.".to_string());
    }
    blocking(move || {
        git_cmd(&root, &["switch", "-c", &clean], None)?;
        Ok(clean)
    })
    .await
}

#[tauri::command]
pub async fn git_push(project_path: String, allow_protected: bool) -> Result<String, String> {
    let root = root_of(&project_path)?;
    blocking(move || {
        let status = read_status(&root)?;
        let remote = status.remote.clone().ok_or("Projekt nie ma zdalnego repozytorium. Utwórz je na GitHubie w zakładce Publikacja.")?;
        if (status.branch == "main" || status.branch == "master") && !allow_protected {
            return Err(format!("PROTECTED: Wypchnięcie bezpośrednio na gałąź {} jest zablokowane w tym projekcie. Utwórz nową gałąź i pull request albo zmień to w ustawieniach publikacji.", status.branch));
        }
        let header = if remote.starts_with("https://github.com/") { github_auth_header() } else { None };
        let out = git_cmd(&root, &["push", "-u", "origin", &status.branch], header.as_deref()).map_err(|e| {
            if e.contains("could not read Username") || e.contains("Authentication failed") {
                "GitHub odrzucił logowanie. Dodaj token GitHub (z uprawnieniem do zapisu w repozytoriach) w ekranie Integracje.".to_string()
            } else if e.contains("rejected") && e.contains("fetch first") {
                "Na GitHubie są nowsze zmiany. Najpierw trzeba je pobrać (git pull) — poproś agenta o scalenie.".to_string()
            } else {
                e
            }
        })?;
        Ok(format!("Wypchnięto gałąź {} do {}.\n{}", status.branch, remote, out.trim()))
    })
    .await
}

#[tauri::command]
pub async fn git_clone(url: String, parent: String) -> Result<String, String> {
    let parent = root_of(&parent)?;
    let name = url.trim().trim_end_matches('/').trim_end_matches(".git").rsplit('/').next().unwrap_or("repo").to_string();
    if name.is_empty() || name.starts_with('.') {
        return Err("Nieprawidłowy adres repozytorium.".to_string());
    }
    let target = parent.join(&name);
    if target.exists() {
        return Err(format!("Folder {name} już istnieje."));
    }
    blocking(move || {
        let header = if url.starts_with("https://github.com/") { github_auth_header() } else { None };
        git_cmd(&parent, &["clone", url.trim(), &name], header.as_deref())?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    login: String,
    name: String,
    email: String,
}

#[tauri::command]
pub async fn github_user() -> Result<GithubUser, String> {
    let token = need_secret("github", "GitHub")?;
    let v = call_api(&http()?, "GitHub", Method::GET, "https://api.github.com/user", &token, None).await?;
    let login = v["login"].as_str().unwrap_or_default().to_string();
    let id = v["id"].as_u64().unwrap_or(0);
    Ok(GithubUser {
        name: v["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(&login).to_string(),
        email: v["email"].as_str().map(str::to_string).unwrap_or_else(|| format!("{id}+{login}@users.noreply.github.com")),
        login,
    })
}

#[tauri::command]
pub async fn github_create_repo(project_path: String, name: String, private: bool, description: Option<String>) -> Result<String, String> {
    let token = need_secret("github", "GitHub")?;
    let root = root_of(&project_path)?;
    let v = call_api(&http()?, "GitHub", Method::POST, "https://api.github.com/user/repos", &token, Some(json!({"name": name.trim(), "private": private, "description": description.unwrap_or_default(), "auto_init": false}))).await?;
    let clone = v["clone_url"].as_str().ok_or("GitHub nie zwrócił adresu repozytorium.")?.to_string();
    let html = v["html_url"].as_str().unwrap_or_default().to_string();
    blocking(move || {
        if !root.join(".git").exists() {
            git_cmd(&root, &["init", "-b", "main"], None)?;
        }
        if git_cmd(&root, &["remote", "get-url", "origin"], None).is_ok() {
            git_cmd(&root, &["remote", "set-url", "origin", &clone], None)?;
        } else {
            git_cmd(&root, &["remote", "add", "origin", &clone], None)?;
        }
        Ok(html)
    })
    .await
}

#[tauri::command]
pub async fn github_create_pr(project_path: String, title: String, body: String, base: Option<String>) -> Result<String, String> {
    let token = need_secret("github", "GitHub")?;
    let root = root_of(&project_path)?;
    let status = blocking(move || read_status(&root)).await?;
    let repo = status.github_repo.ok_or("Zdalne repozytorium tego projektu nie jest na GitHubie.")?;
    let client = http()?;
    let base = match base.filter(|b| !b.is_empty()) {
        Some(b) => b,
        None => call_api(&client, "GitHub", Method::GET, &format!("https://api.github.com/repos/{repo}"), &token, None).await?["default_branch"].as_str().unwrap_or("main").to_string(),
    };
    if base == status.branch {
        return Err("Pull request wymaga osobnej gałęzi — jesteś na gałęzi głównej.".to_string());
    }
    let v = call_api(&client, "GitHub", Method::POST, &format!("https://api.github.com/repos/{repo}/pulls"), &token, Some(json!({"title": title, "body": body, "head": status.branch, "base": base}))).await?;
    Ok(v["html_url"].as_str().unwrap_or_default().to_string())
}

// ---------- Vercel ----------

fn team_q(team_id: &Option<String>, first: bool) -> String {
    match team_id.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => format!("{}teamId={t}", if first { "?" } else { "&" }),
        None => String::new(),
    }
}

#[tauri::command]
pub async fn vercel_account() -> Result<Value, String> {
    let token = need_secret("vercel", "Vercel")?;
    let client = http()?;
    let user = call_api(&client, "Vercel", Method::GET, "https://api.vercel.com/v2/user", &token, None).await?;
    let teams = call_api(&client, "Vercel", Method::GET, "https://api.vercel.com/v2/teams", &token, None).await.unwrap_or(json!({"teams": []}));
    Ok(json!({
        "username": user.pointer("/user/username").cloned().unwrap_or(Value::Null),
        "email": user.pointer("/user/email").cloned().unwrap_or(Value::Null),
        "teams": teams["teams"].as_array().cloned().unwrap_or_default().iter().map(|t| json!({"id": t["id"], "name": t["name"], "slug": t["slug"]})).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub async fn vercel_projects(team_id: Option<String>) -> Result<Value, String> {
    let token = need_secret("vercel", "Vercel")?;
    let v = call_api(&http()?, "Vercel", Method::GET, &format!("https://api.vercel.com/v9/projects?limit=100{}", team_q(&team_id, false)), &token, None).await?;
    Ok(Value::Array(v["projects"].as_array().cloned().unwrap_or_default().iter().map(|p| json!({"id": p["id"], "name": p["name"], "framework": p["framework"]})).collect()))
}

fn deploy_files(root: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    let mut ignore: Vec<String> = vec!["node_modules".into(), ".git".into(), ".vercel".into(), ".next".into(), ".DS_Store".into(), ".agentos".into(), ".agentos-build".into(), "target".into()];
    if let Ok(text) = fs::read_to_string(root.join(".vercelignore")) {
        ignore.extend(text.lines().map(|l| l.trim().trim_start_matches('/').trim_end_matches('/').to_string()).filter(|l| !l.is_empty() && !l.starts_with('#')));
    }
    let mut out = Vec::new();
    let mut total = 0u64;
    let walker = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        let rel = e.path().strip_prefix(root).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let name = e.file_name().to_string_lossy().to_string();
        !ignore.iter().any(|i| i == &name || i == &rel || rel.starts_with(&format!("{i}/")))
    });
    for entry in walker.filter_map(Result::ok).filter(|e| e.file_type().is_file()) {
        let rel = entry.path().strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().to_string();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.starts_with(".env") && name != ".env.example" {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        total += size;
        out.push((rel, entry.path().to_path_buf(), size));
        if out.len() > 8000 || total > 300 * 1024 * 1024 {
            return Err("Projekt jest zbyt duży do wysłania (limit 8000 plików / 300 MB). Dodaj zbędne foldery do .vercelignore.".to_string());
        }
    }
    if out.is_empty() {
        return Err("Brak plików do wdrożenia.".to_string());
    }
    Ok(out)
}

/// Wysyła pliki projektu do Vercela i tworzy wdrożenie (podglądowe albo produkcyjne).
#[tauri::command]
pub async fn vercel_deploy(project_path: String, name: String, project_id: Option<String>, team_id: Option<String>, production: bool) -> Result<Value, String> {
    let token = need_secret("vercel", "Vercel")?;
    let root = root_of(&project_path)?;
    let files = blocking(move || deploy_files(&root)).await?;
    let client = http()?;
    let mut set = JoinSet::new();
    let mut manifest = Vec::new();
    let mut queue = files.into_iter();
    let upload = |client: Client, token: String, team: Option<String>, rel: String, path: PathBuf| async move {
        let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{rel}: {e}"))?;
        let sha = sha1_smol::Sha1::from(&bytes).digest().to_string();
        let size = bytes.len();
        let resp = client
            .post(format!("https://api.vercel.com/v2/files{}", team_q(&team, true)))
            .bearer_auth(&token)
            .header("content-type", "application/octet-stream")
            .header("x-vercel-digest", &sha)
            .body(bytes)
            .send()
            .await
            .map_err(|e| net_err("Vercel", e))?;
        if !resp.status().is_success() {
            return Err(format!("Nie udało się wysłać {rel} ({}).", resp.status().as_u16()));
        }
        Ok::<Value, String>(json!({"file": rel, "sha": sha, "size": size}))
    };
    loop {
        while set.len() < 8 {
            match queue.next() {
                Some((rel, path, _)) => {
                    set.spawn(upload(client.clone(), token.clone(), team_id.clone(), rel, path));
                }
                None => break,
            }
        }
        match set.join_next().await {
            Some(r) => manifest.push(r.map_err(|e| e.to_string())??),
            None => break,
        }
    }
    let clean_name: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect::<String>().trim_matches('-').chars().take(90).collect();
    let mut body = json!({"name": if clean_name.is_empty() { "agentos-app".to_string() } else { clean_name }, "files": manifest});
    if let Some(p) = project_id.filter(|p| !p.is_empty()) {
        body["project"] = json!(p);
    }
    if production {
        body["target"] = json!("production");
    }
    let v = call_api(&client, "Vercel", Method::POST, &format!("https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1{}", team_q(&team_id, false)), &token, Some(body)).await?;
    Ok(json!({
        "id": v["id"], "url": v["url"].as_str().map(|u| format!("https://{u}")), "readyState": v["readyState"],
        "projectId": v["projectId"], "files": manifest.len(),
    }))
}

#[tauri::command]
pub async fn vercel_deployment(id: String, team_id: Option<String>) -> Result<Value, String> {
    let token = need_secret("vercel", "Vercel")?;
    let v = call_api(&http()?, "Vercel", Method::GET, &format!("https://api.vercel.com/v13/deployments/{id}{}", team_q(&team_id, true)), &token, None).await?;
    Ok(json!({"id": v["id"], "url": v["url"].as_str().map(|u| format!("https://{u}")), "readyState": v["readyState"], "errorMessage": v["errorMessage"], "target": v["target"], "projectId": v["projectId"]}))
}

#[tauri::command]
pub async fn vercel_deployments(project_id: String, team_id: Option<String>) -> Result<Value, String> {
    let token = need_secret("vercel", "Vercel")?;
    let v = call_api(&http()?, "Vercel", Method::GET, &format!("https://api.vercel.com/v6/deployments?projectId={project_id}&limit=15{}", team_q(&team_id, false)), &token, None).await?;
    Ok(Value::Array(
        v["deployments"].as_array().cloned().unwrap_or_default().iter().map(|d| json!({
            "id": d["uid"], "url": d["url"].as_str().map(|u| format!("https://{u}")), "state": d["state"].as_str().or(d["readyState"].as_str()),
            "target": d["target"], "created": d["created"], "commit": d.pointer("/meta/githubCommitMessage"),
        })).collect(),
    ))
}

#[tauri::command]
pub async fn vercel_logs(id: String, team_id: Option<String>) -> Result<String, String> {
    let token = need_secret("vercel", "Vercel")?;
    let v = call_api(&http()?, "Vercel", Method::GET, &format!("https://api.vercel.com/v3/deployments/{id}/events?builds=1&limit=300&direction=backward{}", team_q(&team_id, false)), &token, None).await?;
    let mut lines: Vec<String> = v.as_array().cloned().unwrap_or_default().iter().filter_map(|e| e.pointer("/payload/text").or_else(|| e.get("text")).and_then(Value::as_str).map(str::to_string)).collect();
    lines.reverse();
    let text = lines.join("\n");
    Ok(if text.chars().count() > 20000 { text.chars().skip(text.chars().count() - 20000).collect() } else if text.is_empty() { "(brak logów budowania)".into() } else { text })
}

#[tauri::command]
pub async fn vercel_rollback(project_id: String, deployment_id: String, team_id: Option<String>) -> Result<(), String> {
    let token = need_secret("vercel", "Vercel")?;
    call_api(&http()?, "Vercel", Method::POST, &format!("https://api.vercel.com/v1/projects/{project_id}/rollback/{deployment_id}{}", team_q(&team_id, true)), &token, None).await?;
    Ok(())
}

#[tauri::command]
pub async fn vercel_set_env(project_id: String, team_id: Option<String>, key: String, value: String, sensitive: bool) -> Result<(), String> {
    let token = need_secret("vercel", "Vercel")?;
    call_api(
        &http()?, "Vercel", Method::POST,
        &format!("https://api.vercel.com/v10/projects/{project_id}/env?upsert=true{}", team_q(&team_id, false)),
        &token,
        Some(json!({"key": key, "value": value, "type": if sensitive { "encrypted" } else { "plain" }, "target": ["production", "preview", "development"]})),
    ).await?;
    Ok(())
}

// ---------- Supabase ----------

#[tauri::command]
pub async fn supabase_projects() -> Result<Value, String> {
    let token = need_secret("supabase", "Supabase")?;
    let v = call_api(&http()?, "Supabase", Method::GET, "https://api.supabase.com/v1/projects", &token, None).await?;
    Ok(Value::Array(v.as_array().cloned().unwrap_or_default().iter().map(|p| json!({
        "ref": p.get("ref").or_else(|| p.get("id")), "name": p["name"], "region": p["region"], "status": p["status"],
    })).collect()))
}

/// Zapytanie SQL. read_only=true używa punktu API tylko do odczytu (wymuszone po stronie Supabase).
#[tauri::command]
pub async fn supabase_query(project_ref: String, sql: String, read_only: bool) -> Result<Value, String> {
    let token = need_secret("supabase", "Supabase")?;
    if !project_ref.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Nieprawidłowy identyfikator projektu Supabase.".to_string());
    }
    let path = if read_only { "database/query/read-only" } else { "database/query" };
    call_api(&http()?, "Supabase", Method::POST, &format!("https://api.supabase.com/v1/projects/{project_ref}/{path}"), &token, Some(json!({"query": sql}))).await
}

#[tauri::command]
pub async fn supabase_keys(project_ref: String) -> Result<Value, String> {
    let token = need_secret("supabase", "Supabase")?;
    let v = call_api(&http()?, "Supabase", Method::GET, &format!("https://api.supabase.com/v1/projects/{project_ref}/api-keys"), &token, None).await?;
    let keys = v.as_array().cloned().unwrap_or_default();
    let public = keys
        .iter()
        .find(|k| k["type"] == "publishable")
        .or_else(|| keys.iter().find(|k| k["name"] == "anon"))
        .and_then(|k| k["api_key"].as_str())
        .map(str::to_string);
    Ok(json!({"url": format!("https://{project_ref}.supabase.co"), "publicKey": public}))
}

#[tauri::command]
pub async fn supabase_types(project_ref: String) -> Result<String, String> {
    let token = need_secret("supabase", "Supabase")?;
    let v = call_api(&http()?, "Supabase", Method::GET, &format!("https://api.supabase.com/v1/projects/{project_ref}/types/typescript?included_schemas=public"), &token, None).await?;
    v["types"].as_str().map(str::to_string).ok_or_else(|| "Supabase nie zwrócił typów.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b"x-access-token:abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"a"), "YQ==");
    }

    #[test]
    fn parses_github_remotes() {
        assert_eq!(github_repo_from_remote("https://github.com/JanTDom/AgentOS.git").as_deref(), Some("JanTDom/AgentOS"));
        assert_eq!(github_repo_from_remote("git@github.com:o/r.git").as_deref(), Some("o/r"));
        assert!(github_repo_from_remote("https://gitlab.com/o/r").is_none());
    }

    #[test]
    fn flags_secret_files() {
        assert!(is_sensitive(".env"));
        assert!(is_sensitive("config/.env.local"));
        assert!(!is_sensitive(".env.example"));
        assert!(is_sensitive("keys/server.pem"));
        assert!(!is_sensitive("src/env.ts"));
    }

    #[test]
    fn sha1_matches_known_digest() {
        assert_eq!(sha1_smol::Sha1::from("abc").digest().to_string(), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }
}
