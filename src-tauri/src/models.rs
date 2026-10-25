//! Rejestr modeli: lista pobierana na żywo od dostawcy, z nazwą, rodzajem,
//! długością kontekstu i ceną — tylko wtedy, gdy dostawca te dane podaje.
//! Niczego nie zgadujemy: brak danych = pole puste.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    /// chat | embedding | image | audio | other
    pub category: &'static str,
    pub context: Option<u64>,
    pub max_output: Option<u64>,
    /// USD za 1 mln tokenów — wyłącznie z odpowiedzi dostawcy.
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    /// Data publikacji (sekundy unix), jeśli dostawca ją podaje.
    pub created: Option<i64>,
    pub vision: Option<bool>,
    /// LM Studio: czy model jest załadowany do pamięci.
    pub loaded: Option<bool>,
    /// Modele lokalne: rozmiar parametrów / pliku.
    pub size: Option<String>,
}

impl ModelInfo {
    fn new(id: &str, name: &str, category: &'static str) -> Self {
        ModelInfo {
            id: id.to_string(),
            name: name.to_string(),
            category,
            context: None,
            max_output: None,
            input_price: None,
            output_price: None,
            created: None,
            vision: None,
            loaded: None,
            size: None,
        }
    }
}

/// Rodzaj modelu na podstawie identyfikatora (dla dostawców, którzy go nie podają).
pub fn classify(id: &str) -> &'static str {
    let s = id.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| s.contains(w));
    if has(&["embed", "rerank"]) {
        "embedding"
    } else if has(&[
        "tts",
        "whisper",
        "transcribe",
        "audio",
        "realtime",
        "speech",
        "lyria",
    ]) {
        "audio"
    } else if has(&["dall-e", "gpt-image", "imagen", "-image", "sora", "veo"]) {
        "image"
    } else if has(&["moderation", "computer-use"])
        || s.starts_with("babbage")
        || s.starts_with("davinci")
    {
        "other"
    } else {
        "chat"
    }
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return String::new(),
    };
    // „o3”, „4o”, „4.1” zostawiamy bez zmian.
    if !first.is_alphabetic() || chars.clone().next().map_or(false, |c| c.is_ascii_digit()) {
        return word.to_string();
    }
    first.to_uppercase().collect::<String>() + chars.as_str()
}

/// Czytelna nazwa z identyfikatora OpenAI, np. gpt-5.5-mini → GPT-5.5 Mini.
pub fn pretty_openai(id: &str) -> String {
    let mut parts: Vec<&str> = id.split('-').collect();
    let mut date = None;
    let n = parts.len();
    if n >= 4 {
        let (y, m, d) = (parts[n - 3], parts[n - 2], parts[n - 1]);
        if y.len() == 4
            && m.len() == 2
            && d.len() == 2
            && [y, m, d]
                .iter()
                .all(|p| p.chars().all(|c| c.is_ascii_digit()))
        {
            date = Some(format!("{y}-{m}-{d}"));
            parts.truncate(n - 3);
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut rest = &parts[..];
    if parts.first() == Some(&"gpt") && parts.len() > 1 {
        out.push(format!("GPT-{}", parts[1]));
        rest = &parts[2..];
    } else if parts.first() == Some(&"chatgpt") {
        out.push("ChatGPT".to_string());
        rest = &parts[1..];
    }
    out.extend(rest.iter().map(|p| capitalize(p)));
    let mut name = out.join(" ");
    if let Some(d) = date {
        name.push_str(&format!(" ({d})"));
    }
    name
}

/// RFC 3339 (np. 2025-05-22T00:00:00Z) → sekundy unix. Wystarcza do sortowania.
pub fn rfc3339_to_unix(text: &str) -> Option<i64> {
    let date = text.get(0..10)?;
    let mut it = date.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    // Algorytm „days from civil” (H. Hinnant).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400)
}

fn u64_at(item: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|k| item.get(*k).and_then(Value::as_u64))
        .filter(|v| *v > 0)
}

fn price_per_million(v: &Value) -> Option<f64> {
    let per_token = match v {
        Value::String(s) => s.parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    if per_token < 0.0 {
        return None; // OpenRouter używa -1 dla cen zmiennych
    }
    Some((per_token * 1_000_000.0 * 10_000.0).round() / 10_000.0)
}

fn human_bytes(bytes: u64) -> String {
    let gb = bytes as f64 / 1_000_000_000.0;
    if gb >= 1.0 {
        format!("{gb:.1} GB")
    } else {
        format!("{:.0} MB", bytes as f64 / 1_000_000.0)
    }
}

/// Lista w formacie OpenAI (/v1/models) — OpenAI, serwery zgodne, fallback dla lokalnych.
pub fn parse_openai(v: &Value, pretty: bool) -> Vec<ModelInfo> {
    let items = v["data"].as_array().or_else(|| v["models"].as_array());
    items
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["id"]
                        .as_str()
                        .or_else(|| item["name"].as_str())?
                        .trim_start_matches("models/");
                    let name = if pretty {
                        pretty_openai(id)
                    } else {
                        id.to_string()
                    };
                    let mut m = ModelInfo::new(id, &name, classify(id));
                    m.created = item["created"].as_i64().filter(|c| *c > 0);
                    m.context =
                        u64_at(item, &["context_length", "context_window", "max_model_len"]);
                    Some(m)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_anthropic(v: &Value) -> Vec<ModelInfo> {
    v["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["id"].as_str()?;
                    let name = item["display_name"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id);
                    let mut m = ModelInfo::new(id, name, "chat");
                    m.created = item["created_at"].as_str().and_then(rfc3339_to_unix);
                    m.context = u64_at(item, &["max_input_tokens", "context_window"]);
                    m.max_output = u64_at(item, &["max_tokens", "max_output_tokens"]);
                    Some(m)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_google(v: &Value) -> Vec<ModelInfo> {
    v["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["name"].as_str()?.trim_start_matches("models/");
                    let name = item["displayName"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id);
                    let methods: Vec<&str> = item["supportedGenerationMethods"]
                        .as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    let by_id = classify(id);
                    let category = if by_id != "chat" {
                        by_id
                    } else if methods.contains(&"generateContent") {
                        "chat"
                    } else if methods.iter().any(|m| m.starts_with("embed")) {
                        "embedding"
                    } else {
                        "other"
                    };
                    let mut m = ModelInfo::new(id, name, category);
                    m.context = u64_at(item, &["inputTokenLimit"]);
                    m.max_output = u64_at(item, &["outputTokenLimit"]);
                    Some(m)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_openrouter(v: &Value) -> Vec<ModelInfo> {
    v["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["id"].as_str()?;
                    let name = item["name"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id);
                    let mods = |key: &str| -> Vec<String> {
                        item["architecture"][key]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            })
                            .unwrap_or_default()
                    };
                    let output = mods("output_modalities");
                    let input = mods("input_modalities");
                    let category = if output.is_empty() || output.iter().any(|o| o == "text") {
                        let c = classify(id);
                        if c == "image" {
                            "chat"
                        } else {
                            c
                        }
                    } else if output.iter().any(|o| o == "image") {
                        "image"
                    } else if output.iter().any(|o| o == "audio") {
                        "audio"
                    } else {
                        "other"
                    };
                    let mut m = ModelInfo::new(id, name, category);
                    m.context = u64_at(item, &["context_length"]);
                    m.max_output = item["top_provider"]["max_completion_tokens"]
                        .as_u64()
                        .filter(|v| *v > 0);
                    m.input_price = price_per_million(&item["pricing"]["prompt"]);
                    m.output_price = price_per_million(&item["pricing"]["completion"]);
                    m.created = item["created"].as_i64().filter(|c| *c > 0);
                    if !input.is_empty() {
                        m.vision = Some(input.iter().any(|i| i == "image"));
                    }
                    Some(m)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Ollama: /api/tags — zainstalowane modele z rozmiarem.
pub fn parse_ollama(v: &Value) -> Vec<ModelInfo> {
    v["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["name"].as_str().or_else(|| item["model"].as_str())?;
                    let families: Vec<String> = item["details"]["families"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_lowercase)
                                .collect()
                        })
                        .unwrap_or_default();
                    let embedding = id.to_lowercase().contains("embed")
                        || families.iter().any(|f| f.contains("bert"));
                    let mut m =
                        ModelInfo::new(id, id, if embedding { "embedding" } else { "chat" });
                    let params = item["details"]["parameter_size"]
                        .as_str()
                        .filter(|s| !s.is_empty());
                    let bytes = item["size"].as_u64().filter(|b| *b > 0).map(human_bytes);
                    m.size = match (params, bytes) {
                        (Some(p), Some(b)) => Some(format!("{p} · {b}")),
                        (Some(p), None) => Some(p.to_string()),
                        (None, Some(b)) => Some(b),
                        _ => None,
                    };
                    m.created = item["modified_at"].as_str().and_then(rfc3339_to_unix);
                    if families.iter().any(|f| f == "clip" || f == "mllama") {
                        m.vision = Some(true);
                    }
                    Some(m)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// LM Studio: /api/v0/models — rodzaj, kontekst, czy załadowany.
pub fn parse_lmstudio(v: &Value) -> Vec<ModelInfo> {
    v["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item["id"].as_str()?;
                    let kind = item["type"].as_str().unwrap_or("llm");
                    let category = match kind {
                        "embeddings" | "embedding" => "embedding",
                        "llm" | "vlm" => "chat",
                        _ => "other",
                    };
                    let mut m = ModelInfo::new(id, id, category);
                    m.context = u64_at(item, &["max_context_length"]);
                    m.vision = Some(kind == "vlm");
                    m.loaded = item["state"].as_str().map(|s| s == "loaded");
                    m.size = item["quantization"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(|q| format!("kwantyzacja {q}"));
                    Some(m)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn category_rank(c: &str) -> u8 {
    match c {
        "chat" => 0,
        "embedding" => 1,
        "image" => 2,
        "audio" => 3,
        _ => 4,
    }
}

/// Kolejność: najpierw modele do rozmów, w ich obrębie najnowsze; bez duplikatów.
pub fn sort_models(mut models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    models.sort_by(|a, b| {
        category_rank(a.category)
            .cmp(&category_rank(b.category))
            .then_with(|| {
                b.created
                    .unwrap_or(i64::MIN)
                    .cmp(&a.created.unwrap_or(i64::MIN))
            })
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let mut seen = std::collections::HashSet::new();
    models.retain(|m| seen.insert(m.id.clone()));
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pretty_names_for_openai() {
        assert_eq!(pretty_openai("gpt-4o-mini"), "GPT-4o Mini");
        assert_eq!(
            pretty_openai("gpt-4o-mini-2024-07-18"),
            "GPT-4o Mini (2024-07-18)"
        );
        assert_eq!(pretty_openai("o3-mini"), "o3 Mini");
        assert_eq!(pretty_openai("chatgpt-4o-latest"), "ChatGPT 4o Latest");
        assert_eq!(pretty_openai("gpt-4.1"), "GPT-4.1");
    }

    #[test]
    fn classifies_non_chat_models() {
        assert_eq!(classify("text-embedding-3-large"), "embedding");
        assert_eq!(classify("whisper-1"), "audio");
        assert_eq!(classify("gpt-4o-realtime-preview"), "audio");
        assert_eq!(classify("dall-e-3"), "image");
        assert_eq!(classify("gpt-image-1"), "image");
        assert_eq!(classify("davinci-002"), "other");
        assert_eq!(classify("omni-moderation-latest"), "other");
        assert_eq!(classify("gpt-4o"), "chat");
        assert_eq!(classify("o3"), "chat");
    }

    #[test]
    fn parses_anthropic_with_display_names() {
        let v = json!({"data":[
            {"id":"claude-a","display_name":"Claude A","created_at":"2025-02-01T00:00:00Z","type":"model"},
            {"id":"claude-b","display_name":"Claude B","created_at":"2026-01-01T00:00:00Z","type":"model"}
        ],"has_more":false});
        let list = sort_models(parse_anthropic(&v));
        assert_eq!(list[0].id, "claude-b");
        assert_eq!(list[0].name, "Claude B");
        assert_eq!(list[1].created, Some(1738368000));
    }

    #[test]
    fn parses_google_limits_and_methods() {
        let v = json!({"models":[
            {"name":"models/gemini-x","displayName":"Gemini X","inputTokenLimit":1048576,"outputTokenLimit":65536,"supportedGenerationMethods":["generateContent","countTokens"]},
            {"name":"models/text-embedding-004","displayName":"Text Embedding 004","supportedGenerationMethods":["embedContent"]},
            {"name":"models/aqa","displayName":"AQA","supportedGenerationMethods":["generateAnswer"]}
        ]});
        let list = parse_google(&v);
        assert_eq!(list[0].id, "gemini-x");
        assert_eq!(list[0].context, Some(1048576));
        assert_eq!(list[0].category, "chat");
        assert_eq!(list[1].category, "embedding");
        assert_eq!(list[2].category, "other");
    }

    #[test]
    fn parses_openrouter_prices() {
        let v = json!({"data":[{"id":"vendor/m","name":"Vendor: M","context_length":200000,
            "pricing":{"prompt":"0.000003","completion":"0.000015"},
            "architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},
            "top_provider":{"max_completion_tokens":8192}}]});
        let m = &parse_openrouter(&v)[0];
        assert_eq!(m.input_price, Some(3.0));
        assert_eq!(m.output_price, Some(15.0));
        assert_eq!(m.vision, Some(true));
        assert_eq!(m.category, "chat");
        assert_eq!(m.max_output, Some(8192));
    }

    #[test]
    fn parses_local_servers() {
        let o = json!({"models":[{"name":"llama3.2:3b","size":2019393189u64,"details":{"parameter_size":"3.2B","families":["llama"]}},
                                  {"name":"nomic-embed-text:latest","details":{"families":["nomic-bert"]}}]});
        let list = parse_ollama(&o);
        assert_eq!(list[0].size.as_deref(), Some("3.2B · 2.0 GB"));
        assert_eq!(list[1].category, "embedding");
        let l = json!({"data":[{"id":"qwen","type":"vlm","state":"loaded","max_context_length":32768},
                                {"id":"emb","type":"embeddings","state":"not-loaded"}]});
        let list = parse_lmstudio(&l);
        assert_eq!(list[0].loaded, Some(true));
        assert_eq!(list[0].vision, Some(true));
        assert_eq!(list[1].category, "embedding");
    }

    #[test]
    fn sorts_chat_first_and_dedups() {
        let v = json!({"data":[{"id":"text-embedding-3-small","created":3},{"id":"gpt-4o","created":1},{"id":"gpt-5","created":2},{"id":"gpt-5","created":2}]});
        let list = sort_models(parse_openai(&v, true));
        let ids: Vec<&str> = list.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-5", "gpt-4o", "text-embedding-3-small"]);
    }
}

// ---------- sieć ----------

use crate::agent::{check_local_endpoint, friendly_request_error, friendly_status_error, is_local};
use reqwest::Client;
use std::time::Duration;

fn origin(endpoint: &str) -> Option<String> {
    let url = url::Url::parse(endpoint).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

fn openai_base(endpoint: &str) -> String {
    endpoint
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .trim_end_matches("/messages")
        .to_string()
}

async fn get_json(request: reqwest::RequestBuilder, kind: &str) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|e| friendly_request_error(e, kind))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Nieczytelna odpowiedź dostawcy: {e}"))?;
    if !status.is_success() {
        return Err(friendly_status_error(status, &value));
    }
    Ok(value)
}

/// Pełna lista modeli dostawcy z opisem. Dane pochodzą wyłącznie z odpowiedzi dostawcy.
#[tauri::command]
pub async fn list_models_detailed(
    provider_id: String,
    provider_kind: String,
    endpoint: String,
) -> Result<Vec<ModelInfo>, String> {
    let kind = provider_kind.as_str();
    let local = is_local(kind);
    if local {
        check_local_endpoint(&endpoint)?;
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(if local { 5 } else { 25 }))
        .build()
        .map_err(|e| e.to_string())?;
    let key = if local {
        None
    } else {
        let key = crate::get_provider_key(&provider_id)?;
        if key.is_none() && kind != "custom" && kind != "openrouter" {
            return Err("Najpierw zapisz klucz API.".to_string());
        }
        key
    };
    let base = openai_base(&endpoint);

    let models = match kind {
        "anthropic" => {
            let key = key.unwrap_or_default();
            let mut all = Vec::new();
            let mut after: Option<String> = None;
            for _ in 0..10 {
                let mut url = format!("{base}/models?limit=1000");
                if let Some(a) = &after {
                    url.push_str(&format!("&after_id={a}"));
                }
                let req = client
                    .get(&url)
                    .header("x-api-key", &key)
                    .header("anthropic-version", "2023-06-01");
                let v = get_json(req, kind).await?;
                all.extend(parse_anthropic(&v));
                if v["has_more"].as_bool() == Some(true) {
                    after = v["last_id"].as_str().map(str::to_string);
                    if after.is_none() {
                        break;
                    }
                } else {
                    break;
                }
            }
            all
        }
        "google" => {
            let key = key.unwrap_or_default();
            let root = match endpoint.find("/v1beta") {
                Some(i) => format!("{}/v1beta", &endpoint[..i]),
                None => "https://generativelanguage.googleapis.com/v1beta".to_string(),
            };
            let mut all = Vec::new();
            let mut token: Option<String> = None;
            for _ in 0..10 {
                let mut url = format!("{root}/models?pageSize=1000");
                if let Some(t) = &token {
                    url.push_str(&format!("&pageToken={t}"));
                }
                let v = get_json(client.get(&url).header("x-goog-api-key", &key), kind).await?;
                all.extend(parse_google(&v));
                token = v["nextPageToken"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .map(str::to_string);
                if token.is_none() {
                    break;
                }
            }
            all
        }
        "openrouter" => {
            let mut req = client.get(format!("{base}/models"));
            if let Some(k) = &key {
                req = req.bearer_auth(k);
            }
            parse_openrouter(&get_json(req, kind).await?)
        }
        "ollama" => {
            let tags = match origin(&endpoint) {
                Some(o) => get_json(client.get(format!("{o}/api/tags")), kind)
                    .await
                    .ok(),
                None => None,
            };
            match tags {
                Some(v) => parse_ollama(&v),
                None => parse_openai(
                    &get_json(client.get(format!("{base}/models")), kind).await?,
                    false,
                ),
            }
        }
        "lmstudio" => {
            let rich = match origin(&endpoint) {
                Some(o) => get_json(client.get(format!("{o}/api/v0/models")), kind)
                    .await
                    .ok(),
                None => None,
            };
            match rich {
                Some(v) if v["data"].as_array().is_some() => parse_lmstudio(&v),
                _ => parse_openai(
                    &get_json(client.get(format!("{base}/models")), kind).await?,
                    false,
                ),
            }
        }
        _ => {
            let mut req = client.get(format!("{base}/models"));
            if let Some(k) = &key {
                req = req.bearer_auth(k);
            }
            parse_openai(&get_json(req, kind).await?, kind == "openai")
        }
    };
    Ok(sort_models(models))
}
