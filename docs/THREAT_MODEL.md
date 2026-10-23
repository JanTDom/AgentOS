# AgentOS — model zagrożeń MVP

Data: 22 października 2026 r.

## Zakres i założenia

W zakresie są: aplikacja Tauri, frontend React, Rust backend, lokalne katalogi projektów, Keychain macOS, zewnętrzne endpointy modeli, fetch sieciowy oraz allowlista akcji macOS. MVP działa jako aplikacja lokalna dla jednego użytkownika; nie zakłada współdzielenia projektów ani publicznego serwera.

Poza zakresem są: nieograniczone sterowanie myszą i klawiaturą, uruchamianie dowolnych poleceń powłoki z promptu, automatyczne publikowanie do produkcji, multi-tenancy i synchronizacja chmurowa.

## Aktywa

- klucze API i tokeny OAuth;
- prywatne pliki projektów, dokumenty i kod źródłowy;
- integralność repozytoriów i artefaktów;
- zrzuty ekranu i wyniki fetchu sieciowego;
- historia sesji oraz decyzji użytkownika;
- dostępność zasobów CPU, sieci i modeli.

## Granice zaufania

1. Frontend WebView ↔ Rust/Tauri IPC — frontend może zostać zmodyfikowany przez błąd UI lub złośliwy payload; komendy backendu muszą walidować argumenty niezależnie.
2. Rust backend ↔ katalog projektu — ścieżki pochodzą z UI, więc muszą być sprawdzane i ograniczane do jawnie wybranego katalogu.
3. Rust backend ↔ Keychain — klucze nie mogą wracać do snapshotu, logu ani odpowiedzi komendy.
4. Rust backend ↔ sieć — URL jest wejściem użytkownika/agenta i może prowadzić do SSRF lub pobrania nadmiernej ilości danych.
5. Rust backend ↔ macOS `open`/`screencapture` — akcje systemowe mają wpływ poza aplikacją i wymagają jawnego zatwierdzenia.
6. Model zewnętrzny ↔ dane projektu — wysłanie kontekstu poza komputer jest decyzją prywatności, nie domyślnym skutkiem podłączenia modelu.

## Priorytetowe scenariusze nadużyć

| Priorytet | Scenariusz | Skutek | Kontrole MVP |
| --- | --- | --- | --- |
| wysoki | Prompt injection w pliku lub stronie przekonuje agenta do ujawnienia klucza | wyciek sekretu lub danych projektu | klucze poza frontendem, brak dowolnego shell, jawne uprawnienia |
| wysoki | Złośliwy URL wykorzystuje fetch do dostępu do localhost/private network | odczyt usług lokalnych lub metadanych | tylko HTTP/HTTPS, blokada hostów lokalnych/prywatnych, limit redirectów |
| wysoki | Błąd IPC pozwala wywołać akcję systemową bez zgody | otwarcie aplikacji, ujawnienie plików lub screenshot | allowlista akcji, parametr `approved`, walidacja backendowa |
| średni | Nadmierny zakres projektu pozwala czytać niezamierzone katalogi | ujawnienie prywatnych plików | wybór katalogu przez użytkownika, ograniczenie przyszłych komend do project root |
| średni | Odpowiedź modelu lub fetchu przeciąża pamięć | degradacja lub crash aplikacji | timeouty, limit 30k znaków, limit redirectów |
| średni | Brak dowodu powoduje akceptację błędnej zmiany | regresja lub utrata zaufania | etap dowodów, diff, status testów, ręczna akceptacja |

## Warunki przed rozszerzeniem zakresu

- dodać testy ścieżek traversal, symlinków i repozytoriów poza rootem;
- wprowadzić osobny, podpisany model polityki uprawnień per projekt i per sesja;
- ograniczyć endpointy modeli allowlistą lub wymagać jawnego potwierdzenia dla nowej domeny;
- redagować tokeny i dane w logach oraz artefaktach;
- dodać event log odporny na modyfikacje oraz identyfikator decyzji użytkownika;
- zaprojektować Accessibility automation jako osobny moduł z wizualnym wskaźnikiem, nagrywaniem działań i awaryjnym Stop;
- przed dystrybucją wdrożyć code signing, notarization, aktualizacje i politykę prywatności.
