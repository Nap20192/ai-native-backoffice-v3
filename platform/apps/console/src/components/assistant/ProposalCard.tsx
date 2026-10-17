import { useState, type ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import {
  useAssistantApi,
  type DangerOperation,
  type PreviewOperation,
  type PreviewResult,
} from "../../lib/assistant/api";
import { revertAgentVersion, useProposal, type ProposalController } from "../../lib/assistant/confirm";
import { appliedLines, type ThreadItem } from "../../lib/assistant/events";
import { YamlBlock, YamlDiffView } from "./YamlDiffView";
import { Label } from "@/components/ui/label";
import { DependencyList } from "../DependencyList";

/**
 * Карточка одного предложения ассистента (раздел 1.4 плана): создание или
 * правка одного объекта. Здесь же общий каркас `ProposalShell` для карточек
 * пачки, сессии и сообщения. Разницу, класс и отпечаток считает сервер, карточка
 * только показывает их и шлёт решение с отпечатком того, что на экране.
 */

export type ProposalItem = Extract<ThreadItem, { kind: "proposal" }>;

/* ---------- Названия ---------- */

const NOUN_ACC: Record<string, string> = {
  agent: "агента",
  environment: "окружение",
  skill: "навык",
  file: "файл",
  memory_store: "хранилище памяти",
  memory: "запись памяти",
  deployment: "деплоймент на паузе",
  session: "сессию",
  model_card: "карточку модели",
  outcome: "результат",
  skill_version: "версию навыка",
  session_resource: "ресурс сессии",
};

/** Вид объекта в заголовке архива и удаления: деплоймент без «на паузе». */
const DANGER_NOUN_ACC: Record<string, string> = {
  deployment: "деплоймент",
};

const DANGER_VERB: Record<DangerOperation, string> = {
  archive: "Архивировать",
  unarchive: "Вернуть из архива",
  delete: "Удалить",
};

/** Подпись кнопки опасного инструмента. Те же слова, что в окнах архива и удаления. */
const DANGER_CONFIRM: Record<string, string> = {
  archive_object: "В архив",
  unarchive_object: "Вернуть из архива",
  delete_object: "Удалить",
};

export const IRREVERSIBLE_NOTE = "Это нельзя отменить";
export const ARCHIVE_NOTE = "Объект можно вернуть из архива";

const CREATE_NOUN: Record<string, string> = {
  create_agent: "агента",
  create_environment: "окружение",
  create_skill: "навык",
  upload_file: "файл",
  create_memory_store: "хранилище памяти",
  create_deployment: "деплоймент на паузе",
  create_session: "сессию",
};

const CLASS_LABEL: Record<string, string> = {
  create: "Создание",
  edit: "Правка",
  danger: "Опасное",
  out_of_v1: "Вне первой версии",
};

export function nounAcc(kind: string): string {
  return NOUN_ACC[kind] ?? kind;
}

export function operationAction(op: PreviewOperation): "create" | "update" {
  return op.class === "edit" ? "update" : "create";
}

/** Архив или удаление: карточка красная (crud.md, 3.4). Возврат из архива это правка. */
export function isDangerOperation(op: PreviewOperation | undefined): boolean {
  if (!op) return false;
  return op.class === "danger" || op.operation === "archive" || op.operation === "delete";
}

/** «Создать навык «…»» или «Изменить агента «…», версия 3 станет 4». */
export function operationTitle(op: PreviewOperation): string {
  if (op.operation) {
    const what = op.name ? `«${op.name}»` : (op.targetId ?? "");
    const noun = DANGER_NOUN_ACC[op.kind] ?? nounAcc(op.kind);
    return `${DANGER_VERB[op.operation]} ${noun} ${what}`.trim();
  }
  const verb = operationAction(op) === "create" ? "Создать" : "Изменить";
  const name = op.name ? ` «${op.name}»` : "";
  const versions =
    operationAction(op) === "update" && op.versionFrom !== null && op.versionTo !== null
      ? `, версия ${op.versionFrom} станет ${op.versionTo}`
      : "";
  return `${verb} ${nounAcc(op.kind)}${name}${versions}`;
}

export function proposalTitle(preview: PreviewResult | null, tool: string): string {
  if (preview?.title) return preview.title;
  const op = preview?.operations[0];
  if (op) return operationTitle(op);
  if (CREATE_NOUN[tool]) return `Создать ${CREATE_NOUN[tool]}`;
  return "Предложение ассистента";
}

/** Подпись главной кнопки по инструменту и классам операций. */
export function confirmLabelFor(tool: string, preview: PreviewResult | null): string {
  if (tool === "send_message") return "Отправить";
  if (DANGER_CONFIRM[tool]) return DANGER_CONFIRM[tool];
  if (tool === "apply_changes") {
    const ops = preview?.operations ?? [];
    return ops.length > 0 && ops.every((o) => o.class === "create") ? "Создать" : "Применить";
  }
  if (tool in CREATE_NOUN) return "Создать";
  // Класс считает сервер по состоянию объекта: запись памяти по свободному пути это создание.
  const ops = preview?.operations ?? [];
  if (ops.length === 1 && ops[0].class === "create") return "Создать";
  return "Применить";
}

/* ---------- Тело одной операции ---------- */

const DEPLOYMENT_PAUSE_NOTE = "Деплоймент создаётся на паузе. Запустить его можно в консоли";

/** Предупреждения, доступ, YAML или разница и пояснения по виду объекта. */
export function OperationBody({ op }: { op: PreviewOperation }) {
  if (op.operation === "archive" || op.operation === "delete") return <DangerBody op={op} />;
  const isEdit = operationAction(op) === "update" || op.operation === "unarchive";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {op.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Предупреждения">
          {op.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-ddc-warning-text">
              <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {op.access.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-ddc-label">Получит доступ</p>
          <ul className="list-disc pl-5 text-xs text-ddc-text" aria-label="Доступ">
            {op.access.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {isEdit ? (
        <YamlDiffView before={op.beforeYaml} after={op.afterYaml} />
      ) : (
        <YamlBlock yaml={op.afterYaml} />
      )}

      {op.kind === "deployment" && !isEdit ? (
        <div className="flex flex-col gap-1">
          {op.nextRuns.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-ddc-label">Ближайшие запуски</p>
              <ul className="list-disc pl-5 text-xs text-ddc-text" aria-label="Ближайшие запуски">
                {op.nextRuns.slice(0, 3).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-ddc-text-muted">{DEPLOYMENT_PAUSE_NOTE}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Архив или удаление: строка про последствия, списки «Мешает» и «Затронет», объект сейчас. */
function DangerBody({ op }: { op: PreviewOperation }) {
  const irreversible = op.irreversible || op.operation === "delete";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-semibold text-ddc-tone-danger-fg" role="note">
        {irreversible ? IRREVERSIBLE_NOTE : ARCHIVE_NOTE}
      </p>
      {op.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Предупреждения">
          {op.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-ddc-warning-text">
              <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {op.dependencies ? <DependencyList report={op.dependencies} /> : null}
      {op.operation === "archive" ? (
        <YamlDiffView before={op.beforeYaml} after={op.afterYaml} />
      ) : op.beforeYaml ? (
        <div>
          <p className="mb-1 text-xs font-medium text-ddc-label">Что будет удалено</p>
          <YamlBlock yaml={op.beforeYaml} />
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Каркас ---------- */

type EffectivePhase = "pending" | "sent" | "denied" | "applied" | "failed";

function effectivePhase(item: ProposalItem, controller: ProposalController): EffectivePhase {
  if (item.phase !== "pending") return item.phase;
  const local = controller.state.phase;
  if (local === "sent") return "sent";
  if (local === "denied") return "denied";
  return "pending";
}

export interface ProposalShellProps {
  item: ProposalItem;
  sessionId: string;
  /** Заголовок, если карточка строит его сама (пачка, сообщение). */
  title?: (preview: PreviewResult | null) => string;
  /** Подпись главной кнопки, если она отличается от общей. */
  confirmLabel?: (preview: PreviewResult | null) => string;
  /** Тело под заголовком. Вызывается, когда preview загружен. */
  children: (preview: PreviewResult) => ReactNode;
  /** Строки под телом: поясняющие примечания карточки. */
  footnote?: (preview: PreviewResult) => ReactNode;
  /** Текст в состоянии «применено» вместо строк «Создан …». */
  appliedExtra?: ReactNode;
}

export function ProposalShell({
  item,
  sessionId,
  title,
  confirmLabel,
  children,
  footnote,
}: ProposalShellProps) {
  const controller = useProposal({
    sessionId,
    toolUseId: item.id,
    tool: item.tool,
    active: item.phase === "pending",
  });
  const { state } = controller;
  const phase = effectivePhase(item, controller);
  const preview = state.preview;
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");

  const heading = title ? title(preview) : proposalTitle(preview, item.tool);
  const busy = state.phase === "confirming" || state.phase === "loading";
  const block = state.block;
  const canDecide = preview ? preview.canConfirm : true;
  const applyDisabled = busy || !preview || !preview.digest || block !== null || state.phase === "error";
  const label = confirmLabel ? confirmLabel(preview) : confirmLabelFor(item.tool, preview);
  const single = preview && preview.operations.length === 1 ? preview.operations[0] : undefined;
  const classLabel = single ? CLASS_LABEL[single.class] : undefined;
  const danger = isDangerOperation(single);
  // При блокирующих зависимостях кнопки подтверждения нет, есть причина (crud.md, 3.4).
  const blockedByDependencies = (single?.dependencies?.blocking.length ?? 0) > 0;

  return (
    <article
      className={
        danger
          ? "assistant-card flex min-w-0 flex-col gap-2 rounded-xl border-2 border-ddc-tone-danger-ring bg-ddc-tone-danger-bg p-3"
          : "assistant-card flex min-w-0 flex-col gap-2 rounded-xl border border-ddc-border bg-ddc-surface p-3"
      }
      data-phase={phase}
      data-tool={item.tool}
      data-danger={danger ? "true" : undefined}
      aria-label={heading}
    >
      <header className="flex items-start gap-2">
        <SparklesIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--assistant-accent)" />
        <h4 className="min-w-0 flex-1 text-sm leading-5 font-semibold text-ddc-heading">{heading}</h4>
        {phase === "pending" && classLabel ? (
          <span className="assistant-chip shrink-0">{classLabel}</span>
        ) : null}
      </header>

      {phase === "pending" ? (
        <>
          {!preview && state.phase === "loading" ? (
            <div className="flex items-center gap-2 text-xs text-ddc-text-muted" aria-live="polite">
              <Spinner className="size-3.5" />
              <span>Готовлю предложение</span>
            </div>
          ) : null}

          {preview ? children(preview) : null}
          {preview && footnote ? footnote(preview) : null}

          {state.notice ? (
            <p
              className={
                state.stale
                  ? "flex items-center gap-1.5 text-xs font-medium text-ddc-warning-text"
                  : "text-xs font-medium text-ddc-danger-text"
              }
              role="status"
            >
              {state.notice}
            </p>
          ) : null}
          {block ? (
            <p className="text-xs font-medium text-ddc-danger-text" role="alert">
              {block.text}
            </p>
          ) : null}

          {preview && !canDecide ? (
            <p className="text-xs text-ddc-text-muted">
              {`Подтвердить может только ${preview.ownerName ?? "владелец разговора"}`}
            </p>
          ) : null}

          {canDecide ? (
            denying ? (
              <div className="flex flex-col gap-2">
                <Label className="text-xs font-medium text-ddc-label" htmlFor={`deny-${item.id}`}>
                  Причина отказа
                </Label>
                <Textarea
                  id={`deny-${item.id}`}
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Необязательно. Ассистент прочитает причину"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => controller.deny(reason)}
                  >
                    Отправить отказ
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDenying(false)}>
                    Назад
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {blockedByDependencies ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant={danger ? "destructive" : undefined}
                    disabled={applyDisabled}
                    onClick={controller.allow}
                  >
                    {label}
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" disabled={state.phase === "confirming"} onClick={() => controller.deny()}>
                  Отклонить
                </Button>
                {block?.reason === "args_stale" ? (
                  <Button type="button" size="sm" variant="secondary" onClick={controller.askRebuild}>
                    Попросить пересобрать
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={controller.refresh}>
                  Обновить
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  className="px-0"
                  disabled={state.phase === "confirming"}
                  onClick={() => setDenying(true)}
                >
                  Отклонить с причиной
                </Button>
              </div>
            )
          ) : null}
        </>
      ) : null}

      {phase === "sent" ? (
        <p className="flex items-center gap-2 text-xs text-ddc-text-muted" aria-live="polite">
          <Spinner className="size-3.5" />
          <span>Отправлено. Жду результат</span>
        </p>
      ) : null}

      {phase === "denied" ? (
        <div className="flex flex-col gap-0.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-ddc-text-muted">
            <XIcon aria-hidden="true" className="size-3.5" />
            Отклонено
          </p>
          {item.denyMessage ? <p className="text-ddc-text-muted">{`Причина: ${item.denyMessage}`}</p> : null}
        </div>
      ) : null}

      {phase === "failed" ? (
        <div className="flex flex-col gap-0.5 text-xs">
          <p className="font-medium text-ddc-danger-text">Не применено</p>
          {item.resultText ? <p className="text-ddc-text">{item.resultText}</p> : null}
        </div>
      ) : null}

      {phase === "applied" ? <AppliedBlock item={item} /> : null}
    </article>
  );
}

/* ---------- Итог ---------- */

function AppliedBlock({ item }: { item: ProposalItem }) {
  const api = useAssistantApi();
  const lines = appliedLines(item.applied ?? []);
  const first = item.applied?.[0];
  const isAgentEdit =
    (item.tool === "update_agent" || item.tool === "restore_agent_version") &&
    first?.kind === "agent" &&
    first.id !== null &&
    first.version !== null &&
    first.version > 1;
  const from =
    typeof item.input.expected_version === "number"
      ? item.input.expected_version
      : first?.version
        ? first.version - 1
        : null;

  const [revert, setRevert] = useState<
    { state: "idle" } | { state: "busy" } | { state: "done"; version: number } | { state: "error"; text: string }
  >({ state: "idle" });

  async function doRevert() {
    if (!first?.id || first.version === null || from === null) return;
    setRevert({ state: "busy" });
    try {
      const out = await revertAgentVersion(api, {
        agentId: first.id,
        toVersion: from,
        currentVersion: first.version,
      });
      setRevert({ state: "done", version: out.version });
    } catch {
      setRevert({ state: "error", text: "Не удалось вернуть версию. Агента могли изменить после применения" });
    }
  }

  const hasVersion = first?.version !== null && first?.version !== undefined && first.action === "update";
  return (
    <div className="flex flex-col gap-1 text-xs">
      {hasVersion ? (
        <p className="flex items-center gap-1.5 font-medium text-ddc-tone-success-fg">
          <CheckIcon aria-hidden="true" className="size-3.5" />
          {`Применено, версия ${first?.version}`}
        </p>
      ) : null}
      {lines.map((line, i) =>
        line.href ? (
          <Link key={i} to={line.href} className="text-ddc-link hover:underline">
            {line.text}
          </Link>
        ) : (
          <p key={i} className="text-ddc-text">
            {line.text}
          </p>
        ),
      )}
      {lines.length === 0 && !hasVersion ? <p className="text-ddc-text">Применено</p> : null}
      {isAgentEdit && from !== null && revert.state === "idle" ? (
        <div>
          <Button type="button" variant="outline" size="xs" onClick={doRevert}>
            {`Вернуть версию ${from}`}
          </Button>
        </div>
      ) : null}
      {revert.state === "busy" ? (
        <p className="flex items-center gap-2 text-ddc-text-muted">
          <Spinner className="size-3.5" />
          Возвращаю версию
        </p>
      ) : null}
      {revert.state === "done" ? <p className="text-ddc-text">{`Возвращено, новая версия ${revert.version}`}</p> : null}
      {revert.state === "error" ? <p className="text-ddc-danger-text">{revert.text}</p> : null}
    </div>
  );
}

/* ---------- Карточка ---------- */

export interface ProposalCardProps {
  item: ProposalItem;
  sessionId: string;
}

/** Создание или правка одного объекта. */
export function ProposalCard({ item, sessionId }: ProposalCardProps) {
  return (
    <ProposalShell item={item} sessionId={sessionId}>
      {(preview) =>
        preview.operations.length > 0 ? <OperationBody op={preview.operations[0]} /> : null
      }
    </ProposalShell>
  );
}
