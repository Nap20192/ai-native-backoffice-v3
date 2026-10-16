// Web search provider chosen by server settings (docs/plans/environments.md, 7.2).
//
// WEB_SEARCH_PROVIDER takes searxng, brave, tavily, duckduckgo or off.
// Without it DuckDuckGo stays, for development only. A provider that lacks
// its address or key is a startup error: the server never switches to
// another provider silently, because the query text goes to the provider.

export type WebSearchProviderSettings =
  | { provider: "off" }
  | { provider: "duckduckgo" }
  | { provider: "searxng"; url: string }
  | { provider: "brave"; apiKey: string }
  | { provider: "tavily"; apiKey: string };

export type WebSearchProviderName = WebSearchProviderSettings["provider"];

type Env = Readonly<Record<string, string | undefined>>;

function requiredKey(env: Env, name: "BRAVE_SEARCH_API_KEY" | "TAVILY_API_KEY", provider: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for WEB_SEARCH_PROVIDER=${provider}`);
  return value;
}

/** A SearXNG base address: http or https, without a login. The message never
 *  repeats the value, which can hold a password. */
function searxngUrl(env: Env): string {
  const value = env.SEARXNG_URL?.trim();
  if (!value) throw new Error("SEARXNG_URL is required for WEB_SEARCH_PROVIDER=searxng");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid SEARXNG_URL: use an http or https address");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error("Invalid SEARXNG_URL: use an http or https address");
  }
  if (url.username || url.password) {
    throw new Error("Invalid SEARXNG_URL: the address must not contain a login or password");
  }
  return value;
}

/** Reads the provider settings without I/O. */
export function selectWebSearchProvider(env: Env): WebSearchProviderSettings {
  const provider = env.WEB_SEARCH_PROVIDER;
  switch (provider) {
    case undefined:
    case "duckduckgo":
      return { provider: "duckduckgo" };
    case "off":
      return { provider: "off" };
    case "searxng":
      return { provider: "searxng", url: searxngUrl(env) };
    case "brave":
      return { provider: "brave", apiKey: requiredKey(env, "BRAVE_SEARCH_API_KEY", provider) };
    case "tavily":
      return { provider: "tavily", apiKey: requiredKey(env, "TAVILY_API_KEY", provider) };
    default:
      throw new Error("Invalid WEB_SEARCH_PROVIDER: use searxng, brave, tavily, duckduckgo or off");
  }
}
