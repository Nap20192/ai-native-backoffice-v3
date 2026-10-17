/**
 * Остался только встроенный цикл: сервер отказывает агенту с другим harness
 * или с блоком `acp`. Старые агенты ещё хранят такие поля в `_oma`, поэтому
 * перед записью консоль их убирает. Сети и React здесь нет.
 */

type Extension = Record<string, unknown>;

/**
 * Убирает из блока `_oma` поля старого harness, меняет сам блок. Блоки `acp`
 * и `runtime_binding` уходят всегда. Старое значение harness при изменении
 * агента становится `pi`, при создании убирается. `default` и `pi` остаются.
 */
export function dropLegacyHarness(openma: Extension, forUpdate: boolean): void {
  delete openma.acp;
  delete openma.runtime_binding;
  const harness = openma.harness;
  if (harness === undefined || harness === "default" || harness === "pi") return;
  if (forUpdate && typeof harness === "string" && harness !== "") openma.harness = "pi";
  else delete openma.harness;
}

/** Копия `_oma` для изменения агента без полей старого harness. Не объект возвращается как есть. */
export function withoutLegacyHarness(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const next = structuredClone(value as Extension);
  dropLegacyHarness(next, true);
  return next;
}
