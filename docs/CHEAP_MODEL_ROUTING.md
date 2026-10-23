# Tani i darmowy routing modeli

## Cel

AgentOS ma sam znajdować dostępne adaptery modeli, ale nie może wysyłać promptów do nieznanego endpointu tylko dlatego, że reklamuje się jako „free”. Katalog dostawców i router muszą być osobnymi modułami:

1. katalog zbiera oferty i sprawdza ich stan,
2. polityka bezpieczeństwa dopuszcza albo odrzuca adapter,
3. router wybiera model dla konkretnego zadania,
4. ledger zapisuje faktyczne zużycie i koszt,
5. circuit breaker wyłącza źródło po błędach, limitach lub zmianie ceny.

## Skąd brać oferty

- lokalne modele Ollama jako domyślny fallback bez kosztu API,
- agregatory z publicznym katalogiem modeli i cen, przez jeden adapter OpenAI-compatible,
- oficjalne endpointy dostawców dodane przez użytkownika,
- plik manifestu w profilu użytkownika dla własnego serwera zgodnego z OpenAI API.

Nie skanujemy internetu „na ślepo”. Lista domen i formatów odpowiedzi jest allowlistą w backendzie, a każdy nowy adapter wymaga jawnego zatwierdzenia. Klucze przechowuje Keychain, nigdy frontend ani snapshot projektu.

## Rekord oferty

Każda oferta powinna mieć co najmniej:

```text
provider_id, model_id, endpoint
input_price, output_price, currency
free_quota, quota_period, requires_key
capabilities: text | vision | tools | json | long_context
quality_tier, latency_tier, privacy_tier
last_checked, availability, failure_streak
```

„Darmowy” oznacza konkretny limit, okres i warunki. Brak ceny albo nieudany probe oznacza `unknown`, nie zero.

## Probe bez marnowania pieniędzy

Backend wykonuje mały, deterministyczny probe tylko po włączeniu odkrywania. Probe sprawdza HTTP status, zgodność schematu, czas odpowiedzi, limit kontekstu i obsługę wymaganej capability. Nie wysyła danych projektu; używa stałego testowego promptu. Wyniki wygasają po kilku godzinach i są cache'owane.

## Routing per zadanie

Przed wyborem modelu klasyfikator wyciąga z intencji:

- lane: `fast`, `research`, `code`, `vision`, `long_context`, `private_local`,
- wymagane capability,
- maksymalny koszt i preferowany czas,
- czy dane mogą opuścić komputer,
- czy potrzebne są narzędzia albo JSON.

Router odrzuca oferty niespełniające twardych warunków, a potem ocenia pozostałe:

```text
score = 0.30 * quality
      + 0.20 * availability
      + 0.18 * privacy
      + 0.15 * latency
      + 0.12 * budget_fit
      + 0.05 * capability_match
```

W trybie „tani” budżet ma wagę większą niż jakość. W trybie „najlepszy wynik” router może eskalować tylko po nieudanej próbie lub po przekroczeniu progu jakości, nigdy automatycznie do droższego modelu bez zapisania powodu.

## Fallback

1. model lokalny, jeśli zadanie i sprzęt na to pozwalają,
2. najtańsza zweryfikowana oferta z właściwą capability,
3. drugi tani adapter z inną domeną,
4. model premium dopiero po jawnej polityce eskalacji.

Każda próba zapisuje wybrany model, powód wyboru, przewidywany koszt, faktyczne tokeny, wynik i ewentualny fallback. Użytkownik może zablokować eskalację i ustawić twardy limit dzienny.

## Etapy wdrożenia

1. `ProviderCatalog` i manifest adapterów w Rust, bez kluczy w UI.
2. komenda `discover_providers` z allowlistą, cache i probe.
3. `RouteRequest` z capability, prywatnością i budżetem.
4. `UsageLedger` i circuit breaker.
5. ekran „Tanie i darmowe” z ostatnim probe, limitem i przewidywanym kosztem.
6. testy offline na fikcyjnych odpowiedziach oraz test integracyjny z jednym wybranym adapterem.

To daje automatyczne oszczędzanie bez udawania, że każda oferta „free” jest bezwarunkowo darmowa albo bezpieczna.
