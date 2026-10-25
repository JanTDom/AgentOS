// Pomocnicze funkcje rejestru modeli: zapis listy w dostawcy i czytelne opisy.
import type { ModelCategory, ModelInfo, Provider } from "./types";

export const categoryLabel: Record<ModelCategory, string> = {
  chat: "Rozmowa",
  embedding: "Wyszukiwanie (embedding)",
  image: "Obrazy / wideo",
  audio: "Mowa / dźwięk",
  other: "Inne",
};

/** Zmiany dostawcy po pobraniu listy. Zachowuje wybrany model, jeśli nadal jest dostępny. */
export function applyCatalog(provider: Provider, catalog: ModelInfo[]): Partial<Provider> {
  const chat = catalog.filter((m) => m.category === "chat").map((m) => m.id);
  const keep = provider.model && catalog.some((m) => m.id === provider.model);
  return {
    catalog,
    models: chat,
    catalogAt: new Date().toISOString(),
    status: "ok",
    statusText: catalog.length
      ? `${chat.length} do rozmów${catalog.length > chat.length ? ` · ${catalog.length} wszystkich` : ""}`
      : "brak modeli",
    model: keep ? provider.model : chat[0] ?? provider.model ?? "",
  };
}

export function findModel(provider: Provider | undefined, id: string): ModelInfo | undefined {
  return provider?.catalog?.find((m) => m.id === id);
}

/** Nazwa do wyświetlenia: z katalogu, a gdy brak — identyfikator. */
export function modelName(provider: Provider | undefined, id: string): string {
  return findModel(provider, id)?.name ?? id;
}

export function formatTokens(n?: number | null): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)} mln`;
  if (n >= 1000) return `${Math.round(n / 1000)} tys.`;
  return String(n);
}

export function formatPrice(m: ModelInfo): string | null {
  if (m.inputPrice == null && m.outputPrice == null) return null;
  const f = (v?: number | null) => (v == null ? "?" : v === 0 ? "0" : v < 0.01 ? v.toFixed(4) : v.toFixed(2));
  return `$${f(m.inputPrice)} / $${f(m.outputPrice)} za 1 mln tokenów`;
}

export function formatDate(sec?: number | null): string | null {
  if (!sec) return null;
  return new Date(sec * 1000).toLocaleDateString("pl-PL", { year: "numeric", month: "short" });
}

/** Krótki opis modelu do listy: kontekst, cena, rozmiar, obraz. */
export function modelFacts(m: ModelInfo): string[] {
  const facts: string[] = [];
  const ctx = formatTokens(m.context);
  if (ctx) facts.push(`kontekst ${ctx}`);
  const price = formatPrice(m);
  if (price) facts.push(price);
  if (m.size) facts.push(m.size);
  if (m.vision) facts.push("rozumie obrazy");
  if (m.loaded === true) facts.push("załadowany");
  if (m.loaded === false) facts.push("niezaładowany");
  return facts;
}
