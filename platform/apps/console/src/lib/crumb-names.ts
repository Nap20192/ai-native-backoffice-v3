import { useEffect, useSyncExternalStore } from "react";

/**
 * Имена ресурсов для хлебных крошек. Страница детали знает имя записи
 * (агент, окружение, хранилище), а маршрут знает только id из адреса.
 * Страница кладёт имя сюда, крошка берёт его по id. Пока имени нет, крошка
 * показывает общее слово («Агент»): сырой id в интерфейс не выводится
 * (раздел 5 docs/ddc-design-system.md).
 */
const names = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return version;
}

export function setCrumbName(id: string, name: string) {
  if (names.get(id) === name) return;
  names.set(id, name);
  version += 1;
  for (const listener of listeners) listener();
}

/** Подпись крошки для записи с данным id: имя, если страница его уже знает,
 *  иначе общее слово. */
export function crumbName(id: string | undefined, fallback: string): string {
  return (id ? names.get(id) : undefined) || fallback;
}

/** Подписка для компонента крошек: перерисовка, когда страница сообщила имя. */
export function useCrumbNamesVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Страница детали сообщает имя записи, как только оно загрузилось. */
export function useCrumbName(id: string | undefined, name: string | null | undefined) {
  useEffect(() => {
    if (id && name) setCrumbName(id, name);
  }, [id, name]);
}
