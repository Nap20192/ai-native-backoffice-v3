import { formatDateTime } from "../lib/date-format";
import { useMemo, useState, type ReactNode } from "react";
import { XCircleIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { useI18n } from "../i18n";

interface LocalSkill {
  id: string;
  name?: string;
  description?: string;
  source?: "global" | "plugin" | "project";
  source_label?: string;
}

interface Runtime {
  id: string;
  machine_id: string;
  hostname: string;
  os: string;
  agents: Array<{ id: string; binary?: string }>;
  /** Навыки, которые демон нашёл на компьютере пользователя, по id
   *  ACP-агента. Для агента Claude Code список собирается из
   *  ~/.claude/skills/ и ~/.claude/plugins (звёздочка)/skills/. Показывает,
   *  что доступно локально, и служит источником для чёрного списка
   *  навыков агента (AgentConfig.runtime_binding.local_skill_blocklist). */
  local_skills?: Record<string, LocalSkill[]>;
  version: string;
  status: "online" | "offline";
  last_heartbeat: number | null;
  created_at: number;
}

type StatusValue = "any" | "online" | "offline";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "online", label: "В сети" },
  { value: "offline", label: "Не в сети" },
];

const SKILL_SOURCE_LABEL: Record<string, string> = {
  global: "глобальный",
  plugin: "плагин",
  project: "проект",
};

const SETUP_COMMAND = "npx @openma/cli bridge setup";

/** Локальные среды: ноутбуки и виртуальные машины пользователей, на
 *  которых запущен `oma bridge daemon`. Каждая среда может запускать
 *  ACP-совместимых агентов. Агент OMA с `harness: "acp-proxy"` и
 *  заданным `runtime_binding` отдаёт свой цикл одной из таких сред. */
export function RuntimesList() {
  const { api } = useApi();
  const { t } = useI18n();
  const [showInstructions, setShowInstructions] = useState(false);
  const [status, setStatus] = useState<StatusValue>("any");
  const [search, setSearch] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<Runtime | null>(null);
  const [askRevoke, setAskRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);

  // Обновление раз в 15 секунд через `refetchInterval` TQ: только что
  // подключённый демон появляется без перезагрузки страницы. Запрос
  // дешёвый (один SELECT по runtimes), интервал TQ снимает сам при
  // размонтировании.
  const {
    data: runtimesRes,
    isLoading: loading,
    refetch,
  } = useApiQuery<{ runtimes: Runtime[] }>(
    "/v1/oma/runtimes",
    undefined,
    { refetchInterval: 15_000 },
  );
  const runtimes = runtimesRes?.runtimes ?? [];

  // Фильтр по статусу работает на клиенте. В отличие от AgentsList (серверная
  // пагинация и фильтры) список короткий: несколько сред на рабочее
  // пространство, и `/v1/oma/runtimes` уже отдаёт его целиком. Опрос раз в
  // 15 секунд держит статусы свежими, а фильтр в памяти не дёргает сервер
  // при каждом переключении и не сбрасывает опрашиваемый запрос. Если сред
  // станут сотни, фильтр уйдёт в серверный параметр, как в AgentsList.
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return runtimes.filter(
      (r) =>
        (status === "any" || r.status === status) &&
        (!needle || `${r.hostname}\n${r.os}`.toLocaleLowerCase().includes(needle)),
    );
  }, [runtimes, search, status]
  );

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api(`/v1/oma/runtimes/${revokeTarget.id}`, { method: "DELETE" });
      void refetch();
    } catch {
      // Ошибку уже показал клиент API.
    } finally {
      setRevoking(false);
      setAskRevoke(false);
    }
  };

  const columns = useMemo<ColumnDef<Runtime>[]>(
    () => [
      {
        id: "hostname",
        accessorKey: "hostname",
        header: "Имя хоста",
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => {
          const r = row.original;
          const totalSkills = Object.values(r.local_skills ?? {}).reduce(
            (n, arr) => n + (arr?.length ?? 0),
            0,
          );
          return (
            <>
              <span title={r.hostname} className="truncate font-medium text-ddc-heading">
                {r.hostname}
              </span>
              <span title={r.id} className="truncate font-mono text-xs text-ddc-text-muted">
                {r.id}
              </span>
              {totalSkills > 0 && (
                <LocalSkillsPopover
                  hostname={r.hostname}
                  skills={r.local_skills ?? {}}
                  total={totalSkills}
                />
              )}
            </>
          );
        },
        enableHiding: false,
      },
      {
        id: "os",
        accessorKey: "os",
        header: "ОС",
        size: 110,
        cell: ({ row }) => <span className="text-ddc-text-muted">{row.original.os}</span>,
      },
      {
        id: "status",
        accessorFn: (r) => r.status,
        header: t.common.status,
        size: 120,
        cell: ({ row }) =>
          row.original.status === "online" ? (
            <span className="chip tone-success">В сети</span>
          ) : (
            <span className="chip tone-neutral">Не в сети</span>
          ),
      },
      {
        id: "agents",
        accessorFn: (r) => (r.agents ?? []).map((a) => a.id).join(", "),
        header: "Найденные агенты",
        size: 220,
        meta: { priority: 2 },
        cell: ({ row }) => {
          const agents = row.original.agents ?? [];
          if (agents.length === 0) return <Dash />;
          const text = agents.map((a) => a.id).join(", ");
          return (
            <span title={text} className="truncate font-mono text-xs text-ddc-text-muted">
              {text}
            </span>
          );
        },
      },
      {
        id: "heartbeat",
        accessorFn: (r) => r.last_heartbeat ?? 0,
        header: "Последний сигнал",
        size: 160,
        cell: ({ row }) =>
          row.original.last_heartbeat ? (
            <span
              title={formatDateTime(row.original.last_heartbeat * 1000)}
              className="text-xs tabular-nums text-ddc-text-muted"
            >
              {formatHeartbeat(row.original.last_heartbeat)}
            </span>
          ) : (
            <Dash />
          ),
      },
    ],
    [t],
  );

  // Подпись активного фильтра пуста, пока выбрано значение по умолчанию:
  // чип читается как «Статус», а не «Статус: Все». Как в AgentsList.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
    <FilterChip
      label={t.common.status}
      active={status !== "any"}
      display={statusDisplay}
      onClear={() => setStatus("any")}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-48 p-0"
      >
        <FacetedFilter
          options={STATUS_OPTIONS}
          value={status}
          onValueChange={(v) => setStatus(v as StatusValue)}
          searchPlaceholder="Найти статус…"
        />
      </PopoverContent>
    </FilterChip>
  );

  return (
    <DataTable<Runtime>
      title={t.nav.localRuntimes}
      subtitle="Компьютеры, подключённые к платформе: на них агенты выполняются локально."
      createLabel={t.runtimes.connectRuntime}
      onCreate={() => setShowInstructions(true)}
      searchPlaceholder={t.runtimes.searchRuntimes}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={filtered}
      loading={loading}
      getRowId={(r) => r.id}
      rowActions={(runtime) => [
        {
          label: "Отозвать",
          icon: <XCircleIcon className="size-4" />,
          destructive: true,
          onSelect: () => {
            setRevokeTarget(runtime);
            setAskRevoke(true);
          },
        },
      ]}
      emptyTitle={
        status === "any" && !search.trim() ? t.runtimes.noRuntimesYet : t.runtimes.noMatchingRuntimes
      }
      emptyKind="runtime"
      emptyAction={
        status === "any" && !search.trim() && (
          <Button onClick={() => setShowInstructions(true)}>{t.runtimes.connectRuntime}</Button>
        )
      }
      emptySubtitle={
        status === "any" && !search.trim() ? (
          <>
            Выполните <Code>{SETUP_COMMAND}</Code> на компьютере, который хотите подключить.
          </>
        ) : (
          "Измените статус или поисковый запрос."
        )
      }
      columns={columns}
    >
      <Modal
        open={showInstructions}
        onClose={() => setShowInstructions(false)}
        title="Подключение локального компьютера"
        footer={<Button onClick={() => setShowInstructions(false)}>Готово</Button>}
      >
        <div className="space-y-4 text-sm">
          <p className="text-ddc-text-muted">На компьютере, который нужно подключить, выполните:</p>
          <div className="rounded-xl bg-ddc-surface-muted p-3 font-mono text-xs">
            <div className="break-all text-ddc-text select-all">{SETUP_COMMAND}</div>
          </div>
          <p className="text-xs text-ddc-text-muted">
            Мастер откроет этот браузер для входа через OAuth, запишет учётные данные в{" "}
            <Code>~/.oma/bridge/</Code> и (на macOS) установит задание launchd, которое
            держит демон запущенным после перезагрузки. Демон ищет в <Code>$PATH</Code>{" "}
            агентов, совместимых с ACP, и показывает их здесь.
          </p>
          <div>
            <p className="mb-1.5 text-xs text-ddc-text-muted">
              <strong className="font-semibold text-ddc-heading">Рекомендуемые агенты</strong>{" "}
              из набора OMA:
            </p>
            <ul className="ml-4 list-disc space-y-1 text-xs text-ddc-text-muted">
              <li>
                <span className="font-mono text-ddc-text">claude-acp</span>:{" "}
                <Code>npx -y @agentclientprotocol/claude-agent-acp</Code> (ставится сам, если{" "}
                <Code>claude</Code> есть в PATH)
              </li>
              <li>
                <span className="font-mono text-ddc-text">codex-acp</span>: скачайте на странице{" "}
                <a
                  href="https://github.com/zed-industries/codex-acp/releases"
                  target="_blank"
                  rel="noreferrer"
                  className="link"
                >
                  релизов zed-industries/codex-acp
                </a>
              </li>
              <li>
                <span className="font-mono text-ddc-text">hermes</span>:{" "}
                <Code>
                  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh
                  | bash
                </Code>
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-xs text-ddc-text-muted">
              Мастер сам ставит ACP-обёртку, если в <Code>$PATH</Code> есть исходная программа:
            </p>
            <ul className="ml-4 list-disc space-y-1 text-xs text-ddc-text-muted">
              <li>
                есть <Code>claude</Code>: ставит <Code>@agentclientprotocol/claude-agent-acp</Code>
              </li>
              <li>
                есть <Code>codex</Code>: ставит <Code>@normahq/codex-acp-bridge</Code> (управляет
                codex через ACP)
              </li>
              <li>
                нет <Code>gemini</Code>: ставит <Code>@google/gemini-cli</Code> (ACP уже встроен)
              </li>
            </ul>
          </div>
          <p className="text-xs text-ddc-text-muted">
            Более 30 других агентов (gemini, opencode, cline, cursor, kimi, qwen-code и остальные)
            берутся из{" "}
            <a
              href="https://agentclientprotocol.com/get-started/registry"
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              официального реестра ACP
            </a>
            : демон загружает манифест при запуске, и любая установленная программа из него
            становится доступной для выбора.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={askRevoke}
        title={`Отозвать среду «${revokeTarget?.hostname ?? ""}»?`}
        message="Демон на этом компьютере больше не сможет подключаться."
        confirmLabel="Отозвать"
        destructive
        busy={revoking}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => setAskRevoke(false)}
      />
    </DataTable>
  );
}

/** Приглушённая команда или путь в тексте. */
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="prose-wrap rounded-md bg-ddc-surface-sunken px-1 py-0.5 font-mono text-xs text-ddc-text">
      {children}
    </code>
  );
}

/** Пустое значение в ячейке. */
function Dash() {
  return <span className="text-ddc-placeholder">–</span>;
}

/** Навыки, найденные демоном на компьютере. Список лежит в поповере: строка
 *  таблицы фиксирована по высоте, раскрывающийся блок в ней обрезался бы. */
function LocalSkillsPopover({
  hostname,
  skills,
  total,
}: {
  hostname: string;
  skills: Record<string, LocalSkill[]>;
  total: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="flex-none">
          {total} {pluralRu(total, "локальный навык", "локальных навыка", "локальных навыков")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-80 w-80 overflow-y-auto">
        <PopoverHeader>
          <PopoverTitle>Локальные навыки</PopoverTitle>
          <PopoverDescription className="truncate" title={hostname}>
            Найдены демоном на {hostname}
          </PopoverDescription>
        </PopoverHeader>
        {Object.entries(skills).map(([acpId, list]) =>
          !list?.length ? null : (
            <div key={acpId} className="space-y-1">
              <p className="text-xs font-semibold text-ddc-text-muted">Для {acpId}</p>
              <ul className="space-y-1">
                {list.map((s) => (
                  <li
                    key={`${acpId}/${s.source_label ?? ""}/${s.id}`}
                    className="font-mono text-xs break-all"
                  >
                    <span className="text-ddc-text">{s.id}</span>
                    <span className="ml-1 text-ddc-text-muted">
                      ({SKILL_SOURCE_LABEL[s.source ?? "global"] ?? s.source}
                      {s.source_label ? `: ${s.source_label}` : ""})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ),
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Русское склонение: 1 навык, 2 навыка, 5 навыков. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function formatHeartbeat(unixSeconds: number): string {
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (ago < 60) return `${ago} с назад`;
  if (ago < 3600) return `${Math.floor(ago / 60)} мин назад`;
  if (ago < 86400) return `${Math.floor(ago / 3600)} ч назад`;
  return `${Math.floor(ago / 86400)} дн. назад`;
}
