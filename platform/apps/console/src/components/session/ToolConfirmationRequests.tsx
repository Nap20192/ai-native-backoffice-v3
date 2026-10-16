import { useMemo, useState } from "react";
import { ShieldQuestionIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Event } from "../../lib/events";
import { Label } from "@/components/ui/label";

/**
 * Вызовы инструментов, которые ждут решения человека: у встроенного или MCP
 * инструмента стоит политика `always_ask`, harness остановил ход и ждёт
 * `user.tool_confirmation`. Блок стоит над полем ввода страницы сессии и
 * работает на любой сессии, не только на сессии ассистента.
 *
 * Платформенные вызовы ассистента (сервер `platform`) подтверждает только
 * карточка с отпечатком изменения, прямой allow сервер отклоняет. Для них
 * остаётся «Отклонить» и подсказка.
 */

export interface PendingConfirmation {
  id: string;
  kind: "builtin" | "mcp";
  name: string;
  server: string | null;
  input: Record<string, unknown>;
  threadId: string | null;
  platform: boolean;
}

export interface ConfirmationDecision {
  toolUseId: string;
  result: "allow" | "deny";
  threadId: string | null;
  denyMessage?: string;
}

const PLATFORM_SERVER = "platform";

/** Вызовы с `ask` без решения и без результата, в порядке событий. */
export function pendingConfirmations(events: readonly Event[]): PendingConfirmation[] {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.type === "user.tool_confirmation" && typeof event.tool_use_id === "string") {
      settled.add(event.tool_use_id);
    } else if (event.type === "agent.tool_result" && typeof event.tool_use_id === "string") {
      settled.add(event.tool_use_id);
    } else if (event.type === "agent.mcp_tool_result" && typeof event.mcp_tool_use_id === "string") {
      settled.add(event.mcp_tool_use_id);
    }
  }
  const pending: PendingConfirmation[] = [];
  for (const event of events) {
    const isMcp = event.type === "agent.mcp_tool_use";
    if (event.type !== "agent.tool_use" && !isMcp) continue;
    if (event.evaluated_permission !== "ask") continue;
    if (typeof event.id !== "string" || settled.has(event.id)) continue;
    const server = isMcp && typeof event.mcp_server_name === "string" ? event.mcp_server_name : null;
    pending.push({
      id: event.id,
      kind: isMcp ? "mcp" : "builtin",
      name: typeof event.name === "string" ? event.name : "инструмент",
      server,
      input: event.input && typeof event.input === "object" ? event.input : {},
      threadId: typeof event.session_thread_id === "string" ? event.session_thread_id : null,
      platform: server === PLATFORM_SERVER,
    });
  }
  return pending;
}

const INPUT_LIMIT = 600;

function inputPreview(input: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  return text.length > INPUT_LIMIT ? `${text.slice(0, INPUT_LIMIT)}…` : text;
}

function Request({
  item,
  onDecide,
}: {
  item: PendingConfirmation;
  onDecide: (decision: ConfirmationDecision) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  async function decide(result: "allow" | "deny") {
    setBusy(true);
    setFailed(false);
    const decision: ConfirmationDecision = { toolUseId: item.id, result, threadId: item.threadId };
    if (result === "deny" && reason.trim()) decision.denyMessage = reason.trim();
    try {
      await onDecide(decision);
      setSent(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const title = item.server ? `${item.server} / ${item.name}` : item.name;

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-ddc-border bg-ddc-surface p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-ddc-heading">{title}</span>
      </div>
      <pre className="max-h-40 overflow-auto rounded-lg bg-ddc-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-ddc-text">
        {inputPreview(item.input)}
      </pre>
      {sent ? (
        <p className="text-xs text-ddc-text-muted">Решение отправлено</p>
      ) : (
        <>
          {item.platform ? (
            <p className="text-xs text-ddc-text-muted">
              Изменения платформы подтверждаются карточкой в панели ассистента. Здесь можно только отклонить.
            </p>
          ) : null}
          <Label className="flex flex-col gap-1 text-xs text-ddc-text-muted">
            Причина отказа
            <Textarea
              rows={1}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Необязательно. Агент увидит её"
              className="min-h-8"
            />
          </Label>
          {failed ? (
            <p className="text-xs font-medium text-ddc-danger-text" role="alert">
              Не удалось отправить решение. Повторите
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {item.platform ? null : (
              <Button type="button" size="sm" disabled={busy} onClick={() => void decide("allow")}>
                Разрешить
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide("deny")}>
              Отклонить
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

export function ToolConfirmationRequests({
  events,
  onDecide,
}: {
  events: readonly Event[];
  onDecide: (decision: ConfirmationDecision) => Promise<void>;
}) {
  const pending = useMemo(() => pendingConfirmations(events), [events]);
  if (pending.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Ожидает подтверждения"
      className="mx-auto mb-2 flex w-full max-w-[752px] flex-col gap-2 px-4"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-ddc-text-muted">
        <ShieldQuestionIcon aria-hidden="true" className="size-4" />
        Ожидает подтверждения
      </p>
      <ul className="flex flex-col gap-2">
        {pending.map((item) => (
          <Request key={item.id} item={item} onDecide={onDecide} />
        ))}
      </ul>
    </div>
  );
}
