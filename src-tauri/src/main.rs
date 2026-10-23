use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use url::Url;
use walkdir::WalkDir;

const KEYRING_SERVICE: &str = "pl.agentos.desktop";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    id: String,
    name: String,
    path: String,
    kind: String,
    status: String,
    files: usize,
    last_activity: String,
    context_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderRecord {
    id: String,
    name: String,
    kind: String,
    model: String,
    endpoint: String,
    has_key: bool,
    latency: String,
    tone: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderKeyStatus {
    provider_id: String,
    has_key: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelOfferRecord {
    id: String,
    name: String,
    description: String,
    context_length: u64,
    input_price: f64,
    output_price: f64,
    source: String,
    free: bool,
    modalities: Vec<String>,
    checked_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ContextFileRecord {
    name: String,
    path: String,
    content: String,
}

#[tauri::command]
fn write_project_context(path: String, content: String) -> Result<String, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() { return Err("Katalog projektu nie istnieje".into()); }
    if content.len() > 30_000 { return Err("Instrukcje projektu przekraczają limit 30 000 znaków".into()); }
    let target = root.join("PROJECT_CONTEXT.md");
    let temp = root.join(".agentos-project-context.tmp");
    std::fs::write(&temp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    Ok(target.display().to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CheckpointRecord {
    run_id: String,
    project_path: String,
    created_at: String,
    git_head: Option<String>,
    worktree_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillManifestRecord {
    id: String,
    name: String,
    version: String,
    description: String,
    source: String,
    trusted: bool,
    enabled: bool,
}

fn valid_skill_manifest(value: &Value) -> bool {
    ["id", "name", "version", "description", "source"]
        .iter()
        .all(|key| {
            value
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
        })
}

#[tauri::command]
fn list_project_skills(project_path: String) -> Result<Vec<SkillManifestRecord>, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err("Katalog projektu nie istnieje".into());
    }
    let dir = root.join(".agentos").join("skills");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut skills = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Nieprawidłowy manifest skillu {}: {e}", path.display()))?;
        if !valid_skill_manifest(&value) {
            return Err(format!(
                "Manifest skillu {} nie zawiera wymaganych pól",
                path.display()
            ));
        }
        let mut skill: SkillManifestRecord =
            serde_json::from_value(value).map_err(|e| e.to_string())?;
        skill.source = path.display().to_string();
        skills.push(skill);
    }
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(skills)
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn checkpoint_dir(root: &Path) -> PathBuf {
    root.join(".agentos").join("checkpoints")
}

#[tauri::command]
fn create_checkpoint(
    project_path: String,
    run_id: String,
    worktree_path: Option<String>,
) -> Result<CheckpointRecord, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() || !safe_id(&run_id) {
        return Err("Nieprawidłowy katalog projektu lub identyfikator zadania".into());
    }
    let dir = checkpoint_dir(&root);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Nie udało się utworzyć checkpointu: {e}"))?;
    let git_head = Command::new("git")
        .args(["-C", &project_path, "rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string());
    let record = CheckpointRecord {
        run_id: run_id.clone(),
        project_path: project_path.clone(),
        created_at: format!("{:?}", SystemTime::now()),
        git_head,
        worktree_path,
    };
    let path = dir.join(format!("{run_id}.json"));
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(record)
}

#[tauri::command]
fn list_checkpoints(project_path: String) -> Result<Vec<CheckpointRecord>, String> {
    let root = PathBuf::from(&project_path);
    let dir = checkpoint_dir(&root);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(record) = serde_json::from_slice(&bytes) {
                records.push(record);
            }
        }
    }
    Ok(records)
}

#[tauri::command]
fn recover_checkpoint(project_path: String, run_id: String) -> Result<CheckpointRecord, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() || !safe_id(&run_id) {
        return Err("Nieprawidłowy katalog projektu lub identyfikator checkpointu".into());
    }
    let path = checkpoint_dir(&root).join(format!("{run_id}.json"));
    let bytes = std::fs::read(&path)
        .map_err(|_| "Checkpoint nie istnieje albo został usunięty".to_string())?;
    let record: CheckpointRecord = serde_json::from_slice(&bytes)
        .map_err(|_| "Checkpoint jest uszkodzony i nie może zostać odzyskany".to_string())?;
    if record.run_id != run_id || record.project_path != project_path {
        return Err("Checkpoint nie pasuje do wybranego projektu".into());
    }
    if let Some(worktree) = &record.worktree_path {
        if !Path::new(worktree).is_dir() {
            return Err("Izolowany worktree checkpointu nie istnieje".into());
        }
    }
    Ok(record)
}

#[tauri::command]
fn prepare_worktree(project_path: String, run_id: String) -> Result<String, String> {
    let root = PathBuf::from(&project_path);
    if !root.join(".git").is_dir() || !safe_id(&run_id) {
        return Err("Izolacja wymaga repozytorium Git i bezpiecznego identyfikatora".into());
    }
    let parent = root.join(".agentos").join("worktrees");
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let target = parent.join(&run_id);
    if target.exists() {
        return Ok(target.display().to_string());
    }
    let output = Command::new("git")
        .args([
            "-C",
            &project_path,
            "worktree",
            "add",
            "--detach",
            target.to_string_lossy().as_ref(),
            "HEAD",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(target.display().to_string())
}

fn validate_http_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|_| "Nieprawidłowy adres URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Dozwolone są tylko adresy HTTP i HTTPS".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let blocked = host == "localhost"
        || host == "localhost.localdomain"
        || host == "0.0.0.0"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || host.starts_with("172.16.")
        || host.starts_with("172.17.")
        || host.starts_with("172.18.")
        || host.starts_with("172.19.")
        || host.starts_with("172.2");
    if blocked {
        return Err("Adres lokalny lub prywatny jest zablokowany przez politykę sieci".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
fn get_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("snapshot.json");
    if !path.is_file() {
        return Ok(Value::Null);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Nieprawidłowy snapshot AgentOS: {e}"))
}

#[tauri::command]
fn save_snapshot(app: tauri::AppHandle, snapshot: Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("snapshot.json");
    let temp = dir.join("snapshot.json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}

fn price_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|raw| raw.parse::<f64>().ok()))
}

#[tauri::command]
async fn discover_model_offers() -> Result<Vec<ModelOfferRecord>, String> {
    let key = get_provider_key("openrouter")?;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("AgentOS/0.1 model catalog")
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .get("https://openrouter.ai/api/v1/models")
        .header("accept", "application/json");
    if let Some(secret) = key {
        request = request.bearer_auth(secret);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Katalog modeli zwrócił {}: {}", status, payload));
    }

    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();
    let mut offers = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Katalog modeli ma nieoczekiwany format".to_string())?
        .iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_string();
            let name = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let pricing = model.get("pricing")?;
            let input_price = pricing.get("prompt").and_then(price_as_f64)?;
            let output_price = pricing.get("completion").and_then(price_as_f64)?;
            let modalities = model
                .pointer("/architecture/input_modalities")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_else(|| vec!["text".to_string()]);
            Some(ModelOfferRecord {
                id,
                name,
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("Brak opisu w katalogu")
                    .chars()
                    .take(180)
                    .collect(),
                context_length: model
                    .get("context_length")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                input_price,
                output_price,
                source: "OpenRouter · katalog live".to_string(),
                free: input_price == 0.0 && output_price == 0.0,
                modalities,
                checked_at: checked_at.clone(),
            })
        })
        .collect::<Vec<_>>();
    offers.sort_by(|left, right| {
        let left_cost = left.input_price + left.output_price;
        let right_cost = right.input_price + right.output_price;
        left_cost
            .partial_cmp(&right_cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.context_length.cmp(&left.context_length))
    });
    offers.truncate(80);
    Ok(offers)
}

#[tauri::command]
fn inspect_project(path: String) -> Result<ProjectRecord, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Wybrana ścieżka nie jest katalogiem".to_string());
    }
    let files = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .take(5000)
        .count();
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Nowy projekt")
        .to_string();
    let kind = if root.join(".git").is_dir() {
        "git"
    } else {
        "folder"
    };
    let context_files = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "PROJECT_CONTEXT.md"]
        .iter()
        .filter(|name| root.join(name).is_file())
        .map(|name| (*name).to_string())
        .collect();
    Ok(ProjectRecord {
        id: format!("project-{}", uuid_like(&path)),
        name,
        path,
        kind: kind.to_string(),
        status: "active".to_string(),
        files,
        last_activity: "teraz".to_string(),
        context_files,
    })
}

#[tauri::command]
fn read_project_context(path: String) -> Result<Vec<ContextFileRecord>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Wybrana ścieżka nie jest katalogiem".to_string());
    }
    let files = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "PROJECT_CONTEXT.md"]
        .iter()
        .filter_map(|name| {
            let file = root.join(name);
            let content = std::fs::read_to_string(&file).ok()?;
            Some(ContextFileRecord {
                name: (*name).to_string(),
                path: file.display().to_string(),
                content: content.chars().take(30_000).collect(),
            })
        })
        .collect::<Vec<_>>();
    Ok(files)
}

fn uuid_like(value: &str) -> String {
    let mut hash: u64 = 14695981039346656037;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("{hash:x}")
}

#[tauri::command]
fn save_provider(provider: ProviderRecord, api_key: String) -> Result<ProviderKeyStatus, String> {
    if !api_key.trim().is_empty() {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &provider.id)
            .map_err(|error| format!("Nie udało się otworzyć magazynu kluczy: {error}"))?;
        entry
            .set_password(api_key.trim())
            .map_err(|error| format!("Nie udało się zapisać klucza w Keychain: {error}"))?;
    }
    Ok(ProviderKeyStatus {
        provider_id: provider.id.clone(),
        has_key: get_provider_key(&provider.id)?.is_some(),
    })
}

#[tauri::command]
fn get_provider_key_statuses(provider_ids: Vec<String>) -> Result<Vec<ProviderKeyStatus>, String> {
    provider_ids
        .into_iter()
        .map(|provider_id| {
            Ok(ProviderKeyStatus {
                has_key: get_provider_key(&provider_id)?.is_some(),
                provider_id,
            })
        })
        .collect()
}

fn get_provider_key(provider_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider_id)
        .map_err(|error| format!("Nie udało się otworzyć magazynu kluczy: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Nie udało się odczytać klucza z Keychain: {error}")),
    }
}

fn extract_model_text(value: &Value) -> String {
    if let Some(text) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return text.to_string();
    }
    if let Some(text) = value.pointer("/content/0/text").and_then(Value::as_str) {
        return text.to_string();
    }
    value.to_string()
}

#[tauri::command]
async fn run_model(
    provider_id: String,
    model: String,
    endpoint: String,
    provider_kind: String,
    prompt: String,
    project_path: String,
    mode: String,
) -> Result<String, String> {
    let key = get_provider_key(&provider_id)?;
    if provider_kind != "ollama" && key.is_none() {
        return Err("Brak klucza API dla wybranego dostawcy".to_string());
    }
    if provider_kind == "ollama"
        && !endpoint.starts_with("http://localhost")
        && !endpoint.starts_with("http://127.0.0.1")
    {
        return Err("Lokalny adapter może łączyć się wyłącznie z localhost".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|error| error.to_string())?;
    let context =
        format!("Projekt: {project_path}\nTryb: {mode}\n\nZadanie użytkownika:\n{prompt}");
    let response = if provider_kind == "anthropic" {
        client
            .post(&endpoint)
            .header("x-api-key", key.unwrap_or_default())
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&json!({
                "model": model,
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": context}]
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?
    } else {
        let mut request = client
            .post(&endpoint)
            .header("content-type", "application/json")
            .json(&json!({
                "model": model,
                "messages": [{"role": "user", "content": context}]
            }));
        if let Some(secret) = key {
            request = request.bearer_auth(secret);
        }
        request.send().await.map_err(|error| error.to_string())?
    };
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if status != StatusCode::OK && !status.is_success() {
        return Err(format!("Dostawca zwrócił {}: {}", status, body));
    }
    Ok(extract_model_text(&body))
}

#[tauri::command]
async fn web_fetch(url: String) -> Result<String, String> {
    let parsed = validate_http_url(&url)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("AgentOS/0.1 research client")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > 2_000_000)
    {
        return Err("Odpowiedź sieciowa przekracza limit 2 MB".to_string());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 2_000_000 {
        return Err("Odpowiedź sieciowa przekracza limit 2 MB".to_string());
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    if !status.is_success() {
        return Err(format!("Strona zwróciła {}", status));
    }
    Ok(text.chars().take(30_000).collect())
}

#[tauri::command]
fn computer_action(action: String, target: String, approved: bool) -> Result<String, String> {
    if !approved {
        return Err("Akcja wymaga jawnego zatwierdzenia".to_string());
    }
    match action.as_str() {
        "open_url" => {
            let parsed = validate_http_url(&target)?;
            Command::new("open")
                .arg(parsed.as_str())
                .status()
                .map_err(|error| error.to_string())?;
            Ok("Otworzono adres w domyślnej przeglądarce".to_string())
        }
        "reveal_project" => {
            let path = Path::new(&target);
            if !path.is_dir() {
                return Err("Katalog projektu nie istnieje".to_string());
            }
            Command::new("open")
                .arg("-R")
                .arg(path)
                .status()
                .map_err(|error| error.to_string())?;
            Ok("Pokazano projekt w Finderze".to_string())
        }
        "open_terminal" => {
            let path = Path::new(&target);
            if !path.is_dir() {
                return Err("Katalog projektu nie istnieje".to_string());
            }
            Command::new("open")
                .args(["-a", "Terminal", target.as_str()])
                .status()
                .map_err(|error| error.to_string())?;
            Ok("Otworzono Terminal w katalogu projektu".to_string())
        }
        "screenshot" => {
            let output = std::env::temp_dir().join("agentos-screenshot.png");
            Command::new("screencapture")
                .args(["-x", output.to_string_lossy().as_ref()])
                .status()
                .map_err(|error| error.to_string())?;
            Ok(format!("Zapisano screenshot: {}", output.display()))
        }
        _ => Err("Ta akcja komputera nie znajduje się na allowliście MVP".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            save_snapshot,
            discover_model_offers,
            inspect_project,
            read_project_context,
            write_project_context,
            create_checkpoint,
            list_checkpoints,
            recover_checkpoint,
            prepare_worktree,
            list_project_skills,
            save_provider,
            get_provider_key_statuses,
            run_model,
            web_fetch,
            computer_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgentOS");
}

fn main() {
    run();
}

#[cfg(test)]
mod tests {
    use super::{uuid_like, valid_skill_manifest, validate_http_url, KEYRING_SERVICE};
    use keyring::Entry;

    #[test]
    fn validates_skill_manifest_contract() {
        let good = serde_json::json!({"id":"review","name":"Review","version":"1.0.0","description":"Review code","source":"local"});
        let bad = serde_json::json!({"id":"review"});
        assert!(valid_skill_manifest(&good));
        assert!(!valid_skill_manifest(&bad));
    }

    #[test]
    fn blocks_private_network_targets() {
        assert!(validate_http_url("http://127.0.0.1:8080").is_err());
        assert!(validate_http_url("http://192.168.1.20").is_err());
        assert!(validate_http_url("http://10.0.0.5").is_err());
    }

    #[test]
    fn accepts_public_https_targets() {
        assert!(validate_http_url("https://example.com/research").is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keychain_round_trip_works() {
        let account = format!("regression-test-{}", uuid_like("agentos-keychain"));
        let entry =
            Entry::new(KEYRING_SERVICE, &account).expect("Keychain entry should be constructible");
        entry
            .set_password("agentos-regression-secret")
            .expect("Keychain write should succeed");
        assert_eq!(
            entry.get_password().expect("Keychain read should succeed"),
            "agentos-regression-secret"
        );
        entry
            .delete_credential()
            .expect("Keychain cleanup should succeed");
    }
}
