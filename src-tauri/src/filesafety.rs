//! Wspólna ochrona sekretów i identyfikatory operacji.
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn sensitive(path: &str) -> bool {
    path.split('/').any(|p| {
        let p = p.to_ascii_lowercase();
        (p.starts_with(".env") && !matches!(p.as_str(), ".env.example" | ".env.sample"))
            || p.ends_with(".pem")
            || p.ends_with(".key")
            || p.ends_with(".p12")
            || p.ends_with(".pfx")
            || matches!(
                p.as_str(),
                ".ssh" | ".aws" | ".gnupg" | "id_rsa" | "id_ed25519" | ".npmrc" | ".pypirc"
            )
            || p.contains("credentials")
            || p == "service-account.json"
    })
}
pub fn looks_secret(text: &str) -> bool {
    [
        concat!("-----BEGIN ", "PRIVATE KEY-----"),
        concat!("-----BEGIN RSA ", "PRIVATE KEY-----"),
        concat!("gh", "p_"),
        concat!("github", "_pat_"),
        concat!("sk-ant", "-api"),
        concat!("AK", "IA"),
    ]
    .iter()
    .any(|s| text.contains(s))
}
pub fn root(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("Brak folderu projektu.".into());
    }
    let p = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !p.is_dir() {
        return Err("Projekt nie jest katalogiem.".into());
    }
    Ok(p)
}
pub fn resolve(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let p = Path::new(raw);
    let rel = if p.is_absolute() {
        p.strip_prefix(root)
            .map_err(|_| "Ścieżka poza projektem.")?
    } else {
        p
    };
    let mut target = root.to_path_buf();
    for c in rel.components() {
        match c {
            Component::Normal(p) => target.push(p),
            Component::CurDir => {}
            _ => return Err("Ścieżka poza projektem.".into()),
        }
    }
    let mut parent = target.clone();
    loop {
        if std::fs::symlink_metadata(&parent).is_ok() {
            let real = std::fs::canonicalize(&parent)
                .map_err(|_| "Niedostępna ścieżka lub uszkodzone dowiązanie.")?;
            if !real.starts_with(root) {
                return Err("Dowiązanie poza projektem.".into());
            }
            break;
        }
        if !parent.pop() {
            return Err("Brak rodzica ścieżki.".into());
        }
    }
    Ok(target)
}
pub fn check_read(path: &str) -> Result<(), String> {
    if sensitive(path) {
        Err("Plik wrażliwy: odczyt i wysłanie do modelu zablokowane.".into())
    } else {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_sensitive_files() {
        for p in [
            ".env",
            "config/.env.local",
            "x/id_ed25519",
            "a/server.pem",
            ".aws/config",
        ] {
            assert!(sensitive(p), "{p}");
        }
        assert!(!sensitive(".env.example"));
        assert!(!sensitive("src/key.ts"));
    }
    #[test]
    fn hashes_and_ids() {
        assert_eq!(
            digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(id(), id());
    }
    #[test]
    fn rejects_symlinks_and_traversal() {
        let dir = std::env::temp_dir().join(id());
        std::fs::create_dir_all(&dir).unwrap();
        let r = root(dir.to_str().unwrap()).unwrap();
        assert!(resolve(&r, "../a").is_err());
        std::os::unix::fs::symlink("/etc", r.join("outside")).unwrap();
        assert!(resolve(&r, "outside/passwd").is_err());
        std::os::unix::fs::symlink("/nonexistent-external-agentos", r.join("dangling")).unwrap();
        assert!(resolve(&r, "dangling").is_err());
    }
}
