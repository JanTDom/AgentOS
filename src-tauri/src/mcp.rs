//! Minimalny klient MCP (Model Context Protocol) przez stdio.
//! Serwer uruchamiany jest jako proces w powłoce logowania (dostęp do npx, uvx).
//! Wywołania narzędzi zatwierdza użytkownik w interfejsie (chyba że oznaczy serwer jako zaufany).

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const PROTOCOL: &str = "2025-06-18";

struct Conn {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    stderr: Arc<std::sync::Mutex<VecDeque<String>>>,
    next: AtomicU64,
    tools: Vec<McpTool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    name: String,
    description: String,
    input_schema: Value,
}

fn conns() -> &'static Mutex<HashMap<String, Arc<Conn>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Conn>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Conn {
    fn stderr_tail(&self) -> String {
        self.stderr
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    async fn send(&self, message: &Value) -> Result<(), String> {
        let mut line = message.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Serwer MCP nie przyjmuje poleceń: {e}"))?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await?;
        let response = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => {
                return Err(format!(
                    "Serwer MCP zakończył działanie.\n{}",
                    self.stderr_tail()
                ))
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(format!(
                    "Serwer MCP nie odpowiedział w {} s.\n{}",
                    timeout.as_secs(),
                    self.stderr_tail()
                ));
            }
        };
        if let Some(err) = response.get("error") {
            return Err(format!(
                "Błąd serwera MCP: {}",
                err["message"].as_str().unwrap_or(&err.to_string())
            ));
        }
        Ok(response["result"].clone())
    }
}

/// Uruchamia serwer MCP (albo zwraca już działający) i podaje listę jego narzędzi.
#[tauri::command]
pub async fn mcp_start(
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    secret_keys: Vec<String>,
    restart: bool,
) -> Result<Vec<McpTool>, String> {
    if restart {
        let _ = mcp_stop(id.clone()).await;
    } else if let Some(conn) = conns().lock().await.get(&id).cloned() {
        if conn.child.lock().await.try_wait().ok().flatten().is_none() {
            return Ok(conn.tools.clone());
        }
    }
    if command.trim().is_empty() {
        return Err("Podaj polecenie uruchamiające serwer (np. npx).".to_string());
    }
    let mut cmd = Command::new("/bin/zsh");
    cmd.arg("-lc")
        .arg("exec \"$0\" \"$@\"")
        .arg(command.trim())
        .args(&args);
    cmd.envs(&env);
    for key in &secret_keys {
        if let Some(value) = crate::get_provider_key(&format!("mcp-{id}-{key}"))
            .ok()
            .flatten()
        {
            cmd.env(key, value);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Nie udało się uruchomić serwera MCP: {e}"))?;
    let stdin = child.stdin.take().ok_or("Brak wejścia procesu.")?;
    let stdout = child.stdout.take().ok_or("Brak wyjścia procesu.")?;
    let stderr_pipe = child.stderr.take();
    let pending: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));
    let stderr: Arc<std::sync::Mutex<VecDeque<String>>> =
        Arc::new(std::sync::Mutex::new(VecDeque::new()));
    {
        let pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if value.get("result").is_some() || value.get("error").is_some() {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(value);
                        }
                    }
                }
            }
            pending.lock().unwrap().clear();
        });
    }
    if let Some(pipe) = stderr_pipe {
        let stderr = stderr.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buf = stderr.lock().unwrap();
                buf.push_back(line.chars().take(400).collect());
                if buf.len() > 30 {
                    buf.pop_front();
                }
            }
        });
    }
    let mut conn = Conn {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
        pending,
        stderr,
        next: AtomicU64::new(1),
        tools: vec![],
    };
    conn.request("initialize", json!({"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "AgentOS", "version": env!("CARGO_PKG_VERSION")}}), Duration::from_secs(90)).await?;
    conn.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .await?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let params = match &cursor {
            Some(c) => json!({"cursor": c}),
            None => json!({}),
        };
        let result = conn
            .request("tools/list", params, Duration::from_secs(30))
            .await?;
        for t in result["tools"].as_array().cloned().unwrap_or_default() {
            tools.push(McpTool {
                name: t["name"].as_str().unwrap_or_default().to_string(),
                description: t["description"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(1000)
                    .collect(),
                input_schema: if t["inputSchema"].is_object() {
                    t["inputSchema"].clone()
                } else {
                    json!({"type": "object", "properties": {}})
                },
            });
        }
        cursor = result["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    conn.tools = tools.clone();
    conns().lock().await.insert(id, Arc::new(conn));
    Ok(tools)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResult {
    text: String,
    is_error: bool,
}

#[tauri::command]
pub async fn mcp_call(id: String, tool: String, arguments: Value) -> Result<McpResult, String> {
    let conn = conns()
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or("Serwer MCP nie jest uruchomiony.")?;
    let result = conn.request("tools/call", json!({"name": tool, "arguments": if arguments.is_object() { arguments } else { json!({}) }}), Duration::from_secs(300)).await?;
    let mut parts = Vec::new();
    for item in result["content"].as_array().cloned().unwrap_or_default() {
        match item["type"].as_str() {
            Some("text") => parts.push(item["text"].as_str().unwrap_or_default().to_string()),
            Some("resource") => parts.push(
                item.pointer("/resource/text")
                    .and_then(Value::as_str)
                    .unwrap_or("[zasób]")
                    .to_string(),
            ),
            Some(other) => parts.push(format!("[{other}: pominięto w podglądzie]")),
            None => {}
        }
    }
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            parts.push(structured.to_string());
        }
    }
    let mut text = parts.join("\n");
    if text.chars().count() > 60_000 {
        text = text.chars().take(60_000).collect::<String>() + "\n[… obcięto]";
    }
    Ok(McpResult {
        text,
        is_error: result["isError"].as_bool().unwrap_or(false),
    })
}

#[tauri::command]
pub async fn mcp_stop(id: String) -> Result<(), String> {
    if let Some(conn) = conns().lock().await.remove(&id) {
        let _ = conn.child.lock().await.kill().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_running() -> Result<Vec<String>, String> {
    let map = conns().lock().await;
    let mut out = Vec::new();
    for (id, conn) in map.iter() {
        if conn.child.lock().await.try_wait().ok().flatten().is_none() {
            out.push(id.clone());
        }
    }
    Ok(out)
}
