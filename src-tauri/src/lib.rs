//! Biblioteka desktopowa AgentOS.
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;
mod agent;
mod filesafety;
mod integrations;
mod mcp;
mod models;
mod network;
mod operations;
mod persistence;
mod policy;
mod publishing;
mod skills;
const KEYRING_SERVICE: &str = "pl.agentos.desktop";
pub(crate) fn get_provider_key(id: &str) -> Result<Option<String>, String> {
    let e = keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyStatus {
    provider_id: String,
    has_key: bool,
}
#[tauri::command]
fn save_provider(provider: Value, api_key: String) -> Result<KeyStatus, String> {
    let id = provider["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 200)
        .ok_or("Nieprawidłowy identyfikator.")?;
    if !api_key.trim().is_empty() {
        keyring::Entry::new(KEYRING_SERVICE, id)
            .map_err(|e| e.to_string())?
            .set_password(api_key.trim())
            .map_err(|e| e.to_string())?;
    }
    Ok(KeyStatus {
        provider_id: id.into(),
        has_key: get_provider_key(id)?.is_some(),
    })
}
#[tauri::command]
fn delete_secret(id: String) -> Result<(), String> {
    match keyring::Entry::new(KEYRING_SERVICE, &id)
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
fn get_provider_key_statuses(provider_ids: Vec<String>) -> Result<Vec<KeyStatus>, String> {
    provider_ids
        .into_iter()
        .map(|id| {
            Ok(KeyStatus {
                has_key: get_provider_key(&id)?.is_some(),
                provider_id: id,
            })
        })
        .collect()
}
#[tauri::command]
fn inspect_project(path: String) -> Result<Value, String> {
    let r = filesafety::root(&path)?;
    let context: Vec<_> = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "PROJECT_CONTEXT.md"]
        .into_iter()
        .filter(|p| r.join(p).is_file())
        .collect();
    Ok(
        serde_json::json!({"name":r.file_name().unwrap_or_default().to_string_lossy(),"path":r.to_string_lossy(),"contextFiles":context}),
    )
}
#[tauri::command]
fn read_project_context(path: String) -> Result<Vec<Value>, String> {
    use std::io::Read;
    let r = filesafety::root(&path)?;
    let mut out = vec![];
    for name in ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "PROJECT_CONTEXT.md"] {
        let p = filesafety::resolve(&r, name)?;
        if !p.is_file() {
            continue;
        }
        let mut b = vec![];
        std::fs::File::open(p)
            .map_err(|e| e.to_string())?
            .take(30_000)
            .read_to_end(&mut b)
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&b);
        if filesafety::looks_secret(&text) {
            return Err(format!("Potencjalny sekret w {name}."));
        }
        out.push(serde_json::json!({"name":name,"content":text}));
    }
    Ok(out)
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            if let Some(w) = app.get_webview_window("main") {
                w.show()?;
                w.set_focus()?;
            }
            Ok(())
        })
        .invoke_handler(|invoke| {
            let command = invoke.message.command().to_string();
            if !policy::mediated(&command) {
                return dispatch(invoke);
            }
            let args = match invoke.message.payload() {
                tauri::ipc::InvokeBody::Json(v) => v.clone(),
                _ => {
                    invoke.resolver.reject("Wymagane argumenty JSON.");
                    return true;
                }
            };
            let app = invoke.message.webview_ref().app_handle().clone();
            tauri::async_runtime::spawn(async move {
                match policy::authorize(&app, &command, &args).await {
                    Ok(()) => {
                        dispatch(invoke);
                    }
                    Err(e) => invoke.resolver.reject(e),
                }
            });
            true
        })
        .run(tauri::generate_context!())
        .expect("Nie udało się uruchomić AgentOS");
}
fn dispatch(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool> =
        Box::new(tauri::generate_handler![
            persistence::get_snapshot,
            persistence::save_snapshot,
            persistence::recover_snapshot,
            agent::backup_snapshot,
            get_provider_key_statuses,
            save_provider,
            delete_secret,
            inspect_project,
            read_project_context,
            network::web_fetch,
            agent::agent_turn,
            agent::fs_version,
            agent::list_models,
            models::list_models_detailed,
            agent::fs_list,
            agent::fs_read,
            agent::fs_search,
            agent::fs_write,
            agent::change_undo,
            agent::run_command,
            agent::create_project_folder,
            agent::open_in_system,
            agent::read_user_json,
            skills::skill_list,
            skills::skill_read,
            skills::skill_remove,
            skills::skill_search,
            skills::skill_inspect,
            skills::skill_preview,
            skills::skill_install,
            skills::skill_import_local,
            integrations::git_status,
            integrations::git_init,
            integrations::git_commit,
            integrations::git_branch,
            integrations::git_push,
            integrations::git_clone,
            integrations::github_user,
            integrations::github_create_repo,
            integrations::github_create_pr,
            integrations::vercel_account,
            integrations::vercel_projects,
            publishing::vercel_manifest,
            integrations::vercel_deploy,
            integrations::vercel_deployment,
            integrations::vercel_deployments,
            integrations::vercel_logs,
            integrations::vercel_rollback,
            integrations::vercel_set_env,
            integrations::supabase_projects,
            integrations::supabase_query,
            integrations::supabase_keys,
            integrations::supabase_types,
            mcp::mcp_start,
            mcp::mcp_call,
            mcp::mcp_stop,
            mcp::mcp_running,
            operations::cancel_operations
        ]);
    handler(invoke)
}
