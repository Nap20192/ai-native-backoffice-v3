import { useEffect, useMemo, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { useLocation } from "react-router";

import { Button } from "@/components/ui/button";

import {
  createAssistantSession,
  fetchSettings,
  findBuilder,
  sendAssistantMessage,
  useAssistantApi,
} from "../../lib/assistant/api";
import { sessionActivity, useAssistantEvents } from "../../lib/assistant/events";
import { extractOutcomeDraft, outcomeRequestText, type OutcomeSuggestion } from "../../lib/assistant/outcome";
import { buildPageContext, withPageContext } from "../../lib/assistant/page-context";
import { useAuth } from "../../lib/auth";

/**
 * «Предложить результат» в диалоге «Задать результат» (раздел 1.1 плана).
 * Консоль начинает отдельную сессию ассистента в наборе «черновик»: она только
 * читает и готовит черновик через `preview_change`. Описание и критерии
 * попадают в форму, а событие `user.define_outcome` отправляет человек кнопкой
 * диалога.
 */

type Phase =
  | { name: "idle" }
  | { name: "starting" }
  | { name: "working"; sessionId: string }
  | { name: "error"; message: string };

export function SuggestOutcomeButton({
  sessionId,
  onSuggested,
  disabled = false,
}: {
  sessionId: string;
  onSuggested: (suggestion: OutcomeSuggestion) => void;
  disabled?: boolean;
}) {
  const api = useAssistantApi();
  const { user } = useAuth();
  const location = useLocation();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const watched = phase.name === "working" ? phase.sessionId : null;
  const { events, addOptimistic, dropOptimistic } = useAssistantEvents(watched);
  const delivered = useRef<string | null>(null);

  const draft = useMemo(() => extractOutcomeDraft(events), [events]);
  const activity = useMemo(() => sessionActivity(events), [events]);
  const answered = useMemo(() => events.some((e) => e.type === "agent.message"), [events]);

  useEffect(() => {
    if (phase.name !== "working") return;
    if (draft) {
      if (delivered.current !== phase.sessionId) {
        delivered.current = phase.sessionId;
        onSuggested(draft);
      }
      setPhase({ name: "idle" });
    } else if (answered && activity === "idle") {
      setPhase({ name: "error", message: "Ассистент не подготовил черновик. Попробуйте ещё раз" });
    }
  }, [phase, draft, answered, activity, onSuggested]);

  async function start() {
    setPhase({ name: "starting" });
    try {
      const settings = await fetchSettings(api);
      if (!settings.enabled) {
        setPhase({ name: "error", message: "Ассистент выключен. Включить его может владелец или администратор пространства" });
        return;
      }
      const builder = await findBuilder(api);
      if (!builder) {
        setPhase({ name: "error", message: "Ассистента здесь ещё нет. Установите его по Ctrl I" });
        return;
      }
      const sid = await createAssistantSession(api, {
        builder,
        userId: user?.id ?? null,
        mode: "draft",
        title: "Результат сессии",
      });
      setPhase({ name: "working", sessionId: sid });
      const text = withPageContext(
        outcomeRequestText(sessionId),
        buildPageContext({ pathname: `/sessions/${sessionId}`, search: "" }, {}),
      );
      const localId = addOptimistic(text);
      try {
        await sendAssistantMessage(api, sid, text);
      } catch {
        dropOptimistic(localId);
        setPhase({ name: "error", message: "Не удалось отправить просьбу ассистенту. Повторите" });
      }
    } catch {
      setPhase({ name: "error", message: "Не удалось связаться с ассистентом. Повторите" });
    }
  }

  const busy = phase.name === "starting" || phase.name === "working";
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        <SparklesIcon aria-hidden="true" />
        Предложить результат
      </Button>
      {busy ? (
        <p role="status" className="text-xs text-ddc-text-muted">
          Ассистент готовит черновик
        </p>
      ) : null}
      {phase.name === "error" ? (
        <p role="alert" className="text-xs font-medium text-ddc-danger-text">
          {phase.message}
        </p>
      ) : null}
    </div>
  );
}
