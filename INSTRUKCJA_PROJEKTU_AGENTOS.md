# Instrukcja projektu: AgentOS

## Cel dokumentu

Zbuduj aplikację, która będzie wyraźnie lepszym środowiskiem do delegowania, nadzorowania i kończenia pracy z agentami AI niż Claude Desktop, OpenAI Codex i Google Antigravity.

Nie próbuj wygrać liczbą funkcji ani samym hasłem „mamy lepszy model”. Wygraj jakością całego przepływu: od zamiaru użytkownika, przez plan i wykonanie, do sprawdzalnego rezultatu, który można bezpiecznie zaakceptować, poprawić albo wycofać.

To jest instrukcja wykonawcza dla zespołu projektowego i agentów budujących produkt. Traktuj ją jako kontrakt jakości. Jeśli jakaś decyzja techniczna lub produktowa nie wspiera poniższej obietnicy, odrzuć ją albo pokaż, dlaczego mimo wszystko jest potrzebna.

---

## 1. Obietnica produktu

AgentOS jest osobistym i zespołowym centrum pracy z agentami AI. Użytkownik opisuje rezultat, a nie serię komend. AgentOS:

1. rozumie cel, projekt, ograniczenia i poziom ryzyka;
2. proponuje krótki plan oraz zakres dostępu;
3. dobiera właściwy model, narzędzia i agentów;
4. może prowadzić kilka niezależnych ścieżek równolegle;
5. wykonuje pracę lokalnie lub w izolowanym środowisku chmurowym;
6. pokazuje dowody wykonania, a nie tylko tekstowy raport;
7. prosi człowieka wyłącznie o decyzje, których nie powinien podejmować sam;
8. zostawia projekt w stanie, który da się odtworzyć, zrozumieć i cofnąć.

Najkrótsza definicja:

> AgentOS nie jest czatem z narzędziami. Jest systemem operacyjnym dla intencji: zamienia zamiar w plan, plan w pracę, a pracę w zweryfikowany rezultat.

---

## 2. Co użytkownicy najbardziej lubią w istniejących produktach

### Claude Desktop / Claude Code

Najsilniejszy wzorzec to poczucie, że projekt ma własnego, wyspecjalizowanego asystenta. Użytkownicy chwalą:

- projekty z własnym kontekstem, instrukcjami i historią;
- dostęp do lokalnych plików, aplikacji i danych przez MCP;
- możliwość podłączenia narzędzi bez ręcznego kopiowania treści między aplikacjami;
- pracę w interfejsie graficznym, który łatwiej śledzić niż wiele terminali;
- możliwość pokazania działania agenta w przeglądarce, zamiast proszenia użytkownika, aby sam odtwarzał kroki;
- szeroki zakres pracy: kod, dokumenty, analiza, automatyzacja i codzienne zadania.

Najważniejsza lekcja dla AgentOS: kontekst musi być projektowy, aktualny i lokalnie kontrolowany. Nie wystarczy „długa pamięć” bez informacji, skąd pochodzi dana wiedza, kiedy została zaktualizowana i czy użytkownik ją zatwierdził.

### OpenAI Codex

Najsilniejszy wzorzec to orkiestracja pracy programistycznej i możliwość delegowania zadań bez blokowania bieżącej pracy. Użytkownicy oraz materiały produktowe wskazują na:

- wiele agentów działających równolegle;
- osobne wątki z zachowaniem kontekstu;
- izolowane worktree/środowiska, aby eksperymenty nie niszczyły głównej gałęzi;
- przegląd diffu i komentarze bezpośrednio przy zmianach;
- umiejętności/skills, które pakują instrukcje, zasoby i skrypty;
- zadania długotrwałe, kolejkę pracy i automatyzacje;
- pracę w aplikacji, terminalu, IDE i chmurze;
- sandbox i reguły bezpieczeństwa zamiast pełnego, niekontrolowanego dostępu.

Najważniejsza lekcja dla AgentOS: agent powinien być jednostką pracy, którą da się uruchomić, obserwować, zatrzymać, przekierować, porównać z alternatywami i zaakceptować dopiero po kontroli.

### Google Antigravity

Najsilniejszy wzorzec to rozdzielenie dwóch trybów pracy:

- trybu edytora, gdy człowiek chce być blisko kodu;
- trybu managera, gdy chce delegować zadania kilku agentom działającym asynchronicznie.

Użytkownicy i materiały Google szczególnie cenią:

- wykonywanie całych zadań przez edytor, terminal i przeglądarkę;
- działanie agentów w tle;
- artefakty: plan, lista zadań, screenshoty i nagrania walkthrough;
- możliwość komentowania artefaktu i korygowania pracy bez niszczenia całej sesji;
- warstwę pamięci/wiedzy, która zachowuje przydatny kontekst.

Najważniejsza lekcja dla AgentOS: zaufanie rośnie wtedy, gdy użytkownik może zobaczyć rezultat działania. Log narzędzi jest materiałem diagnostycznym, nie dobrym interfejsem kontroli.

---

## 3. Gdzie mamy być radykalnie lepsi

### A. Jeden spójny model pracy

Nie rozdzielaj sztucznie „chatu”, „projektu”, „wątku”, „zadania”, „worktree” i „automatyzacji” na niezrozumiałe byty. Użytkownik ma widzieć jedną rzecz:

**intencję → uruchomienie → dowody → decyzję → rezultat**.

System może mieć techniczne obiekty wewnętrzne, ale interfejs ma je łączyć w jedną oś czasu.

### B. Pamięć z pochodzeniem, a nie czarna skrzynka

Każdy zapisany fakt, preferencja, decyzja i fragment wiedzy musi mieć:

- źródło;
- datę ostatniej weryfikacji;
- właściciela lub autora;
- poziom zaufania;
- zakres projektu;
- możliwość poprawy, wyłączenia i usunięcia;
- informację, czy jest aktualny, wygasły albo sprzeczny z innym źródłem.

Nie pozwalaj agentowi traktować starej pamięci jako prawdy tylko dlatego, że jest dostępna.

### C. Dowody zamiast deklaracji

Każde zadanie kończące się stanem „gotowe” powinno generować odpowiedni pakiet dowodowy, na przykład:

- zmienione pliki i diff;
- wykonane testy wraz z komendami i wynikiem;
- screenshoty przed i po;
- nagranie lub odtworzony walkthrough dla przepływu UI;
- link do preview albo deploymentu;
- lista decyzji podjętych przez agenta;
- lista rzeczy niewykonanych, niepewnych i wymagających człowieka;
- ślad użytych narzędzi, modeli i uprawnień.

„Zakończone” oznacza „spełniło zdefiniowane kryteria i ma dowody”, nie „agent przestał pisać”.

### D. Kontrola zrozumiała dla człowieka

Zaprojektuj cztery poziomy autonomii, wybierane per projekt, narzędzie i typ działania:

1. **Obserwuj** – agent tylko czyta i proponuje.
2. **Przygotuj** – agent tworzy plan, patch, draft lub koszyk zmian, ale nie publikuje.
3. **Wykonaj w granicach** – agent działa sam w zatwierdzonym zakresie.
4. **Wykonaj i publikuj** – agent może wdrożyć lub wysłać wynik po spełnieniu jawnych warunków.

Każde uprawnienie powinno mieć zakres, czas wygaśnięcia i możliwość cofnięcia. Zamiast dziesiątek wyskakujących pytań pokaż jedną czytelną decyzję zbiorczą, np. „zezwól na odczyt repozytorium i uruchamianie testów przez 30 minut; bez dostępu do sekretów i produkcji”.

### E. Multi-model bez uzależnienia od dostawcy

Wspieraj adaptery do wielu modeli i lokalnych modeli, ale nie zmuszaj użytkownika do ręcznego wyboru modelu przy każdym zadaniu. Router powinien dobierać model według:

- rodzaju pracy;
- wymaganego kontekstu;
- kosztu i limitu;
- prywatności;
- czasu odpowiedzi;
- wcześniejszej jakości dla podobnych zadań.

Pokaż, dlaczego wybrano dany model, i umożliw nadpisanie tej decyzji. Awaria dostawcy ma prowadzić do kontrolowanego fallbacku, a nie do utraty pracy.

### F. Lokalność i chmura jako jedna historia

Użytkownik powinien móc rozpocząć pracę lokalnie, kontynuować ją w chmurze i wrócić z telefonu bez kopiowania kontekstu. Musi jednak zawsze wiedzieć:

- gdzie działa agent;
- jakie dane opuściły komputer;
- jaki stan repozytorium lub dokumentów został przekazany;
- kto ma dostęp do wyniku;
- ile kosztuje dalsza praca.

Tryb lokalny powinien działać sensownie także bez połączenia z siecią dla zadań, które nie wymagają modelu zewnętrznego.

---

## 4. Najważniejszy przepływ użytkownika

Przykładowa intencja:

> „Przygotuj nową wersję strony raportu. Zachowaj istniejącą markę, popraw czytelność na telefonie, sprawdź dostępność, uruchom testy i pokaż mi dowody przed publikacją.”

AgentOS musi wtedy:

1. rozpoznać projekt, repozytorium, aktualną gałąź i ograniczenia;
2. pokazać krótkie podsumowanie zrozumienia zadania;
3. zadać najwyżej jedno pytanie, tylko jeśli brak odpowiedzi realnie zmienia zakres;
4. zaproponować plan z etapami i kryteriami akceptacji;
5. wskazać potrzebne narzędzia i uprawnienia;
6. rozpocząć pracę w izolowanym środowisku;
7. rozdzielić pracę na wyspecjalizowane role, np. analityk, implementer, tester i recenzent;
8. utrzymywać jedną oś czasu zamiast czterech niezależnych logów;
9. wykonać testy funkcjonalne, wizualne i dostępnościowe;
10. pokazać artefakty oraz różnice względem stanu wyjściowego;
11. poprosić o decyzję: zaakceptuj, popraw, porównaj z alternatywą albo odrzuć;
12. dopiero po akceptacji scalić, wdrożyć lub zapisać wynik w miejscu wskazanym przez użytkownika.

Jeżeli agent napotka problem, nie może go ukryć pod ogólnym „spróbuję ponownie”. Ma pokazać: co się stało, jaki jest wpływ, jakie są bezpieczne opcje i czego potrzebuje od człowieka.

---

## 5. Główne powierzchnie aplikacji

### 5.1. Command Center

Pierwszy ekran ma być skrzynką intencji, a nie tablicą przypadkowych funkcji. Powinien pokazywać:

- aktywne i oczekujące zadania;
- zadania wymagające decyzji;
- ostatnie dowody i wyniki;
- projekty z problemami;
- koszt, czas i obciążenie agentów w prostym języku.

### 5.2. Project Room

Projekt jest miejscem dla:

- plików i repozytoriów;
- kontekstu i instrukcji;
- pamięci z pochodzeniem;
- dostępnych narzędzi;
- zasad bezpieczeństwa;
- historii intencji i rezultatów;
- celów oraz kryteriów jakości.

### 5.3. Run View

Widok konkretnego wykonania ma pokazywać stan w czasie rzeczywistym:

- plan;
- zależności między krokami;
- aktualnie pracujących agentów;
- ich wejścia i wyjścia;
- blokady;
- prośby o decyzję;
- możliwość wstrzymania, wznowienia, przekierowania i zakończenia.

### 5.4. Evidence Board

Dowody mają być pierwszoplanowe: screenshoty, diffy, testy, logi skrócone do istotnych fragmentów, nagrania, preview, raporty i porównania alternatyw. Każdy artefakt powinien mieć komentarze zakotwiczone w konkretnym miejscu.

### 5.5. Policy Center

Użytkownik konfiguruje tu dostęp do plików, sieci, sekretów, repozytoriów, produkcji, aplikacji desktopowych i usług zewnętrznych. Domyślna zasada: najmniejsze niezbędne uprawnienia.

### 5.6. Memory Library

Pamięć ma być przeszukiwalna, wersjonowana i edytowalna. Użytkownik może zobaczyć, dlaczego agent użył danego faktu i usunąć go bez kasowania całej historii.

---

## 6. Wymagania funkcjonalne wersji MVP

MVP ma być małe, ale musi domykać cały cykl pracy. Zaimplementuj:

1. tworzenie projektu z lokalnym katalogiem;
2. import repozytorium lub folderu dokumentów;
3. projektowe instrukcje i pamięć z metadanymi źródła;
4. skrzynkę intencji i generowanie planu;
5. uruchamianie co najmniej dwóch agentów równolegle w izolowanych sesjach;
6. system narzędzi z deklarowanymi uprawnieniami;
7. zatwierdzanie zbiorcze i wstrzymywanie pracy;
8. diff oraz lista zmian;
9. testy i automatyczne generowanie raportu dowodów;
10. screenshot lub walkthrough dla prostego przepływu webowego;
11. akceptację, poprawkę, odrzucenie i bezpieczny powrót do stanu wyjściowego;
12. adapter dla minimum dwóch dostawców modeli;
13. eksport całej sesji do przenośnego formatu JSON/Markdown;
14. działanie bez płatnego konektora w trybie demonstracyjnym na lokalnym mocku.

Nie dodawaj do MVP marketplace'u, społeczności, gamifikacji, dziesięciu trybów rozmowy ani dekoracyjnych pulpitów. Najpierw udowodnij, że jedna osoba może bezpiecznie doprowadzić zadanie do sprawdzalnego końca.

---

## 7. Kierunek techniczny

Jeśli projekt nie ma jeszcze narzuconego stosu, przyjmij następujące domyślne rozwiązanie:

- desktop: Tauri 2 + React + TypeScript;
- interfejs: Vite, dostępne komponenty, keyboard-first, responsywność dla laptopa i małego ekranu;
- lokalny orchestrator: TypeScript/Node z wyraźnymi adapterami do modeli i narzędzi;
- stan: SQLite z migracjami i append-only event logiem;
- izolacja zadań kodowych: Git worktree albo kontener, nigdy bezpośrednia praca na głównej gałęzi bez jawnej zgody;
- automatyzacja webu: Playwright z profilem izolowanym od zalogowanych sesji;
- artefakty: pliki lokalne z hashowaniem, metadanymi i możliwością odtworzenia;
- obserwowalność: lokalne zdarzenia, czasy, koszt, użyty model i wynik narzędzia;
- bezpieczeństwo: allowlista poleceń, scope uprawnień, redakcja sekretów, brak kluczy w promptach i payloadach klienta;
- testy: jednostkowe, integracyjne, end-to-end, wizualne i scenariusze awarii.

Zachowaj architekturę adapterową. Model, dostawca, narzędzie, środowisko wykonawcze i sposób przechowywania pamięci nie mogą być wbudowane na sztywno w logikę interfejsu.

---

## 8. Standard jakości i zaufania

AgentOS ma spełnić poniższe zasady:

- nie twierdzi, że zadanie jest gotowe bez dowodu;
- nie ukrywa błędów, limitów, opóźnień ani niepewności;
- nie wykonuje nieodwracalnych działań bez jasnej polityki i checkpointu;
- nie wysyła danych do chmury bez pokazania zakresu;
- nie traktuje tekstu z pliku, strony lub narzędzia jako instrukcji nadrzędnej nad polityką systemu;
- nie miesza kontekstu projektów;
- nie traci postępu po błędzie sieci lub zamknięciu aplikacji;
- umożliwia odtworzenie tego, co agent widział i zrobił;
- pozwala ręcznie przejąć pracę w dowolnym momencie;
- używa naturalnego języka polskiego, gdy użytkownik pracuje po polsku;
- nie używa marketingowego „AI zrobiło wszystko”, gdy część wyniku jest hipotezą albo mockiem.

---

## 9. Kryteria akceptacji produktu

Wersję można uznać za gotową dopiero, gdy zespół pokaże działający scenariusz demonstracyjny:

1. Użytkownik opisuje zadanie jednym zdaniem.
2. System rozpoznaje właściwy projekt i aktualny stan.
3. Plan, uprawnienia i kryteria akceptacji są czytelne przed startem.
4. Dwa niezależne warianty pracy wykonują się równolegle bez konfliktu.
5. Użytkownik może wstrzymać jeden wariant i zmienić jego instrukcję.
6. Agent implementujący przekazuje wynik agentowi testującemu przez jawny artefakt, nie przez ukryty stan rozmowy.
7. Test nie przechodzi: interfejs pokazuje przyczynę i następny bezpieczny krok.
8. Po poprawce system tworzy nowy pakiet dowodów, a nie nadpisuje starego bez śladu.
9. Użytkownik może porównać dwa warianty i zaakceptować jeden.
10. Odrzucenie wyniku przywraca stan wyjściowy bez ręcznego odtwarzania plików.
11. Całą sesję można zamknąć i wznowić z zachowaniem kontekstu.
12. Reviewer, który nie widział logów, rozumie z artefaktów, co zmieniono i czy można to bezpiecznie przyjąć.

Mierz przede wszystkim:

- czas od intencji do pierwszego użytecznego artefaktu;
- liczbę niepotrzebnych pytań do użytkownika;
- odsetek zadań zakończonych z pełnym pakietem dowodów;
- liczbę regresji po akceptacji;
- czas potrzebny na znalezienie przyczyny nieudanego kroku;
- liczbę przypadków utraty kontekstu lub pracy;
- koszt i czas wykonania w porównaniu z pojedynczym agentem;
- zaufanie użytkownika mierzone decyzjami „zaakceptuj bez otwierania logów” oraz „wymaga poprawki”.

---

## 10. Plan dostarczania

### Etap 0: fundament

- spisz decyzje architektoniczne;
- zbuduj event log, model projektu, sesji, agenta, narzędzia, artefaktu i uprawnienia;
- przygotuj mock providerów i deterministyczny scenariusz testowy;
- zdefiniuj threat model oraz granice dostępu.

### Etap 1: działający pionowy wycinek

Zbuduj jeden pełny scenariusz: intencja → plan → dwóch agentów → izolowane zmiany → test → screenshot → diff → akceptacja/cofnięcie. Nie zaczynaj od panelu ustawień ani katalogu integracji.

### Etap 2: pamięć, konektory i router

- dodaj pamięć z pochodzeniem i wygasaniem;
- dodaj podpisane paczki narzędzi i konfigurację scope;
- dodaj co najmniej dwóch dostawców modeli;
- dodaj koszt, limity i kontrolowany fallback.

### Etap 3: praca długotrwała i zdalna

- kolejka zadań;
- harmonogramy i automatyzacje;
- bezpieczna kontynuacja w chmurze;
- zdalny podgląd i sterowanie;
- mobilny widok decyzji i dowodów, nie miniaturowy terminal.

### Etap 4: jakość przewyższająca konkurencję

- porównywanie wariantów na podstawie dowodów;
- automatyczny reviewer regresji;
- uczenie preferencji z zatwierdzonych decyzji, zawsze z widocznym źródłem;
- biblioteka scenariuszy jakościowych i benchmarków realnej pracy;
- eksportowalny, przenośny format sesji bez vendor lock-in.

---

## 11. Zasady pracy dla agenta budującego ten projekt

Jesteś jednocześnie product architectem, projektantem doświadczenia, inżynierem, specjalistą bezpieczeństwa i testerem. Pracuj w następującej kolejności:

1. zrób audyt repozytorium, środowiska i istniejących decyzji;
2. nie nadpisuj istniejących zmian bez ich zrozumienia;
3. zaproponuj minimalny pionowy wycinek i kryteria akceptacji;
4. przed większą implementacją pokaż model danych i główny przepływ;
5. implementuj przyrostowo, zachowując adaptery i migracje;
6. po każdym ważnym kroku uruchom testy oraz sprawdzenie wizualne;
7. sprawdzaj także ścieżki błędów, odmowy uprawnień, przerwanie i wznowienie;
8. kończ każdą fazę raportem: zrobione, sprawdzone, niezweryfikowane, ryzyka, następny krok;
9. nie oznaczaj funkcji jako gotowej tylko dlatego, że build przeszedł;
10. gdy nie możesz czegoś zweryfikować, nazwij to wprost i zostaw reprodukowalny sposób sprawdzenia.

Pierwszy cel implementacyjny:

> Zbuduj najpierw demonstrację jednego zadania, które przechodzi od krótkiej intencji do dwóch równoległych wariantów, testu, dowodów, porównania i bezpiecznej akceptacji. Dopiero gdy ten przepływ jest wiarygodny, rozbudowuj katalog modeli, integracji i automatyzacji.

---

## 12. Źródła i metodologia researchu

Research wykonano 22 października 2026 r. Przejrzano materiały producentów oraz publiczne wypowiedzi użytkowników. Materiały producentów traktuj jako opis możliwości, a posty społeczności jako sygnały preferencji i problemów — nie jako reprezentatywną ankietę. W publicznych dyskusjach nazwy „Claude Desktop” i „Claude Code Desktop” bywają mieszane; wnioski dotyczą wspólnego doświadczenia desktopowego, a różnice między produktem ogólnym i coding-agentem trzeba sprawdzać osobno.

### Materiały producentów

- [Anthropic: Projects — kontekst, wiedza i instrukcje projektu](https://support.anthropic.com/en/articles/9519177-how-can-i-create-and-manage-projects)
- [Anthropic: MCP w Claude Desktop](https://docs.anthropic.com/en/docs/mcp)
- [Anthropic: Desktop Extensions — prostsza instalacja lokalnych MCP](https://www.anthropic.com/research/desktop-extensions)
- [Anthropic: lokalne i zdalne konektory](https://support.anthropic.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
- [OpenAI: wprowadzenie aplikacji Codex](https://openai.com/index/introducing-the-codex-app/)
- [OpenAI: Codex Remote — praca zdalna, worktrees, review i sterowanie](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)
- [Google Developers: wprowadzenie Google Antigravity](https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/)

### Głosy użytkowników i społeczności

- [Reddit: Claude Code Desktop — projekty, widoczny dowód działania i status sesji](https://www.reddit.com/r/ClaudeCode/comments/1x7wsxz/claude_code_desktop_is_actually_getting_better/)
- [Reddit: Claude i MCP — lokalny filesystem, pamięć i redukcja kopiowania](https://www.reddit.com/r/ClaudeAI/comments/1h4yvep)
- [Reddit: codzienne MCP — filesystem, GitHub, Playwright, pamięć i integracje](https://www.reddit.com/r/ClaudeAI/comments/1s0u2ms)
- [Hacker News: dyskusja o aplikacji Codex i agentach równoległych](https://news.ycombinator.com/item?id=46859054)
- [Reddit: Codex — opóźnienia, oczekiwanie na zgody i koszt utraty kontekstu](https://www.reddit.com/r/codex/comments/1x3wuhi/codex_has_become_a_drag_on_my_work/)
- [Reddit: krytyka UX agentów — nakładające się funkcje, niespójność i brak jasnej diagnozy błędu](https://www.reddit.com/r/coding_agents/comments/1qw24jl/the_user_experience_for_coding_agents_is_very/)

Jeśli źródło społecznościowe zniknie albo zmieni treść, nie traktuj linku jako jedynego dowodu. W testach produktu odtwórz opisane scenariusze i zapisuj własne wyniki.

---

## Oczekiwany sposób komunikacji

Pisz po polsku, jasno i bez napompowanego marketingu. Mów „zrobione”, „sprawdzone”, „niezweryfikowane” i „zablokowane” tylko wtedy, gdy stan jest prawdziwy. Pokazuj decyzje, dowody i ograniczenia. Użytkownik ma mieć poczucie sterowania systemem, nie obserwowania nieprzewidywalnego eksperymentu.
