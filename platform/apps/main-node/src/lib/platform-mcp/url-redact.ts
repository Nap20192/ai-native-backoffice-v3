export interface RedactedUrl {
  url: string;
  secrets: string[];
}

/** Removed values are request-local secrets, never log or return them to a model. */
export function redactUrl(address: string): RedactedUrl {
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported URL");
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const query = url.search.slice(1);
    const fragment = url.hash.slice(1);
    const secrets = new Set([
      url.username, username, url.password, password, query, fragment, decodeURIComponent(fragment),
    ]);
    if (url.username || url.password) {
      secrets.add(`${url.username}:${url.password}`);
      secrets.add(`${username}:${password}`);
    }
    for (const value of url.searchParams.values()) secrets.add(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    secrets.delete("");
    return { url: url.toString(), secrets: [...secrets] };
  } catch {
    return { url: "[скрыто]", secrets: address ? [address] : [] };
  }
}
