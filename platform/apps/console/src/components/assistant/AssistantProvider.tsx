import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";

import "../../styles/assistant.css";
import { getActiveTenantId } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  createAssistantSession,
  fetchChatHistory,
  fetchSettings,
  findBuilder,
  saveSettings,
  sendAssistantMessage,
  useAssistantApi,
  type AssistantSettings,
  type BuilderRef,
  type ChatSummary,
} from "../../lib/assistant/api";
import {
  buildThread,
  sessionActivity,
  useAssistantEvents,
  type ThreadItem,
} from "../../lib/assistant/events";
import { fetchModelChoices, installBuilder, type ModelChoice } from "../../lib/assistant/install";
import { useInvalidateOnApplied } from "../../lib/assistant/invalidate";
import {
  buildPageContext,
  withPageContext,
  type PageContext,
} from "../../lib/assistant/page-context";
import { versionChange } from "./VersionNotice";
import { useAssistantShortcut } from "./use-assistant-shortcut";

/**
 * Состояние ассистента на всю консоль: открыта ли панель, установлен ли
 * ассистент, выключатель, текущий разговор и его лента. Провайдер стоит внутри
 * маршрутизатора, потому что контекст страницы берётся из адреса (раздел 1.2
 * плана). Пока панель ни разу не открыта, провайдер в сеть не ходит.
 */

export type AssistantStatus = "idle" | "loading" | "error" | "not_installed" | "disabled" | "ready";

export interface AssistantValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Открывает панель и отправляет текст, как только ассистент готов. */
  openWith: (prompt?: string) => void;

  status: AssistantStatus;
  reload: () => void;
  settings: AssistantSettings | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  builder: BuilderRef | null;
  models: ModelChoice[];
  install: (model: string | null) => Promise<void>;
  installing: boolean;
  installError: string | null;

  sessionId: string | null;
  thread: ThreadItem[];
  running: boolean;
  sending: boolean;
  sendError: string | null;
  send: (text: string) => Promise<void>;
  newConversation: () => void;
  history: ChatSummary[];
  historyLoading: boolean;
  loadHistory: () => void;
  openChat: (sessionId: string) => void;

  model: string | null;
  setModel: (model: string | null) => void;

  pageContext: PageContext;
  contextEnabled: boolean;
  removeContext: () => void;
  /** Черновик YAML с правой панели «Описать агента»: уходит в контексте. */
  setDraftYaml: (yaml: string | null) => void;

  versionNotice: { from: number; to: number } | null;
  dismissVersionNotice: () => void;
}

const AssistantContext = createContext<AssistantValue | null>(null);

export function useAssistant(): AssistantValue {
  const value = useContext(AssistantContext);
  if (!value) throw new Error("useAssistant вызван вне AssistantProvider");
  return value;
}

/** Для кнопок, которые могут стоять и вне провайдера (тесты, отдельные страницы). */
export function useOptionalAssistant(): AssistantValue | null {
  return useContext(AssistantContext);
}

/* ---------- Локальное хранилище: только удобство, всё работает и без него ---------- */

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* хранилище недоступно: разговор просто не восстановится */
  }
}
const chatKey = () => `oma_assistant_chat:${getActiveTenantId() ?? "default"}`;
const seenKey = (agentId: string) => `oma_assistant_seen_version:${agentId}`;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const api = useAssistantApi();
  const { user } = useAuth();
  const location = useLocation();
  const userId = user?.id ?? null;

  const [open, setOpenState] = useState(false);
  const booted = useRef(false);
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [builder, setBuilder] = useState<BuilderRef | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [draftYaml, setDraftYaml] = useState<string | null>(null);
  const [contextEnabled, setContextEnabled] = useState(true);
  const [versionNotice, setVersionNotice] = useState<{ from: number; to: number } | null>(null);
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const [pendingFirst, setPendingFirst] = useState<{ sessionId: string; text: string } | null>(null);

  const { events, addOptimistic, dropOptimistic } = useAssistantEvents(sessionId);
  const thread = useMemo(() => buildThread(events), [events]);
  const activity = useMemo(() => sessionActivity(events), [events]);
  // Созданный ассистентом объект сразу виден в открытых списках консоли.
  useInvalidateOnApplied(thread);

  /* ---------- Контекст страницы ---------- */

  const pageContext = useMemo(
    () => buildPageContext({ pathname: location.pathname, search: location.search }, { draftYaml }),
    [location.pathname, location.search, draftYaml],
  );
  useEffect(() => {
    setContextEnabled(true);
  }, [location.pathname]);
  const removeContext = useCallback(() => setContextEnabled(false), []);

  /* ---------- Загрузка: настройки, ассистент, модели ---------- */

  const boot = useCallback(async () => {
    setStatus("loading");
    try {
      const [loadedSettings, loadedBuilder, loadedModels] = await Promise.all([
        fetchSettings(api),
        findBuilder(api),
        fetchModelChoices(api).catch(() => [] as ModelChoice[]),
      ]);
      setSettings(loadedSettings);
      setBuilder(loadedBuilder);
      setModels(loadedModels);
      if (loadedBuilder) {
        const seen = readStore(seenKey(loadedBuilder.agent.id));
        setVersionNotice(versionChange(seen === null ? null : Number(seen), loadedBuilder.agent.version));
        if (seen === null) writeStore(seenKey(loadedBuilder.agent.id), String(loadedBuilder.agent.version));
        const saved = readStore(chatKey());
        if (saved) setSessionId((current) => current ?? saved);
      }
      setStatus(!loadedBuilder ? "not_installed" : loadedSettings.enabled ? "ready" : "disabled");
    } catch {
      setStatus("error");
    }
  }, [api]);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (next && !booted.current) {
        booted.current = true;
        void boot();
      }
    },
    [boot],
  );
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  useAssistantShortcut(toggle);

  const reload = useCallback(() => {
    void boot();
  }, [boot]);

  /* ---------- Установка и выключатель ---------- */

  const install = useCallback(
    async (chosen: string | null) => {
      setInstalling(true);
      setInstallError(null);
      try {
        const ref = await installBuilder(api, { model: chosen });
        setBuilder(ref);
        writeStore(seenKey(ref.agent.id), String(ref.agent.version));
        setStatus(settings?.enabled === false ? "disabled" : "ready");
      } catch (err) {
        setInstallError(errorText(err, "Не удалось установить ассистента"));
      } finally {
        setInstalling(false);
      }
    },
    [api, settings],
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const next = await saveSettings(api, enabled);
      setSettings(next);
      setStatus((current) => (current === "ready" || current === "disabled" ? (next.enabled ? "ready" : "disabled") : current));
    },
    [api],
  );

  /* ---------- Разговор ---------- */

  const deliver = useCallback(
    async (sid: string, fullText: string) => {
      setSending(true);
      const localId = addOptimistic(fullText);
      try {
        await sendAssistantMessage(api, sid, fullText);
      } catch {
        dropOptimistic(localId);
        setSendError("Не удалось отправить сообщение. Повторите");
      } finally {
        setSending(false);
      }
    },
    [api, addOptimistic, dropOptimistic],
  );

  // Первое сообщение нового разговора уходит после того, как лента переключилась
  // на новую сессию: иначе её сброс стёр бы показанную сразу реплику.
  useEffect(() => {
    if (!pendingFirst || pendingFirst.sessionId !== sessionId) return;
    const job = pendingFirst;
    setPendingFirst(null);
    void deliver(job.sessionId, job.text);
  }, [pendingFirst, sessionId, deliver]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !builder || sending) return;
      const full = withPageContext(trimmed, contextEnabled ? pageContext : null);
      setSendError(null);
      if (sessionId) {
        await deliver(sessionId, full);
        return;
      }
      setSending(true);
      try {
        const created = await createAssistantSession(api, { builder, userId, model });
        writeStore(seenKey(builder.agent.id), String(builder.agent.version));
        writeStore(chatKey(), created);
        setVersionNotice(null);
        setSessionId(created);
        setPendingFirst({ sessionId: created, text: full });
      } catch {
        setSendError("Не удалось начать разговор. Повторите");
        setSending(false);
      }
    },
    [api, builder, contextEnabled, deliver, model, pageContext, sending, sessionId, userId],
  );

  const openWith = useCallback(
    (prompt?: string) => {
      setOpen(true);
      if (prompt) setQueuedPrompt(prompt);
    },
    [setOpen],
  );
  useEffect(() => {
    if (queuedPrompt && status === "ready" && builder) {
      const prompt = queuedPrompt;
      setQueuedPrompt(null);
      void send(prompt);
    }
  }, [queuedPrompt, status, builder, send]);

  const newConversation = useCallback(() => {
    setSessionId(null);
    setSendError(null);
    setPendingFirst(null);
    writeStore(chatKey(), null);
  }, []);

  const openChat = useCallback((sid: string) => {
    setSessionId(sid);
    setSendError(null);
    writeStore(chatKey(), sid);
  }, []);

  const loadHistory = useCallback(() => {
    if (!builder) return;
    setHistoryLoading(true);
    fetchChatHistory(api, { agentId: builder.agent.id, userId })
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [api, builder, userId]);

  const dismissVersionNotice = useCallback(() => {
    if (builder) writeStore(seenKey(builder.agent.id), String(builder.agent.version));
    setVersionNotice(null);
  }, [builder]);

  const value = useMemo<AssistantValue>(
    () => ({
      open,
      setOpen,
      toggle,
      openWith,
      status,
      reload,
      settings,
      setEnabled,
      builder,
      models,
      install,
      installing,
      installError,
      sessionId,
      thread,
      running: sending || activity === "running",
      sending,
      sendError,
      send,
      newConversation,
      history,
      historyLoading,
      loadHistory,
      openChat,
      model,
      setModel,
      pageContext,
      contextEnabled,
      removeContext,
      setDraftYaml,
      versionNotice,
      dismissVersionNotice,
    }),
    [
      open, setOpen, toggle, openWith, status, reload, settings, setEnabled, builder, models, install,
      installing, installError, sessionId, thread, sending, activity, sendError, send, newConversation,
      history, historyLoading, loadHistory, openChat, model, pageContext, contextEnabled, removeContext,
      versionNotice, dismissVersionNotice,
    ],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}
