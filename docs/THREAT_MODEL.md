# AgentOS — model zagrożeń 0.5

Data aktualizacji: 2026-10-24 (data środowiskowa, niezweryfikowana zewnętrznie).

## Aktywa i granice

Aktywa: klucze API, prywatne pliki, historia rozmów, repozytoria, bazy i wdrożenia. Granice zaufania: WebView ↔ Rust IPC, Rust ↔ folder projektu, Rust ↔ Keychain, model ↔ treść projektu, sieć publiczna, procesy terminala/MCP i usługi GitHub/Vercel/Supabase.

## Kontrole obecne

- Polityka backendowa pośredniczy w komendach IPC; argumenty mutacji są zatwierdzane natywnie albo przez świadomie włączoną globalną zgodę.
- Tryb tylko do odczytu jest sprawdzany także w backendzie dla operacji mających ścieżkę projektu.
- Ścieżki i istniejący rodzice są kanonikalizowani; traversal i dowiązania poza root są blokowane.
- Popularne pliki wrażliwe i sygnatury sekretów są blokowane przy odczycie, commitowaniu i publikacji.
- Publiczny fetch sprawdza URL, DNS, adresy IP, przekierowania i limit treści. Lokalne modele wymagają dokładnego hosta loopback.
- Zapisy plików używają hash wersji bazowej, unikalnego ID, kopii i atomowej podmiany.
- Snapshot jest atomowy, walidowany i rotowany; błąd odczytu blokuje nadpisanie.
- Stop wysyła sygnał anulowania do wspieranych żądań oraz zabija grupę procesu terminala.
- Publikacja Vercel wymaga manifestu i ponownej kontroli plików.

## Istotne ograniczenia

1. **Terminal i MCP nie są sandboxem.** Mogą czytać lub modyfikować dane poza projektem z uprawnieniami użytkownika.
2. Globalna zgoda na wszystko zwiększa skutki przejęcia sesji. Włączenie wymaga natywnego potwierdzenia, ale użytkownik odpowiada za jej wyłączenie po zakończeniu pracy.
3. MCP nie ma kryptograficznej tożsamości ani podpisów narzędzi. Skille są skanowane heurystycznie, nie podpisane.
4. Log audytowy nie jest hash-chain ani przechowywany poza zapisywalnymi danymi aplikacji.
5. Anulowanie nie gwarantuje cofnięcia żądania już przyjętego przez zewnętrzną usługę.
6. Wykrywanie sekretów jest heurystyczne. Nietypowy sekret może przejść kontrolę.
7. Historia i kopie są lokalne, lecz nie mają dodatkowego szyfrowania aplikacyjnego. Kosz nie jest trwałym wymazaniem.
8. Endpointy dostawców niestandardowych są dopuszczane tylko przez HTTPS, ale zaufanie do samego dostawcy pozostaje decyzją użytkownika.
9. Instalator bez Developer ID nie zapewnia tożsamości wydawcy ani notaryzacji.

## OWASP ASI — aktualny obraz

- ASI-01 Prompt Injection: częściowo — instrukcje i deterministyczna polityka narzędzi, brak klasyfikatora treści.
- ASI-02 Tool Use: częściowo — allowlista i walidacja, lecz terminal/MCP mają szeroki zakres.
- ASI-03 Agency: częściowo — tryby projektu i limity kroków.
- ASI-04 Escalation: częściowo — zmiana polityki wymaga natywnej zgody.
- ASI-05 Trust Boundary: luka — brak podpisanej tożsamości agentów/MCP.
- ASI-06 Logging: luka — brak odpornego na manipulację audytu.
- ASI-07 Identity: luka — agenci mają identyfikatory logiczne, nie kryptograficzne.
- ASI-08 Policy Bypass: częściowo — polityka w Rust, nadal potrzebne testy całego IPC.
- ASI-09 Supply Chain: częściowo — limity i skan skilli, brak podpisów/SBOM.
- ASI-10 Monitoring: częściowo — limit kroków i Stop, brak detekcji anomalii.

## Przed publiczną dystrybucją

Podpis Developer ID, notaryzacja, automatyczne aktualizacje z podpisem, polityka prywatności, szyfrowanie historii, hash-chain audytu, izolacja terminala/MCP, podpisy skilli i pełne testy penetracyjne IPC/sieci.
