//! Integracje usług. Mutacje podlegają kontroli IPC w policy.rs.
use reqwest::{Client, Method};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
fn secret(id: &str) -> Result<String, String> {
    crate::get_provider_key(id)?.ok_or_else(|| format!("Brak tokenu {id}."))
}
fn http() -> Result<Client, String> {
    Client::builder()
        .user_agent("AgentOS/0.5")
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}
async fn request(
    service: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let base = match service {
        "github" => "https://api.github.com",
        "vercel" => "https://api.vercel.com",
        "supabase" => "https://api.supabase.com",
        _ => return Err("Nieznana usługa.".into()),
    };
    let mut r = http()?
        .request(method, format!("{base}{path}"))
        .bearer_auth(secret(service)?)
        .header("accept", "application/json");
    if let Some(b) = body {
        r = r.json(&b);
    }
    let response = r.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let bytes = crate::network::limited(response, 8_000_000).await?;
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!(
            "{service}: HTTP {} — {}",
            status.as_u16(),
            v.pointer("/error/message")
                .or_else(|| v.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("błąd usługi")
                .chars()
                .take(400)
                .collect::<String>()
        ));
    }
    Ok(v)
}
fn root(p: &str) -> Result<PathBuf, String> {
    crate::filesafety::root(p)
}
fn git(r: &Path, args: &[&str], auth: bool) -> Result<String, String> {
    let mut c = Command::new("/usr/bin/git");
    c.current_dir(r)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.quotepath=off"]);
    if auth {
        if let Ok(t) = secret("github") {
            c.env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
                .env(
                    "GIT_CONFIG_VALUE_0",
                    format!(
                        "AUTHORIZATION: basic {}",
                        base64(format!("x-access-token:{t}").as_bytes())
                    ),
                );
        }
    }
    let o = c.args(args).output().map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(if o.stdout.is_empty() {
            String::from_utf8_lossy(&o.stderr)
        } else {
            String::from_utf8_lossy(&o.stdout)
        }
        .to_string())
    } else {
        Err(String::from_utf8_lossy(&o.stderr)
            .chars()
            .take(1500)
            .collect())
    }
}
fn base64(b: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = ((c[0] as u32) << 16)
            | ((c.get(1).copied().unwrap_or(0) as u32) << 8)
            | c.get(2).copied().unwrap_or(0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() {
                T[((n >> (18 - 6 * i)) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    s
}
pub fn github_repo_from_remote(u: &str) -> Option<String> {
    let u = u.trim().trim_end_matches('/').trim_end_matches(".git");
    let s = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("git@github.com:"))
        .or_else(|| u.strip_prefix("ssh://git@github.com/"))?;
    let parts: Vec<_> = s.split('/').collect();
    if parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && *p != ".."
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    {
        Some(s.into())
    } else {
        None
    }
}
#[derive(Serialize)]
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
fn status(r: &Path) -> Result<GitStatus, String> {
    if !r.join(".git").exists() {
        return Ok(GitStatus {
            is_repo: false,
            branch: String::new(),
            remote: None,
            github_repo: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![],
            last_commit: None,
            sensitive: vec![],
        });
    }
    let raw = git(r, &["status", "--porcelain=v1", "-z", "-uall"], false)?;
    let mut entries = raw.split('\0');
    let mut files = vec![];
    while let Some(e) = entries.next() {
        if e.len() < 4 {
            continue;
        }
        let code = &e[..2];
        let p = e[3..].to_string();
        if code.contains('R') || code.contains('C') {
            let _ = entries.next();
        }
        files.push(GitFile {
            path: p,
            status: if code == "??" {
                "nowy"
            } else if code.contains('D') {
                "usunięty"
            } else {
                "zmieniony"
            }
            .into(),
        });
    }
    let remote = git(r, &["remote", "get-url", "origin"], false)
        .ok()
        .map(|s| s.trim().to_string());
    let counts = git(
        r,
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        false,
    )
    .unwrap_or_default();
    let mut n = counts.split_whitespace().filter_map(|s| s.parse().ok());
    Ok(GitStatus {
        is_repo: true,
        branch: git(r, &["symbolic-ref", "--short", "HEAD"], false)
            .unwrap_or_default()
            .trim()
            .into(),
        github_repo: remote.as_deref().and_then(github_repo_from_remote),
        remote,
        upstream: git(r, &["rev-parse", "--abbrev-ref", "@{u}"], false)
            .ok()
            .map(|s| s.trim().into()),
        ahead: n.next().unwrap_or(0),
        behind: n.next().unwrap_or(0),
        sensitive: files
            .iter()
            .filter(|f| crate::filesafety::sensitive(&f.path))
            .map(|f| f.path.clone())
            .collect(),
        files,
        last_commit: git(r, &["log", "-1", "--format=%h · %s · %cr"], false)
            .ok()
            .map(|s| s.trim().into()),
    })
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn git_status(project_path: String) -> Result<GitStatus, String> {
    let r = root(&project_path)?;
    blocking(move || status(&r)).await
}
#[tauri::command]
pub async fn git_init(project_path: String) -> Result<String, String> {
    let r = root(&project_path)?;
    blocking(move||{git(&r,&["init","-b","main"],false)?;if !r.join(".gitignore").exists(){fs::write(r.join(".gitignore"),"node_modules/\n.env\n.env.*\n!.env.example\n.DS_Store\ndist/\nbuild/\n.vercel/\n.agentos/\n").map_err(|e|e.to_string())?;}Ok("Włączono historię wersji.".into())}).await
}
#[tauri::command]
pub async fn git_commit(
    project_path: String,
    message: String,
    author_name: Option<String>,
    author_email: Option<String>,
    allow_sensitive: bool,
) -> Result<String, String> {
    let _ = allow_sensitive;
    let r = root(&project_path)?;
    if message.trim().is_empty() {
        return Err("Podaj opis.".into());
    }
    blocking(move || {
        let s = status(&r)?;
        if !s.sensitive.is_empty() {
            return Err(format!(
                "Pliki wrażliwe zablokowane: {}",
                s.sensitive.join(", ")
            ));
        }
        for f in &s.files {
            let p = crate::filesafety::resolve(&r, &f.path)?;
            if let Ok(t) = fs::read_to_string(p) {
                if crate::filesafety::looks_secret(&t) {
                    return Err(format!("Potencjalny sekret: {}", f.path));
                }
            }
        }
        git(&r, &["add", "-A"], false)?;
        let mut a = vec![];
        if git(&r, &["config", "user.email"], false).is_err() {
            a.extend([
                "-c".to_string(),
                format!(
                    "user.name={}",
                    author_name.unwrap_or_else(|| "AgentOS".into())
                ),
                "-c".into(),
                format!(
                    "user.email={}",
                    author_email.unwrap_or_else(|| "agentos@localhost".into())
                ),
            ]);
        }
        a.extend(["commit".into(), "-m".into(), message]);
        git(&r, &a.iter().map(String::as_str).collect::<Vec<_>>(), false)?;
        git(&r, &["log", "-1", "--format=%h %s"], false)
    })
    .await
}
#[tauri::command]
pub async fn git_branch(project_path: String, name: String) -> Result<String, String> {
    let r = root(&project_path)?;
    blocking(move || {
        git(&r, &["check-ref-format", "--branch", &name], false)?;
        git(&r, &["switch", "-c", &name], false)?;
        Ok(name)
    })
    .await
}
#[tauri::command]
pub async fn git_push(project_path: String, allow_protected: bool) -> Result<String, String> {
    let r = root(&project_path)?;
    blocking(move || {
        let s = status(&r)?;
        if matches!(s.branch.as_str(), "main" | "master") && !allow_protected {
            return Err("Gałąź chroniona — użyj nowej gałęzi i PR.".into());
        }
        if s.remote
            .as_deref()
            .and_then(github_repo_from_remote)
            .is_none()
        {
            return Err("Push wymaga zweryfikowanego origin GitHub.".into());
        }
        git(&r, &["push", "-u", "origin", &s.branch], true)
    })
    .await
}
#[tauri::command]
pub async fn git_clone(url: String, parent: String) -> Result<String, String> {
    let repo = github_repo_from_remote(&url).ok_or("Dozwolony tylko adres GitHub.")?;
    let r = root(&parent)?;
    let name = repo.split('/').next_back().unwrap().to_string();
    blocking(move || {
        git(&r, &["clone", "--", &url, &name], true)?;
        Ok(r.join(name).to_string_lossy().into())
    })
    .await
}
#[derive(Serialize)]
pub struct GithubUser {
    login: String,
    name: String,
    email: String,
}
#[tauri::command]
pub async fn github_user() -> Result<GithubUser, String> {
    let v = request("github", Method::GET, "/user", None).await?;
    let login = v["login"].as_str().ok_or("Brak użytkownika.")?.to_string();
    Ok(GithubUser {
        name: v["name"].as_str().unwrap_or(&login).into(),
        email: v["email"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}+{login}@users.noreply.github.com", v["id"])),
        login,
    })
}
#[tauri::command]
pub async fn github_create_repo(
    project_path: String,
    name: String,
    private: bool,
    description: Option<String>,
) -> Result<String, String> {
    let r = root(&project_path)?;
    if git(&r, &["remote", "get-url", "origin"], false).is_ok() {
        return Err("Origin już istnieje — nie zmieniono go.".into());
    }
    let v = request(
        "github",
        Method::POST,
        "/user/repos",
        Some(json!({"name":name,"private":private,"description":description,"auto_init":false})),
    )
    .await?;
    let clone = v["clone_url"].as_str().ok_or("Brak URL.")?.to_string();
    let html = v["html_url"].as_str().unwrap_or("").to_string();
    blocking(move || {
        if !r.join(".git").exists() {
            git(&r, &["init", "-b", "main"], false)?;
        }
        git(&r, &["remote", "add", "origin", &clone], false)?;
        Ok(html)
    })
    .await
}
#[tauri::command]
pub async fn github_create_pr(
    project_path: String,
    title: String,
    body: String,
    base: Option<String>,
) -> Result<String, String> {
    let s = git_status(project_path).await?;
    let repo = s.github_repo.ok_or("Brak GitHub origin.")?;
    let base = match base {
        Some(b) => b,
        None => request("github", Method::GET, &format!("/repos/{repo}"), None).await?
            ["default_branch"]
            .as_str()
            .unwrap_or("main")
            .into(),
    };
    let v = request(
        "github",
        Method::POST,
        &format!("/repos/{repo}/pulls"),
        Some(json!({"title":title,"body":body,"base":base,"head":s.branch})),
    )
    .await?;
    Ok(v["html_url"].as_str().ok_or("Brak PR URL.")?.into())
}
fn tq(t: &Option<String>, first: bool) -> String {
    t.as_ref()
        .map(|t| {
            format!(
                "{}teamId={}",
                if first { "?" } else { "&" },
                url::form_urlencoded::byte_serialize(t.as_bytes()).collect::<String>()
            )
        })
        .unwrap_or_default()
}
fn ident(s: &str) -> Result<(), String> {
    if s.is_empty()
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Err("Nieprawidłowy identyfikator usługi.".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn vercel_account() -> Result<Value, String> {
    let u = request("vercel", Method::GET, "/v2/user", None).await?;
    let ts = request("vercel", Method::GET, "/v2/teams", None).await?;
    Ok(json!({"username":u["user"]["username"],"email":u["user"]["email"],"teams":ts["teams"]}))
}
#[tauri::command]
pub async fn vercel_projects(team_id: Option<String>) -> Result<Value, String> {
    Ok(request(
        "vercel",
        Method::GET,
        &format!("/v9/projects?limit=100{}", tq(&team_id, false)),
        None,
    )
    .await?["projects"]
        .clone())
}
#[tauri::command]
pub async fn vercel_deploy(
    app: tauri::AppHandle,
    project_path: String,
    name: String,
    project_id: Option<String>,
    team_id: Option<String>,
    production: bool,
) -> Result<Value, String> {
    let r = root(&project_path)?;
    let files = crate::publishing::files(&r)?;
    let manifest = crate::publishing::manifest(&files)?;
    crate::policy::confirm(
        &app,
        "Pliki do publikacji",
        format!(
            "Cel: {}\n{} plików, {} bajtów\nSHA-256 {}\n\n{}",
            if production { "PRODUKCJA" } else { "podgląd" },
            manifest.files.len(),
            manifest.total_bytes,
            manifest.hash,
            manifest.files.join("\n")
        ),
    )
    .await?;
    crate::operations::cancellable(async{
        if crate::publishing::manifest(&files)?.hash!=manifest.hash{return Err("Pliki zmieniły się po zgodzie.".into());}
        let token=secret("vercel")?;let c=http()?;let mut uploaded=vec![];
        for(rel,p)in files{let b=tokio::fs::read(p).await.map_err(|e|e.to_string())?;if crate::filesafety::looks_secret(&String::from_utf8_lossy(&b)){return Err(format!("Potencjalny sekret: {rel}"));}let sha=sha1_smol::Sha1::from(&b).digest().to_string();let size=b.len();let response=c.post(format!("https://api.vercel.com/v2/files{}",tq(&team_id,true))).bearer_auth(&token).header("content-type","application/octet-stream").header("x-vercel-digest",&sha).body(b).send().await.map_err(|e|e.to_string())?;if !response.status().is_success(){return Err(format!("Nie wysłano {rel}: {}",response.status()));}uploaded.push(json!({"file":rel,"sha":sha,"size":size}));}
        let clean:String=name.to_lowercase().chars().map(|c|if c.is_ascii_alphanumeric()||c=='-'{c}else{'-'}).take(90).collect();let mut body=json!({"name":clean,"files":uploaded});if let Some(p)=project_id{ident(&p)?;body["project"]=json!(p);}if production{body["target"]=json!("production");}
        let v=request("vercel",Method::POST,&format!("/v13/deployments?skipAutoDetectionConfirmation=1{}",tq(&team_id,false)),Some(body)).await?;Ok(json!({"id":v["id"],"url":v["url"].as_str().map(|u|format!("https://{u}")),"readyState":v["readyState"],"projectId":v["projectId"],"files":manifest.files.len()}))
    }).await
}
#[tauri::command]
pub async fn vercel_deployment(id: String, team_id: Option<String>) -> Result<Value, String> {
    ident(&id)?;
    let v = request(
        "vercel",
        Method::GET,
        &format!("/v13/deployments/{id}{}", tq(&team_id, true)),
        None,
    )
    .await?;
    Ok(
        json!({"id":v["id"],"url":v["url"].as_str().map(|u|format!("https://{u}")),"readyState":v["readyState"],"errorMessage":v["errorMessage"],"target":v["target"],"projectId":v["projectId"]}),
    )
}
#[tauri::command]
pub async fn vercel_deployments(
    project_id: String,
    team_id: Option<String>,
) -> Result<Value, String> {
    ident(&project_id)?;
    let v = request(
        "vercel",
        Method::GET,
        &format!(
            "/v6/deployments?projectId={project_id}&limit=15{}",
            tq(&team_id, false)
        ),
        None,
    )
    .await?;
    Ok(json!(v["deployments"].as_array().into_iter().flatten().map(|d|json!({"id":d["uid"],"url":d["url"].as_str().map(|u|format!("https://{u}")),"state":d["state"],"target":d["target"],"created":d["created"],"commit":d.pointer("/meta/githubCommitMessage")})).collect::<Vec<_>>()))
}
#[tauri::command]
pub async fn vercel_logs(id: String, team_id: Option<String>) -> Result<String, String> {
    ident(&id)?;
    let v = request(
        "vercel",
        Method::GET,
        &format!(
            "/v3/deployments/{id}/events?builds=1&limit=300&direction=backward{}",
            tq(&team_id, false)
        ),
        None,
    )
    .await?;
    let mut lines: Vec<_> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            e.pointer("/payload/text")
                .or_else(|| e.get("text"))
                .and_then(Value::as_str)
        })
        .collect();
    lines.reverse();
    Ok(lines.join("\n").chars().take(20_000).collect())
}
#[tauri::command]
pub async fn vercel_rollback(
    project_id: String,
    deployment_id: String,
    team_id: Option<String>,
) -> Result<(), String> {
    ident(&project_id)?;
    ident(&deployment_id)?;
    request(
        "vercel",
        Method::POST,
        &format!(
            "/v1/projects/{project_id}/rollback/{deployment_id}{}",
            tq(&team_id, true)
        ),
        None,
    )
    .await?;
    Ok(())
}
#[tauri::command]
pub async fn vercel_set_env(
    project_id: String,
    team_id: Option<String>,
    key: String,
    value: String,
    sensitive: bool,
) -> Result<(), String> {
    ident(&project_id)?;
    request("vercel",Method::POST,&format!("/v10/projects/{project_id}/env?upsert=true{}",tq(&team_id,false)),Some(json!({"key":key,"value":value,"type":if sensitive{"encrypted"}else{"plain"},"target":["production","preview","development"]}))).await?;
    Ok(())
}
#[tauri::command]
pub async fn supabase_projects() -> Result<Value, String> {
    let v = request("supabase", Method::GET, "/v1/projects", None).await?;
    Ok(json!(v.as_array().into_iter().flatten().map(|p|json!({"ref":p.get("ref").or_else(||p.get("id")),"name":p["name"],"region":p["region"],"status":p["status"]})).collect::<Vec<_>>()))
}
#[tauri::command]
pub async fn supabase_query(
    project_ref: String,
    sql: String,
    read_only: bool,
) -> Result<Value, String> {
    ident(&project_ref)?;
    request(
        "supabase",
        Method::POST,
        &format!(
            "/v1/projects/{project_ref}/database/query{}",
            if read_only { "/read-only" } else { "" }
        ),
        Some(json!({"query":sql})),
    )
    .await
}
#[tauri::command]
pub async fn supabase_keys(project_ref: String) -> Result<Value, String> {
    ident(&project_ref)?;
    let v = request(
        "supabase",
        Method::GET,
        &format!("/v1/projects/{project_ref}/api-keys"),
        None,
    )
    .await?;
    let keys: Vec<_> = v.as_array().into_iter().flatten().collect();
    let public = keys
        .iter()
        .find(|k| k["type"] == "publishable")
        .or_else(|| keys.iter().find(|k| k["name"] == "anon"))
        .and_then(|k| k["api_key"].as_str());
    Ok(json!({"url":format!("https://{project_ref}.supabase.co"),"publicKey":public}))
}
#[tauri::command]
pub async fn supabase_types(project_ref: String) -> Result<String, String> {
    ident(&project_ref)?;
    Ok(request(
        "supabase",
        Method::GET,
        &format!("/v1/projects/{project_ref}/types/typescript?included_schemas=public"),
        None,
    )
    .await?["types"]
        .as_str()
        .ok_or("Brak typów.")?
        .into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes() {
        assert_eq!(base64(b"a"), "YQ==");
        assert_eq!(base64(b"ab"), "YWI=");
    }
    #[test]
    fn remotes() {
        assert_eq!(
            github_repo_from_remote("git@github.com:o/r.git").unwrap(),
            "o/r"
        );
        assert!(github_repo_from_remote("https://github.com.evil/o/r").is_none());
    }
    #[test]
    fn identifiers() {
        assert!(ident("../secret").is_err());
    }
}
