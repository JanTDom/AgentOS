//! Awaryjne anulowanie operacji backendu. Licznik generacji eliminuje utracone sygnały.
use std::sync::OnceLock;
use tokio::sync::watch;
fn sender() -> &'static watch::Sender<u64> {
    static S: OnceLock<watch::Sender<u64>> = OnceLock::new();
    S.get_or_init(|| watch::channel(0).0)
}
pub fn subscribe() -> watch::Receiver<u64> {
    sender().subscribe()
}
#[tauri::command]
pub fn cancel_operations() {
    sender().send_modify(|n| *n = n.wrapping_add(1));
}
pub async fn cancellable<T>(
    f: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let mut rx = subscribe();
    tokio::select! {v=f=>v,_=rx.changed()=>Err("Operacja anulowana przez użytkownika.".into())}
}
pub fn kill_group(pid: u32) {
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", &format!("-{pid}")])
        .status();
}
