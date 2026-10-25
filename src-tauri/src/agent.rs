//! Adaptery modeli, streaming SSE i ograniczone operacje na plikach.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::Manager;
use walkdir::WalkDir;

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
    pub stop_reason: String,
}
#[derive(Clone, Serialize)]
pub struct Delta {
    pub text: String,
}
pub(crate) fn is_local(k: &str) -> bool {
    matches!(k, "ollama" | "lmstudio" | "local")
}
pub(crate) fn check_local_endpoint(e: &str) -> Result<(), String> {
    crate::network::local_endpoint(e).map(|_| ())
}
pub(crate) fn friendly_request_error(e: reqwest::Error, _: &str) -> String {
    if e.is_timeout() {
        "Model nie odpowiedział w wyznaczonym czasie.".into()
    } else if e.is_connect() {
        "Nie można połączyć się z dostawcą. Sprawdź połączenie.".into()
    } else {
        format!("Błąd połączenia: {e}")
    }
}
pub(crate) fn friendly_status_error(s: reqwest::StatusCode, b: &Value) -> String {
    format!(
        "Dostawca HTTP {}: {}",
        s.as_u16(),
        b.pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Nieprawidłowa odpowiedź.")
            .chars()
            .take(500)
            .collect::<String>()
    )
}
fn obj(v: &Value) -> Value {
    if v.is_object() {
        v.clone()
    } else {
        json!({})
    }
}
fn parse_input(v: &Value) -> Result<Value, String> {
    let v = if let Some(s) = v.as_str() {
        serde_json::from_str(s).map_err(|e| format!("Niepełne argumenty narzędzia: {e}"))?
    } else {
        v.clone()
    };
    if !v.is_object() {
        return Err("Argumenty narzędzia muszą być obiektem.".into());
    }
    Ok(v)
}
fn messages(system: &str, msgs: &[AgentMessage], anthropic: bool, responses: bool) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    if !anthropic && !responses && !system.is_empty() {
        out.push(json!({"role":"system","content":system}));
    }
    for m in msgs {
        if responses {
            match m.role.as_str(){"assistant"=>{if !m.text.is_empty(){out.push(json!({"role":"assistant","content":m.text}));}for c in &m.tool_calls{out.push(json!({"type":"function_call","call_id":c.id,"name":c.name,"arguments":c.input.to_string()}));}},"tool"=>out.push(json!({"type":"function_call_output","call_id":m.tool_call_id,"output":m.content})),_=>out.push(json!({"role":"user","content":m.text})),}
            continue;
        }
        if anthropic {
            let (role, blocks) = match m.role.as_str() {
                "assistant" => {
                    let mut b = vec![];
                    if !m.text.is_empty() {
                        b.push(json!({"type":"text","text":m.text}));
                    }
                    for c in &m.tool_calls {
                        b.push(json!({"type":"tool_use","id":c.id,"name":c.name,"input":obj(&c.input)}));
                    }
                    ("assistant", b)
                }
                "tool" => (
                    "user",
                    vec![
                        json!({"type":"tool_result","tool_use_id":m.tool_call_id,"content":m.content,"is_error":m.is_error}),
                    ],
                ),
                _ => ("user", vec![json!({"type":"text","text":m.text})]),
            };
            if blocks.is_empty() {
                continue;
            }
            if let Some(last) = out.last_mut() {
                if last["role"] == role {
                    last["content"].as_array_mut().unwrap().extend(blocks);
                    continue;
                }
            }
            out.push(json!({"role":role,"content":blocks}));
            continue;
        }
        match m.role.as_str() {
            "assistant" => {
                let mut v = json!({"role":"assistant","content":m.text});
                if !m.tool_calls.is_empty() {
                    v["tool_calls"]=json!(m.tool_calls.iter().map(|c|json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.input.to_string()}})).collect::<Vec<_>>());
                }
                out.push(v);
            }
            "tool" => {
                out.push(json!({"role":"tool","tool_call_id":m.tool_call_id,"content":m.content}))
            }
            _ => out.push(json!({"role":"user","content":m.text})),
        }
    }
    out
}
fn responses_endpoint(e: &str) -> String {
    format!(
        "{}/responses",
        e.trim_end_matches('/')
            .trim_end_matches("/chat/completions")
            .trim_end_matches("/responses")
    )
}
#[tauri::command]
pub async fn agent_turn(
    provider_id: String,
    provider_kind: String,
    endpoint: String,
    model: String,
    system: String,
    messages: Vec<AgentMessage>,
    tools: Vec<ToolSpec>,
    on_delta: tauri::ipc::Channel<Delta>,
) -> Result<AgentReply, String> {
    crate::operations::cancellable(turn(
        provider_id,
        provider_kind,
        endpoint,
        model,
        system,
        messages,
        tools,
        on_delta,
    ))
    .await
}
async fn turn(
    provider_id: String,
    kind: String,
    endpoint: String,
    model: String,
    system: String,
    msgs: Vec<AgentMessage>,
    tools: Vec<ToolSpec>,
    channel: tauri::ipc::Channel<Delta>,
) -> Result<AgentReply, String> {
    if model.trim().is_empty() {
        return Err("Wybierz model w ekranie Modele.".into());
    }
    if msgs
        .iter()
        .map(|m| {
            m.text.len()
                + m.content.len()
                + m.tool_calls
                    .iter()
                    .map(|c| c.input.to_string().len())
                    .sum::<usize>()
        })
        .sum::<usize>()
        + system.len()
        > 2_000_000
    {
        return Err("Historia przekracza bezpieczny limit. Rozpocznij nową rozmowę.".into());
    }
    let local = is_local(&kind);
    let key = if local {
        None
    } else {
        Some(crate::get_provider_key(&provider_id)?.ok_or("Brak klucza API.")?)
    };
    let client = crate::network::model_client(&endpoint, local).await?;
    let ant = kind == "anthropic";
    let resp = kind == "openai";
    let url = if resp {
        responses_endpoint(&endpoint)
    } else {
        endpoint
    };
    let mut body = if ant {
        json!({"model":model,"max_tokens":8192,"system":system,"messages":messages("",&msgs,true,false),"stream":true})
    } else if resp {
        json!({"model":model,"instructions":system,"input":messages("",&msgs,false,true),"store":false,"stream":true,"max_output_tokens":8192})
    } else {
        json!({"model":model,"messages":messages(&system,&msgs,false,false),"stream":true,"max_tokens":8192,"stream_options":{"include_usage":true}})
    };
    if !tools.is_empty() {
        body["tools"]=json!(tools.iter().map(|t|if ant{json!({"name":t.name,"description":t.description,"input_schema":t.parameters})}else if resp{json!({"type":"function","name":t.name,"description":t.description,"parameters":t.parameters})}else{json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}})}).collect::<Vec<_>>());
    }
    let mut req = client.post(url).json(&body);
    if let Some(k) = key {
        req = if ant {
            req.header("x-api-key", k)
                .header("anthropic-version", "2023-06-01")
        } else {
            req.bearer_auth(k)
        };
    }
    let mut r = req
        .send()
        .await
        .map_err(|e| friendly_request_error(e, &kind))?;
    if !r.status().is_success() {
        let s = r.status();
        let b = crate::network::limited(r, 64_000).await?;
        let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
        return Err(friendly_status_error(s, &v));
    }
    let sse = r
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    if !sse {
        return parse_reply(
            &serde_json::from_slice(&crate::network::limited(r, 4_000_000).await?)
                .map_err(|e| e.to_string())?,
            ant,
            resp,
        );
    }
    let mut reply = AgentReply::default();
    let mut buffer = Vec::new();
    let mut total = 0;
    let mut calls: std::collections::BTreeMap<usize, (String, String, String)> = Default::default();
    let mut finished = false;
    while let Some(chunk) = r.chunk().await.map_err(|e| e.to_string())? {
        total += chunk.len();
        if total > 8_000_000 {
            return Err("Strumień przekracza limit 8 MB.".into());
        }
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line =
                String::from_utf8(buffer.drain(..=end).collect()).map_err(|e| e.to_string())?;
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                finished = true;
                continue;
            }
            if data.is_empty() {
                continue;
            }
            let v: Value =
                serde_json::from_str(data).map_err(|e| format!("Nieprawidłowy strumień: {e}"))?;
            if v["type"] == "error" || v.get("error").is_some() {
                return Err(format!(
                    "Błąd strumienia: {}",
                    v["error"]["message"]
                        .as_str()
                        .unwrap_or("przerwana odpowiedź")
                ));
            }
            let mut text = "";
            if ant {
                match v["type"].as_str() {
                    Some("message_start") => {
                        reply.input_tokens = v
                            .pointer("/message/usage/input_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                    }
                    Some("content_block_start") if v["content_block"]["type"] == "tool_use" => {
                        calls.insert(
                            v["index"].as_u64().unwrap_or(0) as usize,
                            (
                                v["content_block"]["id"].as_str().unwrap_or("").into(),
                                v["content_block"]["name"].as_str().unwrap_or("").into(),
                                String::new(),
                            ),
                        );
                    }
                    Some("content_block_delta") => {
                        text = v["delta"]["text"].as_str().unwrap_or("");
                        if let Some(s) = v["delta"]["partial_json"].as_str() {
                            if let Some(c) =
                                calls.get_mut(&(v["index"].as_u64().unwrap_or(0) as usize))
                            {
                                c.2.push_str(s);
                            }
                        }
                    }
                    Some("message_delta") => {
                        reply.output_tokens = v
                            .pointer("/usage/output_tokens")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        reply.stop_reason = v["delta"]["stop_reason"].as_str().unwrap_or("").into();
                    }
                    Some("message_stop") => finished = true,
                    _ => {}
                }
            } else if resp {
                match v["type"].as_str() {
                    Some("response.output_text.delta") => text = v["delta"].as_str().unwrap_or(""),
                    Some("response.completed") => {
                        let parsed = parse_reply(&v["response"], false, true)?;
                        reply.tool_calls = parsed.tool_calls;
                        reply.input_tokens = parsed.input_tokens;
                        reply.output_tokens = parsed.output_tokens;
                        reply.stop_reason = parsed.stop_reason;
                        finished = true;
                    }
                    Some("response.incomplete") | Some("response.failed") => {
                        return Err(
                            "Dostawca zwrócił niepełną odpowiedź — nie wykonano narzędzi.".into(),
                        )
                    }
                    _ => {}
                }
            } else {
                text = v
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(ts) = v
                    .pointer("/choices/0/delta/tool_calls")
                    .and_then(Value::as_array)
                {
                    for t in ts {
                        let c = calls
                            .entry(t["index"].as_u64().unwrap_or(0) as usize)
                            .or_default();
                        if let Some(s) = t["id"].as_str() {
                            c.0.push_str(s);
                        }
                        if let Some(s) = t["function"]["name"].as_str() {
                            c.1.push_str(s);
                        }
                        if let Some(s) = t["function"]["arguments"].as_str() {
                            c.2.push_str(s);
                        }
                    }
                }
                if let Some(s) = v
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                {
                    reply.stop_reason = s.into();
                }
                if let Some(n) = v.pointer("/usage/prompt_tokens").and_then(Value::as_u64) {
                    reply.input_tokens = n;
                }
                if let Some(n) = v
                    .pointer("/usage/completion_tokens")
                    .and_then(Value::as_u64)
                {
                    reply.output_tokens = n;
                }
            }
            if !text.is_empty() {
                reply.text.push_str(text);
                let _ = channel.send(Delta { text: text.into() });
            }
        }
    }
    if !finished {
        return Err(
            "Połączenie przerwane przed końcem odpowiedzi — narzędzia nie zostały wykonane.".into(),
        );
    }
    if matches!(
        reply.stop_reason.as_str(),
        "length" | "max_tokens" | "refusal" | "content_filter"
    ) {
        return Err(format!(
            "Odpowiedź zatrzymana: {}. Nie wykonano narzędzi.",
            reply.stop_reason
        ));
    }
    for (_, (id, name, input)) in calls {
        reply.tool_calls.push(ToolCall {
            id: if id.is_empty() {
                crate::filesafety::id()
            } else {
                id
            },
            name,
            input: parse_input(&json!(if input.is_empty() { "{}" } else { &input }))?,
        });
    }
    Ok(reply)
}
fn parse_reply(v: &Value, ant: bool, resp: bool) -> Result<AgentReply, String> {
    let mut r = AgentReply::default();
    let blocks = if ant {
        v["content"].as_array()
    } else if resp {
        v["output"].as_array()
    } else {
        None
    };
    if let Some(bs) = blocks {
        for b in bs {
            match b["type"].as_str() {
                Some("text") => r.text.push_str(b["text"].as_str().unwrap_or("")),
                Some("message") => {
                    for p in b["content"].as_array().into_iter().flatten() {
                        if p["type"] == "output_text" {
                            r.text.push_str(p["text"].as_str().unwrap_or(""));
                        }
                    }
                }
                Some("tool_use") => r.tool_calls.push(ToolCall {
                    id: b["id"].as_str().unwrap_or("").into(),
                    name: b["name"].as_str().unwrap_or("").into(),
                    input: parse_input(&b["input"])?,
                }),
                Some("function_call") => r.tool_calls.push(ToolCall {
                    id: b["call_id"].as_str().unwrap_or("").into(),
                    name: b["name"].as_str().unwrap_or("").into(),
                    input: parse_input(&b["arguments"])?,
                }),
                _ => {}
            }
        }
    } else {
        let m = &v["choices"][0]["message"];
        r.text = m["content"].as_str().unwrap_or("").into();
        for c in m["tool_calls"].as_array().into_iter().flatten() {
            r.tool_calls.push(ToolCall {
                id: c["id"].as_str().unwrap_or("").into(),
                name: c["function"]["name"].as_str().unwrap_or("").into(),
                input: parse_input(&c["function"]["arguments"])?,
            });
        }
    }
    r.input_tokens = v
        .pointer("/usage/input_tokens")
        .or_else(|| v.pointer("/usage/prompt_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    r.output_tokens = v
        .pointer("/usage/output_tokens")
        .or_else(|| v.pointer("/usage/completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    r.stop_reason = v["stop_reason"]
        .as_str()
        .or_else(|| {
            v.pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
        })
        .or_else(|| v["status"].as_str())
        .unwrap_or("")
        .into();
    if matches!(
        r.stop_reason.as_str(),
        "max_tokens" | "length" | "refusal" | "incomplete" | "failed" | "content_filter"
    ) {
        return Err("Niepełna lub odrzucona odpowiedź — nie wykonano narzędzi.".into());
    }
    Ok(r)
}
#[tauri::command]
pub async fn list_models(
    provider_id: String,
    provider_kind: String,
    endpoint: String,
) -> Result<Vec<String>, String> {
    Ok(
        crate::models::list_models_detailed(provider_id, provider_kind, endpoint)
            .await?
            .into_iter()
            .map(|m| m.id)
            .collect(),
    )
}

const IGNORED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".turbo",
    ".agentos-history",
];
fn ignored(e: &walkdir::DirEntry) -> bool {
    IGNORED.contains(&e.file_name().to_string_lossy().as_ref())
        || crate::filesafety::sensitive(&e.path().to_string_lossy())
}
fn relative(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().into()
}
fn bounded(s: String, n: usize) -> String {
    if s.chars().count() > n {
        format!("{}\n[… obcięto]", s.chars().take(n).collect::<String>())
    } else {
        s
    }
}
#[derive(Serialize)]
pub struct FileEntry {
    path: String,
    kind: String,
    size: u64,
}
#[tauri::command]
pub fn fs_list(
    project_path: String,
    path: Option<String>,
    depth: Option<usize>,
) -> Result<Vec<FileEntry>, String> {
    let root = crate::filesafety::root(&project_path)?;
    let start = crate::filesafety::resolve(&root, path.as_deref().unwrap_or(""))?;
    Ok(WalkDir::new(start)
        .min_depth(1)
        .max_depth(depth.unwrap_or(2).clamp(1, 5))
        .sort_by_file_name()
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !ignored(e))
        .filter_map(Result::ok)
        .take(600)
        .map(|e| FileEntry {
            path: relative(&root, e.path()),
            kind: if e.file_type().is_dir() {
                "dir"
            } else {
                "file"
            }
            .into(),
            size: e.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .collect())
}
#[tauri::command]
pub fn fs_read(project_path: String, path: String) -> Result<String, String> {
    crate::filesafety::check_read(&path)?;
    let root = crate::filesafety::root(&project_path)?;
    let target = crate::filesafety::resolve(&root, &path)?;
    let size = fs::metadata(&target).map_err(|e| e.to_string())?.len();
    if size > 512 * 1024 {
        return Err("Plik przekracza limit odczytu 512 KB.".into());
    }
    let mut b = vec![];
    fs::File::open(target)
        .map_err(|e| e.to_string())?
        .take(512 * 1024)
        .read_to_end(&mut b)
        .map_err(|e| e.to_string())?;
    if b.iter().take(8000).any(|b| *b == 0) {
        return Err(
            "Plik binarny lub dokument. Wyeksportuj tekst albo użyj odpowiedniej umiejętności."
                .into(),
        );
    }
    let s = String::from_utf8_lossy(&b).to_string();
    if crate::filesafety::looks_secret(&s) {
        return Err("Plik zawiera potencjalny sekret — odczyt zablokowany.".into());
    }
    Ok(bounded(s, 60_000))
}
#[tauri::command]
pub fn fs_search(project_path: String, query: String) -> Result<Vec<String>, String> {
    let root = crate::filesafety::root(&project_path)?;
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err("Puste zapytanie.".into());
    }
    let mut out = vec![];
    for e in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !ignored(e))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .take(20_000)
    {
        let p = relative(&root, e.path());
        if p.to_lowercase().contains(&q) {
            out.push(format!("{p} (nazwa)"));
        }
        if e.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > 1_000_000 {
            continue;
        }
        let Ok(s) = fs::read_to_string(e.path()) else {
            continue;
        };
        if crate::filesafety::looks_secret(&s) {
            continue;
        }
        for (n, l) in s.lines().enumerate() {
            if l.to_lowercase().contains(&q) {
                out.push(format!(
                    "{p}:{}: {}",
                    n + 1,
                    l.chars().take(200).collect::<String>()
                ));
            }
            if out.len() >= 120 {
                return Ok(out);
            }
        }
    }
    Ok(out)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    id: String,
    path: String,
    project_root: String,
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
fn history(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Nieprawidłowy identyfikator.".into());
    }
    let d = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history")
        .join(id);
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}
fn file_lock() -> &'static std::sync::Mutex<()> {
    static L: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| std::sync::Mutex::new(()))
}
#[tauri::command]
pub fn fs_version(project_path: String, path: String) -> Result<String, String> {
    crate::filesafety::check_read(&path)?;
    let r = crate::filesafety::root(&project_path)?;
    let p = crate::filesafety::resolve(&r, &path)?;
    if !p.exists() {
        Ok("missing".into())
    } else {
        Ok(crate::filesafety::digest(
            &fs::read(&p).map_err(|e| e.to_string())?,
        ))
    }
}
#[tauri::command]
pub fn fs_write(
    app: tauri::AppHandle,
    project_path: String,
    path: String,
    content: String,
    conversation_id: String,
    expected_hash: String,
) -> Result<ChangeRecord, String> {
    let _g = file_lock().lock().map_err(|_| "Blokada plików.")?;
    let root = crate::filesafety::root(&project_path)?;
    let target = crate::filesafety::resolve(&root, &path)?;
    let rel = relative(&root, &target);
    crate::filesafety::check_read(&rel)?;
    if rel.split('/').any(|s| s == ".git") {
        return Err("Zapis do .git zablokowany.".into());
    }
    if content.len() > 2_000_000 {
        return Err("Limit zapisu 2 MB.".into());
    }
    let existed = target.exists();
    let before = if existed {
        Some(fs::read_to_string(&target).map_err(|_| "Istniejący plik nie jest tekstowy.")?)
    } else {
        None
    };
    let actual = before
        .as_ref()
        .map(|s| crate::filesafety::digest(s.as_bytes()))
        .unwrap_or_else(|| "missing".into());
    if expected_hash != actual {
        return Err("CONFLICT: Plik zmienił się od podglądu. Odczytaj go ponownie.".into());
    }
    let id = format!("change-{}", crate::filesafety::id());
    let backup = Backup {
        id: id.clone(),
        path: rel.clone(),
        project_root: root.to_string_lossy().into(),
        absolute_path: target.to_string_lossy().into(),
        existed,
        before: before.clone(),
        after: content.clone(),
    };
    fs::write(
        history(&app, &conversation_id)?.join(format!("{id}.json")),
        serde_json::to_vec(&backup).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Some(p) = target.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let temp = target.with_extension(format!("{}.tmp", crate::filesafety::id()));
    fs::write(&temp, &content).map_err(|e| e.to_string())?;
    fs::rename(temp, &target).map_err(|e| e.to_string())?;
    Ok(ChangeRecord {
        id,
        path: rel,
        kind: if existed { "modified" } else { "created" }.into(),
        before,
        after: content,
    })
}
#[tauri::command]
pub fn change_undo(
    app: tauri::AppHandle,
    conversation_id: String,
    change_id: String,
    force: bool,
) -> Result<String, String> {
    let _g = file_lock().lock().map_err(|_| "Blokada plików.")?;
    let raw = fs::read(history(&app, &conversation_id)?.join(format!("{change_id}.json")))
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let path = v["path"].as_str().ok_or("Brak ścieżki.")?;
    let absolute = v["absolutePath"].as_str().ok_or("Brak ścieżki.")?;
    let root = crate::filesafety::root(v["projectRoot"].as_str().ok_or("Brak projektu w kopii.")?)?;
    let target = crate::filesafety::resolve(&root, path)?;
    if target != PathBuf::from(absolute) {
        return Err("Kopia nie odpowiada projektowi.".into());
    }
    if !force && fs::read_to_string(&target).ok().as_deref() != v["after"].as_str() {
        return Err(format!("CONFLICT: {path} ma późniejsze zmiany."));
    }
    if v["existed"] == true {
        fs::write(target, v["before"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
    } else if target.is_file() {
        fs::remove_file(target).map_err(|e| e.to_string())?;
    }
    Ok(format!("Cofnięto zmianę {path}"))
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
#[tauri::command]
pub async fn run_command(
    project_path: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<CommandResult, String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let root = crate::filesafety::root(&project_path)?;
    if command.trim().is_empty() || command.len() > 4000 {
        return Err("Nieprawidłowe polecenie.".into());
    }
    let mut cancel = crate::operations::subscribe();
    let started = Instant::now();
    let mut cmd = tokio::process::Command::new("/bin/zsh");
    cmd.args(["-lc", &command])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id().ok_or("Brak PID.")?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let mut ob = vec![];
    let mut eb = vec![];
    let mut timed_out = false;
    let status = tokio::select! {s=child.wait()=>s.map_err(|e|e.to_string())?,_=tokio::time::sleep(Duration::from_secs(timeout_secs.unwrap_or(120).clamp(5,120)))=>{timed_out=true;crate::operations::kill_group(pid);std::process::Command::new("/usr/bin/true").args(["-KILL",&format!("-{pid}")]).status().ok();child.wait().await.map_err(|e|e.to_string())?},_=cancel.changed()=>{crate::operations::kill_group(pid);std::process::Command::new("/usr/bin/true").args(["-KILL",&format!("-{pid}")]).status().ok();let _=child.wait().await;return Err("Polecenie anulowane.".into());}};
    out.take(100_000).read_to_end(&mut ob).await.ok();
    err.take(100_000).read_to_end(&mut eb).await.ok();
    Ok(CommandResult {
        exit_code: status.code(),
        stdout: bounded(String::from_utf8_lossy(&ob).into(), 20_000),
        stderr: bounded(String::from_utf8_lossy(&eb).into(), 12_000),
        duration_ms: started.elapsed().as_millis(),
        timed_out,
    })
}
#[tauri::command]
pub fn create_project_folder(parent: String, name: String) -> Result<String, String> {
    let root = crate::filesafety::root(&parent)?;
    let clean: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "-_ ".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    if clean.trim().is_empty() {
        return Err("Pusta nazwa.".into());
    }
    let target = root.join(clean);
    if target.exists() {
        return Err("Folder już istnieje.".into());
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into())
}
#[tauri::command]
pub fn open_in_system(
    project_path: String,
    path: Option<String>,
    mode: String,
) -> Result<(), String> {
    let r = crate::filesafety::root(&project_path)?;
    let p = crate::filesafety::resolve(&r, path.as_deref().unwrap_or(""))?;
    let mut c = std::process::Command::new("/usr/bin/open");
    match mode.as_str() {
        "finder" => {
            c.arg("-R");
        }
        "terminal" => {
            c.args(["-a", "Terminal"]);
        }
        "default" => {}
        _ => return Err("Nieznany tryb.".into()),
    }
    if !c.arg(p).status().map_err(|e| e.to_string())?.success() {
        return Err("Nie udało się otworzyć pliku.".into());
    }
    Ok(())
}
#[tauri::command]
pub fn backup_snapshot(app: tauri::AppHandle, label: String) -> Result<bool, String> {
    if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Nieprawidłowa etykieta.".into());
    }
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let p = d.join(format!("snapshot-{label}.json"));
    if p.exists() || !d.join("snapshot.json").exists() {
        return Ok(false);
    }
    fs::copy(d.join("snapshot.json"), p).map_err(|e| e.to_string())?;
    Ok(true)
}
#[tauri::command]
pub fn read_user_json(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if p.extension().and_then(|s| s.to_str()) != Some("json")
        || fs::metadata(p).map_err(|e| e.to_string())?.len() > 1_000_000
    {
        return Err("Wybierz JSON do 1 MB.".into());
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn converts_tool_history() {
        let m = vec![AgentMessage {
            role: "assistant".into(),
            text: "".into(),
            tool_calls: vec![ToolCall {
                id: "a".into(),
                name: "read_file".into(),
                input: json!({"path":"a"}),
            }],
            tool_call_id: "".into(),
            content: "".into(),
            is_error: false,
        }];
        assert_eq!(messages("", &m, false, true)[0]["type"], "function_call");
    }
    #[test]
    fn rejects_incomplete_arguments() {
        assert!(parse_input(&json!("{\"path\":")).is_err());
    }
    #[test]
    fn rejects_cutoff() {
        assert!(parse_reply(&json!({"stop_reason":"max_tokens"}), true, false).is_err());
    }
    #[test]
    fn builds_endpoint() {
        assert_eq!(
            responses_endpoint("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/responses"
        );
    }
}
