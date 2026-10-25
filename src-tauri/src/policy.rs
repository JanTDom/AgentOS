//! Niezależna od modelu kontrola IPC. Zgoda jest natywnym oknem i dotyczy
//! dokładnego wywołania. UI nie może zastąpić jej parametrem `approved`.
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn roots() -> &'static Mutex<HashSet<PathBuf>> {
    static ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    ROOTS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub async fn confirm(app: &tauri::AppHandle, title: &str, detail: String) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(detail)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Zezwól".into(),
            "Odmów".into(),
        ))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    if rx.await.unwrap_or(false) {
        Ok(())
    } else {
        Err("Operacja odrzucona w natywnym oknie bezpieczeństwa.".into())
    }
}

fn snapshot(app: &tauri::AppHandle) -> Result<Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("snapshot.json");
    if !path.exists() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Nie można sprawdzić uprawnień: {e}"))
}

fn project_mode(app: &tauri::AppHandle, root: &Path) -> Result<String, String> {
    let s = snapshot(app)?;
    Ok(s["projects"]
        .as_array()
        .and_then(|p| {
            p.iter().find(|p| {
                p["path"]
                    .as_str()
                    .and_then(|p| std::fs::canonicalize(p).ok())
                    .as_deref()
                    == Some(root)
            })
        })
        .and_then(|p| p["accessMode"].as_str())
        .unwrap_or("ask")
        .into())
}

/// Ustawienia → Zgoda na wszystko. Włączenie wymaga potwierdzenia w natywnym oknie
/// (approve_policy_changes), więc ani model, ani UI nie mogą go włączyć po cichu.
fn approve_all(s: &Value) -> bool {
    s["approveAll"].as_bool() == Some(true)
}

fn is_registered_project(s: &Value, root: &Path) -> bool {
    s["projects"].as_array().is_some_and(|p| {
        p.iter().any(|p| {
            p["path"]
                .as_str()
                .and_then(|p| std::fs::canonicalize(p).ok())
                .as_deref()
                == Some(root)
        })
    })
}

pub fn mutation(command: &str, args: &Value) -> bool {
    match command {
        "fs_write"
        | "change_undo"
        | "run_command"
        | "write_project_context"
        | "create_project_folder"
        | "skill_install"
        | "skill_import_local"
        | "skill_remove"
        | "git_init"
        | "git_commit"
        | "git_branch"
        | "git_push"
        | "git_clone"
        | "github_create_repo"
        | "github_create_pr"
        | "vercel_deploy"
        | "vercel_rollback"
        | "vercel_set_env"
        | "mcp_start"
        | "mcp_call"
        | "delete_secret" => true,
        "supabase_query" => args["readOnly"] != true,
        _ => false,
    }
}

pub fn mediated(command: &str) -> bool {
    !matches!(
        command,
        "get_snapshot"
            | "save_snapshot"
            | "backup_snapshot"
            | "get_provider_key_statuses"
            | "cancel_operations"
            | "mcp_stop"
            | "mcp_running"
    )
}

pub async fn authorize(app: &tauri::AppHandle, command: &str, args: &Value) -> Result<(), String> {
    let settings = snapshot(app)?;
    let auto = approve_all(&settings);
    let path = args["projectPath"].as_str().or_else(|| {
        if matches!(
            command,
            "inspect_project" | "read_project_context" | "write_project_context"
        ) {
            args["path"].as_str()
        } else {
            None
        }
    });
    if let Some(path) = path {
        let root = std::fs::canonicalize(path).map_err(|_| "Folder projektu jest niedostępny.")?;
        if !root.is_dir() {
            return Err("Projekt musi być katalogiem.".into());
        }
        let known = roots()
            .lock()
            .map_err(|_| "Blokada polityki.")?
            .contains(&root);
        if !known && !(auto && is_registered_project(&settings, &root)) {
            confirm(app, "Dostęp do projektu", format!("Zezwolić AgentOS na dostęp do folderu?\n{}\n\nModel chmurowy może otrzymać odczytane pliki. Narzędzia plikowe nie mogą wychodzić poza ten folder. Terminal i MCP nie są izolowane.", root.display())).await?;
            roots()
                .lock()
                .map_err(|_| "Blokada polityki.")?
                .insert(root.clone());
        }
        if mutation(command, args) && project_mode(app, &root)? == "read" {
            return Err("Backend: projekt jest w trybie tylko do odczytu.".into());
        }
    }
    if command == "mcp_call" || command == "mcp_start" {
        let s = snapshot(app)?;
        if s["projects"]
            .as_array()
            .is_some_and(|p| p.iter().any(|p| p["accessMode"] == "read"))
        {
            // Brak przypisania serwera do projektu oznacza brak możliwości dowiedzenia
            // zakresu. Konserwatywnie nie wykonujemy globalnego MCP w tej sytuacji.
            return Err("MCP wymaga jawnego zakresu projektu. Globalny MCP jest zablokowany, gdy projekt ma tryb tylko do odczytu. Wyłącz MCP lub zmień tryb projektu świadomie.".into());
        }
    }
    if command == "save_provider" {
        confirm(app, "Zapis poświadczenia", format!("Zapisać lub zastąpić klucz w Keychain?\nIdentyfikator: {}\nWartość klucza nie jest wyświetlana.", args["provider"]["id"].as_str().unwrap_or("?"))).await?;
    }
    if mutation(command, args) && !auto {
        let mut display = args.clone();
        for k in ["value", "apiKey", "env", "secretKeys"] {
            if display.get(k).is_some() {
                display[k] = Value::String("[ukryto]".into());
            }
        }
        if let Some(content) = args["content"].as_str() {
            display["content"] = Value::String(format!(
                "{} bajtów; SHA-256 {}",
                content.len(),
                crate::filesafety::digest(content.as_bytes())
            ));
        }
        let detail = serde_json::to_string_pretty(&display).map_err(|e| e.to_string())?;
        if detail.chars().count() > 24_000 {
            return Err(
                "Argumenty zbyt długie do bezpiecznego zatwierdzenia. Podziel operację.".into(),
            );
        }
        confirm(app, "AgentOS — zgoda backendu", format!("Operacja: {command}\n\n{detail}\n\nZgoda dotyczy tylko tego wywołania. Terminal i MCP działają z uprawnieniami użytkownika; mogą zmienić pliki poza projektem. Zmian w usługach zewnętrznych nie cofa przycisk Cofnij.")).await?;
    }
    Ok(())
}

pub async fn approve_policy_changes(
    app: &tauri::AppHandle,
    old: &Value,
    new: &Value,
) -> Result<(), String> {
    if approve_all(new) && !approve_all(old) {
        confirm(app, "Zgoda na wszystko", "Włączyć zgodę na wszystko?\n\nAgentOS przestanie pytać o zapisy plików, polecenia terminala, instalacje umiejętności, operacje git, wdrożenia i wywołania MCP we wszystkich projektach poza trybem „Tylko odczyt”.\n\nTerminal i MCP działają z Twoimi uprawnieniami i mogą zmienić pliki poza projektem. Zmian w usługach zewnętrznych nie cofa przycisk Cofnij. Wyłączysz to w Ustawieniach.".into()).await?;
    }
    let previous = old["projects"].as_array();
    for project in new["projects"].as_array().into_iter().flatten() {
        let before = previous.and_then(|ps| ps.iter().find(|p| p["id"] == project["id"]));
        if before.is_some_and(|p| {
            p["accessMode"] != project["accessMode"] || p["path"] != project["path"]
        }) {
            confirm(
                app,
                "Zmiana uprawnień projektu",
                format!(
                    "Projekt: {}\nFolder: {}\nNowy tryb: {}",
                    project["name"], project["path"], project["accessMode"]
                ),
            )
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gates_writes_and_sql() {
        assert!(mutation("fs_write", &serde_json::json!({})));
        assert!(mutation(
            "supabase_query",
            &serde_json::json!({"readOnly":false})
        ));
        assert!(!mutation(
            "supabase_query",
            &serde_json::json!({"readOnly":true})
        ));
        assert!(mediated("mcp_call"));
        assert!(mediated("run_command"));
    }
    #[test]
    fn reads_approve_all_flag() {
        assert!(approve_all(&serde_json::json!({"approveAll": true})));
        assert!(!approve_all(&serde_json::json!({"approveAll": false})));
        assert!(!approve_all(&serde_json::json!({})));
        assert!(!approve_all(&Value::Null));
    }
}
