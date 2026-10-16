import { useCallback, useEffect, useRef, useState } from "react";
import { dump } from "js-yaml";
import { CheckIcon, CopyIcon, SparklesIcon } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { useOptionalAssistant } from "../../components/assistant/AssistantProvider";
import { Modal } from "../../components/Modal";
import { useAssistantApi, type BuilderRef } from "../../lib/assistant/api";
import {
  fetchBuilderBundle,
  fetchModelChoices,
  installBuilder,
  type BuilderBundleInfo,
  type ModelChoice,
} from "../../lib/assistant/install";
import { BUILDER_TEMPLATE } from "../../data/templates";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Диалог шаблона «Конструктор» (раздел 1.5 плана builder-agent): описание,
 * «Что умеет» по группам инструментов, «MCP-серверы», конфигурация агента в
 * YAML с «Копировать» и предупреждение о составе. «Использовать шаблон» ставит
 * окружение «Ассистент» и агента обычным API от имени пользователя. Тело агента
 * и группы инструментов приходят с сервера, консоль их не придумывает.
 */

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function mcpServers(agent: Record<string, unknown>): Array<{ name: string; url: string }> {
  const list = Array.isArray(agent.mcp_servers) ? agent.mcp_servers : [];
  const out: Array<{ name: string; url: string }> = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name === "string") out.push({ name: r.name, url: typeof r.url === "string" ? r.url : "" });
  }
  return out;
}

export function BuilderTemplateDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean;
  onClose: () => void;
  /** Вместо перехода на страницу нового агента. */
  onInstalled?: (ref: BuilderRef) => void;
}) {
  const api = useAssistantApi();
  const navigate = useNavigate();
  const assistant = useOptionalAssistant();
  const reloadAssistant = assistant?.reload;

  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [bundle, setBundle] = useState<BuilderBundleInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const modelsLoaded = useRef(false);

  // Модели грузим один раз за открытие, первую выбираем сами.
  useEffect(() => {
    if (!open) {
      modelsLoaded.current = false;
      return;
    }
    if (modelsLoaded.current) return;
    modelsLoaded.current = true;
    setInstallError(null);
    let cancelled = false;
    fetchModelChoices(api)
      .catch(() => [] as ModelChoice[])
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setModel((current) => current ?? list[0]?.id ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  // Комплект зависит от выбранной модели: из него строится YAML.
  useEffect(() => {
    if (!open || models === null) return;
    let cancelled = false;
    setLoadError(null);
    fetchBuilderBundle(api, model)
      .then((info) => {
        if (!cancelled) setBundle(info);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorText(err, "Не удалось загрузить шаблон"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, api, model, models, attempt]);

  const yaml = bundle ? dump(bundle.agent, { lineWidth: -1, noRefs: true }) : "";
  const noModels = models !== null && models.length === 0;
  const canInstall = !installing && bundle !== null && !loadError && model !== null && !bundle.needsModel;

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Не удалось скопировать");
    }
  }, [yaml]);

  async function install() {
    if (!canInstall) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const ref = await installBuilder(api, { model });
      toast.success("Шаблон «Конструктор» установлен");
      reloadAssistant?.();
      onClose();
      if (onInstalled) onInstalled(ref);
      else navigate(`/agents/${encodeURIComponent(ref.agent.id)}`);
    } catch (err) {
      setInstallError(errorText(err, "Не удалось установить шаблон"));
    } finally {
      setInstalling(false);
    }
  }

  const servers = bundle ? mcpServers(bundle.agent) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={BUILDER_TEMPLATE.name}
      maxWidth="max-w-2xl"
      closeDisabled={installing}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={installing}>
            Отмена
          </Button>
          <Button type="button" onClick={() => void install()} disabled={!canInstall} loading={installing}>
            Использовать шаблон
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Badge variant="info" className="w-fit">
            <SparklesIcon aria-hidden="true" />
            {BUILDER_TEMPLATE.badge}
          </Badge>
          <p className="text-sm text-ddc-text">{BUILDER_TEMPLATE.description}</p>
        </div>

        <section className="flex flex-col gap-1.5">
          <Label htmlFor="builder-model-select" className="text-xs font-medium text-ddc-label">
            Модель
          </Label>
          {noModels ? (
            <p className="text-sm text-ddc-warning-text">
              Нет карточек моделей. Создайте карточку на странице «Карточки моделей», потом вернитесь к шаблону
            </p>
          ) : (
            <NativeSelect
              id="builder-model-select"
              value={model ?? ""}
              disabled={models === null || installing}
              onChange={(event) => setModel(event.target.value || null)}
              className="h-10 max-w-sm rounded-xl border border-ddc-border-strong bg-ddc-outline-bg px-3 text-sm text-ddc-text"
            >
              {(models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </section>

        {loadError ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm font-medium text-ddc-danger-text">
              Не удалось загрузить шаблон. {loadError}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </Button>
          </div>
        ) : null}

        {bundle ? (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-ddc-heading">Что умеет</h3>
              <ul className="flex flex-col gap-2">
                {bundle.toolGroups.map((group) => (
                  <li key={group.id} className="rounded-xl border border-ddc-border p-3">
                    <p className="text-sm font-medium text-ddc-heading">{group.title}</p>
                    <p className="mt-0.5 text-xs text-ddc-text-muted">
                      {group.confirm ? "Эти инструменты спрашивают подтверждение у человека" : "Работают без подтверждения"}
                    </p>
                    <p className="mt-1 font-mono text-xs break-words text-ddc-text">{group.tools.join(", ")}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-ddc-heading">MCP-серверы</h3>
              <ul className="flex flex-col gap-1">
                {servers.map((server) => (
                  <li key={server.name} className="text-sm text-ddc-text">
                    <span className="font-mono">{server.name}</span>
                    {server.url ? <span className="ml-2 text-xs break-all text-ddc-text-muted">{server.url}</span> : null}
                  </li>
                ))}
              </ul>
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ddc-heading">Конфигурация агента</h3>
                <Button type="button" size="xs" variant="outline" onClick={() => void copy()}>
                  {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                  Копировать
                </Button>
              </div>
              <pre
                aria-label="Конфигурация агента"
                tabIndex={0}
                className="max-h-64 overflow-auto rounded-xl bg-ddc-surface-sunken p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-ddc-text"
              >
                {yaml}
              </pre>
              <p className="text-xs text-ddc-text-muted">
                Если добавить агенту встроенные инструменты, другой MCP-сервер или навык, сервер не будет обслуживать такие сессии.
                Чтобы сделать своего ассистента, меняйте имя, модель и набор инструментов платформы.
              </p>
            </section>
          </>
        ) : loadError || noModels ? null : (
          <p className="text-sm text-ddc-text-muted" role="status">
            Загружаю шаблон
          </p>
        )}

        {installError ? (
          <p role="alert" className="text-sm font-medium text-ddc-danger-text">
            {installError}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
