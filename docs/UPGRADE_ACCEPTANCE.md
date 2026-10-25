# Aktualizacja niezawodności AgentOS

## Źródła i zakres

- Źródło decyzji: polecenie użytkownika w bieżącej rozmowie: „Wykonaj to wszystko (…) zaktualizowany instalator (…) można było kasować stare czaty”.
- Źródło techniczne: audyt bieżącego kodu, build frontendu i 25 testów Rust; początkowo 16 lokalnych zmian na gałęzi `redesign-agent-loop`.
- Data środowiskowa: 2026-10-24; pewność zakresu: wysoka. Nie weryfikowano daty zewnętrznym źródłem.

## Kryteria akceptacji

1. Operacje zmieniające pliki i wykonujące polecenia wymagają sprawdzanej backendowo polityki oraz zgody przypisanej do argumentów; tryb odczytu odmawia zapisu.
2. MCP nie otrzymuje automatycznie uprawnień zapisu w trybie odczytu. Terminal i MCP nie są opisywane jako sandbox.
3. Host lokalnego modelu jest parsowany, a nie sprawdzany prefiksem. Publiczny fetch sprawdza IP, DNS i przekierowania oraz limity pobierania.
4. Pliki wrażliwe są blokowane w odczycie i publikacji; przed publikacją użytkownik może sprawdzić manifest.
5. Odłączenie usługi usuwa odpowiedni sekret z Keychain; błąd nie jest przedstawiany jako sukces.
6. Historia ma kolejkę zapisu, sygnalizację błędu i odzyskiwanie; uszkodzony snapshot nie jest automatycznie zastępowany pustym.
7. Zapis porównuje wersję bazową, używa unikalnych identyfikatorów i nie nadpisuje równoległych zmian bez decyzji.
8. Diff jasno pokazuje, czy jest pełny. Cofanie respektuje projekt i późniejsze zmiany.
9. Stary czat można przenieść do kosza po potwierdzeniu i przywrócić. Aktywnego czatu nie można usunąć; pliki projektu pozostają bez zmian.
10. Projekt zapamiętuje dostawcę i konkretny model.
11. Stop anuluje wspierane operacje backendu; ograniczenia anulowania usług zewnętrznych są jawne.
12. Odpowiedzi są strumieniowane; limity kontekstu i kosztów są jawne, bez fikcyjnych cen.
13. Przejście z lokalnego modelu na chmurowy wymaga zgody na wysłanie historii.
14. Podsumowanie oddziela faktyczne wyniki narzędzi od deklaracji modelu.
15. Testy regresyjne i CI obejmują nowe zachowania; dokumentacja odpowiada implementacji.
16. DMG dla Intel ma nowy numer wersji, przechodzi weryfikację obrazu i trafia do Pobranych bez nadpisania starego pliku.

## Ograniczenia

- Brak tożsamości code-signing w środowisku (sprawdzone narzędziem); nie obiecujemy podpisu Developer ID ani notaryzacji.
- Dostępny target Rust: x86_64-apple-darwin. Nie obiecujemy wersji uniwersalnej.
- Brak płatnych wywołań modeli i rzeczywistych wdrożeń bez osobnej zgody.
- Istniejące lokalne zmiany zachowujemy. Bez automatycznego commita, push i instalacji aktualizacji na miejsce działającej aplikacji.
- Nie usuwamy istniejących plików projektu. Kosz czatów jest logiczny; kopie bezpieczeństwa mogą nadal zawierać wcześniejszą historię.

## Kopie i migracja

- Kopia kodu sprzed aktualizacji powinna powstać w ignorowanym `.agentos-build/` przed zmianą kodu.
- Przed migracją danych aplikacja tworzy kopię snapshotu; klucze pozostają w Keychain.
- Zachować format 4 z opcjonalnymi nowymi polami, jeśli wystarczy do kompatybilności; nie odrzucać nowszych lub uszkodzonych danych bez komunikatu.

## Status dowodów

Ten dokument jest zakresem, nie potwierdzeniem wykonania. Faktyczne wyniki testów, różnice i ograniczenia należy zapisać po implementacji.
