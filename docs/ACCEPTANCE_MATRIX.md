# AgentOS — macierz akceptacyjna 0.5.3

## Zakres i dowody

- Agent widzi nazwy, identyfikatory i pełne opisy wszystkich włączonych skillów globalnych oraz projektu — usunięto limit 60.
- Narzędzie `search_installed_skills` przeszukuje pełną bibliotekę lokalną po nazwie, identyfikatorze i opisie. Puste zapytanie zwraca wszystkie włączone pozycje.
- `find_skills` przeszukuje włączoną bibliotekę lokalną przed zapytaniem do katalogu/GitHuba.
- `use_skill` przyjmuje stabilny klucz. Niejednoznaczne nazwy nie wybierają po cichu pierwszego trafienia.
- Wyłączenia globalne i projektowe są zachowane; pełny `SKILL.md` jest ładowany na żądanie.

| Kontrola | Dowód | Status |
|---|---|---|
| Lista ponad dawnym limitem 60 | Test włączonych 212 skilli; prompt zawiera skill nr 212 | przechodzi |
| Wyszukiwanie opisu i pusta fraza | Test wyszukiwania case-insensitive i zwrotu wszystkich 212 pozycji | przechodzi |
| Dokładny klucz i duplikaty nazw | Test wyboru po kluczu i jawnej obsługi niejednoznaczności | przechodzi |
| Wyłączenia globalne/projektowe | Test, oba wyłączone skille są filtrowane | przechodzi |
| Build frontendu | `npm run build` — TypeScript oraz Vite, 1606 modułów | przechodzi |
| Testy logiki frontendu | `npm run test:frontend` | przechodzi |
| Format Rust | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | przechodzi |
| Testy Rust | 28 testów; test Keychain pominięty w tym przebiegu | przechodzi |
| Mac Intel | DMG zweryfikowany przez `hdiutil verify`; Info.plist 0.5.3, Bundle ID `pl.agentos.desktop`, Mach-O x86_64 | przechodzi |
| Podpis macOS | `codesign` potwierdza brak podpisu; brak Developer ID i notaryzacji | ograniczenie środowiska |
| Weryfikacja wersji | `package.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json` = 0.5.3 | przechodzi |
| Vercel | pominięte — AgentOS to aplikacja desktopowa, zgodnie z poleceniem użytkownika | pominięte |

## Instalator

- Plik: `/Users/macbookpro/Downloads/AgentOS-0.5.3-Intel-20261025-102114.dmg`
- SHA-256: `5b242159811542c9f751a3ce7c099490fe69a814297e7e9a4f55577773ce8d4d`
- Rozmiar: ok. 11 MB; `hdiutil verify` potwierdził poprawną sumę obrazu.
- Zawiera `AgentOS.app` dla Intel (`x86_64`). Podpis i notaryzacja nie są dostępne w tym środowisku.

## Ograniczenia

Lista wszystkich metadanych rośnie wraz z liczbą włączonych skilli i zużywa kontekst modelu. Agent dobiera pasujące pozycje i ładuje ich pełne instrukcje na żądanie; sama obecność skilla na liście nie gwarantuje jego użycia ani bezbłędnego wykonania instrukcji. Vercel nie był używany.
