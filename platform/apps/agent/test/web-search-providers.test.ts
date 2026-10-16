import { describe, expect, it } from "vitest";
import { selectWebSearchProvider } from "../src/harness/web-search-providers.js";

describe("web search provider selection", () => {
  it("defaults to DuckDuckGo for development and supports disabling", () => {
    expect(selectWebSearchProvider({})).toEqual({ provider: "duckduckgo" });
    expect(selectWebSearchProvider({ WEB_SEARCH_PROVIDER: "off" })).toEqual({ provider: "off" });
  });
  it("selects configured providers without I/O", () => {
    expect(selectWebSearchProvider({ WEB_SEARCH_PROVIDER: "searxng", SEARXNG_URL: "https://search.example.org/" })).toEqual({ provider: "searxng", url: "https://search.example.org/" });
    expect(selectWebSearchProvider({ WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "test-key" })).toEqual({ provider: "brave", apiKey: "test-key" });
    expect(selectWebSearchProvider({ WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "test-key" })).toEqual({ provider: "tavily", apiKey: "test-key" });
  });
  it.each(["brave", "tavily", "searxng", "invalid", ""])("rejects unusable %s without silently switching providers", (provider) => {
    expect(() => selectWebSearchProvider({ WEB_SEARCH_PROVIDER: provider })).toThrow();
  });
  it.each(["file:///etc/passwd", "https://user:secret@search.example.org/", "invalid"])("rejects invalid search endpoint without printing credentials", (url) => {
    expect(() => selectWebSearchProvider({ WEB_SEARCH_PROVIDER: "searxng", SEARXNG_URL: url })).toThrow("Invalid SEARXNG_URL");
  });
});
