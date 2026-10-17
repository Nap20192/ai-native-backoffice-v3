import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useId, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  AlertTriangleIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  GlobeIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import type {
  BetaLimitedNetworkParams,
  BetaPackages,
  BetaPackagesParams,
  BetaUnrestrictedNetwork,
} from "@anthropic-ai/sdk/resources/beta/environments/environments";
import { useApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import { Select, SelectOption } from "../components/Select";
import { toast } from "sonner";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { useCrumbName } from "../lib/crumb-names";
import { DangerDialog } from "../components/DangerDialog";
import { Field } from "../components/Field";
import { Skeleton } from "../components/Skeleton";
import { templateLabel } from "../lib/environment-templates";
import {
  isPlatformMetadataKey,
  type OmaCloudConfigParams,
  type OmaEnvironment,
  type OmaEnvironmentUpdateParams,
  type OmaLimitedNetworkParams,
} from "../lib/environment-oma";
import { useSandboxCatalog } from "../lib/sandbox-catalog";
import { ImageSection } from "./environments/ImageSection";
import { SectionCard } from "./environments/SectionCard";

// =================================================================
// Types
// =================================================================

/** Менеджеры пакетов в выпадающем списке.
 *  `gem` есть в схеме, но намеренно не показан, потому что ни в прежнем образе
 *  `node:22-bookworm`, ни в образах каталога, например `workplace`, нет ruby.
 *  Если в окружении уже есть gem-пакеты, при сохранении они возвращаются как
 *  есть, чтобы не потерять данные пользователя. */
const MANAGERS = ["apt", "cargo", "go", "npm", "pip"] as const;
type Manager = (typeof MANAGERS)[number];
const ALL_MANAGERS = [...MANAGERS, "gem"] as const;
type AnyManager = (typeof ALL_MANAGERS)[number];

/** Образы каталога не содержат cargo и go, и сервер с каталогом отклоняет
 *  такие пакеты ответом 400. Список их не предлагает. Строка, где они уже
 *  есть, остаётся, чтобы пользователь мог её поправить. */
const OUTSIDE_CATALOG_IMAGES: readonly Manager[] = ["cargo", "go"];

interface NetworkingConfig {
  type: "unrestricted" | "limited";
  allowed_hosts?: string[];
  allow_mcp_servers?: boolean;
  allow_package_managers?: boolean;
  /** Поле сервера. Формы для него нет: значение возвращается при сохранении как пришло. */
  allow_web_search?: boolean;
}

type Env = OmaEnvironment;

// Строки редактора: пакеты и метаданные хранятся упорядоченными массивами,
// чтобы строки не перепрыгивали при правке, даже если порядок ключей
// объекта меняется при нормализации перед сохранением.
interface PackageRow {
  manager: Manager;
  /** Пакеты через пробел, например `pandas numpy==2.0` */
  packages: string;
}
interface MetadataRow {
  key: string;
  value: string;
}

// =================================================================
// Page
// =================================================================

export function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const managedApi = useManagedApi();
  const nav = useNavigate();

  const [env, setEnv] = useState<Env | null>(null);
  useCrumbName(id, env?.name);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Архив и удаление идут через DangerDialog со списком зависимостей.
  const [dangerDialog, setDangerDialog] = useState<"archive" | "delete" | null>(null);

  // Состояние формы хранится отдельно от `env`: так «Отмена» откатывает
  // правки без повторной загрузки, а позже можно сравнить значения и
  // предупредить о несохранённых изменениях.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [networking, setNetworking] = useState<NetworkingConfig>({
    type: "unrestricted",
    allow_mcp_servers: false,
    allow_package_managers: false,
    allowed_hosts: [],
  });
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [packageRows, setPackageRows] = useState<PackageRow[]>([]);
  const [metadataRows, setMetadataRows] = useState<MetadataRow[]>([]);
  // Каталог образов сервера. Без каталога раздела «Образ» нет, а менеджеры
  // пакетов и шаблоны остаются как были.
  const sandboxCatalog = useSandboxCatalog();
  // Первая загрузка через TQ. Страница перерисовывается, когда кэш
  // заполнен, а эффект ниже один раз на ответ переносит данные в форму
  // (смена id между рендерами заново заполняет форму).
  const { data: fetchedEnv, error: fetchError } = useApiQuery<Env>(
    id ? `/v1/environments/${id}` : null,
  );
  useEffect(() => {
    if (fetchedEnv) applyEnv(fetchedEnv);
    // applyEnv зависит только от `fetchedEnv` (это замыкание над
    // setter-ами useState, они стабильны). Правило линтера отключено: чтобы
    // добавить applyEnv в зависимости, пришлось бы мемоизировать цепочку
    // setter-ов, а проще оставить эффект «при приходе данных».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedEnv]);
  useEffect(() => {
    if (fetchError) {
      setLoadError(fetchError instanceof Error ? fetchError.message : "Неизвестная ошибка");
    }
  }, [fetchError]);

  function applyEnv(e: Env) {
    setEnv(e);
    setName(e.name);
    setDescription(e.description ?? "");

    const cloud = e.config.type === "cloud" ? e.config : null;
    const saved = networkingFromEnv(e);
    setNetworking(saved.networking);
    setAllowedHostsText(saved.hostsText);
    setImage(cloud?.image ?? null);

    setPackageRows(packagesToRows(cloud?.packages));

    setMetadataRows(metadataToRows(e.metadata));
  }

  const hasReservedKey = metadataRows.some((row) => isPlatformMetadataKey(row.key.trim()));

  async function save() {
    if (!id || !env) return;
    setSaving(true);
    try {
      const config: OmaEnvironmentUpdateParams["config"] =
        env.config.type === "cloud"
          ? ({
              type: "cloud",
              // Поле сервера: пишем его, только если сервер его отдал.
              ...("image" in env.config ? { image } : {}),
              packages: rowsToPackagesPatch(env.config.packages, packageRows),
              networking: buildNetworking(networking, allowedHostsText),
            } satisfies OmaCloudConfigParams)
          : { type: "self_hosted" };

      const body: OmaEnvironmentUpdateParams = {
        name: name.trim(),
        description: description.trim() || null,
        config,
        metadata: rowsToMetadataPatch(env.metadata, metadataRows),
      };

      const updated = await managedApi.environments.update(id, body);
      applyEnv(updated as Env);
      toast.success("Окружение сохранено");
    } catch (err) {
      // useApi уже показывает ошибку тостом, второй не нужен.
      void err;
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    nav("/environments");
  }

  async function restore() {
    if (!id) return;
    try {
      const restored = await managedApi.environments.unarchive(id);
      applyEnv(restored as Env);
      toast.success("Окружение возвращено из архива");
    } catch {
      // useApi уже показывает ошибку тостом.
    }
  }

  if (loadError) {
    return (
      <Page>
        <div className="console-settings-layout">
          <div role="alert" className="callout-danger">
            <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
            <div className="min-w-0">
              <p className="font-semibold">Не удалось загрузить окружение</p>
              <p className="prose-wrap mt-1">{loadError}</p>
            </div>
          </div>
          <div>
            <Button variant="outline" onClick={cancel}>
              К списку окружений
            </Button>
          </div>
        </div>
      </Page>
    );
  }
  if (!env) {
    return <EnvironmentDetailSkeleton />;
  }

  const isCloud = env.config.type === "cloud";
  const templateId = env.metadata?.oma_template;
  const savedNetworking = networkingFromEnv(env);
  const networkChanged =
    JSON.stringify(buildNetworking(networking, allowedHostsText)) !==
    JSON.stringify(buildNetworking(savedNetworking.networking, savedNetworking.hostsText));

  return (
    <Page>
      <div className="console-settings-layout" data-testid="settings-layout">
        {/* Шапка: название, тип размещения, шаблон */}
        <PageHeader
          className="mb-0"
          title={
            <>
              <span className="min-w-0">{env.name || "Окружение"}</span>
              <span className="chip tone-neutral flex-none">
                <GlobeIcon aria-hidden="true" />
                {isCloud ? "Облако" : "Свой сервер"}
              </span>
              {templateId && (
                <span className="chip tone-neutral flex-none">
                  Шаблон «{templateLabel(templateId, sandboxCatalog.catalog)}»
                </span>
              )}
            </>
          }
          description={
            !isCloud
              ? "Название и метаданные окружения."
              : sandboxCatalog.catalog
                ? "Название, образ, сеть, пакеты и метаданные окружения."
                : "Название, сеть, пакеты и метаданные окружения."
          }
        />

        {/* Статус-чип и баннер build_error убраны: окружение без состояния
            после перехода на настройку при прогреве, статус всегда «готов»
            и по сети не передаётся. Ошибки установки пакетов видны в первой
            же сессии, которая использует окружение, а не при создании. */}

        {/* Основное */}
        <div className="card space-y-4 p-5">
          <Field label="Название">
            <Input
              id="env-name"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 50))}
              placeholder="Название окружения"
            />
          </Field>
          <Field label="Описание">
            <Textarea
              id="env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Для чего нужно это окружение"
              className="resize-y"
            />
          </Field>
        </div>

        {/* Образ. У «Своего сервера» образа нет. */}
        {isCloud && (
          <ImageSection
            catalog={sandboxCatalog.catalog}
            loading={sandboxCatalog.isLoading}
            value={image}
            onChange={setImage}
            networking={networking}
            disabled={saving}
          />
        )}

        {/* Сеть */}
        {isCloud && (
          <SectionCard
            title="Сеть"
            subtitle="Правила сетевого доступа для песочниц, собранных из этого окружения."
          >
            <div className="space-y-4">
              <Field label="Тип доступа">
                <Select
                  className="w-full sm:w-64"
                  value={networking.type}
                  onValueChange={(v) =>
                    setNetworking({
                      ...networking,
                      type: v as NetworkingConfig["type"],
                    })
                  }
                >
                  <SelectOption value="unrestricted">Без ограничений</SelectOption>
                  <SelectOption value="limited">Ограниченный</SelectOption>
                </Select>
              </Field>

              <Toggle
                label="Разрешить сетевой доступ MCP-серверам"
                checked={!!networking.allow_mcp_servers}
                onChange={(v) =>
                  setNetworking({ ...networking, allow_mcp_servers: v })
                }
              />
              <Toggle
                label="Разрешить сетевой доступ менеджерам пакетов"
                hint={PACKAGE_MANAGERS_HINT}
                checked={!!networking.allow_package_managers}
                onChange={(v) =>
                  setNetworking({ ...networking, allow_package_managers: v })
                }
              />

              {networking.type === "limited" && (
                <Field
                  label="Разрешённые хосты"
                  hint="Имена хостов через запятую, например: www.example1.com, api.example2.com"
                >
                  <Textarea
                    value={allowedHostsText}
                    onChange={(e) => setAllowedHostsText(e.target.value)}
                    rows={2}
                    placeholder="www.example1.com, www.example2.com"
                    className="resize-y"
                  />
                </Field>
              )}

              {networkChanged && (
                <div role="status" className="callout-warning">
                  <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
                  <p className="prose-wrap min-w-0">
                    Сеть изменена. Активные сессии этого окружения пересоздадут песочницу на
                    следующем ходе. Файлы вне /mnt/session/outputs пропадут.
                  </p>
                </div>
              )}
            </div>
          </SectionCard>
        )}

        {/* Пакеты */}
        {isCloud && (
          <SectionCard
            title="Пакеты"
            subtitle="Пакеты и версии, которые ставятся при сборке песочниц."
          >
            <div className="space-y-4">
              {packageRows.length === 0 ? (
                <p className="text-sm text-ddc-text-muted">Только то, что есть в образе.</p>
              ) : (
                <div className="space-y-3">
                  {packageRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Select
                        className="w-24 flex-none"
                        placeholder="Менеджер пакетов"
                        value={row.manager}
                        onValueChange={(v) =>
                          setPackageRows((rows) =>
                            rows.map((r, j) =>
                              j === i ? { ...r, manager: v as Manager } : r,
                            ),
                          )
                        }
                      >
                        {selectableManagers(sandboxCatalog.catalog !== null, row.manager).map((m) => (
                          <SelectOption key={m} value={m}>{m}</SelectOption>
                        ))}
                      </Select>
                      <Input
                        value={row.packages}
                        onChange={(e) =>
                          setPackageRows((rows) =>
                            rows.map((r, j) =>
                              j === i ? { ...r, packages: e.target.value } : r,
                            ),
                          )
                        }
                        aria-label="Пакеты и версии"
                        placeholder="pandas numpy==2.0.0"
                        className="min-w-0 flex-1 font-mono"
                      />
                      <RemoveRowButton
                        label="Удалить строку пакетов"
                        onClick={() =>
                          setPackageRows((rows) => rows.filter((_, j) => j !== i))
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setPackageRows((rows) => [...rows, { manager: "pip", packages: "" }])
                }
              >
                <PlusIcon aria-hidden="true" />
                Добавить пакет
              </Button>
              {env.config.type === "cloud" && env.config.packages.gem.length > 0 && (
                <p className="border-t border-ddc-divider pt-4 text-sm text-ddc-text-muted">
                  Сохранено устаревших gem-пакетов: {env.config.packages.gem.length}. Их нельзя
                  изменить, потому что в образах песочницы нет Ruby.
                </p>
              )}
            </div>
          </SectionCard>
        )}

        {/* Метаданные */}
        <SectionCard
          title="Метаданные"
          subtitle="Свои пары «ключ и значение», чтобы помечать это окружение."
        >
          <div className="space-y-4">
            {metadataRows.length === 0 ? (
              <p className="text-sm text-ddc-text-muted">Метаданных нет.</p>
            ) : (
              <div className="space-y-3">
                {metadataRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      onChange={(e) =>
                        setMetadataRows((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, key: e.target.value } : r,
                          ),
                        )
                      }
                      aria-label="Ключ"
                      aria-invalid={isPlatformMetadataKey(row.key.trim()) || undefined}
                      placeholder="Ключ"
                      className="min-w-0 flex-1 font-mono"
                    />
                    <Input
                      value={row.value}
                      onChange={(e) =>
                        setMetadataRows((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, value: e.target.value } : r,
                          ),
                        )
                      }
                      aria-label="Значение"
                      placeholder="Значение"
                      className="min-w-0 flex-1"
                    />
                    <RemoveRowButton
                      label="Удалить строку метаданных"
                      onClick={() =>
                        setMetadataRows((rows) => rows.filter((_, j) => j !== i))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            {hasReservedKey && (
              <p role="alert" className="text-xs leading-4 text-ddc-danger-text">
                Платформа зарезервировала ключи, которые начинаются с «oma_». Выберите другой ключ.
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setMetadataRows((rows) => [...rows, { key: "", value: "" }])
              }
            >
              <PlusIcon aria-hidden="true" />
              Добавить метку
            </Button>
          </div>
        </SectionCard>

        {/* Действия */}
        <div className="console-settings-actions flex-wrap" data-testid="settings-actions">
          <Button onClick={save} loading={saving} disabled={!name.trim() || hasReservedKey}>
            Сохранить изменения
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={saving}>
            Отмена
          </Button>
          {env.archived_at ? (
            <Button variant="outline" onClick={() => void restore()} disabled={saving}>
              <ArchiveRestoreIcon aria-hidden="true" />
              Вернуть из архива
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setDangerDialog("archive")} disabled={saving}>
              <ArchiveIcon aria-hidden="true" />
              В архив
            </Button>
          )}
          <Button
            variant="danger-ghost"
            aria-label="Удалить окружение"
            onClick={() => setDangerDialog("delete")}
            disabled={saving}
          >
            <TrashIcon aria-hidden="true" />
            Удалить
          </Button>
          <span
            title={env.id}
            className="ml-auto min-w-0 max-w-full truncate font-mono text-xs text-ddc-text-muted"
          >
            {env.id}
          </span>
        </div>
      </div>

      <DangerDialog
        open={dangerDialog === "archive"}
        operation="archive"
        target={id ? { kind: "environment", id } : null}
        etagPath={id ? `/v1/environments/${id}` : undefined}
        title="Отправить окружение в архив?"
        message="Окружение перестанет выбираться для новых сессий."
        confirmLabel="В архив"
        run={(options) => managedApi.environments.archive(id!, options)}
        onDone={() => nav("/environments")}
        onClose={() => setDangerDialog(null)}
      />
      <DangerDialog
        open={dangerDialog === "delete"}
        operation="delete"
        target={id ? { kind: "environment", id } : null}
        etagPath={id ? `/v1/environments/${id}` : undefined}
        title="Удалить окружение?"
        message="Окружение будет удалено вместе с настройками."
        run={(options) => managedApi.environments.delete(id!, options)}
        onDone={() => nav("/environments")}
        onClose={() => setDangerDialog(null)}
      />
    </Page>
  );
}

// =================================================================
// Скелетон загрузки: повторяет разметку страницы, чтобы она не прыгала
// =================================================================

function EnvironmentDetailSkeleton() {
  return (
    <Page>
      <div className="console-settings-layout" aria-busy="true">
        <span role="status" className="sr-only">
          Загрузка…
        </span>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="card space-y-4 p-5">
          <Skeleton className="h-10 w-full" rounded="lg" />
          <Skeleton className="h-16 w-full" rounded="lg" />
        </div>
        {[0, 1, 2].map((i) => (
          <section key={i} className="console-settings-section">
            <header className="console-settings-section-header">
              <div className="flex min-w-0 flex-col gap-1">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
            </header>
            <div className="console-settings-section-body space-y-3">
              <Skeleton className="h-10 w-full" rounded="lg" />
            </div>
          </section>
        ))}
      </div>
    </Page>
  );
}

// =================================================================
// Form primitives
// =================================================================

/** Подпись под флажком менеджеров пакетов (раздел 2.2 плана environments.md).
 *  Реестры с учётными записями дают код в песочнице канал для вывода данных,
 *  поэтому цена флажка названа прямо. */
const PACKAGE_MANAGERS_HINT =
  "Агент сможет сам ставить пакеты из реестров. Код пакетов увидит файлы сессии. " +
  "Через PyPI и npm такой код может вывести данные, например опубликовать их как пакет.";

/** Переключатель DDC: `button.switch` с `role="switch"`, клик по подписи
 *  тоже переключает. Кольцо фокуса общее, своё не задаём. Пояснение под
 *  флажком связано с ним через `aria-describedby`. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const hintId = useId();
  return (
    <div>
      <Label className="min-h-10 cursor-pointer justify-between gap-4 text-sm leading-5 font-normal text-ddc-text">
        <span className="min-w-0">{label}</span>
        <PlainButton
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          aria-describedby={hint ? hintId : undefined}
          onClick={() => onChange(!checked)}
          className="switch"
        >
          <span className="switch-knob" />
        </PlainButton>
      </Label>
      {hint && (
        <p id={hintId} className="text-xs leading-4 text-ddc-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Кнопка удаления строки: иконка 40px в ряду полей, краснеет только при
 *  наведении (правило 3 DDC). */
function RemoveRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex-none text-ddc-icon-muted hover:bg-ddc-tone-danger-bg hover:text-ddc-danger-text"
    >
      <TrashIcon aria-hidden="true" />
    </Button>
  );
}

// =================================================================
// Чистые функции вынесены на уровень модуля, чтобы тестировать их без
// React. Они переводят схему окружения в строки редактора и обратно для
// пакетов и метаданных.
// =================================================================

/** Менеджеры в списке строки. С каталогом образов cargo и go скрыты, кроме
 *  менеджера, который в строке уже выбран. */
function selectableManagers(catalogEnabled: boolean, current: Manager): readonly Manager[] {
  if (!catalogEnabled) return MANAGERS;
  return MANAGERS.filter((m) => !OUTSIDE_CATALOG_IMAGES.includes(m) || m === current);
}

function networkingFromEnv(e: Env): { networking: NetworkingConfig; hostsText: string } {
  const cloud = e.config.type === "cloud" ? e.config : null;
  const net = cloud?.networking ?? { type: "unrestricted" as const };
  if (net.type !== "limited") {
    return {
      networking: {
        type: net.type,
        allow_mcp_servers: false,
        allow_package_managers: false,
        allowed_hosts: [],
      },
      hostsText: "",
    };
  }
  return {
    networking: {
      type: net.type,
      allow_mcp_servers: net.allow_mcp_servers,
      allow_package_managers: net.allow_package_managers,
      allowed_hosts: net.allowed_hosts,
      ...(net.allow_web_search !== undefined && { allow_web_search: net.allow_web_search }),
    },
    hostsText: net.allowed_hosts.join(", "),
  };
}

function packagesToRows(packages: BetaPackages | undefined): PackageRow[] {
  if (!packages) return [];
  const rows: PackageRow[] = [];
  for (const m of MANAGERS) {
    const list = packages[m];
    if (list && list.length > 0) {
      rows.push({ manager: m, packages: list.join(" ") });
    }
  }
  return rows;
}

function rowsToPackagesPatch(
  original: BetaPackages,
  rows: PackageRow[],
): BetaPackagesParams {
  const out: BetaPackagesParams = { type: "packages" };
  for (const row of rows) {
    const specs = row.packages
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (specs.length === 0) continue;
    // Строки с одним менеджером сливаются в одну: интерфейс не требует
    // уникальности, и так удобнее пользователю.
    const existing = out[row.manager] ?? [];
    out[row.manager] = [...existing, ...specs];
  }
  for (const manager of MANAGERS) {
    if (original[manager].length > 0 && out[manager] === undefined) {
      out[manager] = null;
    }
  }
  return out;
}

/** Редактор метаданных не показывает метки платформы (`oma_template` и другие
 *  с префиксом `oma_`): их ставит сервер, правит человек не их. */
function metadataToRows(
  metadata: Record<string, string> | undefined,
): MetadataRow[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([key]) => !isPlatformMetadataKey(key))
    .map(([key, value]) => ({
      key,
      value,
    }));
}

/** Метки платформы в правку не попадают: ни как значения, ни как удаление.
 *  Метаданные при правке идут патчем, поэтому ключ, которого нет в
 *  запросе, остаётся нетронутым. */
function rowsToMetadataPatch(
  original: Record<string, string>,
  rows: MetadataRow[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k || isPlatformMetadataKey(k)) continue;
    out[k] = row.value;
  }
  for (const key of Object.keys(original)) {
    if (isPlatformMetadataKey(key)) continue;
    if (!(key in out)) out[key] = null;
  }
  return out;
}

function buildNetworking(
  net: NetworkingConfig,
  allowedHostsText: string,
): BetaUnrestrictedNetwork | OmaLimitedNetworkParams {
  const hosts = allowedHostsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (net.type === "unrestricted") {
    return { type: "unrestricted" };
  }
  const limited: BetaLimitedNetworkParams & { allow_web_search?: boolean } = {
    type: "limited",
    allow_mcp_servers: !!net.allow_mcp_servers,
    allow_package_managers: !!net.allow_package_managers,
    allowed_hosts: hosts,
  };
  // Поле сервера: возвращаем то, что пришло, а не сбрасываем его при правке сети.
  if (net.allow_web_search !== undefined) limited.allow_web_search = net.allow_web_search;
  return limited;
}
