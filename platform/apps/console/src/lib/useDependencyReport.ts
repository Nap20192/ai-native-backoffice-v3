import { useEffect, useRef, useState } from "react";

import { useApi } from "./api";
import {
  parseDependencyReport,
  type DependencyOperation,
  type DependencyReport,
  type DependencyTargetKind,
} from "./dependencies";

export interface DependencyTarget {
  kind: DependencyTargetKind;
  id: string;
  /** Номер версии навыка для `skill_version`. */
  version?: string;
}

const IDLE_STATE: DependencyReportState = { report: null, etag: null, loading: false, failed: false };

export interface DependencyReportState {
  report: DependencyReport | null;
  /** `ETag` объекта, прочитанный вместе со списком (для `If-Match`). */
  etag: string | null;
  loading: boolean;
  failed: boolean;
}

/** Адрес списка зависимостей (docs/plans/crud.md, 1.2). */
export function dependencyPath(target: DependencyTarget, operation: DependencyOperation): string {
  const query = new URLSearchParams({ operation });
  if (target.version) query.set("version", target.version);
  return `/v1/oma/dependencies/${encodeURIComponent(target.kind)}/${encodeURIComponent(target.id)}?${query.toString()}`;
}

/**
 * Читает список зависимостей, пока открыто окно архива или удаления. Если
 * задан `etagPath`, рядом читается `ETag` объекта: окно шлёт его в `If-Match`
 * и сервер отвечает 412, когда объект успели изменить. Ошибка чтения не
 * блокирует окно: сервер всё равно проверит зависимости при записи.
 */
export function useDependencyReport(
  target: DependencyTarget | null,
  operation: DependencyOperation,
  etagPath?: string,
): DependencyReportState {
  const client = useApi();
  // Клиент держим в ссылке: чтение зависимостей не должно перезапускаться
  // из-за новой функции `api` на каждом рендере.
  const clientRef = useRef(client);
  clientRef.current = client;
  const [state, setState] = useState<DependencyReportState>(IDLE_STATE);
  const kind = target?.kind;
  const id = target?.id;
  const version = target?.version;

  useEffect(() => {
    if (!kind || !id) {
      // Тот же объект, пока окно закрыто: повторный рендер не запускает цикл.
      setState(IDLE_STATE);
      return;
    }
    let cancelled = false;
    setState({ report: null, etag: null, loading: true, failed: false });
    const path = dependencyPath({ kind, id, version }, operation);
    const { api, apiRaw } = clientRef.current;
    const reportRequest = api<unknown>(path, { quiet: true }).then(parseDependencyReport);
    const etagRequest = etagPath
      ? apiRaw(etagPath, { quiet: true })
          .then((response) => response.headers.get("etag"))
          .catch(() => null)
      : Promise.resolve(null);
    Promise.all([reportRequest.catch(() => null), etagRequest]).then(([report, etag]) => {
      if (cancelled) return;
      setState({ report, etag, loading: false, failed: report === null });
    });
    return () => {
      cancelled = true;
    };
  }, [kind, id, version, operation, etagPath]);

  return state;
}
