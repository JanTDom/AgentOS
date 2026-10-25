//! Trwały snapshot: serializacja zapisów, atomowa podmiana i kopie rotacyjne.
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Manager;
fn lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}
fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}
fn validate(v: &Value) -> Result<(), String> {
    if v["version"] != 4
        || !v["projects"].is_array()
        || !v["conversations"].is_array()
        || !v["providers"].is_array()
    {
        return Err("Nieobsługiwana lub uszkodzona historia. Nie nadpisano danych.".into());
    }
    Ok(())
}
fn read(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Uszkodzona historia: {e}"))
}
#[tauri::command]
pub async fn get_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    let _g = lock().lock().await;
    let p = dir(&app)?.join("snapshot.json");
    if !p.exists() {
        return Ok(Value::Null);
    }
    read(&p)
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension(format!("{}.tmp", crate::filesafety::id()));
    let mut f = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_snapshot(app: tauri::AppHandle, snapshot: Value) -> Result<(), String> {
    validate(&snapshot)?;
    let _g = lock().lock().await;
    let d = dir(&app)?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let p = d.join("snapshot.json");
    if p.exists() {
        let old = read(&p)?; // fail closed: nie zastępuj uszkodzonej historii
        crate::policy::approve_policy_changes(&app, &old, &snapshot).await?;
        let first = d.join("snapshot-before-0.5.json");
        if !first.exists() {
            std::fs::copy(&p, &first).map_err(|e| e.to_string())?;
        }
        for i in (1..5).rev() {
            let from = d.join(format!("snapshot-backup-{i}.json"));
            if from.exists() {
                std::fs::copy(from, d.join(format!("snapshot-backup-{}.json", i + 1)))
                    .map_err(|e| e.to_string())?;
            }
        }
        std::fs::copy(&p, d.join("snapshot-backup-1.json")).map_err(|e| e.to_string())?;
    }
    atomic(
        &p,
        &serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
pub async fn recover_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    crate::policy::confirm(&app,"Odzyskiwanie historii","Przywrócić najnowszą poprawną kopię? Obecny snapshot zostanie zachowany w osobnym pliku. Kopia może zawierać wcześniej usunięte czaty.".into()).await?;
    let _g = lock().lock().await;
    let d = dir(&app)?;
    for i in 1..=5 {
        let p = d.join(format!("snapshot-backup-{i}.json"));
        if let Ok(v) = read(&p) {
            if validate(&v).is_ok() {
                let current = d.join("snapshot.json");
                if current.exists() {
                    std::fs::copy(
                        &current,
                        d.join(format!("snapshot-damaged-{}.json", crate::filesafety::id())),
                    )
                    .map_err(|e| e.to_string())?;
                }
                atomic(
                    &current,
                    &serde_json::to_vec(&v).map_err(|e| e.to_string())?,
                )?;
                return Ok(v);
            }
        }
    }
    Err("Nie znaleziono poprawnej kopii. Oryginalne dane pozostały nietknięte.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_format() {
        assert!(validate(&serde_json::json!({"version":99})).is_err());
    }
    #[test]
    fn atomic_roundtrip() {
        let d = std::env::temp_dir().join(crate::filesafety::id());
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("test.json");
        atomic(&p, b"{\"a\":1}").unwrap();
        assert_eq!(read(&p).unwrap()["a"], 1);
    }
}
