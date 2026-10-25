# AgentOS

AgentOS to lokalna aplikacja macOS do pracy z modelami AI nad folderami projektów. Łączy rozmowę, narzędzia plikowe, plan, jawne uprawnienia, cofanie zmian i integracje publikacyjne.

## Najważniejsze funkcje wersji 0.5.3

- modele lokalne (Ollama, LM Studio) i chmurowe;
- klucze przechowywane w macOS Keychain;
- plan i zgody w rozmowie oraz opcjonalna globalna „Zgoda na wszystko” potwierdzana natywnie;
- wersjonowane zapisy plików z wykrywaniem konfliktów i cofnięciem;
- Stop anulujący wspierane żądania modelu i grupy procesów terminala;
- kosz starych czatów z przywracaniem (usunięcie czatu nie cofa zmian w projekcie);
- pełna lista wszystkich włączonych umiejętności w kontekście modelu, bez limitu 60;
- lokalne wyszukiwanie całej biblioteki skilli po nazwie, identyfikatorze i opisie; pełne instrukcje są odczytywane na żądanie;
- ochrona ścieżek, dowiązań, plików wrażliwych i publicznych żądań sieciowych;
- GitHub, Vercel, Supabase i lokalne serwery MCP.

## Granice bezpieczeństwa

Narzędzia plikowe są ograniczone do wybranego projektu. **Terminal i MCP nie są sandboxem** — procesy działają z uprawnieniami użytkownika i mogą oddziaływać poza projektem. Zgoda na wszystko nie wyłącza trybu „Tylko odczyt”. Cofnięcie obejmuje zapisy wykonane narzędziem plikowym, nie dowolne polecenia, commity, bazy danych ani operacje produkcyjne.

Treść skillów jest materiałem pomocniczym, a nie instrukcjami nadrzędnymi. Skryptów skilli AgentOS nie uruchamia automatycznie. Same metadane na liście nie wymuszają zastosowania skillu; agent dobiera pasujące pozycje i odczytuje `SKILL.md` narzędziem `use_skill`.

Pliki `.env`, klucze prywatne i popularne pliki poświadczeń są blokowane w narzędziach odczytu oraz publikacji. Jest to ochrona warstwowa, nie gwarancja wykrycia każdego sekretu.

Rozmowy, kosz i kopie snapshotu są lokalne, ale nie są dodatkowo szyfrowane przez AgentOS. Skasowanie czatu przenosi go do kosza; kopie bezpieczeństwa mogą nadal zawierać wcześniejszy stan.

## Development

```bash
npm ci
npm run build
npm run test:frontend
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:dev
```

## Instalator Intel

Na Macu Intel:

```bash
npm run tauri:build:intel
```

Artefakty powstają w `src-tauri/target/x86_64-apple-darwin/release/bundle/`. Dystrybucja publiczna wymaga własnego certyfikatu Apple Developer ID i notaryzacji; lokalny niepodpisany DMG może wymagać zezwolenia w Prywatność i ochrona.

## Dokumentacja

- `docs/THREAT_MODEL.md` — granice i ryzyka;
- `docs/UPGRADE_ACCEPTANCE.md` — kryteria aktualizacji 0.5;
- `docs/ACCEPTANCE_MATRIX.md` — macierz funkcji i dowodów wydania 0.5.3.
