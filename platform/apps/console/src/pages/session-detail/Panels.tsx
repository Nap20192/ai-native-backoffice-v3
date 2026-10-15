import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowRightIcon, XIcon } from "lucide-react";

import { useApi } from "../../lib/api";
import { Skeleton } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { formatBytesRu, formatDateTimeRu } from "../../components/session/format-ru";

/**
 * Правые панели, которые открывает `SessionDetail`. Вынесены сюда, чтобы
 * основная страница занималась потоком событий и чатом: панели сами грузят
 * данные и показывают их, им нужны только id и обработчик закрытия.
 *
 * Два вида:
 *   - `ResourcePanel` загружает агента, окружение или хранилище и показывает
 *     его JSON. Открывается по клику на чип в шапке сессии.
 *   - `FilesPanel` перечисляет файлы, которые агент записал в
 *     `/mnt/session/outputs/`, со ссылками на скачивание.
 *
 * На экране шире xl панель стоит справа шириной 420px. Уже xl она ложится
 * поверх рабочей области сессии (родитель relative), иначе чат сжимался бы
 * до нуля.
 */

const PANEL_CLASS =
  "absolute inset-0 z-10 flex min-h-0 w-full flex-col border-l border-ddc-divider bg-ddc-surface animate-fade-in xl:static xl:z-auto xl:w-[420px] xl:shrink-0 xl:animate-none";

const KIND_LABEL: Record<"agent" | "environment" | "vault", string> = {
  agent: "Агент",
  environment: "Окружение",
  vault: "Хранилище секретов",
};

const KIND_LINK_LABEL: Record<"agent" | "environment" | "vault", string> = {
  agent: "Открыть агента",
  environment: "Открыть окружение",
  vault: "Открыть хранилище",
};

function PanelSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" role="status">
      <span className="sr-only">Загрузка…</span>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

function PanelError({ message }: { message: string }) {
  return (
    <div className="callout-danger flex-col items-stretch gap-0.5" role="alert">
      <div className="font-medium">Не удалось загрузить</div>
      <div className="break-words">{message}</div>
    </div>
  );
}

export function ResourcePanel({
  panel,
  onClose,
}: {
  panel: { kind: "agent" | "environment" | "vault"; id: string };
  onClose: () => void;
}) {
  // Destructure the JSON call function from the shared transport object.
  // explicitly. A previous version assigned the whole object to `api` and
  // then called `api(url)`, which threw "api is not a function" and white-
  // screened the page on first badge click.
  const { api } = useApi();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    const url =
      panel.kind === "agent"
        ? `/v1/agents/${panel.id}`
        : panel.kind === "environment"
        ? `/v1/environments/${panel.id}`
        : `/v1/vaults/${panel.id}`;
    api<Record<string, unknown>>(url)
      .then((d) => setData(d))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // `api` from useApi() is a fresh closure every render — including it in
    // deps caused setData → re-render → new api → effect refire → infinite
    // loop. The stable inputs are kind + id; api itself is callable as-is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.kind, panel.id]);

  const linkPath =
    panel.kind === "agent"
      ? `/agents/${panel.id}`
      : panel.kind === "environment"
      ? `/environments/${panel.id}`
      : `/vaults/${panel.id}`;

  // For agent / env, prefer name + description in the visible header.
  const displayName =
    (data?.name as string | undefined) ??
    (data?.display_name as string | undefined) ??
    panel.id;
  const description = (data?.description as string | undefined) ?? null;

  return (
    <aside className={PANEL_CLASS} aria-label={KIND_LABEL[panel.kind]}>
      <div className="flex shrink-0 items-start gap-3 border-b border-ddc-divider px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">{KIND_LABEL[panel.kind]}</div>
          <div className="mt-1 truncate text-base font-semibold text-ddc-heading" title={displayName}>
            {displayName}
          </div>
          {description && (
            <div className="mt-0.5 line-clamp-2 text-xs text-ddc-text-muted">{description}</div>
          )}
          <div className="mt-1 truncate font-mono text-xs text-ddc-text-muted" title={panel.id}>
            {panel.id}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          title="Закрыть"
          aria-label="Закрыть панель"
          className="-my-0.5 -mr-1"
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5 text-xs">
        {err && <PanelError message={err} />}
        {!data && !err && <PanelSkeleton />}
        {data && (
          <pre className="overflow-x-auto rounded-xl bg-ddc-surface-muted p-3 font-mono text-xs break-all whitespace-pre-wrap text-ddc-label">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
      <div className="shrink-0 border-t border-ddc-divider bg-ddc-footer px-5 py-3">
        <Link to={linkPath} className="link inline-flex items-center gap-1.5 text-sm">
          {KIND_LINK_LABEL[panel.kind]}
          <ArrowRightIcon className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </aside>
  );
}

interface SessionOutputFile {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

export function FilesPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { api } = useApi();
  const [files, setFiles] = useState<SessionOutputFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setFiles(null);
    setErr(null);
    api<{ data: SessionOutputFile[]; has_more: boolean }>(
      `/v1/sessions/${sessionId}/outputs`,
    )
      .then((d) => setFiles(d.data ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // api closure changes every render; sessionId is the only stable input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <aside className={PANEL_CLASS} aria-label="Файлы сессии">
      <div className="flex shrink-0 items-start gap-3 border-b border-ddc-divider px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Файлы</div>
          <div className="mt-1 text-base font-semibold text-ddc-heading">Результаты сессии</div>
          <div className="mt-0.5 text-xs text-ddc-text-muted">
            Файлы, которые агент сохранил в <code className="font-mono">/mnt/session/outputs/</code>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          title="Закрыть"
          aria-label="Закрыть панель"
          className="-my-0.5 -mr-1"
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto text-xs">
        {err && (
          <div className="p-5">
            <PanelError message={err} />
          </div>
        )}
        {!files && !err && (
          <div className="p-5">
            <PanelSkeleton />
          </div>
        )}
        {files && files.length === 0 && (
          <EmptyState
            size="sm"
            kind="file"
            title="Файлов пока нет"
            body={
              <>
                Чтобы файлы появились здесь, агент должен сохранять их в{" "}
                <code className="font-mono">/mnt/session/outputs/</code>.
              </>
            }
            className="m-5 border-0 shadow-none"
          />
        )}
        {files && files.length > 0 && (
          <ul className="divide-y divide-ddc-divider">
            {files.map((f) => (
              <li key={f.filename} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <a
                    href={`/v1/sessions/${sessionId}/outputs/${encodeURIComponent(f.filename)}`}
                    download={f.filename}
                    className="link block truncate font-mono text-sm"
                    title={f.filename}
                  >
                    {f.filename}
                  </a>
                  <div className="mt-0.5 text-2xs text-ddc-text-muted tabular-nums">
                    {formatBytesRu(f.size_bytes)} · {f.media_type} · {formatDateTimeRu(f.uploaded_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
