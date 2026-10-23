# AgentOS — macierz akceptacyjna zakresu 15 obszarów

Stan audytu: 2026-10-24. Repozytorium: `JanTDom/AgentOS`.

| # | Obszar | Kryterium | Dowód w aktualnym stanie | Status |
|---:|---|---|---|---|
| 1 | Dostawcy modeli | Adaptery OpenAI-compatible, Anthropic, Google, Ollama, OpenRouter i custom | `src/App.tsx`, `src-tauri/src/main.rs`, typ `Provider` | potwierdzone kodem |
| 2 | Klucze i aktualizacje | Klucze są w macOS Keychain, a snapshot nie zawiera sekretów | `save_provider`, `get_provider_key`, `get_snapshot/save_snapshot`; test Keychain na macOS | potwierdzone kodem/testem |
| 3 | Praca w katalogach | Import i inspekcja istniejących katalogów oraz przenośne pliki Claude/Codex/Gemini/AgentOS | `inspect_project`, `read_project_context`, `PROJECT_CONTEXT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | potwierdzone kodem |
| 4 | Sieć | HTTPS/HTTP z blokadą localhost/prywatnych zakresów, limitami i zgodą | `validate_http_url`, `web_fetch`, limit 2 MB/30 000 znaków | potwierdzone kodem/testem |
| 5 | Sterowanie komputerem | Jawne akcje: Finder, Terminal, URL, screenshot, aktywacja aplikacji, ograniczone kliknięcie i tekst | `computer_action`, `AccessibilityControls`, allowlista, limity, `approved` | potwierdzone kodem; test graficzny zależny od WindowServer |
| 6 | Rozmowa | Kolejne pytania w tym samym runie z zachowaniem wiadomości i wyborem modelu | `Run.messages`, `sendFollowUp`, composer w `RunView` | potwierdzone kodem |
| 7 | Równoległość | Niezależne runy, limit równoległości i trwała kolejka FIFO | `maxParallelTasks`, `QueuedTask`, snapshot, `ActivityView` | potwierdzone kodem |
| 8 | Pamięć | Globalna/projektowa pamięć, źródła, deduplikacja i oznaczanie konfliktów | `MemoryItem`, `onAddMemory`, `buildTaskPrompt`, status `conflict` | potwierdzone kodem |
| 9 | Routing kosztowy | Tryby economical/balanced/quality, preferencja lokalnego modelu, limit zadania i budżet dzienny | `chooseProvider`, `dailyBudget`, `maxCostPerTask`, ledger | potwierdzone kodem |
| 10 | Katalog modeli | Wyszukiwanie ofert darmowych i tanich z OpenRouter oraz użycie w routerze | `discover_model_offers`, `ModelsView`, `ModelOffer` | potwierdzone kodem; katalog wymaga sieci i klucza |
| 11 | Agenci | Wielu agentów, role, modele i zależności DAG z wykrywaniem cykli | `AgentDefinition.dependsOn`, `orderAgents`, Workspace | potwierdzone kodem |
| 12 | Skille | Manifesty JSON, import tylko z GitHub HTTPS, brak wykonywania kodu, jawne zaufanie | `list_project_skills`, `download_skill_manifest`, `SkillPanel` | potwierdzone kodem |
| 13 | Źródła i dowody | Źródła projektowe, artefakty odpowiedzi/checkpointu/worktree i eksport dowodów | `ProjectSource`, `EvidenceArtifact`, `exportRunEvidence`, `EvidenceRail` | potwierdzone kodem |
| 14 | Izolacja i odzyskiwanie | Worktree, checkpoint z HEAD, odtworzenie brakującego worktree i wznowienie runa | `prepare_worktree`, `create_checkpoint`, `recover_checkpoint`, `recoverRun` | potwierdzone kodem; wymaga repozytorium Git |
| 15 | Dostawa | Testy, push do GitHub i Intel DMG w Downloads | `cargo test` (5 testów), `npm run build`, commit `e5c0b7d`, `AgentOS-0.1.0-Intel.dmg` | testy/build/push potwierdzone; wizualny test wymaga pełnego WindowServer |

## Ostatnia weryfikacja techniczna

- Frontend: `npm run build` — przechodzi.
- Rust: `cargo fmt --check`, `cargo check`, `cargo test` — przechodzą; 5 testów, 0 błędów.
- Intel bundle: `x86_64`, bundle ID `pl.agentos.desktop`, wersja `0.1.0`.
- Aktualny DMG: `/Users/macbookpro/Downloads/AgentOS-0.1.0-Intel.dmg`.
- Ostatni hash DMG: `de73278ae320696db64551cbe486bb4f06c3343bab1c0449829daaf29fffa00b`.
- Proces po starcie wchodzi w `NSApplication run` i obsługuje WebKit; środowisko testowe nie udostępnia obrazu WindowServer (`screencapture: could not create image from display`).

## Granica interpretacji

„Potwierdzone kodem” oznacza, że kontrakt jest obecny i przechodzi testy statyczne/jednostkowe. Nie oznacza automatycznie pozytywnego testu z zewnętrznym dostawcą modelu, działającym Keychainem, repozytorium użytkownika ani graficzną sesją macOS. Te zależności są oznaczone osobno, żeby nie mieszać dowodu implementacji z dowodem środowiskowym.
