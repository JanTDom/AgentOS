//! Bezpieczne endpointy: dokładne hosty lokalne, DNS i limitowane pobieranie.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use url::Url;

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_multicast()
                && !v.is_broadcast()
                && !v.is_documentation()
                && v.octets()[0] != 0
                && v.octets()[0] < 224
                && !(v.octets()[0] == 100 && (64..128).contains(&v.octets()[1]))
                && !(v.octets()[0] == 198 && (18..20).contains(&v.octets()[1]))
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let b = v.octets();
            !v.is_loopback()
                && !v.is_unspecified()
                && !v.is_multicast()
                && (b[0] & 0xfe) != 0xfc
                && !(b[0] == 0xfe && (b[1] & 0xc0) == 0x80)
                && (b[0] & 0xe0) == 0x20
                && !(b[0..4] == [0x20, 0x01, 0x0d, 0xb8])
        }
    }
}
pub fn local_endpoint(raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw).map_err(|_| "Nieprawidłowy URL.")?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some()
    {
        return Err("Nieprawidłowy lokalny endpoint.".into());
    }
    match u.host() {
        Some(url::Host::Domain("localhost")) => Ok(u),
        Some(url::Host::Ipv4(v)) if v == Ipv4Addr::LOCALHOST => Ok(u),
        Some(url::Host::Ipv6(v)) if v == Ipv6Addr::LOCALHOST => Ok(u),
        _ => Err("Model lokalny może łączyć się tylko z localhost, 127.0.0.1 lub ::1.".into()),
    }
}
pub async fn public_url(raw: &str) -> Result<(Url, Vec<std::net::SocketAddr>), String> {
    let u = Url::parse(raw).map_err(|_| "Nieprawidłowy URL.")?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some()
    {
        return Err("Dozwolone HTTP/HTTPS bez poświadczeń w URL.".into());
    }
    let host = u
        .host_str()
        .ok_or("Brak hosta.")?
        .trim_matches(['[', ']'])
        .to_string();
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return Err("Adres lokalny jest zablokowany.".into());
    }
    let addresses: Vec<_> =
        tokio::net::lookup_host((host.as_str(), u.port_or_known_default().unwrap_or(443)))
            .await
            .map_err(|e| e.to_string())?
            .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        return Err("DNS wskazuje adres prywatny lub zastrzeżony — odmowa.".into());
    }
    Ok((u, addresses))
}
pub async fn model_client(endpoint: &str, local: bool) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if local {
        local_endpoint(endpoint)?;
    } else {
        let (u, addresses) = public_url(endpoint).await?;
        if u.scheme() != "https" {
            return Err("Model chmurowy wymaga HTTPS.".into());
        }
        b = b.resolve_to_addrs(u.host_str().ok_or("Brak hosta.")?, &addresses);
    }
    b.build().map_err(|e| e.to_string())
}
pub async fn limited(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err("Odpowiedź przekracza limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > max {
            return Err("Odpowiedź przekracza limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn web_fetch(url: String) -> Result<String, String> {
    let mut raw = url;
    for _ in 0..4 {
        let (u, addresses) = public_url(&raw).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(u.host_str().ok_or("Brak hosta.")?, &addresses)
            .build()
            .map_err(|e| e.to_string())?;
        let r = client
            .get(u.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if r.status().is_redirection() {
            let location = r
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("Brak location.")?;
            raw = u.join(location).map_err(|e| e.to_string())?.to_string();
            continue;
        }
        if !r.status().is_success() {
            return Err(format!("HTTP {}", r.status()));
        }
        return Ok(String::from_utf8_lossy(&limited(r, 2_000_000).await?)
            .chars()
            .take(30_000)
            .collect());
    }
    Err("Za dużo przekierowań.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loopback_is_exact() {
        for p in [
            "http://localhost.evil.test",
            "http://127.0.0.1.evil.test",
            "http://localhost@evil.test",
        ] {
            assert!(local_endpoint(p).is_err());
        }
        assert!(local_endpoint("http://localhost:11434/v1").is_ok());
        assert!(local_endpoint("http://[::1]:1234").is_ok());
    }
    #[test]
    fn blocks_private_ranges() {
        for p in [
            "127.0.0.1",
            "172.31.1.1",
            "10.0.0.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "::ffff:127.0.0.1",
            "fe80::1",
        ] {
            assert!(!public_ip(p.parse().unwrap()), "{p}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
    }
}
