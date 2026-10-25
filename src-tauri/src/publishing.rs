//! Publikowanie z kontrolą manifestu i blokadą plików wrażliwych.
use serde::Serialize;
use std::path::{Path, PathBuf};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub files: Vec<String>,
    pub total_bytes: u64,
    pub hash: String,
}
pub fn files(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let ignore = [
        "node_modules",
        ".git",
        ".vercel",
        ".next",
        ".DS_Store",
        ".agentos",
        ".agentos-build",
        "target",
        ".playwright-cli",
    ];
    let extra = std::fs::read_to_string(root.join(".vercelignore")).unwrap_or_default();
    let patterns: Vec<_> = extra
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('#'))
        .collect();
    if patterns
        .iter()
        .any(|s| s.contains('*') || s.starts_with('!'))
    {
        return Err(".vercelignore: użyj jawnych ścieżek zamiast glob/negacji. Publikacja wstrzymana, aby nie wysłać wykluczonych danych.".into());
    }
    let mut out = vec![];
    let mut total = 0;
    for e in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            let rel = e
                .path()
                .strip_prefix(root)
                .unwrap_or(e.path())
                .to_string_lossy();
            !ignore.contains(&e.file_name().to_string_lossy().as_ref())
                && !crate::filesafety::sensitive(&rel)
                && !patterns.iter().any(|p| {
                    let p = p.trim_matches('/');
                    rel == p || rel.starts_with(&format!("{p}/"))
                })
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let rel = e
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let size = e.metadata().map_err(|e| e.to_string())?.len();
        total += size;
        if size > 25_000_000 || total > 300_000_000 || out.len() >= 8000 {
            return Err("Limit publikacji: 8000 plików, 300 MB łącznie, 25 MB na plik.".into());
        }
        let b = std::fs::read(e.path()).map_err(|e| e.to_string())?;
        if crate::filesafety::looks_secret(&String::from_utf8_lossy(&b)) {
            return Err(format!(
                "Potencjalny sekret w {rel} — publikacja zablokowana."
            ));
        }
        out.push((rel, e.path().to_path_buf()));
    }
    if out.is_empty() {
        return Err("Brak plików do publikacji.".into());
    }
    Ok(out)
}
pub fn manifest(files: &[(String, PathBuf)]) -> Result<Manifest, String> {
    let mut hashes = vec![];
    let mut total = 0;
    for (rel, p) in files {
        let b = std::fs::read(p).map_err(|e| e.to_string())?;
        total += b.len() as u64;
        hashes.push(format!("{rel}:{}", crate::filesafety::digest(&b)));
    }
    Ok(Manifest {
        files: files.iter().map(|(r, _)| r.clone()).collect(),
        total_bytes: total,
        hash: crate::filesafety::digest(hashes.join("\n").as_bytes()),
    })
}
#[tauri::command]
pub fn vercel_manifest(project_path: String) -> Result<Manifest, String> {
    manifest(&files(&crate::filesafety::root(&project_path)?)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_secrets() {
        let r = std::env::temp_dir().join(crate::filesafety::id());
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(r.join(".env"), "hidden").unwrap();
        std::fs::write(r.join("index.html"), "ok").unwrap();
        let f = files(&r).unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(manifest(&f).unwrap().total_bytes, 2);
    }
}
