import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { fetchActions, useAssistantApi, type ActionRow } from "../../lib/assistant/api";

/**
 * Вкладка «Изменения»: журнал действий сессии ассистента (раздел 3.6 плана),
 * по одной строке на каждый вызов инструмента.
 */

const RESULT_LABEL: Record<string, string> = {
  ok: "Выполнено",
  error: "Ошибка",
  denied: "Отклонено",
  refused_confirmation: "Нет подтверждения",
  refused_stale: "Объект изменился",
  refused_class: "Вне первой версии",
  refused_disabled: "Ассистент выключен",
};

const TARGET_HREF: Record<string, (id: string) => string | null> = {
  agent: (id) => `/agents/${encodeURIComponent(id)}`,
  environment: (id) => `/environments/${encodeURIComponent(id)}`,
  session: (id) => `/sessions/${encodeURIComponent(id)}`,
  memory_store: (id) => `/memory/${encodeURIComponent(id)}`,
  skill: () => "/skills",
  file: () => "/files",
  model_card: () => "/model-cards",
  harness_card: () => "/harnesses",
};

function formatTime(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

export function ChangesTab({ sessionId }: { sessionId: string | null }) {
  const api = useAssistantApi();
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const load = useCallback(
    async (next: string | null) => {
      if (!sessionId) return;
      setState("loading");
      try {
        const page = await fetchActions(api, { sessionId, cursor: next });
        setRows((prev) => (next ? [...prev, ...page.rows] : page.rows));
        setCursor(page.nextCursor);
        setState("idle");
      } catch {
        setState("error");
      }
    },
    [api, sessionId],
  );

  useEffect(() => {
    setRows([]);
    setCursor(null);
    void load(null);
  }, [load]);

  if (!sessionId) {
    return <p className="px-3 py-6 text-sm text-ddc-text-muted">В этом разговоре действий пока нет</p>;
  }
  if (state === "error") {
    return (
      <div className="flex flex-col items-start gap-2 px-3 py-6 text-sm">
        <p className="text-ddc-danger-text">Не удалось загрузить журнал</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load(null)}>
          Повторить
        </Button>
      </div>
    );
  }
  if (state === "loading" && rows.length === 0) {
    return (
      <div className="flex justify-center px-3 py-6">
        <Spinner />
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="px-3 py-6 text-sm text-ddc-text-muted">В этом разговоре действий пока нет</p>;
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <ul className="flex flex-col divide-y divide-ddc-divider rounded-lg border border-ddc-border" aria-label="Журнал действий">
        {rows.map((row) => {
          const href = row.targetKind && row.targetId ? TARGET_HREF[row.targetKind]?.(row.targetId) : null;
          return (
            <li key={`${row.id}-${row.opIndex}`} className="flex flex-col gap-0.5 px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono font-medium text-ddc-text">{row.tool}</span>
                <span
                  className={
                    row.result === "ok" ? "text-ddc-tone-success-fg" : row.result.startsWith("refused") || row.result === "error" ? "text-ddc-danger-text" : "text-ddc-text-muted"
                  }
                >
                  {RESULT_LABEL[row.result] ?? row.result}
                </span>
              </div>
              <div className="flex items-center gap-2 text-ddc-text-muted">
                <span>{formatTime(row.createdAt)}</span>
                {href && row.targetId ? (
                  <Link to={href} className="min-w-0 truncate text-ddc-link hover:underline">
                    {`${row.targetKind} ${row.targetId}`}
                  </Link>
                ) : null}
              </div>
              {row.errorMessage ? <p className="text-ddc-danger-text">{row.errorMessage}</p> : null}
            </li>
          );
        })}
      </ul>
      {cursor ? (
        <Button type="button" variant="outline" size="sm" disabled={state === "loading"} onClick={() => void load(cursor)}>
          Показать ещё
        </Button>
      ) : null}
    </div>
  );
}
