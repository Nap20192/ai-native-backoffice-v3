import { ArrowUpIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { ApiError } from "../../../lib/api";
import {
  createAssistantSession,
  fetchSettings,
  findBuilder,
  sendAssistantMessage,
  useAssistantApi,
  type BuilderRef,
} from "../../../lib/assistant/api";
import { buildThread, sessionActivity, useAssistantEvents } from "../../../lib/assistant/events";
import { fetchModelChoices, installBuilder, type ModelChoice } from "../../../lib/assistant/install";
import { buildPageContext, withPageContext } from "../../../lib/assistant/page-context";
import { useAuth } from "../../../lib/auth";
import { useOptionalAssistant } from "../AssistantProvider";
import { AssistantThread } from "../AssistantThread";
import { InstallPrompt } from "../InstallPrompt";
import { ConfigPreviewPanel } from "./ConfigPreviewPanel";
import { useDescribeState, validateDraft } from "./describe-state";
import { Label } from "@/components/ui/label";

/**
 * «Описать агента» (раздел 1.3 плана). Поле с описанием и «Сгенерировать», затем
 * две колонки: слева чат с ассистентом в наборе «черновик», справа панель
 * «Конфигурация агента». Ассистент ничего не пишет в платформу. Агента создаёт
 * эта страница обычным `POST /v1/agents` по клику с YAML панели.
 */

export interface DescribeAgentProps {
  initialPrompt?: string;
  /** Начать сразу с `initialPrompt`, не дожидаясь кнопки (быстрый старт). */
  autoStart?: boolean;
  onCancel?: () => void;
  /** Вместо перехода на страницу агента. Панель ассистента тогда не открывается. */
  onCreated?: (agent: { id: string; name: string }) => void;
  className?: string;
}

type Phase = "start" | "checking" | "install" | "disabled" | "error" | "work";

const PLACEHOLDER =
  "Например: агент, который раз в день собирает новые заявки из файла и пишет сводку";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function DescribeAgent({
  initialPrompt = "",
  autoStart = false,
  onCancel,
  onCreated,
  className,
}: DescribeAgentProps) {
  const api = useAssistantApi();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const assistant = useOptionalAssistant();
  const userId = user?.id ?? null;

  const [prompt, setPrompt] = useState(initialPrompt);
  const [phase, setPhase] = useState<Phase>("start");
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingFirst, setPendingFirst] = useState<{ sessionId: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const builderRef = useRef<BuilderRef | null>(null);
  const startedRef = useRef(false);

  const { events, addOptimistic, dropOptimistic } = useAssistantEvents(sessionId);
  const thread = useMemo(() => buildThread(events), [events]);
  const running = sending || sessionActivity(events) === "running";
  const [state, dispatch] = useDescribeState(events);
  const validation = useMemo(() => validateDraft(state), [state]);

  // Черновик уходит и на Ctrl I: панель ассистента тоже его видит.
  const setDraftYaml = assistant?.setDraftYaml;
  useEffect(() => {
    setDraftYaml?.(state.yaml);
  }, [setDraftYaml, state.yaml]);
  useEffect(() => () => setDraftYaml?.(null), [setDraftYaml]);

  /* ---------- Разговор ---------- */

  const withContext = useCallback(
    (text: string) =>
      withPageContext(text, buildPageContext({ pathname: location.pathname, search: location.search }, { draftYaml: state.yaml })),
    [location.pathname, location.search, state.yaml],
  );

  const deliver = useCallback(
    async (sid: string, full: string) => {
      setSending(true);
      const localId = addOptimistic(full);
      try {
        await sendAssistantMessage(api, sid, full);
      } catch {
        dropOptimistic(localId);
        setSendError("Не удалось отправить сообщение. Повторите");
      } finally {
        setSending(false);
      }
    },
    [api, addOptimistic, dropOptimistic],
  );

  // Первое сообщение уходит после того, как лента переключилась на новую сессию:
  // иначе её сброс стёр бы показанную сразу реплику.
  useEffect(() => {
    if (!pendingFirst || pendingFirst.sessionId !== sessionId) return;
    const job = pendingFirst;
    setPendingFirst(null);
    void deliver(job.sessionId, job.text);
  }, [pendingFirst, sessionId, deliver]);

  const launch = useCallback(
    async (builder: BuilderRef, text: string) => {
      const id = await createAssistantSession(api, { builder, userId, mode: "draft", title: "Описание агента" });
      setSessionId(id);
      setPendingFirst({ sessionId: id, text: withContext(text) });
      setPhase("work");
    },
    [api, userId, withContext],
  );

  const begin = useCallback(
    async (text: string) => {
      setPhase("checking");
      try {
        const [settings, builder, loadedModels] = await Promise.all([
          fetchSettings(api),
          findBuilder(api),
          fetchModelChoices(api).catch(() => [] as ModelChoice[]),
        ]);
        setModels(loadedModels);
        if (!settings.enabled) {
          setPhase("disabled");
          return;
        }
        if (!builder) {
          setPhase("install");
          return;
        }
        builderRef.current = builder;
        await launch(builder, text);
      } catch {
        setPhase("error");
      }
    },
    [api, launch],
  );

  useEffect(() => {
    if (autoStart && initialPrompt.trim() && !startedRef.current) {
      startedRef.current = true;
      void begin(initialPrompt.trim());
    }
  }, [autoStart, initialPrompt, begin]);

  async function install(model: string | null) {
    setInstalling(true);
    setInstallError(null);
    try {
      const builder = await installBuilder(api, { model });
      builderRef.current = builder;
      await launch(builder, prompt.trim());
    } catch (err) {
      setInstallError(errorText(err, "Не удалось установить ассистента"));
    } finally {
      setInstalling(false);
    }
  }

  async function submitMessage() {
    const value = message.trim();
    if (!value || !sessionId || sending) return;
    setMessage("");
    setSendError(null);
    await deliver(sessionId, withContext(value));
  }

  function onMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitMessage();
    }
  }

  /* ---------- Создание агента ---------- */

  async function createAgent() {
    if (!validation.ok || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = (await api("/v1/agents", {
        method: "POST",
        body: JSON.stringify(validation.payload),
        quiet: true,
      })) as { id?: unknown; name?: unknown } | null;
      const id = typeof created?.id === "string" ? created.id : null;
      if (!id) throw new Error("Сервер не вернул id агента");
      const name = typeof created?.name === "string" ? created.name : String(validation.payload.name ?? "");
      if (onCreated) {
        onCreated({ id, name });
      } else {
        navigate(`/agents/${encodeURIComponent(id)}`);
        // Разговор продолжается в панели Ctrl I с контекстом нового агента.
        assistant?.newConversation();
        assistant?.setOpen(true);
      }
    } catch (err) {
      const detail = err instanceof ApiError || err instanceof Error ? ` ${err.message}` : "";
      setCreateError(`Не удалось создать агента.${detail}`.trim());
    } finally {
      setCreating(false);
    }
  }

  function cancel() {
    if (onCancel) onCancel();
    else navigate("/agents");
  }

  /* ---------- Вид ---------- */

  if (phase === "work" && sessionId) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-4", className)}>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
          <section aria-label="Чат с ассистентом" className="flex min-h-[420px] min-w-0 flex-col rounded-xl border border-ddc-border bg-ddc-surface">
            <div className="max-h-[60dvh] min-h-0 flex-1 overflow-y-auto">
              <AssistantThread items={thread} sessionId={sessionId} running={running} />
            </div>
            <div className="flex flex-col gap-1.5 border-t border-ddc-border px-3 py-2">
              {sendError ? (
                <p className="text-xs font-medium text-ddc-danger-text" role="alert">
                  {sendError}
                </p>
              ) : null}
              <div className="flex items-end gap-2">
                <Textarea
                  rows={2}
                  aria-label="Сообщение ассистенту"
                  placeholder="Ответьте или попросите что-нибудь поправить"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={onMessageKeyDown}
                  className="min-h-10 flex-1"
                />
                <Button
                  type="button"
                  size="icon-sm"
                  aria-label="Отправить"
                  title="Отправить"
                  disabled={sending || !message.trim()}
                  onClick={() => void submitMessage()}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
              </div>
            </div>
          </section>

          <ConfigPreviewPanel
            state={state}
            error={validation.ok ? null : validation.error}
            onEdit={(text) => dispatch({ type: "edit", text })}
            onField={(key, value) => dispatch({ type: "field", key, value })}
            onFormat={(format) => dispatch({ type: "format", format })}
            disabled={creating}
          />
        </div>

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t border-ddc-border bg-ddc-surface px-1 py-3">
          {createError ? (
            <p className="mr-auto text-xs font-medium text-ddc-danger-text" role="alert">
              {createError}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={cancel} disabled={creating}>
            Отмена
          </Button>
          <Button
            type="button"
            disabled={!validation.ok || creating}
            loading={creating}
            title={validation.ok ? undefined : validation.error}
            onClick={() => void createAgent()}
          >
            Создать агента
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "install") {
    return (
      <div className={cn("max-w-[768px]", className)}>
        <InstallPrompt models={models} busy={installing} error={installError} onInstall={(m) => void install(m)} />
      </div>
    );
  }

  if (phase === "disabled") {
    return (
      <p className={cn("max-w-[768px] text-sm text-ddc-text-muted", className)}>
        Ассистент выключен. Включить его может владелец или администратор пространства
      </p>
    );
  }

  if (phase === "error") {
    return (
      <div className={cn("flex max-w-[768px] flex-col items-start gap-3", className)}>
        <p className="text-sm text-ddc-danger-text">Не удалось загрузить ассистента</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void begin(prompt.trim())}>
          Повторить
        </Button>
      </div>
    );
  }

  const empty = !prompt.trim();
  const busy = phase === "checking";
  return (
    <section className={cn("flex max-w-[768px] flex-col gap-3", className)}>
      <Label htmlFor="describe-prompt" className="flex items-center gap-1.5 text-sm font-medium text-ddc-heading">
        <SparklesIcon aria-hidden="true" className="size-4 text-(--assistant-accent)" />
        Опишите, что должен делать агент
      </Label>
      <Textarea
        id="describe-prompt"
        aria-label="Опишите, что должен делать агент"
        rows={5}
        placeholder={PLACEHOLDER}
        value={prompt}
        disabled={busy}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div>
        <Button
          type="button"
          variant={empty ? "secondary" : "default"}
          disabled={empty || busy}
          loading={busy}
          onClick={() => void begin(prompt.trim())}
        >
          Сгенерировать
        </Button>
      </div>
    </section>
  );
}
