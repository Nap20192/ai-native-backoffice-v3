/** Serializes JSON with lexicographically sorted keys, preserving array order.
 * Rejects values that JSON would silently discard or coerce. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function serialize(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) throw new TypeError("Expected a JSON value");
    if (ancestors.has(item)) throw new TypeError("Cyclic JSON value");
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Expected a plain JSON object");
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        return `[${Array.from({ length: item.length }, (_, index) => serialize(item[index])).join(",")}]`;
      }
      return `{${Object.keys(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) throw new TypeError("JSON accessors are not supported");
        return `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
      }).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return serialize(value);
}
