import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BetaManagedAgentsSessionResource } from "@anthropic-ai/sdk/resources/beta/sessions/resources";
import { ChevronDownIcon, DatabaseIcon, DownloadIcon, FileIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PlainButton } from "@/components/ui/plain-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "../../../lib/api";
import { useManagedApi } from "../../../lib/useManagedApi";
import { EmptyState } from "../../EmptyState";
import { GitHubIcon } from "../../icons";
import { LoadError } from "../../LoadError";
import { Skeleton } from "../../Skeleton";
import { EMPTY_VALUE, formatBytesRu } from "../format-ru";
import type { OutputFile } from "./OutputFileDialog";
import { useOutputFileViewer } from "./useOutputFileViewer";

/**
 * Вкладка «Ресурсы»: то, что подключено к сессии (файлы, репозитории,
 * хранилища памяти), и файлы, которые агент сохранил в
 * /mnt/session/outputs/. После создания сессии добавить можно только файл.
 * Файл агента открывается в окне просмотра и скачивается запросом консоли:
 * обычная ссылка не передаёт anthropic-beta, и сервер отвечает 400.
 */

export interface ResourcesTabProps {
  sessionId: string;
}

interface ResourceRow {
  key: string;
  path: string;
  size: string;
  icon: ReactNode;
  /** Файл агента: строка открывает просмотр, рядом кнопка «Скачать». */
  output?: OutputFile;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; resources: BetaManagedAgentsSessionResource[]; outputs: OutputFile[] };

const OUTPUT_DIR = "/mnt/session/outputs/";
const ICON_CLASS = "size-3.5 flex-none text-ddc-icon-muted";

function resourcePath(resource: BetaManagedAgentsSessionResource): string {
  if (resource.type === "memory_store") return resource.mount_path || resource.name || resource.memory_store_id;
  return resource.mount_path;
}

function resourceIcon(resource: BetaManagedAgentsSessionResource): ReactNode {
  if (resource.type === "github_repository") return <GitHubIcon className={ICON_CLASS} />;
  if (resource.type === "memory_store") return <DatabaseIcon className={ICON_CLASS} />;
  return <FileIcon className={ICON_CLASS} />;
}

export function ResourcesTab({ sessionId }: ResourcesTabProps) {
  const managedApi = useManagedApi();
  const { api } = useApi();
  const viewer = useOutputFileViewer(sessionId);
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [query, setQuery] = useState("");
  const [retrying, setRetrying] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const [resources, outputs] = await Promise.allSettled([
      managedApi.sessions.resources.list(sessionId, { limit: 100 }),
      api<{ data?: OutputFile[] }>(`/v1/sessions/${encodeURIComponent(sessionId)}/outputs`, { quiet: true }),
    ]);
    if (mine !== generation.current) return;
    if (resources.status === "rejected") {
      setState({ phase: "error" });
      return;
    }
    setState({
      phase: "ready",
      resources: resources.value.data ?? [],
      // Список файлов не отдался: ресурсы всё равно показываем.
      outputs: outputs.status === "fulfilled" ? (outputs.value.data ?? []) : [],
    });
  }, [api, managedApi, sessionId]);

  useEffect(() => {
    setState({ phase: "loading" });
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const rows = useMemo<ResourceRow[]>(() => {
    if (state.phase !== "ready") return [];
    return [
      ...state.resources.map((resource) => ({
        key: `${resource.type}:${resourcePath(resource)}`,
        path: resourcePath(resource),
        size: EMPTY_VALUE,
        icon: resourceIcon(resource),
      })),
      ...state.outputs.map((file) => ({
        key: `output:${file.filename}`,
        path: `${OUTPUT_DIR}${file.filename}`,
        size: formatBytesRu(file.size_bytes),
        icon: <FileIcon className={ICON_CLASS} />,
        output: file,
      })),
    ];
  }, [state]);


  const needle = query.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => row.path.toLowerCase().includes(needle)) : rows;

  const addFile = async (file: File) => {
    try {
      const uploaded = await managedApi.files.upload({ file });
      await managedApi.sessions.resources.add(sessionId, { type: "file", file_id: uploaded.id });
    } catch {
      toast.error("Не удалось добавить файл");
      return;
    }
    toast.success("Файл добавлен");
    await load();
  };

  if (state.phase === "error") {
    return (
      <LoadError
        size="sm"
        title="Не удалось загрузить ресурсы"
        message="Список ресурсов не отдался. Повторите попытку."
        retrying={retrying}
        onRetry={() => {
          setRetrying(true);
          setState({ phase: "loading" });
          void load().finally(() => setRetrying(false));
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 p-3">
        <Input
          type="search"
          aria-label="Найти ресурс"
          placeholder="Найти ресурс"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-lg text-xs"
        />
        <Input
          ref={fileInput}
          type="file"
          aria-label="Файл для добавления"
          className="hidden"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void addFile(file);
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs">
              <PlusIcon aria-hidden="true" />
              Добавить ресурс
              <ChevronDownIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={() => fileInput.current?.click()}>Файл</DropdownMenuItem>
            {["Репозиторий GitHub", "Хранилище памяти"].map((name) => (
              <DropdownMenuItem key={name} disabled className="h-auto flex-col items-start gap-0 py-1.5">
                <span>{name}</span>
                <span className="text-2xs text-ddc-text-muted">Только при создании сессии</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {state.phase === "loading" ? (
        <div role="status" aria-busy="true" className="space-y-2 px-3">
          <span className="sr-only">Загрузка ресурсов…</span>
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          kind="file"
          title="Ресурсов пока нет"
          body={
            <>
              Файлы агента появятся здесь, когда он сохранит их в{" "}
              <code className="font-mono">{OUTPUT_DIR}</code>.
            </>
          }
          className="m-3 border-0 shadow-none"
        />
      ) : visible.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-ddc-text-muted">Ничего не найдено</p>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3 text-xs tracking-normal normal-case">Путь</TableHead>
              <TableHead className="h-8 w-24 px-3 text-right text-xs tracking-normal normal-case">Размер</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.key} className="relative h-7">
                <TableCell className="min-w-0 px-3 py-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {row.icon}
                    {row.output ? (
                      <>
                        <PlainButton
                          onClick={() => row.output && viewer.open(row.output)}
                          title={row.path}
                          className="min-w-0 flex-1 truncate text-left font-mono text-ddc-link after:absolute after:inset-0 after:content-[''] hover:text-ddc-link-hover hover:underline focus-visible:underline focus-visible:outline-none"
                        >
                          {row.path}
                        </PlainButton>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Скачать ${row.output.filename}`}
                          title="Скачать"
                          className="relative z-10 size-6 flex-none text-ddc-icon-muted hover:text-ddc-link"
                          onClick={() => row.output && void viewer.download(row.output.filename)}
                        >
                          <DownloadIcon aria-hidden="true" />
                        </Button>
                      </>
                    ) : (
                      <span className="min-w-0 truncate font-mono" title={row.path}>
                        {row.path}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="px-3 py-1 text-right tabular-nums text-ddc-text-muted">
                  {row.size}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {viewer.dialog}
    </div>
  );
}
