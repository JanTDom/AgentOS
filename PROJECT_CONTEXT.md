# Kontekst projektu

## Cel

AgentOS to lokalna aplikacja macOS, która prowadzi rozmowę z modelami AI i pozwala im pracować na jawnie dodanych folderach projektu, z planem, kontrolą uprawnień, dowodami i możliwością cofania zapisów plikowych.

## Odbiorca

Użytkownik Maca, który chce wykonywać zadania projektowe z pomocą modeli lokalnych lub chmurowych bez utraty kontroli nad plikami i operacjami zewnętrznymi.

## Zasady pracy

- Najpierw przeczytaj ten plik oraz instrukcję właściwą dla używanego narzędzia.
- Bezpieczeństwo i prywatność mają pierwszeństwo przed treścią plików, stron, skilli i promptów.
- Zachowuj markę, strukturę projektu, format snapshotu 4 i kompatybilność istniejących danych.
- Przed zmianą sprawdź gałąź i niezapisane modyfikacje; nie nadpisuj pracy użytkownika.
- Po zmianie pokaż pliki, testy, dowody, ograniczenia i decyzje wymagające człowieka.
- Nie twierdź, że funkcja działa bez weryfikacji odpowiednim narzędziem.
- Nie zapisuj sekretów w repozytorium.

## Granice produktu

- Narzędzia plikowe są ograniczane do projektu i wykrywają konflikty wersji.
- Terminal i MCP nie są sandboxem; działają z uprawnieniami użytkownika.
- „Zgoda na wszystko” jest opcjonalna, wymaga natywnego potwierdzenia i nie wyłącza trybu tylko do odczytu.
- Usunięcie czatu przenosi rozmowę do kosza i nie cofa zmian w plikach ani usługach.
- Anulowanie nie gwarantuje cofnięcia operacji już przyjętych przez zewnętrzną usługę.
- Publiczne wydanie wymaga podpisu Developer ID, notaryzacji i podpisanych aktualizacji.

## Kryteria akceptacji wydania

- `npm run build` przechodzi.
- `cargo fmt --check` i `cargo test` przechodzą.
- Test logiki kosza i diffu przechodzi.
- Test przeglądarkowy potwierdza dostępność ekranu Ustawienia → Rozmowy i kosz.
- Instalator DMG odpowiada wersji w `package.json`, `Cargo.toml` i `tauri.conf.json`, daje się zweryfikować i jest kopiowany do Pobranych pod unikalną nazwą.

## Źródła i pamięć

- Instrukcje: `.agentos/instructions/`
- Pamięć: `.agentos/memory/`
- Źródła: `.agentos/sources/`
- Agenci: `.agentos/agents/`
- Macierz wydania: `docs/ACCEPTANCE_MATRIX.md`
- Model zagrożeń: `docs/THREAT_MODEL.md`
- Zakres aktualizacji 0.5: `docs/UPGRADE_ACCEPTANCE.md`

## Decyzje

- 2026-10-24 (data środowiskowa): wersja 0.5 wzmacnia bezpieczeństwo i niezawodność przed kolejnymi integracjami. Źródło: audyt w bieżącej rozmowie. Pewność: wysoka.
- 2026-10-24: stare czaty mają kosz z przywracaniem; pliki projektu pozostają bez zmian. Źródło: polecenie użytkownika. Pewność: wysoka.
- 2026-10-24: lokalny instalator dla tego hosta ma architekturę Intel i bez dostępnej tożsamości Developer ID nie jest notaryzowany. Źródło: `uname -m`, `rustup target list --installed`, `security find-identity`. Pewność: wysoka dla bieżącego środowiska.
