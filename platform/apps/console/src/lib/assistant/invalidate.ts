import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useEffect, useRef } from "react";

import type { AppliedInfo, ThreadItem } from "./events";

/**
 * После записи ассистента открытые списки консоли должны показать новый
 * объект. Запись выполняет сервер, когда приходит результат вызова, поэтому
 * списки обновляются по строке «применено» в ленте, а не по ответу `confirm`.
 */

const LIST_PATH: Record<string, string> = {
  agent: "/v1/agents",
  environment: "/v1/environments",
  skill: "/v1/skills",
  skill_version: "/v1/skills",
  file: "/v1/files",
  memory_store: "/v1/memory_stores",
  memory: "/v1/memory_stores",
  deployment: "/v1/deployments",
  session: "/v1/sessions",
  message: "/v1/sessions",
  session_resource: "/v1/sessions",
  model_card: "/v1/oma/model_cards",
};

/** Пути списков, которые затронула запись, без повторов и по порядку. */
export function listPathsFor(items: readonly ThreadItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.kind !== "proposal" || item.phase !== "applied") continue;
    for (const info of item.applied ?? ([] as AppliedInfo[])) {
      const path = LIST_PATH[info.kind];
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** Ключ запроса начинается с пути списка: сам список, его страницы и объекты. */
export function matchesListPath(key: unknown, paths: readonly string[]): boolean {
  if (typeof key !== "string") return false;
  return paths.some((path) => key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}?`));
}

/** Обновляет списки консоли, когда в ленте появилась новая применённая запись. */
export function useInvalidateOnApplied(thread: readonly ThreadItem[]): void {
  const client = useContext(QueryClientContext);
  const handled = useRef(new Set<string>());

  useEffect(() => {
    const fresh = thread.filter(
      (item) => item.kind === "proposal" && item.phase === "applied" && !handled.current.has(item.id),
    );
    if (fresh.length === 0) return;
    for (const item of fresh) handled.current.add(item.id);
    const paths = listPathsFor(fresh);
    if (!client || paths.length === 0) return;
    void client.invalidateQueries({ predicate: (query) => matchesListPath(query.queryKey[0], paths) });
  }, [client, thread]);
}
