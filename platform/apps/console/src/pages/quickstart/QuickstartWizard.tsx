import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpIcon, CheckIcon, CopyIcon } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { useOptionalAssistant } from "../../components/assistant/AssistantProvider";
import { AssistantThread } from "../../components/assistant/AssistantThread";
import { DescribeAgent } from "../../components/assistant/describe/DescribeAgent";
import { Modal } from "../../components/Modal";
import { Page } from "../../components/Page";
import { PageHeader } from "../../components/PageHeader";
import { useAssistantApi } from "../../lib/assistant/api";
import {
  agentHandoffPrompt,
  collectResources,
  exportSnippet,
  wizardSteps,
  type WizardAgent,
  type WizardStep,
} from "../../lib/quickstart";

/**
 * Мастер `/quickstart/new` (раздел 1.3 плана builder-agent). Шаг 1 это
 * «Описать агента» в наборе «черновик»: агента создаёт консоль. Дальше слева чат
 * с ассистентом в полном наборе, он предлагает окружение, сессию и первое
 * сообщение карточками, а каждую запись подтверждает человек. Справа «Ход»,
 * «Ресурсы» и «Экспорт кодом». Кнопка «Начать тестовую сессию» создаёт сессию
 * без ассистента.
 */

function StepList({ steps, horizontal = false }: { steps: WizardStep[]; horizontal?: boolean }) {
  return (
    <ol aria-label="Ход" className={cn("flex gap-2", horizontal ? "flex-row flex-wrap" : "flex-col")}>
      {steps.map((step, index) => (
        <li
          key={step.id}
          aria-current={step.status === "current" ? "step" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
            step.status === "current" && "bg-ddc-selected-bg font-medium text-ddc-selected-text",
            step.status === "done" && "text-ddc-text",
            step.status === "todo" && "text-ddc-text-muted",
          )}
        >
          <span
            aria-hidden="true"
            className="flex size-5 shrink-0 items-center justify-center rounded-full border border-ddc-border-strong text-xs"
          >
            {step.status === "done" ? <CheckIcon className="size-3" /> : index + 1}
          </span>
          <span>{step.title}</span>
          {step.id === "connect" ? (
            <Link to="/api-keys" className="ml-1 text-xs text-ddc-link hover:underline">
              API-ключи
            </Link>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function WizardChat({ assistant }: { assistant: NonNullable<ReturnType<typeof useOptionalAssistant>> }) {
  const [text, setText] = useState("");
  const ready = assistant.status === "ready";

  async function submit() {
    const value = text.trim();
    if (!value || !ready || assistant.sending) return;
    setText("");
    await assistant.send(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <section aria-label="Чат с ассистентом" className="flex min-h-[420px] min-w-0 flex-col rounded-xl border border-ddc-border bg-ddc-surface">
      <div className="max-h-[60dvh] min-h-0 flex-1 overflow-y-auto">
        {!ready ? (
          <p className="px-3 py-4 text-sm text-ddc-text-muted" role="status">
            {assistant.status === "disabled"
              ? "Ассистент выключен. Включить его может владелец или администратор пространства"
              : assistant.status === "error"
                ? "Не удалось загрузить ассистента"
                : "Загружаю ассистента"}
          </p>
        ) : (
          <AssistantThread items={assistant.thread} sessionId={assistant.sessionId ?? ""} running={assistant.running} />
        )}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-ddc-border px-3 py-2">
        {assistant.sendError ? (
          <p className="text-xs font-medium text-ddc-danger-text" role="alert">
            {assistant.sendError}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            aria-label="Сообщение ассистенту"
            placeholder="Ответьте ассистенту или попросите что-нибудь поправить"
            value={text}
            disabled={!ready}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-10 flex-1"
          />
          <Button
            type="button"
            size="icon-sm"
            aria-label="Отправить"
            title="Отправить"
            disabled={!ready || assistant.sending || !text.trim()}
            onClick={() => void submit()}
          >
            <ArrowUpIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}

export function QuickstartWizard() {
  const location = useLocation();
  const navigate = useNavigate();
  const api = useAssistantApi();
  const assistant = useOptionalAssistant();

  const state = location.state as { prompt?: unknown } | null;
  const prompt = typeof state?.prompt === "string" ? state.prompt.trim() : "";

  const [agent, setAgent] = useState<WizardAgent | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const booted = useRef(false);
  const handoffSent = useRef(false);

  const status = assistant?.status;
  const reload = assistant?.reload;
  const newConversation = assistant?.newConversation;
  const send = assistant?.send;

  // Агент готов: разговор начинается заново с новым агентом, а провайдер
  // загружает ассистента, если панель ещё ни разу не открывалась.
  useEffect(() => {
    if (!agent || booted.current) return;
    booted.current = true;
    newConversation?.();
    if (status === "idle") reload?.();
  }, [agent, status, reload, newConversation]);

  useEffect(() => {
    if (!agent || handoffSent.current || status !== "ready" || !send) return;
    handoffSent.current = true;
    void send(agentHandoffPrompt(agent));
  }, [agent, status, send]);

  const thread = assistant?.thread;
  const resources = useMemo(() => collectResources(thread ?? []), [thread]);
  const steps = useMemo(() => wizardSteps({ agent, ...resources }), [agent, resources]);

  if (!prompt) return <Navigate to="/quickstart" replace />;

  async function startSession() {
    if (!agent || !resources.environment || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const fresh = (await api(`/v1/agents/${encodeURIComponent(agent.id)}`, { quiet: true })) as { version?: unknown } | null;
      const version = typeof fresh?.version === "number" ? fresh.version : agent.version;
      const created = (await api("/v1/sessions", {
        method: "POST",
        quiet: true,
        body: JSON.stringify({
          agent: { type: "agent", id: agent.id, version },
          environment_id: resources.environment.id,
          title: `Проверка: ${agent.name}`,
        }),
      })) as { id?: unknown } | null;
      if (typeof created?.id !== "string") throw new Error("Сервер не вернул id сессии");
      navigate(`/sessions/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setStartError(err instanceof Error && err.message ? err.message : "Не удалось начать сессию");
    } finally {
      setStarting(false);
    }
  }

  const snippet = agent
    ? exportSnippet({ agentId: agent.id, agentVersion: agent.version, environmentId: resources.environment?.id ?? null })
    : "";

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  const header = (
    <PageHeader title="Быстрый старт" description="Агент, окружение и первая сессия за четыре шага." />
  );

  if (!agent) {
    return (
      <Page header={header}>
        <div className="flex min-w-0 flex-col gap-4">
          <StepList steps={steps} horizontal />
          <DescribeAgent
            initialPrompt={prompt}
            autoStart
            onCancel={() => navigate("/quickstart")}
            onCreated={(created) => setAgent({ id: created.id, name: created.name || "Агент", version: 1 })}
          />
        </div>
      </Page>
    );
  }

  return (
    <Page header={header}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {assistant ? (
          <WizardChat assistant={assistant} />
        ) : (
          <p className="text-sm text-ddc-text-muted">
            Чат с ассистентом недоступен на этой странице. Окружение и сессию можно создать в разделах «Окружения» и «Сессии»
          </p>
        )}

        <aside className="flex min-w-0 flex-col gap-4">
          <section aria-label="Ход" className="rounded-xl border border-ddc-border bg-ddc-surface p-3">
            <h2 className="mb-2 text-sm font-semibold text-ddc-heading">Ход</h2>
            <StepList steps={steps} />
          </section>

          <section aria-label="Ресурсы" className="rounded-xl border border-ddc-border bg-ddc-surface p-3">
            <h2 className="mb-2 text-sm font-semibold text-ddc-heading">Ресурсы</h2>
            <ul className="flex flex-col gap-1 text-sm">
              <li>
                <span className="text-ddc-text-muted">Агент: </span>
                <Link to={`/agents/${encodeURIComponent(agent.id)}`} className="text-ddc-link hover:underline">
                  {agent.name}
                </Link>
              </li>
              {resources.environment ? (
                <li>
                  <span className="text-ddc-text-muted">Окружение: </span>
                  <Link to={`/environments/${encodeURIComponent(resources.environment.id)}`} className="text-ddc-link hover:underline">
                    {resources.environment.name}
                  </Link>
                </li>
              ) : null}
              {resources.session ? (
                <li>
                  <span className="text-ddc-text-muted">Сессия: </span>
                  <Link to={`/sessions/${encodeURIComponent(resources.session.id)}`} className="text-ddc-link hover:underline">
                    {resources.session.name}
                  </Link>
                </li>
              ) : null}
            </ul>
          </section>

          <div className="flex flex-col gap-2">
            {startError ? (
              <p role="alert" className="text-xs font-medium text-ddc-danger-text">
                {startError}
              </p>
            ) : null}
            <Button
              type="button"
              disabled={!resources.environment || starting}
              loading={starting}
              title={resources.environment ? undefined : "Сначала нужно окружение"}
              onClick={() => void startSession()}
            >
              Начать тестовую сессию
            </Button>
            <Button type="button" variant="outline" onClick={() => setExportOpen(true)}>
              Экспорт кодом
            </Button>
          </div>
        </aside>
      </div>

      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Экспорт кодом"
        maxWidth="max-w-2xl"
        footer={
          <Button type="button" variant="outline" onClick={() => void copySnippet()}>
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            Копировать
          </Button>
        }
      >
        <pre className="max-h-80 overflow-auto rounded-xl bg-ddc-surface-sunken p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-ddc-text">
          {snippet}
        </pre>
      </Modal>
    </Page>
  );
}
