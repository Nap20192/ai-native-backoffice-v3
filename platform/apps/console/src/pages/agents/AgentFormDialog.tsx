import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  PlusIcon,
  SearchIcon,
  SearchXIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import yaml from "js-yaml";
import type {
  AgentCreateParams,
  AgentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { useManagedApi } from "../../lib/useManagedApi";
import { Combobox } from "../../components/Combobox";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import { McpServerPickerModal } from "../../components/McpServerPickerModal";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { AGENT_TEMPLATES, tagLabel, type AgentTemplate } from "../../data/templates";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../../types/agent";
import { useI18n } from "../../i18n";
import {
  INITIAL_FORM,
  agentToForm,
  agentToPreservedConfig,
  configToForm,
  materializeAgentUpdate,
  mergeFormIntoConfig,
  parseAgentConfigText,
  prepareCodePayload,
  type FormState,
  type McpEntry,
  type SkillEntry,
  type ToolOverride,
} from "./agentFormCodec";

const ANTHROPIC_SKILLS = [
  { id: "xlsx", label: "Excel (xlsx)" },
  { id: "pdf", label: "PDF" },
  { id: "pptx", label: "PowerPoint (pptx)" },
  { id: "docx", label: "Word (docx)" },
];

// Имена встроенных инструментов AMA должны совпадать с enum
// `BetaManagedAgentsAgentToolConfig.name` в SDK. Источник правды это набор
// agent_toolset_20260401: неизвестное имя прошло бы проверку API, но
// рантайм такой инструмент не подключит.
const BUILTIN_TOOLS: Array<{ name: string; label: string; description: string }> = [
  { name: "bash", label: "bash", description: "Выполнение команд оболочки в песочнице" },
  { name: "edit", label: "edit", description: "Правка файлов на месте" },
  { name: "read", label: "read", description: "Чтение файлов из файловой системы песочницы" },
  { name: "write", label: "write", description: "Создание и перезапись файлов" },
  { name: "glob", label: "glob", description: "Поиск файлов по шаблону пути" },
  { name: "grep", label: "grep", description: "Поиск по содержимому файлов" },
  { name: "web_fetch", label: "web_fetch", description: "Загрузка страницы по URL в markdown. Основной способ читать из веба." },
  { name: "web_search", label: "web_search", description: "Веб-поиск через DuckDuckGo. Основной способ искать в вебе." },
  { name: "browser", label: "browser (по запросу)", description: "Тяжёлый многошаговый сеанс браузера: переходы, клики, скриншоты. По умолчанию выключен, потому что модели часто тянутся к нему в простых запросах. Включайте, только если нужна интерактивная навигация, страницы на JS или вход в аккаунт." },
];

/** Названия режимов разрешения для людей. Значения для API остаются прежними. */
const PERMISSION_LABEL: Record<string, string> = {
  always_allow: "Всегда разрешать",
  always_ask: "Всегда спрашивать",
  disabled: "Отключён",
};

const TABS = [
  { id: "basic", label: "Основное" },
  { id: "tools", label: "Инструменты" },
  { id: "skills", label: "Навыки" },
  { id: "mcp", label: "MCP-серверы" },
  { id: "agents", label: "Мультиагентность" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Подпись поля `.label` портала DDC: 12px, medium, отступ 6px. */
const LABEL_CLS = "mb-1.5 block text-xs leading-4 font-medium text-ddc-label";

interface AgentFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after the agent is created successfully. Parent uses this
   *  to refresh the list. The dialog handles its own navigation to the
   *  new agent's detail page. */
  onCreated?: () => void;
  /** Called after a successful update in edit mode. Parent refreshes
   *  detail/list caches; the dialog closes itself and stays on the
   *  current route. */
  onUpdated?: (agent: Agent) => void;
  /** When set, the dialog opens in edit mode: skips the template step,
   *  prefills from this agent, and POSTs `/v1/agents/:id` on save. */
  agent?: Agent | null;
  /** Data sets the form's pickers pull from. The parent fetches these
   *  on mount (loadAux) and passes them down so the dialog doesn't have
   *  to re-fetch on every open. */
  allAgents: Agent[];
  customSkills: Array<{ id: string; name: string; description: string }>;
  modelCards: ModelCard[];
}

/**
 * Окно создания и изменения агента. Собрано на `Modal` (правило 11 DDC):
 * ловушка фокуса, Escape, блокировка прокрутки и возврат фокуса приходят от
 * него. При создании два шага (шаблон, затем форма), у формы три режима
 * правки (форма, YAML, JSON). При изменении шаг с шаблоном пропускается, поля
 * заполняются из `agent`. Всё своё состояние окно держит у себя: родителю
 * достаточно смонтировать его и передать списки для выпадающих полей.
 */
export function AgentFormDialog({
  open,
  onClose,
  onCreated,
  onUpdated,
  agent: editingAgent,
  allAgents,
  customSkills,
  modelCards,
}: AgentFormDialogProps) {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const isEdit = !!editingAgent;

  const [createError, setCreateError] = useState("");
  const [createStep, setCreateStep] = useState<"template" | "form">("template");
  const [templateSearch, setTemplateSearch] = useState("");
  const [form, setForm] = useState({ ...INITIAL_FORM });
  /** Full config baseline for lossless Form↔code merges on edit. */
  const [preservedConfig, setPreservedConfig] = useState<Record<string, unknown> | null>(
    null,
  );
  const [tab, setTab] = useState<TabId>("basic");
  const [createMode, setCreateMode] = useState<"form" | "yaml" | "json">("form");
  const [codeValue, setCodeValue] = useState("");
  const [showMcpPicker, setShowMcpPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const errorRef = useRef<HTMLDivElement>(null);

  // Prefill when opening in edit mode (or when the agent version changes
  // after a concurrent refresh). Create mode starts at the template step.
  useEffect(() => {
    if (!open) return;
    if (editingAgent) {
      setForm(agentToForm(editingAgent));
      setPreservedConfig(agentToPreservedConfig(editingAgent));
      setCreateStep("form");
      setTab("basic");
      setCreateMode("form");
      setCreateError("");
      setCodeValue("");
      setSaving(false);
    } else {
      setPreservedConfig(null);
    }
  }, [open, editingAgent?.id, editingAgent?.version]);

  // Pre-select default model card when entering the form step. (tenant_id,
  // model_id) is UNIQUE in DB, so picking a card uniquely determines the
  // model. Skip if user/paste already set model. Re-runs when modelCards
  // arrives if the dialog opened before the aux fetch.
  useEffect(() => {
    if (createStep !== "form") return;
    if (form.modelCardId || form.model) return;
    if (modelCards.length === 0) return;
    const def = modelCards.find((mc) => mc.is_default) ?? modelCards[0];
    setForm((f) => ({ ...f, modelCardId: def.id, model: def.model_id }));
    // Intentionally not depending on form.* — guards above prevent the
    // re-trigger loop and we only want to hydrate on step entry / cards arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createStep, modelCards.length]);

  // Ошибка сохранения может появиться, пока форма прокручена вниз: подводим
  // её в поле зрения.
  useEffect(() => {
    if (createError) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [createError]);

  const closeCreate = () => {
    setCreateStep("template");
    setTemplateSearch("");
    setForm({ ...INITIAL_FORM });
    setPreservedConfig(null);
    setTab("basic");
    setCreateError("");
    setCreateMode("form");
    setCodeValue("");
    setSaving(false);
    onClose();
  };

  const persistAgent = async (payload: Record<string, unknown>): Promise<Agent> => {
    if (isEdit && editingAgent) {
      const updated = await managedApi.agents.update(editingAgent.id, {
        ...payload,
        version: editingAgent.version,
      } as AgentUpdateParams);
      return updated as unknown as Agent;
    }

    const created = await managedApi.agents.create(
      payload as unknown as AgentCreateParams,
    );
    return created as unknown as Agent;
  };

  const create = async () => {
    setCreateError("");
    setSaving(true);
    try {
      const payload = mergeFormIntoConfig(form, preservedConfig, { forUpdate: isEdit });
      if (isEdit && editingAgent) {
        const updated = await persistAgent(payload);
        closeCreate();
        onUpdated?.(updated);
      } else {
        const agent = await persistAgent(payload);
        closeCreate();
        onCreated?.();
        nav(`/agents/${agent.id}`);
      }
    } catch (e: any) {
      setCreateError(
        e?.message || (isEdit ? "Не удалось обновить агента" : "Не удалось создать агента"),
      );
    } finally {
      setSaving(false);
    }
  };

  const addMcp = () =>
    setForm({
      ...form,
      mcpServers: [...form.mcpServers, {
        name: "",
        type: "url",
        url: "",
        command: "",
        argsJson: "[]",
        envJson: "{}",
      }],
    });
  const addMcpFromRegistry = (entry: { id: string; name: string; url: string }) => {
    if (form.mcpServers.some((m) => m.url === entry.url)) return;
    setForm({
      ...form,
      mcpServers: [...form.mcpServers, {
        name: entry.id,
        type: "url",
        url: entry.url,
        command: "",
        argsJson: "[]",
        envJson: "{}",
      }],
    });
  };
  const updateMcp = (i: number, field: keyof McpEntry, val: string) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, mcpServers: updated });
  };
  const removeMcp = (i: number) =>
    setForm({ ...form, mcpServers: form.mcpServers.filter((_, j) => j !== i) });

  const toggleAnthropicSkill = (skillId: string) => {
    const exists = form.skills.find((s) => s.type === "anthropic" && s.skill_id === skillId);
    if (exists) {
      setForm({
        ...form,
        skills: form.skills.filter((s) => !(s.type === "anthropic" && s.skill_id === skillId)),
      });
    } else {
      setForm({
        ...form,
        skills: [...form.skills, { type: "anthropic", skill_id: skillId }],
      });
    }
  };

  const addCallable = (agentId: string) => {
    if (form.callableAgents.find((c) => c.id === agentId)) return;
    setForm({
      ...form,
      callableAgents: [...form.callableAgents, { type: "agent", id: agentId }],
    });
  };
  const removeCallable = (i: number) =>
    setForm({ ...form, callableAgents: form.callableAgents.filter((_, j) => j !== i) });

  const selectTemplate = (tmpl: AgentTemplate) => {
    if (tmpl.id === "blank") {
      setForm({ ...INITIAL_FORM });
      setPreservedConfig(null);
    } else {
      setForm({
        ...INITIAL_FORM,
        name: tmpl.name,
        model: tmpl.model,
        system: tmpl.system,
        description: tmpl.description,
        mcpServers: tmpl.mcpServers.map((m) => ({
          ...m,
          type: "url" as const,
          command: "",
          argsJson: "[]",
          envJson: "{}",
        })),
        skills: tmpl.skills.map((s) => ({ ...s } as SkillEntry)),
      });
      setPreservedConfig(null);
    }
    setCreateStep("form");
    setTab("basic");
  };

  // Convert current form state to a config object (lossless vs preservedConfig).
  const formToConfig = () =>
    mergeFormIntoConfig(form, preservedConfig, { forUpdate: isEdit });

  // Switch between form/yaml/json modes
  const switchMode = (mode: "form" | "yaml" | "json") => {
    if (mode === createMode) return;
    if (createMode === "form") {
      // form → code: serialize merged form + preserved unsupported fields
      const config = formToConfig();
      setCodeValue(
        mode === "yaml" ? yaml.dump(config, { lineWidth: -1 }) : JSON.stringify(config, null, 2),
      );
    } else if (mode === "form") {
      // code → form: parse into preserved baseline, then extract form fields
      try {
        const parsed = parseAgentConfigText(codeValue, createMode);
        const config = isEdit
          ? materializeAgentUpdate(preservedConfig ?? {}, parsed)
          : parsed;
        setPreservedConfig(config);
        setForm(configToForm(config));
      } catch (error) {
        setCreateError(error instanceof Error ? error.message : "Некорректная конфигурация");
        return;
      }
    } else {
      // yaml ↔ json: convert between formats
      try {
        const parsed = parseAgentConfigText(codeValue, createMode);
        setCodeValue(
          mode === "yaml"
            ? yaml.dump(parsed, { lineWidth: -1 })
            : JSON.stringify(parsed, null, 2),
        );
      } catch (error) {
        setCreateError(error instanceof Error ? error.message : "Некорректная конфигурация");
        return;
      }
    }
    setCreateError("");
    setCreateMode(mode);
  };

  // Create / update agent from code editor
  const createFromCode = async () => {
    setCreateError("");
    setSaving(true);
    try {
      const parsed = prepareCodePayload(
        parseAgentConfigText(
          codeValue,
          createMode === "yaml" ? "yaml" : "json",
        ),
        { forUpdate: isEdit },
      );
      if (isEdit && editingAgent) {
        const updated = await persistAgent(parsed);
        closeCreate();
        onUpdated?.(updated);
      } else {
        const agent = await persistAgent(parsed);
        closeCreate();
        onCreated?.();
        nav(`/agents/${agent.id}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Некорректная конфигурация";
      setCreateError(msg);
    } finally {
      setSaving(false);
    }
  };

  const needle = templateSearch.trim().toLocaleLowerCase();
  const filteredTemplates = needle
    ? AGENT_TEMPLATES.filter(
        (tmpl) =>
          tmpl.name.toLocaleLowerCase().includes(needle) ||
          tmpl.description.toLocaleLowerCase().includes(needle) ||
          tmpl.tags.some((tag) => tagLabel(tag).toLocaleLowerCase().includes(needle)),
      )
    : AGENT_TEMPLATES;

  // Resolve which card the Model dropdown should highlight: explicit pick
  // wins, otherwise derive from model_id (paste path / pre-select effect).
  // Empty string when nothing matches (e.g. paste mode with an unknown model).
  const selectedCardId =
    form.modelCardId || modelCards.find((mc) => mc.model_id === form.model)?.id || "";

  // В режиме правки шаг с шаблоном не показывается никогда, даже в первый
  // кадр до того, как эффект переведёт окно на шаг формы.
  const showTemplates = createStep === "template" && !isEdit;
  const title = isEdit ? t.agents.editAgentTitle : t.agents.newAgentTitle;
  const subtitle = showTemplates
    ? "Выберите шаблон или соберите агента с нуля."
    : isEdit
      ? t.agents.editingVersion.replace("{version}", String(editingAgent?.version ?? ""))
      : "Настройте агента в форме или опишите его в YAML или JSON.";

  const tabCounts: Record<TabId, number> = {
    basic: 0,
    tools: Object.keys(form.toolOverrides).length,
    skills: form.skills.length,
    mcp: form.mcpServers.length,
    agents: form.callableAgents.length,
  };
  const summary = [
    form.skills.length > 0 && `Навыки: ${form.skills.length}`,
    form.mcpServers.length > 0 && `MCP: ${form.mcpServers.length}`,
    form.callableAgents.length > 0 && `Агенты: ${form.callableAgents.length}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const canSubmit = createMode === "form" ? !!form.name : !!codeValue.trim();

  const footer = showTemplates ? (
    <Button variant="ghost" onClick={closeCreate}>
      {t.common.cancel}
    </Button>
  ) : (
    <>
      <span className="mr-auto min-w-0 text-xs text-ddc-text-muted tabular-nums">
        {createMode === "form" ? summary : `Редактор ${createMode.toUpperCase()}`}
      </span>
      <Button variant="ghost" onClick={closeCreate} disabled={saving}>
        {t.common.cancel}
      </Button>
      <Button
        onClick={() => void (createMode === "form" ? create() : createFromCode())}
        disabled={!canSubmit}
        loading={saving}
        loadingLabel={isEdit ? t.common.saving : t.common.creating}
      >
        {isEdit ? t.common.saveChanges : t.agents.createAgent}
      </Button>
    </>
  );

  return (
    <>
      <Modal
        open={open}
        onClose={closeCreate}
        title={title}
        subtitle={subtitle}
        maxWidth="max-w-2xl"
        closeDisabled={saving}
        footer={footer}
      >
        {/* Шаг выбора шаблона: только при создании */}
        {showTemplates && (
          <div className="space-y-4">
            <div className="relative">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ddc-placeholder"
              />
              <Input
                type="search"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                className="pl-9"
                placeholder="Поиск шаблонов…"
                aria-label="Поиск шаблонов"
                autoComplete="off"
              />
            </div>
            {filteredTemplates.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {filteredTemplates.map((tmpl) => (
                  <PlainButton
                    type="button"
                    key={tmpl.id}
                    onClick={() => selectTemplate(tmpl)}
                    className="card card-link flex flex-col items-start gap-1 p-4 text-left"
                  >
                    <span className="text-sm font-medium text-ddc-heading">{tmpl.name}</span>
                    <span className="line-clamp-2 text-xs text-ddc-text-muted">
                      {tmpl.description}
                    </span>
                    {tmpl.tags.length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {tmpl.tags.map((tag) => (
                          <Badge key={tag} variant="neutral">
                            {tagLabel(tag)}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </PlainButton>
                ))}
              </div>
            ) : (
              <EmptyState
                size="sm"
                icon={<SearchXIcon />}
                title="Шаблоны не найдены"
                body="Измените поисковый запрос."
                action={
                  <Button variant="outline" onClick={() => setTemplateSearch("")}>
                    Сбросить поиск
                  </Button>
                }
              />
            )}
          </div>
        )}

        {/* Шаг формы */}
        {!showTemplates && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {!isEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setCreateStep("template");
                    setTemplateSearch("");
                    setCreateMode("form");
                  }}
                >
                  <ArrowLeftIcon />
                  К шаблонам
                </Button>
              )}
              <div className="segmented ml-auto" role="group" aria-label="Режим правки">
                {(["form", "yaml", "json"] as const).map((m) => (
                  <PlainButton
                    type="button"
                    key={m}
                    disabled={saving}
                    aria-pressed={createMode === m}
                    onClick={() => switchMode(m)}
                    className="segmented-item"
                  >
                    {m === "form" ? "Форма" : m.toUpperCase()}
                  </PlainButton>
                ))}
              </div>
            </div>

            {createError && (
              <div ref={errorRef} role="alert" className="callout-danger">
                <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
                <span className="min-w-0 break-words">{createError}</span>
              </div>
            )}

            {/* Режим кода (YAML/JSON) */}
            {createMode !== "form" && (
              <Textarea
                value={codeValue}
                onChange={(e) => setCodeValue(e.target.value)}
                rows={18}
                className="min-h-72 resize-y font-mono text-xs leading-5"
                spellCheck={false}
                aria-label={`Конфигурация агента в формате ${createMode.toUpperCase()}`}
              />
            )}

            {/* Режим формы */}
            {createMode === "form" && (
              <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
                <TabsList aria-label="Разделы настроек агента">
                  {TABS.map(({ id, label }) => (
                    <TabsTrigger key={id} value={id}>
                      {label}
                      {tabCounts[id] > 0 && (
                        <span className="count-pill">
                          {tabCounts[id] > 99 ? "99+" : tabCounts[id]}
                        </span>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>

                <TabsContent value="basic">
                  <BasicTab
                    form={form}
                    setForm={setForm}
                    modelCards={modelCards}
                    selectedCardId={selectedCardId}
                  />
                </TabsContent>

                <TabsContent value="tools">
                  <ToolsTab form={form} setForm={setForm} />
                </TabsContent>

                <TabsContent value="skills">
                  <SkillsTab
                    form={form}
                    setForm={setForm}
                    customSkills={customSkills}
                    toggleAnthropicSkill={toggleAnthropicSkill}
                  />
                </TabsContent>

                <TabsContent value="mcp">
                  <McpTab
                    form={form}
                    onPickFromRegistry={() => setShowMcpPicker(true)}
                    addMcp={addMcp}
                    updateMcp={updateMcp}
                    removeMcp={removeMcp}
                  />
                </TabsContent>

                <TabsContent value="agents">
                  <AgentsTab
                    form={form}
                    setForm={setForm}
                    allAgents={allAgents}
                    addCallable={addCallable}
                    removeCallable={removeCallable}
                  />
                </TabsContent>
              </Tabs>
            )}
          </div>
        )}
      </Modal>

      {/* Выбор MCP-сервера: тот же реестр, что в хранилище секретов */}
      <McpServerPickerModal
        open={showMcpPicker}
        onClose={() => setShowMcpPicker(false)}
        alreadyAddedUrls={form.mcpServers.flatMap((m) =>
          m.type === "url" && m.url ? [m.url] : []
        )}
        onPick={addMcpFromRegistry}
      />
    </>
  );
}

type FormSetter = React.Dispatch<React.SetStateAction<FormState>>;

/** Поле с выпадающим выбором (Combobox): подпись и подсказка, как у `Field`,
 *  но связь с полем через группу, потому что у Combobox нет своего `id`. */
function GroupField({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId}>
      <span id={labelId} className={LABEL_CLS}>
        {label}
      </span>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-4 text-ddc-text-muted">{hint}</p>}
    </div>
  );
}

interface BasicTabProps {
  form: FormState;
  setForm: FormSetter;
  modelCards: ModelCard[];
  selectedCardId: string;
}

function BasicTab({ form, setForm, modelCards, selectedCardId }: BasicTabProps) {
  return (
    <div className="space-y-4">
      <Field
        label={
          <>
            Название
            <span aria-hidden="true" className="ml-0.5 text-ddc-danger-text">*</span>
          </>
        }
      >
        <Input
          id="agent-name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Ассистент по договорам"
          aria-required="true"
        />
      </Field>
      {/* Выбор модели: карточка однозначно задаёт модель. */}
      {modelCards.length === 0 ? (
        <div className="callout-warning">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
          <p className="min-w-0">
            Карточки моделей не настроены. Облачным агентам нужна хотя бы одна карточка с
            доступом к LLM.{" "}
            <Link to="/model-cards" className="link">
              Добавить карточку
            </Link>
          </p>
        </div>
      ) : (
        <GroupField label="Модель">
          <Combobox<ModelCard>
            value={selectedCardId}
            onValueChange={(v, item) => {
              setForm({ ...form, modelCardId: v, model: item?.model_id ?? v });
            }}
            endpoint="/v1/oma/model_cards"
            searchParam="q"
            pagination="oma"
            getValue={(mc) => mc.id}
            getLabel={(mc) => (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate" title={mc.model_id}>{mc.model_id}</span>
                {mc.model !== mc.model_id && (
                  <span className="text-ddc-text-muted">({mc.model})</span>
                )}
                {mc.is_default && <Badge variant="brand">По умолчанию</Badge>}
              </span>
            )}
            getTextLabel={(mc) =>
              `${mc.model_id}${mc.model !== mc.model_id ? ` (${mc.model})` : ""}${
                mc.is_default ? ", по умолчанию" : ""
              }`
            }
            placeholder={
              !selectedCardId && form.model
                ? `${form.model}: нет подходящей карточки, выберите другую`
                : "Выберите карточку модели…"
            }
          />
        </GroupField>
      )}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <GroupField label="Вспомогательная модель">
          <Combobox<ModelCard>
            value={
              modelCards.find((card) => card.model_id === form.auxiliaryModel)?.id ?? ""
            }
            onValueChange={(value, item) =>
              setForm({
                ...form,
                auxiliaryModel: item?.model_id ?? (value ? form.auxiliaryModel : ""),
              })
            }
            endpoint="/v1/oma/model_cards"
            searchParam="q"
            pagination="oma"
            getValue={(card) => card.id}
            getLabel={(card) => card.model_id}
            getTextLabel={(card) => card.model_id}
            placeholder="Нет"
          />
        </GroupField>
        <Field label="Скорость">
          <Select
            value={form.auxiliaryModelSpeed || "default"}
            disabled={!form.auxiliaryModel}
            onValueChange={(value) =>
              setForm({
                ...form,
                auxiliaryModelSpeed:
                  value === "standard" || value === "fast" ? value : "",
              })
            }
            className="w-full"
          >
            <SelectOption value="default">По умолчанию</SelectOption>
            <SelectOption value="standard">Стандартная</SelectOption>
            <SelectOption value="fast">Быстрая</SelectOption>
          </Select>
        </Field>
      </div>
      <Field
        label="Идентификаторы добавляемых промптов"
        hint="По одному идентификатору в строке."
      >
        <Textarea
          id="agent-appendable-prompts"
          value={form.appendablePrompts.join("\n")}
          onChange={(event) =>
            setForm({
              ...form,
              appendablePrompts: event.target.value
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean),
            })
          }
          rows={3}
          className="resize-none font-mono text-xs leading-5"
          placeholder={"prompt_review\nprompt_security"}
        />
      </Field>
      <Field label="Описание">
        <Input
          id="agent-description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Проверяет договоры и сверяет реквизиты сторон"
        />
      </Field>
      <Field
        label="Метаданные (JSON)"
        hint="До 16 пар «ключ: значение»: ключ до 64 символов, значение до 512."
      >
        <Textarea
          id="agent-metadata"
          value={form.metadataJson}
          onChange={(event) => setForm({ ...form, metadataJson: event.target.value })}
          rows={4}
          className="resize-y font-mono text-xs leading-5"
          spellCheck={false}
          placeholder='{"team":"legal"}'
        />
      </Field>
      <Field label="Системный промпт">
        <Textarea
          id="agent-system"
          value={form.system}
          onChange={(e) => setForm({ ...form, system: e.target.value })}
          rows={6}
          className="resize-y font-mono text-xs leading-5"
          placeholder="Вы ассистент сотрудников бэк-офиса. Отвечайте кратко и по делу…"
        />
      </Field>
    </div>
  );
}

function ToolsTab({ form, setForm }: { form: FormState; setForm: FormSetter }) {
  return (
    <div className="space-y-4">
      <p className="text-xs leading-4 text-ddc-text-muted">
        Встроенный набор инструментов агента. Делегирование другим агентам вынесено на вкладку
        «Мультиагентность», а не в этот набор. Внешние инструменты подключаются на вкладке
        «MCP-серверы».
      </p>

      <div className="rounded-xl bg-ddc-surface-muted p-4">
        <div className="text-sm font-medium text-ddc-heading">Политика по умолчанию</div>
        <p className="mt-1 mb-4 text-xs leading-4 text-ddc-text-muted">
          Действует для каждого инструмента ниже со значением{" "}
          <span className="font-mono">default</span>.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Label className="flex items-center gap-2 text-sm leading-5">
            <Checkbox
              checked={form.toolDefaultEnabled}
              onCheckedChange={(checked) =>
                setForm({ ...form, toolDefaultEnabled: checked === true })
              }
            />
            Включить инструменты
          </Label>
          <div className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-sm">
            <span className="flex-none text-ddc-text-muted">Разрешение:</span>
            <Select
              value={form.toolDefaultPermission}
              disabled={!form.toolDefaultEnabled}
              placeholder="Разрешение по умолчанию"
              onValueChange={(value) =>
                setForm({
                  ...form,
                  toolDefaultPermission: value as "always_allow" | "always_ask",
                })
              }
              className="w-full min-w-0"
            >
              <SelectOption value="always_allow">{PERMISSION_LABEL.always_allow}</SelectOption>
              <SelectOption value="always_ask">{PERMISSION_LABEL.always_ask}</SelectOption>
            </Select>
          </div>
        </div>
      </div>

      <div>
        <div className="text-sm font-medium text-ddc-heading">Исключения по инструментам</div>
        <p className="mt-1 mb-3 text-xs leading-4 text-ddc-text-muted">
          В списке каждой строки показано действующее значение. Выберите{" "}
          <span className="font-mono">default</span>, чтобы наследовать политику выше, или
          конкретное значение, чтобы её переопределить. Режим «Всегда спрашивать» создаёт
          событие <span className="font-mono">user.tool_confirmation</span>, которое клиент
          должен подтвердить перед каждым вызовом.
        </p>
        <div className="divide-y divide-ddc-divider overflow-hidden rounded-xl border border-ddc-border">
          {BUILTIN_TOOLS.map((bt) => {
            const current = form.toolOverrides[bt.name] ?? "default";
            const effectiveLabel = !form.toolDefaultEnabled
              ? "отключён"
              : PERMISSION_LABEL[form.toolDefaultPermission].toLocaleLowerCase();
            const isOff =
              current === "disabled" || (current === "default" && !form.toolDefaultEnabled);
            return (
              <div
                key={bt.name}
                className={cn(
                  "flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
                  isOff && "opacity-50",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm text-ddc-heading">{bt.label}</div>
                  <div className="line-clamp-2 text-xs text-ddc-text-muted" title={bt.description}>
                    {bt.description}
                  </div>
                </div>
                <Select
                  value={current}
                  placeholder={`Режим инструмента ${bt.name}`}
                  onValueChange={(value) => {
                    const v = value as ToolOverride;
                    const next = { ...form.toolOverrides };
                    if (v === "default") delete next[bt.name];
                    else next[bt.name] = v;
                    setForm({ ...form, toolOverrides: next });
                  }}
                  className="w-full flex-none sm:w-72"
                >
                  <SelectOption value="default">По умолчанию ({effectiveLabel})</SelectOption>
                  <SelectOption value="always_allow">{PERMISSION_LABEL.always_allow}</SelectOption>
                  <SelectOption value="always_ask">{PERMISSION_LABEL.always_ask}</SelectOption>
                  <SelectOption value="disabled">{PERMISSION_LABEL.disabled}</SelectOption>
                </Select>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Строка выбора навыка: чекбокс и подписи. Выбранная строка на подложке brand-50. */
function SkillRow({
  active,
  onToggle,
  children,
}: {
  active: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Label
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm leading-5 font-normal transition-colors",
        active
          ? "border-ddc-tone-brand-ring bg-ddc-selected-bg text-ddc-selected-text"
          : "border-ddc-border text-ddc-text hover:bg-ddc-surface-muted",
      )}
    >
      <Checkbox checked={active} onCheckedChange={onToggle} />
      {children}
    </Label>
  );
}

function SkillsTab({
  form,
  setForm,
  customSkills,
  toggleAnthropicSkill,
}: {
  form: FormState;
  setForm: FormSetter;
  customSkills: AgentFormDialogProps["customSkills"];
  toggleAnthropicSkill: (id: string) => void;
}) {
  // Hide skills that are already surfaced under Anthropic Skills above
  // (xlsx/pdf/pptx/docx — their backend rows show up in the same list as
  // user-registered skills, otherwise we duplicate).
  const anthropicIds = new Set(ANTHROPIC_SKILLS.map((s) => s.id));
  const filtered = customSkills.filter((cs) => !anthropicIds.has(cs.id));

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-sm font-medium text-ddc-heading">Навыки Anthropic</div>
        <div className="grid gap-3 sm:grid-cols-2">
          {ANTHROPIC_SKILLS.map((s) => {
            const active = form.skills.some(
              (sk) => sk.type === "anthropic" && sk.skill_id === s.id,
            );
            return (
              <SkillRow key={s.id} active={active} onToggle={() => toggleAnthropicSkill(s.id)}>
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
              </SkillRow>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 text-sm font-medium text-ddc-heading">Свои навыки</div>
        {filtered.length > 0 ? (
          <div className="space-y-3">
            {filtered.map((cs) => {
              const active = form.skills.some(
                (sk) => sk.type === "custom" && sk.skill_id === cs.id,
              );
              return (
                <SkillRow
                  key={cs.id}
                  active={active}
                  onToggle={() => {
                    if (active) {
                      setForm({
                        ...form,
                        skills: form.skills.filter(
                          (sk) => !(sk.type === "custom" && sk.skill_id === cs.id),
                        ),
                      });
                    } else {
                      setForm({
                        ...form,
                        skills: [
                          ...form.skills,
                          { type: "custom", skill_id: cs.id, version: "latest" },
                        ],
                      });
                    }
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={cs.name}>{cs.name}</span>
                    {cs.description && (
                      <span className="block truncate text-xs text-ddc-text-muted" title={cs.description}>
                        {cs.description}
                      </span>
                    )}
                  </span>
                  <span
                    className="max-w-40 flex-none truncate font-mono text-xs text-ddc-text-muted"
                    title={cs.id}
                  >
                    {cs.id}
                  </span>
                </SkillRow>
              );
            })}
          </div>
        ) : (
          <p className="text-xs leading-4 text-ddc-text-muted">
            Своих навыков пока нет.{" "}
            <Link to="/skills" className="link">
              Создать навык
            </Link>
          </p>
        )}
      </div>
      {form.skills.length > 0 && (
        <div className="space-y-3 rounded-xl border border-ddc-border p-4">
          <div>
            <div className="text-sm font-medium text-ddc-heading">Закреплённые версии навыков</div>
            <p className="mt-1 text-xs leading-4 text-ddc-text-muted">
              Пустое поле означает последнюю версию (<span className="font-mono">latest</span>).
            </p>
          </div>
          {form.skills.map((skill, index) => (
            <div key={`${skill.type}:${skill.skill_id}`} className="flex items-center gap-3">
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-ddc-text-muted"
                title={skill.skill_id}
              >
                {skill.skill_id}
              </span>
              <Input
                value={skill.version ?? ""}
                onChange={(event) => {
                  const skills = [...form.skills];
                  skills[index] = {
                    ...skill,
                    ...(event.target.value
                      ? { version: event.target.value }
                      : {}),
                  };
                  if (!event.target.value) delete skills[index].version;
                  setForm({ ...form, skills });
                }}
                className="w-32 flex-none"
                placeholder="latest"
                aria-label={`Версия навыка ${skill.skill_id}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function McpTab({
  form,
  onPickFromRegistry,
  addMcp,
  updateMcp,
  removeMcp,
}: {
  form: FormState;
  onPickFromRegistry: () => void;
  addMcp: () => void;
  updateMcp: (i: number, field: keyof McpEntry, val: string) => void;
  removeMcp: (i: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm font-medium text-ddc-heading">MCP-серверы</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onPickFromRegistry}>
            <PlusIcon />
            Выбрать из списка
          </Button>
          <Button variant="outline" size="sm" onClick={addMcp}>
            <PlusIcon />
            Свой сервер
          </Button>
        </div>
      </div>
      {form.mcpServers.map((mcp, i) => (
        <div key={i} className="space-y-4 rounded-xl bg-ddc-surface-muted p-4">
          <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_7rem_auto]">
            <Field label="Название">
              <Input
                id={`mcp-name-${i}`}
                value={mcp.name}
                onChange={(e) => updateMcp(i, "name", e.target.value)}
                placeholder="github"
              />
            </Field>
            <Field label="Тип">
              <Select
                id={`mcp-type-${i}`}
                value={mcp.type}
                onValueChange={(value) => updateMcp(i, "type", value)}
                className="w-full"
              >
                <SelectOption value="url">URL</SelectOption>
                <SelectOption value="stdio">stdio</SelectOption>
              </Select>
            </Field>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeMcp(i)}
              aria-label={`Удалить MCP-сервер ${mcp.name || i + 1}`}
              title="Удалить"
              className="justify-self-end text-ddc-icon-muted hover:bg-ddc-tone-danger-bg hover:text-ddc-danger-text"
            >
              <Trash2Icon />
            </Button>
          </div>
          {mcp.type === "url" ? (
            <Field label="URL">
              <Input
                id={`mcp-url-${i}`}
                value={mcp.url}
                onChange={(e) => updateMcp(i, "url", e.target.value)}
                placeholder="https://mcp.github.com/sse"
              />
            </Field>
          ) : (
            <div className="space-y-4">
              <Field label="Команда (абсолютный путь в песочнице)">
                <Input
                  id={`mcp-command-${i}`}
                  value={mcp.command}
                  onChange={(e) => updateMcp(i, "command", e.target.value)}
                  placeholder="/usr/local/bin/my-mcp-server"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Аргументы (массив JSON)">
                  <Input
                    id={`mcp-args-${i}`}
                    value={mcp.argsJson}
                    onChange={(e) => updateMcp(i, "argsJson", e.target.value)}
                    placeholder='["--root", "/workspace"]'
                  />
                </Field>
                <Field label="Переменные окружения без секретов (объект JSON)">
                  <Input
                    id={`mcp-env-${i}`}
                    value={mcp.envJson}
                    onChange={(e) => updateMcp(i, "envJson", e.target.value)}
                    placeholder='{"LOG_LEVEL":"info"}'
                  />
                </Field>
              </div>
            </div>
          )}
        </div>
      ))}
      {form.mcpServers.length === 0 && (
        <EmptyState
          size="sm"
          title="MCP-серверы не настроены"
          body="MCP-серверы подключают внешние инструменты по протоколу Model Context Protocol."
        />
      )}
    </div>
  );
}

function AgentsTab({
  form,
  setForm,
  allAgents,
  addCallable,
  removeCallable,
}: {
  form: FormState;
  setForm: FormSetter;
  allAgents: Agent[];
  addCallable: (agentId: string) => void;
  removeCallable: (i: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-ddc-heading">Вызываемые агенты</div>
        <p className="mt-1 text-xs leading-4 text-ddc-text-muted">
          Агенты, которым этот агент может передавать задачи через инструменты{" "}
          <span className="font-mono">call_agent_&lt;id&gt;</span>.
        </p>
      </div>

      {form.callableAgents.map((ca, i) => {
        const agentInfo = allAgents.find((a) => a.id === ca.id);
        return (
          <div
            key={i}
            className="flex flex-wrap items-end gap-3 rounded-xl border border-ddc-border p-3"
          >
            <div className="min-w-0 flex-1 basis-40">
              <div className="truncate text-sm font-medium text-ddc-heading" title={agentInfo?.name || ca.id}>
                {agentInfo?.name || ca.id}
              </div>
              <div className="truncate font-mono text-xs text-ddc-text-muted" title={ca.id}>
                {ca.id}
              </div>
            </div>
            <Field label="Версия" className="w-28 flex-none">
              <Input
                id={`callable-version-${i}`}
                type="number"
                min="1"
                value={ca.version ?? ""}
                onChange={(event) => {
                  const callableAgents = [...form.callableAgents];
                  if (event.target.value === "") {
                    callableAgents[i] = { ...ca, version: undefined };
                  } else {
                    const version = Number(event.target.value);
                    if (!Number.isInteger(version) || version < 1) return;
                    callableAgents[i] = { ...ca, version };
                  }
                  setForm({ ...form, callableAgents });
                }}
                placeholder="latest"
              />
            </Field>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeCallable(i)}
              aria-label={`Убрать агента ${agentInfo?.name || ca.id}`}
              title="Убрать"
              className="text-ddc-icon-muted hover:bg-ddc-tone-danger-bg hover:text-ddc-danger-text"
            >
              <Trash2Icon />
            </Button>
          </div>
        );
      })}

      <GroupField label="Добавить агента">
        <Combobox<Agent>
          value=""
          onValueChange={(v) => {
            if (v) addCallable(v);
          }}
          endpoint="/v1/agents"
          getValue={(a) => a.id}
          getLabel={(a) => (
            <span>
              {a.name} <span className="text-ddc-text-muted">({a.id})</span>
            </span>
          )}
          getTextLabel={(a) => `${a.name} (${a.id})`}
          placeholder="Выберите агента…"
          excludeIds={form.callableAgents.map((c) => c.id)}
        />
      </GroupField>

      {form.callableAgents.length === 0 && allAgents.length === 0 && (
        <p className="text-xs leading-4 text-ddc-text-muted">
          Сначала создайте других агентов, чтобы включить делегирование.
        </p>
      )}
    </div>
  );
}
