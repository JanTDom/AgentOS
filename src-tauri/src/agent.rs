//! Pętla agenta AgentOS: wywołanie modelu z narzędziami oraz bezpieczne
//! operacje na plikach projektu (odczyt, wyszukiwanie, zapis z kopią
//! zapasową i cofaniem) i polecenia terminala uruchamiane za zgodą.
//!
//! Zasada: agent nigdy nie wychodzi poza folder projektu, nie usuwa plików
//! i nie pisze do `.git`. Każdy zapis ma kopię „przed”, którą można przywrócić.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use walkdir::WalkDir;

const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt", "__pycache__",
    ".venv", "venv", ".DS_Store", ".cache", ".turbo", ".agentos-history",
];
const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_TOOL_TEXT: usize = 60_000;
const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;

// ---------- wspólne typy ----------

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentReply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tools_unsupported: bool,
}

fn is_local(kind: &str) -> bool {
    kind == "ollama" || kind == "lmstudio" || kind == "local"
}

fn local_name(kind: &str) -> &'static str {
    match kind { "lmstudio" => "LM Studio", "local" => "lokalnym serwerem modeli", _ => "Ollama" }
}

fn check_local_endpoint(endpoint: &str) -> Result<(), String> {
    if endpoint.starts_with("http://localhost") || endpoint.starts_with("http://127.0.0.1") {
        Ok(())
    } else {
        Err("Model lokalny może łączyć się wyłącznie z tym komputerem (localhost).".to_string())
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn truncate_text(text: String, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text;
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{cut}\n\n[… obcięto — pokazano pierwsze {limit} znaków]")
}

fn friendly_request_error(error: reqwest::Error, kind: &str) -> String {
    if error.is_timeout() {
        return "Model nie odpowiedział w wyznaczonym czasie. Spróbuj ponownie albo wybierz szybszy model.".to_string();
    }
    if error.is_connect() {
        if is_local(kind) {
            return format!("Nie można połączyć się z {}. Sprawdź, czy program działa na tym Macu, i spróbuj ponownie.", local_name(kind));
        }
        return "Brak połączenia z serwerem dostawcy. Sprawdź internet albo przełącz się na model lokalny.".to_string();
    }
    format!("Błąd połączenia: {error}")
}

fn friendly_status_error(status: reqwest::StatusCode, body: &Value) -> String {
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| body.pointer("/error").and_then(Value::as_str))
        .or_else(|| body.pointer("/message").and_then(Value::as_str))
        .map(|s| s.to_string())
        .unwrap_or_else(|| truncate_text(body.to_string(), 400));
    match status.as_u16() {
        401 | 403 => format!("Dostawca odrzucił klucz API ({}). Sprawdź klucz w ekranie Modele. Szczegóły: {message}", status.as_u16()),
        404 => format!("Dostawca nie zna tego modelu albo adresu (404). Wybierz model z listy w ekranie Modele. Szczegóły: {message}"),
        429 => format!("Przekroczono limit zapytań lub środków u dostawcy (429). Szczegóły: {message}"),
        _ => format!("Dostawca zwrócił błąd {}: {message}", status.as_u16()),
    }
}

// ---------- wywołanie modelu ----------

#[tauri::command]
pub async fn agent_turn(
    provider_id: String,
    provider_kind: String,
    endpoint: String,
    model: String,
    system: String,
    messages: Vec<AgentMessage>,
    tools: Vec<ToolSpec>,
) -> Result<AgentReply, String> {
    if model.trim().is_empty() {
        return Err("Dla tego dostawcy nie wybrano modelu. Otwórz Modele i wybierz model z listy.".to_string());
    }
    let key = if is_local(&provider_kind) {
        check_local_endpoint(&endpoint)?;
        None
    } else {
        match crate::get_provider_key(&provider_id)? {
            Some(key) => Some(key),
            None => return Err("Brak klucza API dla tego dostawcy. Dodaj klucz w ekranie Modele.".to_string()),
        }
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    if provider_kind == "anthropic" {
        return anthropic_turn(&client, &endpoint, key.as_deref().unwrap_or_default(), &model, &system, &messages, &tools).await;
    }
    match openai_turn(&client, &provider_kind, &endpoint, key.as_deref(), &model, &system, &messages, &tools).await {
        Err(error) if !tools.is_empty() && looks_like_tools_unsupported(&error) => {
            let mut reply = openai_turn(&client, &provider_kind, &endpoint, key.as_deref(), &model, &system, &messages, &[]).await?;
            reply.tools_unsupported = true;
            Ok(reply)
        }
        other => other,
    }
}

fn looks_like_tools_unsupported(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("does not support tools")
        || lower.contains("tools is not supported")
        || lower.contains("tool use is not supported")
        || lower.contains("function calling is not")
}

fn object_input(value: &Value) -> Value {
    if value.is_object() { value.clone() } else { json!({}) }
}

fn anthropic_messages(messages: &[AgentMessage]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for message in messages {
        let (role, blocks): (&str, Vec<Value>) = match message.role.as_str() {
            "assistant" => {
                let mut blocks = Vec::new();
                if !message.text.trim().is_empty() {
                    blocks.push(json!({"type": "text", "text": message.text}));
                }
                for call in &message.tool_calls {
                    blocks.push(json!({"type": "tool_use", "id": call.id, "name": call.name, "input": object_input(&call.input)}));
                }
                ("assistant", blocks)
            }
            "tool" => (
                "user",
                vec![json!({"type": "tool_result", "tool_use_id": message.tool_call_id, "content": message.content, "is_error": message.is_error})],
            ),
            _ => {
                if message.text.trim().is_empty() { ("user", vec![]) } else { ("user", vec![json!({"type": "text", "text": message.text})]) }
            }
        };
        if blocks.is_empty() {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if last["role"] == role {
                if let Some(array) = last["content"].as_array_mut() {
                    array.extend(blocks);
                    continue;
                }
            }
        }
        out.push(json!({"role": role, "content": blocks}));
    }
    out
}

async fn anthropic_turn(
    client: &Client,
    endpoint: &str,
    key: &str,
    model: &str,
    system: &str,
    messages: &[AgentMessage],
    tools: &[ToolSpec],
) -> Result<AgentReply, String> {
    let mut body = json!({
        "model": model,
        "max_tokens": 8192,
        "messages": anthropic_messages(messages),
    });
    if !system.trim().is_empty() {
        body["system"] = json!(system);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools.iter().map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters})).collect(),
        );
    }
    let response = client
        .post(endpoint)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| friendly_request_error(e, "anthropic"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("Nieczytelna odpowiedź dostawcy: {e}"))?;
    if !status.is_success() {
        return Err(friendly_status_error(status, &value));
    }
    let mut reply = AgentReply::default();
    if let Some(blocks) = value["content"].as_array() {
        for block in blocks {
            match block["type"].as_str() {
                Some("text") => {
                    if !reply.text.is_empty() { reply.text.push('\n'); }
                    reply.text.push_str(block["text"].as_str().unwrap_or_default());
                }
                Some("tool_use") => reply.tool_calls.push(ToolCall {
                    id: block["id"].as_str().unwrap_or_default().to_string(),
                    name: block["name"].as_str().unwrap_or_default().to_string(),
                    input: object_input(&block["input"]),
                }),
                _ => {}
            }
        }
    }
    reply.input_tokens = value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0);
    reply.output_tokens = value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0);
    Ok(reply)
}

fn openai_messages(system: &str, messages: &[AgentMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    if !system.trim().is_empty() {
        out.push(json!({"role": "system", "content": system}));
    }
    for message in messages {
        match message.role.as_str() {
            "assistant" => {
                let mut item = json!({"role": "assistant", "content": if message.text.is_empty() { Value::Null } else { json!(message.text) }});
                if !message.tool_calls.is_empty() {
                    item["tool_calls"] = Value::Array(
                        message.tool_calls.iter().map(|c| json!({
                            "id": c.id,
                            "type": "function",
                            "function": {"name": c.name, "arguments": object_input(&c.input).to_string()}
                        })).collect(),
                    );
                }
                out.push(item);
            }
            "tool" => out.push(json!({"role": "tool", "tool_call_id": message.tool_call_id, "content": message.content})),
            _ => out.push(json!({"role": "user", "content": message.text})),
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
async fn openai_turn(
    client: &Client,
    kind: &str,
    endpoint: &str,
    key: Option<&str>,
    model: &str,
    system: &str,
    messages: &[AgentMessage],
    tools: &[ToolSpec],
) -> Result<AgentReply, String> {
    let mut body = json!({"model": model, "messages": openai_messages(system, messages)});
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools.iter().map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}})).collect(),
        );
    }
    let mut request = client.post(endpoint).header("content-type", "application/json").json(&body);
    if let Some(secret) = key {
        request = request.bearer_auth(secret);
    }
    let response = request.send().await.map_err(|e| friendly_request_error(e, kind))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("Nieczytelna odpowiedź dostawcy: {e}"))?;
    if !status.is_success() {
        return Err(friendly_status_error(status, &value));
    }
    let message = &value["choices"][0]["message"];
    let mut reply = AgentReply {
        text: message["content"].as_str().unwrap_or_default().to_string(),
        ..AgentReply::default()
    };
    if let Some(calls) = message["tool_calls"].as_array() {
        for (index, call) in calls.iter().enumerate() {
            let raw = &call["function"]["arguments"];
            let input = match raw {
                Value::String(text) => serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({})),
                Value::Object(_) => raw.clone(),
                _ => json!({}),
            };
            reply.tool_calls.push(ToolCall {
                id: call["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("call_{}_{}", now_ms(), index)),
                name: call["function"]["name"].as_str().unwrap_or_default().to_string(),
                input: object_input(&input),
            });
        }
    }
    reply.input_tokens = value.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(0);
    reply.output_tokens = value.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0);
    Ok(reply)
}

/// Lista modeli dostępnych u dostawcy (lokalnego albo chmurowego).
#[tauri::command]
pub async fn list_models(provider_id: String, provider_kind: String, endpoint: String) -> Result<Vec<String>, String> {
    let base = endpoint
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .trim_end_matches("/messages")
        .to_string();
    let url = format!("{base}/models");
    let local = is_local(&provider_kind);
    if local {
        check_local_endpoint(&endpoint)?;
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(if local { 4 } else { 20 }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(&url);
    if !local {
        let key = crate::get_provider_key(&provider_id)?
            .ok_or_else(|| "Najpierw zapisz klucz API.".to_string())?;
        request = if provider_kind == "anthropic" {
            request.header("x-api-key", key).header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(key)
        };
    }
    let response = request.send().await.map_err(|e| friendly_request_error(e, &provider_kind))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|e| format!("Nieczytelna odpowiedź: {e}"))?;
    if !status.is_success() {
        return Err(friendly_status_error(status, &value));
    }
    let mut models: Vec<String> = value["data"]
        .as_array()
        .or_else(|| value["models"].as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["id"].as_str().or_else(|| item["name"].as_str()))
                .map(|id| id.trim_start_matches("models/").to_string())
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();
    Ok(models)
}

// ---------- pliki projektu ----------

fn project_root(project_path: &str) -> Result<PathBuf, String> {
    if project_path.trim().is_empty() {
        return Err("Ta rozmowa nie ma projektu — operacje na plikach są niedostępne.".to_string());
    }
    fs::canonicalize(project_path).map_err(|_| "Folder projektu nie istnieje albo jest niedostępny.".to_string())
}

/// Zamienia ścieżkę podaną przez agenta na ścieżkę wewnątrz projektu.
fn resolve_in_project(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    let relative: PathBuf = if Path::new(trimmed).is_absolute() {
        Path::new(trimmed)
            .strip_prefix(root)
            .map(Path::to_path_buf)
            .map_err(|_| "Ścieżka wskazuje poza folder projektu — odmowa.".to_string())?
    } else {
        PathBuf::from(trimmed)
    };
    let mut out = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err("Ścieżka wychodzi poza folder projektu — odmowa.".to_string()),
        }
    }
    let mut existing = out.clone();
    while !existing.exists() {
        if !existing.pop() {
            break;
        }
    }
    let canonical = fs::canonicalize(&existing).unwrap_or(existing);
    if !canonical.starts_with(root) {
        return Err("Ścieżka (przez dowiązanie) prowadzi poza projekt — odmowa.".to_string());
    }
    Ok(out)
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string()
}

fn is_ignored(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    path: String,
    kind: String,
    size: u64,
}

#[tauri::command]
pub fn fs_list(project_path: String, path: Option<String>, depth: Option<usize>) -> Result<Vec<FileEntry>, String> {
    let root = project_root(&project_path)?;
    let start = resolve_in_project(&root, path.as_deref().unwrap_or(""))?;
    if !start.is_dir() {
        return Err("To nie jest folder.".to_string());
    }
    let max_depth = depth.unwrap_or(2).clamp(1, 5);
    let mut entries = Vec::new();
    let walker = WalkDir::new(&start)
        .min_depth(1)
        .max_depth(max_depth)
        .sort_by_file_name()
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_ignored(&entry.file_name().to_string_lossy()));
    for entry in walker.filter_map(Result::ok) {
        let kind = if entry.file_type().is_dir() { "dir" } else { "file" };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push(FileEntry { path: relative_display(&root, entry.path()), kind: kind.to_string(), size });
        if entries.len() >= 600 {
            break;
        }
    }
    Ok(entries)
}

fn extract_document_text(path: &Path) -> Result<Option<String>, String> {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let path_str = path.to_string_lossy().to_string();
    let output = match extension.as_str() {
        "docx" | "doc" | "rtf" | "odt" | "pages" | "webarchive" => Command::new("/usr/bin/textutil")
            .args(["-convert", "txt", "-stdout", &path_str])
            .output(),
        "pdf" => {
            let script = "function run(argv){ObjC.import('PDFKit');var d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));if(!d||d.isNil()){return '';}var s=d.string;return (s&&!s.isNil())?s.js:'';}";
            Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", script, &path_str]).output()
        }
        "xlsx" | "xls" | "numbers" => {
            return Err("Arkusze XLSX nie są jeszcze czytane bezpośrednio. Wyeksportuj arkusz do CSV albo poproś o odczyt poleceniem (np. Python), jeśli jest dostępny.".to_string())
        }
        _ => return Ok(None),
    };
    let output = output.map_err(|e| format!("Nie udało się odczytać dokumentu: {e}"))?;
    if !output.status.success() {
        return Err(format!("Nie udało się wyodrębnić tekstu: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.trim().is_empty() {
        return Err("Dokument nie zawiera tekstu do odczytu (może to być skan bez warstwy tekstowej).".to_string());
    }
    Ok(Some(text))
}

#[tauri::command]
pub fn fs_read(project_path: String, path: String) -> Result<String, String> {
    let root = project_root(&project_path)?;
    let target = resolve_in_project(&root, &path)?;
    if !target.is_file() {
        return Err(format!("Plik „{path}” nie istnieje."));
    }
    if let Some(text) = extract_document_text(&target)? {
        return Ok(truncate_text(text, MAX_TOOL_TEXT));
    }
    let size = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    let mut file = fs::File::open(&target).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    file.by_ref().take(MAX_READ_BYTES).read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    if buffer.iter().take(8000).any(|byte| *byte == 0) {
        return Err(format!("„{path}” to plik binarny ({size} bajtów) — nie da się go odczytać jako tekst."));
    }
    let mut text = String::from_utf8_lossy(&buffer).to_string();
    if size > MAX_READ_BYTES {
        text.push_str(&format!("\n\n[… plik ma {size} bajtów, pokazano początek]"));
    }
    Ok(truncate_text(text, MAX_TOOL_TEXT))
}

#[tauri::command]
pub fn fs_search(project_path: String, query: String) -> Result<Vec<String>, String> {
    let root = project_root(&project_path)?;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Err("Podaj tekst do wyszukania.".to_string());
    }
    let mut results = Vec::new();
    let walker = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_ignored(&entry.file_name().to_string_lossy()));
    for entry in walker.filter_map(Result::ok).filter(|e| e.file_type().is_file()) {
        let relative = relative_display(&root, entry.path());
        if relative.to_lowercase().contains(&needle) {
            results.push(format!("{relative} (nazwa pliku)"));
        }
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > 1_000_000 {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else { continue };
        if bytes.iter().take(8000).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (number, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                let snippet: String = line.trim().chars().take(200).collect();
                results.push(format!("{relative}:{}: {snippet}", number + 1));
                if results.len() >= 120 {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeBackup {
    id: String,
    path: String,
    absolute_path: String,
    existed: bool,
    before: Option<String>,
    after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    id: String,
    path: String,
    kind: String,
    before: Option<String>,
    after: String,
}

fn history_dir(app: &tauri::AppHandle, conversation_id: &str) -> Result<PathBuf, String> {
    if conversation_id.is_empty() || !conversation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Nieprawidłowy identyfikator rozmowy.".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history")
        .join(conversation_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Nie można utworzyć historii zmian: {e}"))?;
    Ok(dir)
}

/// Zapisuje plik w projekcie. Najpierw tworzy kopię stanu „przed”.
#[tauri::command]
pub fn fs_write(app: tauri::AppHandle, project_path: String, path: String, content: String, conversation_id: String) -> Result<ChangeRecord, String> {
    let root = project_root(&project_path)?;
    let target = resolve_in_project(&root, &path)?;
    let relative = relative_display(&root, &target);
    if relative.split('/').any(|part| part == ".git") {
        return Err("Zapis do katalogu .git jest zablokowany.".to_string());
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err("Plik jest zbyt duży (limit 2 MB na jeden zapis).".to_string());
    }
    if target.is_dir() {
        return Err("Pod tą ścieżką jest folder, nie plik.".to_string());
    }
    let existed = target.is_file();
    let before = if existed {
        Some(fs::read_to_string(&target).map_err(|_| "Istniejący plik nie jest tekstowy — agent nie nadpisuje plików binarnych.".to_string())?)
    } else {
        None
    };
    let id = format!("change-{}", now_ms());
    let backup = ChangeBackup {
        id: id.clone(),
        path: relative.clone(),
        absolute_path: target.to_string_lossy().to_string(),
        existed,
        before: before.clone(),
        after: content.clone(),
    };
    let dir = history_dir(&app, &conversation_id)?;
    fs::write(dir.join(format!("{id}.json")), serde_json::to_vec(&backup).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Nie udało się zapisać kopii zapasowej — plik nie został zmieniony: {e}"))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, &content).map_err(|e| format!("Nie udało się zapisać pliku: {e}"))?;
    Ok(ChangeRecord { id, path: relative, kind: if existed { "modified" } else { "created" }.to_string(), before, after: content })
}

/// Przywraca stan pliku sprzed zmiany agenta.
#[tauri::command]
pub fn change_undo(app: tauri::AppHandle, conversation_id: String, change_id: String, force: bool) -> Result<String, String> {
    if !change_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Nieprawidłowy identyfikator zmiany.".to_string());
    }
    let dir = history_dir(&app, &conversation_id)?;
    let raw = fs::read(dir.join(format!("{change_id}.json"))).map_err(|_| "Nie znaleziono kopii zapasowej tej zmiany.".to_string())?;
    let backup: ChangeBackup = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let target = PathBuf::from(&backup.absolute_path);
    let current = fs::read_to_string(&target).ok();
    if !force && current.as_deref() != Some(backup.after.as_str()) {
        return Err(format!("CONFLICT: „{}” zmienił się po zapisie agenta. Cofnięcie nadpisze późniejsze zmiany.", backup.path));
    }
    if backup.existed {
        fs::write(&target, backup.before.unwrap_or_default()).map_err(|e| e.to_string())?;
        Ok(format!("Przywrócono poprzednią wersję {}", backup.path))
    } else {
        if target.is_file() {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        Ok(format!("Usunięto plik utworzony przez agenta: {}", backup.path))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u128,
    timed_out: bool,
}

/// Uruchamia polecenie w folderze projektu. Interfejs prosi o zgodę przed wywołaniem.
#[tauri::command]
pub async fn run_command(project_path: String, command: String, timeout_secs: Option<u64>) -> Result<CommandResult, String> {
    let root = project_root(&project_path)?;
    if command.trim().is_empty() || command.len() > 4000 {
        return Err("Polecenie jest puste albo zbyt długie.".to_string());
    }
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120).clamp(5, 600));
    tokio::task::spawn_blocking(move || {
        use std::os::unix::process::CommandExt;
        let started = Instant::now();
        let mut child = Command::new("/bin/zsh")
            .args(["-lc", &command])
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("Nie udało się uruchomić polecenia: {e}"))?;
        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        let out_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(pipe) = stdout_pipe.as_mut() { let _ = pipe.take(4_000_000).read_to_end(&mut buf); }
            buf
        });
        let err_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(pipe) = stderr_pipe.as_mut() { let _ = pipe.take(4_000_000).read_to_end(&mut buf); }
            buf
        });
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break Some(status);
            }
            if started.elapsed() > timeout {
                timed_out = true;
                let _ = Command::new("/bin/kill").args(["-TERM", &format!("-{}", child.id())]).status();
                std::thread::sleep(Duration::from_millis(500));
                let _ = child.kill();
                break child.wait().ok();
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let stdout = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).to_string();
        let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).to_string();
        Ok(CommandResult {
            exit_code: status.and_then(|s| s.code()),
            stdout: truncate_text(stdout, 20_000),
            stderr: truncate_text(stderr, 12_000),
            duration_ms: started.elapsed().as_millis(),
            timed_out,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tworzy nowy folder projektu wewnątrz wskazanego folderu nadrzędnego.
#[tauri::command]
pub fn create_project_folder(parent: String, name: String) -> Result<String, String> {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect();
    let clean = clean.trim().to_string();
    if clean.is_empty() {
        return Err("Podaj nazwę projektu.".to_string());
    }
    let parent = fs::canonicalize(&parent).map_err(|_| "Wybrany folder nadrzędny nie istnieje.".to_string())?;
    let target = parent.join(&clean);
    if target.exists() && fs::read_dir(&target).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(format!("Folder „{clean}” już istnieje i nie jest pusty. Wybierz inną nazwę."));
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Otwiera folder lub plik projektu w Finderze, Terminalu albo domyślnej aplikacji.
#[tauri::command]
pub fn open_in_system(project_path: String, path: Option<String>, mode: String) -> Result<(), String> {
    let root = project_root(&project_path)?;
    let target = resolve_in_project(&root, path.as_deref().unwrap_or(""))?;
    let target_str = target.to_string_lossy().to_string();
    let status = match mode.as_str() {
        "finder" => Command::new("/usr/bin/open").args(["-R", &target_str]).status(),
        "terminal" => Command::new("/usr/bin/open").args(["-a", "Terminal", &target_str]).status(),
        "default" => Command::new("/usr/bin/open").arg(&target_str).status(),
        _ => return Err("Nieznany sposób otwarcia.".to_string()),
    };
    status.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_project() {
        let root = std::env::temp_dir().join(format!("agentos-test-{}", now_ms()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(&root).unwrap();
        assert!(resolve_in_project(&root, "../etc/passwd").is_err());
        assert!(resolve_in_project(&root, "/etc/passwd").is_err());
        assert!(resolve_in_project(&root, "src/app.ts").is_ok());
        let inside = root.join("a.txt");
        assert!(resolve_in_project(&root, inside.to_str().unwrap()).is_ok());
    }

    #[test]
    fn merges_tool_results_for_anthropic() {
        let messages = vec![
            AgentMessage { role: "user".into(), text: "hej".into(), tool_calls: vec![], tool_call_id: String::new(), content: String::new(), is_error: false },
            AgentMessage { role: "assistant".into(), text: String::new(), tool_calls: vec![
                ToolCall { id: "a".into(), name: "read_file".into(), input: json!({"path": "x"}) },
                ToolCall { id: "b".into(), name: "read_file".into(), input: json!({"path": "y"}) },
            ], tool_call_id: String::new(), content: String::new(), is_error: false },
            AgentMessage { role: "tool".into(), text: String::new(), tool_calls: vec![], tool_call_id: "a".into(), content: "1".into(), is_error: false },
            AgentMessage { role: "tool".into(), text: String::new(), tool_calls: vec![], tool_call_id: "b".into(), content: "2".into(), is_error: false },
        ];
        let built = anthropic_messages(&messages);
        assert_eq!(built.len(), 3);
        assert_eq!(built[2]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn detects_missing_tool_support() {
        assert!(looks_like_tools_unsupported("Dostawca zwrócił błąd 400: registry.ollama.ai/library/gemma does not support tools"));
        assert!(!looks_like_tools_unsupported("401 unauthorized"));
    }
}

/// Jednorazowa kopia poprzedniego formatu danych przed migracją.
#[tauri::command]
pub fn backup_snapshot(app: tauri::AppHandle, label: String) -> Result<bool, String> {
    if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Nieprawidłowa etykieta kopii.".to_string());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let source = dir.join("snapshot.json");
    let target = dir.join(format!("snapshot-{label}.json"));
    if !source.is_file() || target.exists() {
        return Ok(false);
    }
    fs::copy(&source, &target).map_err(|e| e.to_string())?;
    Ok(true)
}
