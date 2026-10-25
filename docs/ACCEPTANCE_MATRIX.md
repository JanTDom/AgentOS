# AgentOS — macierz akceptacyjna 0.5.2

Stan końcowej weryfikacji: 2026-10-25 (data środowiskowa). Instalator Intel.

| Obszar | Dowód | Status |
|---|---|---|
| Build frontend | `npm run build` — 1605 modułów | przechodzi |
| Format Rust | `cargo fmt --check` | przechodzi |
| Testy Rust | 28 testów, 0 błędów (test Keychain pominięty w przebiegu wydania) | przechodzi |
| Kosz czatów | `src/chatTrash.ts`, `ChatManager`, przycisk w rozmowie | test logiki przechodzi |
| Trwałość historii | kolejka frontend + atomowy snapshot i 5 kopii | testy jednostkowe przechodzą |
| Konflikty plików | `fs_version`, `fs_write(expected_hash)` | kod + build/test |
| Ścieżki i symlinki | `filesafety.rs` | test traversal/symlink przechodzi |
| Sieć i SSRF | `network.rs` | test zakresów IP i dokładnego loopback przechodzi |
| Sekrety | blokady odczytu, commitowania i publikacji; usuwanie tokenu | test heurystyk; bez gwarancji pełnego wykrycia |
| Backendowe zgody | `policy.rs`, natywne okna, tryb odczytu | test klasyfikacji przechodzi |
| Zgoda na wszystko | natywne potwierdzenie włączenia; read-only nadal nadrzędne | kod + build |
| Stop | backendowy sygnał, anulowanie modelu i grupy terminala | kod + build; bez testu z płatnym API |
| Streaming | Tauri Channel + SSE | kod + build; bez wywołania płatnego dostawcy |
| Publikacja | manifest, limit, ponowny hash i skan | test plików; bez rzeczywistego wdrożenia |
| UI Ustawienia/Kosz | Playwright przez lokalny Vite i Google Chrome | przechodzi, screenshot `.agentos-build/settings-smoke.png` |
| Instalator | DMG zamontowany, wersja 0.5.2, Mach-O x86_64, `hdiutil verify` | przechodzi |

## Instalator

- Plik: `/Users/macbookpro/Downloads/AgentOS-0.5.2-Intel-20261025-093223.dmg`
- SHA-256: `67a18eae8bcd6eefc77af89c0604550b27b9599e25e17a18a22ed6e0cf0979eb`
- Bundle ID: `pl.agentos.desktop`
- Podpis: brak; `codesign` i `spctl` potwierdzają brak użytecznej sygnatury.

## Granica interpretacji

Nie wykonywano płatnych wywołań modeli, zmian w prawdziwej bazie, push, PR ani wdrożeń Vercel. Streaming i anulowanie zewnętrznych usług wymagają jeszcze testów integracyjnych z rzeczywistymi kontami. Terminal i MCP nie są sandboxem. Wykrywanie sekretów jest heurystyczne. Instalator jest lokalny, Intel, bez Developer ID i notaryzacji.
