import { formatDate } from "../lib/date-format";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo, useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useOmaInfiniteApiQuery } from "../lib/useApiQuery";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field } from "../components/Field";
import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import { PopoverContent } from "@/components/ui/popover";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { TextInput, SecretInput } from "../components/Input";
import { toast } from "sonner";
import type { ModelCard } from "@open-managed-agents/api-types";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";
import { MODEL_CARD_DRAFT_STATE_KEY, sanitizeModelCardDraft } from "../lib/assistant/drafts";
import { LocalDebugOnlyWarning } from "../components/LocalDebugOnlyWarning";

// Common Pi provider presets. The actual provider id is an open string; the
// text field below also accepts any current/future Pi id or a custom id.
const PROVIDERS = [
  { value: "anthropic", label: "Anthropic", desc: "Модели Claude" },
  { value: "openai", label: "OpenAI", desc: "Модели GPT" },
  { value: "deepseek", label: "DeepSeek", desc: "Каталог DeepSeek" },
  { value: "openrouter", label: "OpenRouter", desc: "Каталог OpenRouter" },
  { value: "google", label: "Google", desc: "Модели Gemini" },
  { value: "minimax", label: "MiniMax", desc: "Модели MiniMax" },
] as const;

type ProviderValue = string;

const PROVIDER_FILTER_OPTIONS: { value: ProviderValue | "any"; label: string }[] = [
  { value: "any", label: "Все" },
  ...PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
];

const INITIAL_FORM = {
  provider: "anthropic" as ProviderValue,
  model_id: "",
  model: "",
  api_key: "",
  base_url: "",
  is_default: false,
  pi_config: "",
  custom_headers: [{ key: "", value: "" }] as Array<{ key: string; value: string }>,
};

export function ModelCardsList() {
  const { api } = useApi();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [error, setError] = useState("");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showModelSuggestions, setShowModelSuggestions] = useState(false);

  // Удаление карточки подтверждается окном ConfirmDialog (правило 11 DDC).
  // Цель не сбрасываем при закрытии: текст окна не должен пропасть, пока оно
  // уходит с экрана.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Server-driven filter state. Each piece flows into cardsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [provider, setProvider] = useState<ProviderValue | "any">("any");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const cardsParams = useMemo(
    () => ({
      ...(provider !== "any" ? { provider } : {}),
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [provider, created.after, created.before, search],
  );

  const {
    items: cards,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useOmaInfiniteApiQuery<ModelCard>("/v1/oma/model_cards", { limit: 20, params: cardsParams });

  // Provider discovery is Pi catalog metadata; credentials stay in the Model
  // Card create/rotate request and are never forwarded just to browse models.
  const fetchModels = useCallback(async (provider: string) => {
    if (!provider.trim()) {
      setAvailableModels([]);
      return;
    }
    setModelsLoading(true);
    try {
      const result = await api<{ data: Array<{ id: string; name: string }> }>("/v1/oma/models/list", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      setAvailableModels(result.data);
    } catch {
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, [api]);

  const save = async () => {
    setError("");
    if (!form.model_id || (!editingId && !form.api_key)) {
      setError("Укажите ID модели и API-ключ.");
      return;
    }
    try {
      const payload: Record<string, unknown> = {
        provider: form.provider,
        model_id: form.model_id,
        // model defaults to model_id when blank — common case is "the handle
        // IS the LLM string". Users only fill `model` when they want a
        // distinct wire-level value (e.g. handle "claude-prod" → wire
        // "claude-sonnet-4-6").
        model: form.model || form.model_id,
        api_key: form.api_key,
        is_default: form.is_default,
      };
      if (form.base_url) payload.base_url = form.base_url;
      // Serialize custom headers from array to object
      const hdrs: Record<string, string> = {};
      for (const h of form.custom_headers) {
        if (h.key && h.value) hdrs[h.key] = h.value;
      }
      if (Object.keys(hdrs).length > 0) payload.custom_headers = hdrs;
      if (form.pi_config.trim()) {
        let piConfig: unknown;
        try {
          piConfig = JSON.parse(form.pi_config);
        } catch {
          setError("Конфигурация Pi должна быть корректным JSON.");
          return;
        }
        if (typeof piConfig !== "object" || piConfig === null || Array.isArray(piConfig)) {
          setError("Конфигурация Pi должна быть JSON-объектом.");
          return;
        }
        payload.pi_config = piConfig;
      }
      if (editingId) {
        if (!form.api_key) delete payload.api_key;
        await api(`/v1/oma/model_cards/${editingId}`, { method: "POST", body: JSON.stringify(payload) });
      } else {
        // Create returns the card + a probe result. Surface it so the user
        // finds out NOW if their api_key / base_url / model id is broken.
        const created = await api<{ probe?: { ok: boolean | null; message?: string; reason?: string } }>(
          "/v1/oma/model_cards",
          { method: "POST", body: JSON.stringify(payload) },
        );
        const probe = created.probe;
        if (probe?.ok === true) {
          toast.success(`Карточка модели создана, ключ ${form.provider} проверен.`);
        } else if (probe?.ok === false) {
          toast.warning(
            probe.message
              ? `Карточка модели сохранена, но ключ не прошёл проверку: ${probe.message}`
              : "Карточка модели сохранена, но ключ не прошёл проверку. Проверьте API-ключ, базовый URL и ID модели.",
          );
        }
        // ok === null (unsupported provider) → no toast, success is implicit.
      }
      closeDialog(); load();
    } catch (e: any) { setError(e?.message || "Не удалось сохранить"); }
  };

  // Повторный клик по «Создать» во время запроса не должен создать вторую
  // карточку, поэтому сохранение идёт через useAsyncAction.
  const saveAction = useAsyncAction(save);

  const remove = async (id: string) => {
    try { await api(`/v1/oma/model_cards/${id}`, { method: "DELETE" }); load(); } catch {}
  };

  const askDelete = () => {
    if (!editingId) return;
    setDeleteTarget({ id: editingId, name: form.model_id });
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await remove(deleteTarget.id);
    setDeleting(false);
    setDeleteOpen(false);
    closeDialog();
  };

  const startEdit = (card: ModelCard) => {
    const hdrs = card.custom_headers
      ? Object.entries(card.custom_headers).map(([key, value]) => ({ key, value }))
      : [{ key: "", value: "" }];
    if (hdrs.length === 0) hdrs.push({ key: "", value: "" });
    setForm({
      // Older rows on disk may carry a provider value outside the current
      // enum (e.g. legacy "anthropic"); the tile picker simply leaves none
      // selected in that case. Cast keeps the form state strictly typed.
      provider: card.provider as ProviderValue,
      model_id: card.model_id,
      model: card.model,
      api_key: "",
      base_url: card.base_url || "",
      is_default: card.is_default || false,
      pi_config: card.pi_config ? JSON.stringify(card.pi_config, null, 2) : "",
      custom_headers: hdrs,
    });
    setEditingId(card.id); setShowCreate(true); setError("");
  };

  // Черновик ассистента приходит в состоянии маршрута, не в адресе. Берём из него
  // только поля белого списка: ключ, адрес и заголовки вводит пользователь. После
  // открытия состояние сбрасываем, чтобы обновление страницы не открыло окно снова.
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null;
    const raw = state?.[MODEL_CARD_DRAFT_STATE_KEY];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    const draft = sanitizeModelCardDraft(raw);
    setForm({
      ...INITIAL_FORM,
      custom_headers: [{ key: "", value: "" }],
      ...(draft.provider ? { provider: draft.provider } : {}),
      model_id: draft.model_id ?? "",
      model: draft.model ?? "",
      is_default: draft.is_default ?? false,
      pi_config: draft.pi_config ? JSON.stringify(draft.pi_config, null, 2) : "",
    });
    setEditingId(null);
    setShowCreate(true);
    setError("");
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);

  const closeDialog = () => {
    setShowCreate(false); setEditingId(null); setForm({ ...INITIAL_FORM }); setError("");
  };

  const providerLabel = (p: string) => PROVIDERS.find((x) => x.value === p)?.label || p;

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. The id+model_id
  // pair opts out of the Columns hide menu so the user can't end up
  // with a table that has nothing identifying. Actions also stays
  // visible — without Edit/Delete the table is read-only and there's
  // no detail page to drill into.
  const columns = useMemo<ColumnDef<ModelCard>[]>(
    () => [
      {
        id: "model_id",
        accessorKey: "model_id",
        header: "ID модели",
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-ddc-heading" title={row.original.model_id}>
              {row.original.model_id}
            </div>
            <div className="truncate font-mono text-xs text-muted" title={row.original.id}>
              {row.original.id}
            </div>
          </div>
        ),
        enableHiding: false,
      },
      {
        id: "provider",
        accessorKey: "provider",
        header: "Провайдер",
        size: 140,
        cell: ({ row }) => (
          <span className="chip tone-neutral">{providerLabel(row.original.provider)}</span>
        ),
      },
      {
        id: "model",
        accessorKey: "model",
        header: "Модель провайдера",
        size: 200,
        meta: { priority: 3 },
        cell: ({ row }) =>
          row.original.model === row.original.model_id ? (
            <span className="truncate text-muted">(совпадает с ID)</span>
          ) : (
            <span className="truncate font-mono text-xs text-muted" title={row.original.model}>
              {row.original.model}
            </span>
          ),
      },
      {
        id: "api_key",
        accessorFn: (c) => c.api_key_preview ?? "",
        header: "API-ключ",
        size: 130,
        meta: { priority: 4 },
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted">
            ****{row.original.api_key_preview}
          </span>
        ),
      },
      {
        id: "base_url",
        accessorFn: (c) => c.base_url ?? "",
        header: "Базовый URL",
        size: 220,
        meta: { priority: 5 },
        cell: ({ row }) =>
          row.original.base_url ? (
            <span className="truncate text-xs text-muted" title={row.original.base_url}>
              {row.original.base_url}
            </span>
          ) : (
            <span className="text-xs text-ddc-placeholder">Не задан</span>
          ),
      },
      {
        id: "default",
        accessorFn: (c) => (c.is_default ? "default" : ""),
        header: "По умолчанию",
        size: 150,
        cell: ({ row }) =>
          row.original.is_default ? <span className="chip tone-brand">По умолчанию</span> : null,
      },
      {
        id: "created",
        accessorFn: (c) => c.created_at,
        header: t.common.created,
        size: 120,
        meta: { priority: 1 },
        cell: ({ row }) => (
          <span className="text-muted tabular-nums">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    // Intentionally keyed only on the dictionary: startEdit + remove close
    // over `form`/`api` but the column defs only need to reflect identity,
    // not capture a fresh closure on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Провайдер ▾" rather than "Провайдер: Все ▾". The
  // clear-X only renders when the chip is in non-default state.
  const providerDisplay =
    provider === "any"
      ? undefined
      : PROVIDER_FILTER_OPTIONS.find((o) => o.value === provider)?.label;

  const filters = (
    <>
      <FilterChip
        label="Провайдер"
        active={provider !== "any"}
        display={providerDisplay}
        onClear={() => setProvider("any")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-56 p-0"
        >
          <FacetedFilter
            options={PROVIDER_FILTER_OPTIONS}
            value={provider}
            onValueChange={(v) => setProvider(v as ProviderValue | "any")}
            searchPlaceholder="Провайдер…"
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  const openCreate = () => { setShowCreate(true); setError(""); };

  const labelCls = "mb-1.5 block text-xs leading-4 font-medium text-ddc-label";

  return (
    <DataTable<ModelCard>
      title={t.nav.modelCards}
      subtitle="Подключения к языковым моделям: провайдер, ключ доступа и адрес."
      createLabel={t.modelCards.newModelCard}
      onCreate={openCreate}
      searchPlaceholder={t.modelCards.searchModelCards}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={cards}
      loading={loading}
      onRowClick={(c) => startEdit(c)}
      getRowId={(c) => c.id}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? t.modelCards.noMatchingModelCards : t.modelCards.noModelCardsYet}
      emptyKind="model_card"
      emptyAction={
        !search && <Button onClick={openCreate}><PlusIcon />{t.modelCards.newModelCard}</Button>
      }
      emptySubtitle={
        search ? (
          "Попробуйте изменить запрос."
        ) : (
          <>
            <p>Добавьте карточку модели, чтобы задать ключи доступа для ваших агентов.</p>
            <p className="mt-3 text-xs">
              Без карточек моделей агенты используют переменную окружения{" "}
              <code className="font-mono">ANTHROPIC_API_KEY</code>.
            </p>
          </>
        )
      }
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={closeDialog}
        title={editingId ? "Изменить карточку модели" : "Новая карточка модели"}
        closeDisabled={saveAction.loading}
        footer={
          <>
            {editingId && (
              <Button
                variant="danger-ghost"
                onClick={askDelete}
                disabled={saveAction.loading}
                className="mr-auto"
              >
                {t.common.delete}
              </Button>
            )}
            <Button variant="ghost" onClick={closeDialog} disabled={saveAction.loading}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={saveAction.run}
              loading={saveAction.loading}
              disabled={!form.model_id || (!editingId && !form.api_key)}
            >
              {editingId ? t.common.save : t.common.create}
            </Button>
          </>
        }>
        <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-4">
          <LocalDebugOnlyWarning />
          {error && (
            <div role="alert" className="callout-danger">
              {error}
            </div>
          )}
          <TextInput
            id="modelcard-id"
            label="ID модели *"
            hint="Уникальное имя в рабочем пространстве, на него ссылаются агенты."
            value={form.model_id}
            onChange={(e) => setForm({ ...form, model_id: e.target.value })}
            placeholder="claude-prod, claude-sonnet-4-6, bedrock-sonnet, ..."
          />
          <div role="group" aria-labelledby="modelcard-provider-label">
            <span id="modelcard-provider-label" className={labelCls}>Провайдер Pi *</span>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((p) => {
                const selected = form.provider === p.value;
                return (
                  <PlainButton
                    key={p.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setForm({ ...form, provider: p.value, model: "", base_url: "" });
                      setAvailableModels([]);
                      void fetchModels(p.value);
                    }}
                    className={cn(
                      "min-w-0 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                      selected
                        ? "border-ddc-ring bg-ddc-selected-bg text-ddc-selected-text"
                        : "border-ddc-border-strong text-ddc-text hover:bg-ddc-surface-muted",
                    )}
                  >
                    <div className="truncate font-medium" title={p.label}>{p.label}</div>
                    <div className="truncate text-xs text-muted" title={p.desc}>{p.desc}</div>
                  </PlainButton>
                );
              })}
            </div>
            <TextInput
              value={form.provider}
              onChange={(e) => {
                setForm({ ...form, provider: e.target.value });
                setAvailableModels([]);
              }}
              onBlur={() => void fetchModels(form.provider)}
              className="mt-2"
              placeholder="ID провайдера Pi, например anthropic, deepseek, my-vllm"
              aria-label="ID провайдера Pi"
            />
          </div>
          <SecretInput
            id="modelcard-api-key"
            label={editingId ? "API-ключ" : "API-ключ *"}
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder={editingId ? "Оставьте пустым, чтобы сохранить текущий ключ" : "sk-..."}
            name="model-api-key-field"
          />
          <div>
            <Label htmlFor="modelcard-wire-model" className={labelCls}>
              Модель провайдера
            </Label>
            <div className="relative">
              <Input id="modelcard-wire-model" value={form.model}
                onChange={(e) => { setForm({ ...form, model: e.target.value }); setShowModelSuggestions(true); }}
                onFocus={() => {
                  setShowModelSuggestions(true);
                  if (availableModels.length === 0) void fetchModels(form.provider);
                }}
                onBlur={() => setTimeout(() => setShowModelSuggestions(false), 150)}
                aria-describedby="modelcard-wire-model-hint"
                placeholder={form.model_id || "например, claude-sonnet-4-6, deepseek-v4-flash, org/model"}
                autoComplete="off" name="model-field" />
              {showModelSuggestions && availableModels.length > 0 && (
                <div className="menu absolute top-full left-0 z-10 mt-1 max-h-48 w-full overflow-y-auto">
                  {availableModels
                    .filter((m) => !form.model || m.id.includes(form.model) || m.name.toLowerCase().includes(form.model.toLowerCase()))
                    .map((m) => (
                      <PlainButton key={m.id} type="button"
                        onMouseDown={() => { setForm({ ...form, model: m.id }); setShowModelSuggestions(false); }}
                        className="menu-item">
                        <span className="min-w-0 truncate" title={m.name !== m.id ? `${m.name} (${m.id})` : m.id}>
                          {m.name !== m.id ? m.name : m.id}
                        </span>
                        {m.name !== m.id && (
                          <span className="ml-auto flex-none truncate text-xs text-muted" title={m.id}>{m.id}</span>
                        )}
                      </PlainButton>
                    ))}
                </div>
              )}
            </div>
            <p id="modelcard-wire-model-hint" className="mt-1.5 text-xs leading-4 text-muted">
              {modelsLoading
                ? "Загружаем список моделей…"
                : !availableModels.length && form.provider
                  ? "Каталог Pi не загружен. Для своих провайдеров укажите модель вручную."
                  : "Отправляется провайдеру. Если пусто, берётся ID модели."}
            </p>
          </div>
          <TextInput
            id="modelcard-base-url"
            label="Базовый URL"
            hint="Необязательно для встроенных провайдеров Pi."
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            placeholder="https://your-provider.example/v1"
          />
          <Field label="Конфигурация Pi" hint="JSON. Для своего провайдера нужно поле api.">
            <Textarea
              id="modelcard-pi-config"
              value={form.pi_config}
              onChange={(e) => setForm({ ...form, pi_config: e.target.value })}
              className="min-h-24 font-mono text-xs"
              placeholder={'{"api":"openai-completions","reasoning":false,"contextWindow":128000,"maxTokens":16384}'}
              spellCheck={false}
            />
          </Field>
          <div role="group" aria-labelledby="modelcard-headers-label">
            <span id="modelcard-headers-label" className={labelCls}>Свои заголовки (необязательно)</span>
            <div className="space-y-2">
              {form.custom_headers.map((h, i) => {
                const removable = form.custom_headers.length > 1;
                return (
                  <div
                    key={i}
                    className={cn(
                      "grid items-center gap-2",
                      removable
                        ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                        : "sm:grid-cols-2",
                    )}
                  >
                    <Input value={h.key} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], key: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} placeholder="Имя заголовка" aria-label={`Заголовок ${i + 1}: имя`} autoComplete="off" />
                    <Input value={h.value} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], value: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} placeholder="Значение" aria-label={`Заголовок ${i + 1}: значение`} autoComplete="off" />
                    {removable && (
                      <Button variant="ghost" size="icon-xs" type="button"
                        onClick={() => setForm({ ...form, custom_headers: form.custom_headers.filter((_, j) => j !== i) })}
                        className="col-start-2 row-span-2 row-start-1 self-center text-ddc-icon-muted hover:text-ddc-danger-text sm:col-start-3 sm:row-span-1"
                        aria-label={`Удалить заголовок ${i + 1}`}
                        title="Удалить заголовок">
                        <XIcon />
                      </Button>
                    )}
                  </div>
                );
              })}
              <PlainButton type="button" className="btn-add"
                onClick={() => setForm({ ...form, custom_headers: [...form.custom_headers, { key: "", value: "" }] })}>
                <PlusIcon aria-hidden="true" />
                Добавить заголовок
              </PlainButton>
            </div>
          </div>
          <Label className="cursor-pointer text-sm leading-5 font-normal text-ddc-text">
            <Checkbox
              checked={form.is_default}
              onCheckedChange={(checked) =>
                setForm({ ...form, is_default: checked === true })
              }
            />
            Использовать как карточку по умолчанию
          </Label>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteOpen}
        title="Удалить карточку модели?"
        message={
          deleteTarget
            ? `Карточка «${deleteTarget.name}» будет удалена. Действие нельзя отменить.`
            : "Действие нельзя отменить."
        }
        confirmLabel={t.common.delete}
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteOpen(false)}
      />
    </DataTable>
  );
}
