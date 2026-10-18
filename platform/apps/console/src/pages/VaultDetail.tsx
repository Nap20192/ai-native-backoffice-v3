import { useCrumbName } from "../lib/crumb-names";
import { formatDateTime } from "../lib/date-format";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckCircleIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  SearchXIcon,
  ServerIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type {
  BetaManagedAgentsCredential,
  CredentialCreateParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type { BetaManagedAgentsVault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";

import { useApi } from "../lib/api";
import { useApiQuery, useInfiniteApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { useAsyncAction } from "../hooks/useAsyncAction";

import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DangerDialog } from "../components/DangerDialog";
import { EmptyState } from "../components/EmptyState";
import { Skeleton, SkeletonRows } from "../components/Skeleton";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Disclosure } from "../components/Disclosure";
import { LocalCombobox } from "../components/LocalCombobox";
import { Field } from "../components/Field";
import { SecretInput, TextInput } from "../components/Input";
import { Select, SelectOption } from "../components/Select";
import { FilterChip } from "../components/FilterChip";
import { FacetedFilter } from "../components/FacetedFilter";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import { PopoverContent } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { MCP_REGISTRY, type McpRegistryEntry } from "../data/mcp-registry";
import { useI18n } from "../i18n";

// =================================================================
// Types
// =================================================================

type Vault = BetaManagedAgentsVault;
type Credential = BetaManagedAgentsCredential;

function credentialTypeView(credential: Credential): {
  label: string;
  target: string;
} {
  const authType: string = credential.auth.type;
  // Учётные данные CLI (cap_cli) создаются мимо SDK-типов, поэтому ветка
  // стоит до switch: иначе такая строка списка осталась бы без вида.
  if (authType === "cap_cli") {
    const cliId = (credential.auth as unknown as { cli_id?: string }).cli_id;
    return { label: "CLI", target: cliId ?? "" };
  }
  switch (credential.auth.type) {
    case "mcp_oauth":
      return { label: "OAuth", target: credential.auth.mcp_server_url };
    case "static_bearer":
      return { label: "Bearer", target: credential.auth.mcp_server_url };
    case "environment_variable":
      return { label: "Переменная окружения", target: credential.auth.secret_name };
    default:
      return { label: authType, target: "" };
  }
}

// First-wave cap CLI list. Mirrors @open-managed-agents/cap builtinSpecs.
// Lifted verbatim from VaultsList — kept here because the Add-credential
// flow now lives on this page.
const CAP_CLIS: Array<{ cli_id: string; label: string; helper: string; oauth?: boolean }> = [
  { cli_id: "gh", label: "GitHub CLI (gh)", helper: "Персональный токен доступа (ghp_...)", oauth: true },
  { cli_id: "glab", label: "GitLab CLI (glab)", helper: "Персональный токен доступа (glpat-...)", oauth: true },
  { cli_id: "az", label: "Azure CLI (az)", helper: "Токен доступа ARM", oauth: true },
  { cli_id: "gcloud", label: "Google Cloud SDK", helper: "Токен доступа OAuth", oauth: true },
  { cli_id: "fly", label: "Fly.io (fly / flyctl)", helper: "Токен Fly API (fo1_...)" },
  { cli_id: "vercel", label: "Vercel CLI", helper: "Токен доступа аккаунта" },
  { cli_id: "doctl", label: "DigitalOcean (doctl)", helper: "API-токен (dop_v1_...)" },
  { cli_id: "heroku", label: "Heroku CLI", helper: "API-токен (heroku auth:token)" },
  { cli_id: "cf", label: "Cloudflare (cf / wrangler)", helper: "API-токен (CLOUDFLARE_API_TOKEN)" },
  { cli_id: "npm", label: "Реестр npm", helper: "Гранулярный токен доступа (npm_...)" },
  { cli_id: "aws", label: "AWS CLI и SDK", helper: "Секретный ключ доступа AWS" },
  { cli_id: "kubectl", label: "kubectl", helper: "Bearer-токен для API-сервера" },
  { cli_id: "docker", label: "Реестр Docker", helper: "Пароль или персональный токен реестра" },
  { cli_id: "git", label: "git (HTTPS-репозитории)", helper: "Персональный токен доступа" },
];

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "active", label: "Активные" },
  { value: "archived", label: "В архиве" },
];

// Подпись над полем и групповым контролом вне Field (раздел 3 DDC, `.label`).
const LABEL_CLS = "mb-1.5 block text-xs leading-4 font-medium text-ddc-label";

// Кнопки шапки на телефоне 390px сжимаются до иконок 40x40, подпись остаётся
// для диктора (`sr-only`), иначе три подписи не помещаются в один ряд.
const HEADER_ACTION_CLS = "max-sm:w-10 max-sm:px-0";

// Пустое состояние внутри карточки списка: сама карточка уже есть, поэтому
// рамка, тень и подложка EmptyState гасятся.
const EMPTY_IN_CARD = "rounded-none border-0 bg-transparent shadow-none";

type PendingAction =
  | { kind: "archive-vault" }
  | { kind: "delete-vault" }
  | { kind: "delete-credential"; id: string; name: string };

// =================================================================
// Page
// =================================================================

export function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const { data: vault, error: vaultError } = useApiQuery<BetaManagedAgentsVault>(
    id ? `/v1/vaults/${id}` : null,
  );
  useCrumbName(id, vault?.display_name);
  const {
    items: credentials,
    isLoading: credsLoading,
    refresh: refetchCreds,
  } = useInfiniteApiQuery<Credential>(
    `/v1/vaults/${id ?? "missing"}/credentials`,
    {
      enabled: !!id,
      limit: 100,
      params: { include_archived: "true" },
    },
  );

  // Status filter applied client-side — the credentials list endpoint
  // doesn't accept a status query param. Transport still follows the Managed
  // `page`/`next_page` contract while the product remains a continuous feed.
  const [status, setStatus] = useState<StatusValue>("active");
  const filteredCreds = useMemo(() => {
    if (status === "any") return credentials;
    if (status === "active") return credentials.filter((c) => !c.archived_at);
    return credentials.filter((c) => !!c.archived_at);
  }, [credentials, status]);

  const [showAddCred, setShowAddCred] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [editingCred, setEditingCred] = useState<Credential | null>(null);

  // Архивация и удаление подтверждаются окном ConfirmDialog (правило 11
  // DDC). Выбранное действие не сбрасываем при закрытии: текст окна не
  // должен пропасть, пока оно уходит с экрана.
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Refetch credentials after a successful add/delete. Mirrors the old
  // `openVault(selectedVault)` reload from VaultsList, but goes through
  // TQ so any other tab/observer with the same key updates too.
  const reloadCredentials = useCallback(() => {
    if (!id) return;
    void refetchCreds();
    void queryClient.invalidateQueries({
      queryKey: [`/v1/vaults/${id}/credentials`],
    });
  }, [id, refetchCreds, queryClient]);

  const reloadVault = useCallback(() => {
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: [`/v1/vaults/${id}`] });
    void queryClient.invalidateQueries({ queryKey: ["/v1/vaults"] });
  }, [id, queryClient]);

  const askConfirm = (action: PendingAction) => {
    setPending(action);
    setConfirmOpen(true);
  };

  const restoreVault = async () => {
    if (!id) return;
    try {
      await managedApi.vaults.unarchive(id);
      reloadVault();
    } catch {
      // useApi already toasts the underlying error.
    }
  };

  // Архив и удаление хранилища идут через DangerDialog. Удаление учётных
  // данных остаётся простым подтверждением: у него нет зависимостей.
  const runConfirmed = async () => {
    if (!id || pending?.kind !== "delete-credential") return;
    setConfirmBusy(true);
    try {
      await managedApi.vaults.credentials.delete(pending.id, { vault_id: id });
      reloadCredentials();
    } catch {
      // useApi already toasts the underlying error.
    } finally {
      setConfirmBusy(false);
      setConfirmOpen(false);
    }
  };

  const errorMsg =
    vaultError instanceof Error
      ? vaultError.message
      : vaultError
        ? String(vaultError)
        : null;

  if (!id || errorMsg) {
    return (
      <div className="page">
        <EmptyState
          tone="warning"
          icon={<TriangleAlertIcon />}
          title={id ? "Не удалось загрузить хранилище" : "Хранилище не найдено"}
          body={
            id ? (
              <span role="alert">{errorMsg}</span>
            ) : (
              "В адресе страницы не указан идентификатор хранилища."
            )
          }
          action={
            <Button variant="outline" onClick={() => nav("/vaults")}>
              К списку хранилищ
            </Button>
          }
        />
      </div>
    );
  }
  if (!vault) {
    return (
      <div className="page" aria-busy="true">
        <span className="sr-only">{t.common.loading}</span>
        <div className="console-detail-stack">
          <div className="space-y-2">
            <Skeleton className="h-8 w-64 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <div className="card overflow-hidden">
            <div className="border-b border-ddc-divider px-5 py-4">
              <Skeleton className="h-5 w-40" />
            </div>
            <SkeletonRows count={3} />
          </div>
        </div>
      </div>
    );
  }

  const archived = !!vault.archived_at;
  const updatedAt = vault.updated_at;

  // Active-filter chip display — null at the default so the chip reads
  // "Статус ▾" rather than "Статус: Все ▾". Matches the list-page pattern.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const credsCount = filteredCreds.length > 99 ? "99+" : String(filteredCreds.length);

  const confirmTitle = "Удалить учётные данные?";
  const confirmMessage =
    pending?.kind === "delete-credential"
      ? `Учётные данные «${pending.name}» будут удалены. Действие нельзя отменить.`
      : "Действие нельзя отменить.";

  return (
    <Page
      layout="rail"
      header={
        <PageHeader
          title={
            <>
              <span className="min-w-0">{vault.display_name}</span>
              {archived && <Badge variant="neutral">{t.common.archived}</Badge>}
            </>
          }
          description="Учётные данные и делегированный доступ для управляемых агентов."
          actions={
            <>
              {!archived && (
                <Button
                  variant="outline"
                  className={HEADER_ACTION_CLS}
                  title={t.common.rename}
                  onClick={() => setShowRename(true)}
                >
                  <PencilIcon />
                  <span className="max-sm:sr-only">{t.common.rename}</span>
                </Button>
              )}
              {archived ? (
                <Button
                  variant="outline"
                  className={HEADER_ACTION_CLS}
                  title={t.common.unarchive}
                  onClick={() => void restoreVault()}
                >
                  <ArchiveRestoreIcon />
                  <span className="max-sm:sr-only">{t.common.unarchive}</span>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className={HEADER_ACTION_CLS}
                  title={t.common.archive}
                  onClick={() => askConfirm({ kind: "archive-vault" })}
                >
                  <ArchiveIcon />
                  <span className="max-sm:sr-only">{t.common.archive}</span>
                </Button>
              )}
              <Button
                variant="danger-ghost"
                className={HEADER_ACTION_CLS}
                title={t.common.delete}
                onClick={() => askConfirm({ kind: "delete-vault" })}
              >
                <Trash2Icon />
                <span className="max-sm:sr-only">{t.common.delete}</span>
              </Button>
            </>
          }
        />
      }
      rail={
        <section className="console-property-group" aria-label="Свойства хранилища">
          <h2 className="console-property-group-title">Свойства</h2>
          <dl className="console-property-list">
            <PropertyRow label={t.common.id}><span className="font-mono text-xs">{vault.id}</span></PropertyRow>
            <PropertyRow label={t.common.status}>
              <span className={`chip ${archived ? "tone-ghost" : "tone-success"}`}>
                {archived ? t.common.archived : "Активно"}
              </span>
            </PropertyRow>
            <PropertyRow label={t.common.created}>
              <span className="tabular-nums">{formatDateTime(vault.created_at)}</span>
            </PropertyRow>
            <PropertyRow label="Обновлено">
              <span className="tabular-nums">{formatDateTime(updatedAt)}</span>
            </PropertyRow>
            {archived && (
              <PropertyRow label="В архиве с">
                <span className="tabular-nums">{formatDateTime(vault.archived_at!)}</span>
              </PropertyRow>
            )}
          </dl>
        </section>
      }
    >
      <div className="console-detail-stack">
        <section
          className="console-detail-section card overflow-hidden"
          aria-labelledby="vault-credentials-title"
        >
          <header className="flex flex-wrap items-center gap-3 border-b border-ddc-divider px-5 py-4">
            <h2 id="vault-credentials-title" className="section-title mr-auto">
              Учётные данные
              {!credsLoading && <span className="count-pill">{credsCount}</span>}
            </h2>
            <FilterChip
              label={t.common.status}
              active={status !== "any"}
              display={statusDisplay}
              onClear={() => setStatus("any")}
            >
              <PopoverContent
                align="end"
                sideOffset={4}
                collisionPadding={8}
                className="w-48 p-0"
              >
                <FacetedFilter
                  options={STATUS_OPTIONS}
                  value={status}
                  onValueChange={(v) => setStatus(v as StatusValue)}
                  searchPlaceholder="Статус…"
                />
              </PopoverContent>
            </FilterChip>
            {!archived && (
              <Button onClick={() => setShowAddCred(true)}>
                <PlusIcon />
                Добавить
              </Button>
            )}
          </header>

          <div className="console-detail-table-wrap" data-testid="credential-list-surface">
            {credsLoading ? (
              <SkeletonRows count={3} />
            ) : filteredCreds.length === 0 ? (
              credentials.length === 0 ? (
                <EmptyState
                  size="sm"
                  className={EMPTY_IN_CARD}
                  icon={<KeyRoundIcon />}
                  title="Учётных данных пока нет"
                  body="Подключите MCP-сервер или добавьте токен CLI."
                  action={
                    !archived && (
                      <Button onClick={() => setShowAddCred(true)}>
                        <PlusIcon />
                        Добавить
                      </Button>
                    )
                  }
                />
              ) : (
                <EmptyState
                  size="sm"
                  className={EMPTY_IN_CARD}
                  icon={<SearchXIcon />}
                  title="Ничего не найдено"
                  body="Под выбранный статус ничего не подходит."
                  action={
                    <Button variant="outline" onClick={() => setStatus("any")}>
                      Сбросить фильтр
                    </Button>
                  }
                />
              )
            ) : (
              <Table className="console-detail-table max-lg:min-w-0!">
                <TableHeader variant="wireless">
                  <TableRow variant="wireless">
                    <TableHead className="pl-5!">{t.common.name}</TableHead>
                    <TableHead className="hidden 2xl:table-cell">{t.common.id}</TableHead>
                    <TableHead className="hidden w-44 lg:table-cell">Тип</TableHead>
                    <TableHead className="hidden 2xl:table-cell">Сервер или переменная</TableHead>
                    <TableHead className="hidden w-28 sm:table-cell">{t.common.status}</TableHead>
                    <TableHead className="hidden w-40 min-[1800px]:table-cell">Обновлено</TableHead>
                    <TableHead className="w-24 pr-5!">
                      <span className="sr-only">{t.common.actions}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCreds.map((c) => {
                    const typeView = credentialTypeView(c);
                    const credName = c.display_name || "Без названия";
                    return (
                      <TableRow variant="wireless" key={c.id}>
                        <TableCell className="pl-5!">
                          <div className="truncate font-medium text-ddc-heading" title={credName}>
                            {credName}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted lg:hidden">
                            <span className="truncate" title={typeView.label}>{typeView.label}</span>
                            {c.archived_at && (
                              <span className="chip tone-ghost sm:hidden">{t.common.archived}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden 2xl:table-cell">
                          <div className="truncate font-mono text-xs text-muted" title={c.id}>
                            {c.id}
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="chip tone-neutral max-w-full">
                            <span className="truncate" title={typeView.label}>{typeView.label}</span>
                          </span>
                        </TableCell>
                        <TableCell className="hidden 2xl:table-cell">
                          {typeView.target ? (
                            <div
                              className="truncate font-mono text-xs text-muted"
                              title={typeView.target}
                            >
                              {typeView.target}
                            </div>
                          ) : (
                            <span className="text-ddc-placeholder">Нет</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className={`chip ${c.archived_at ? "tone-ghost" : "tone-success"}`}>
                            {c.archived_at ? t.common.archived : "Активно"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted tabular-nums min-[1800px]:table-cell">
                          {formatDateTime(c.updated_at)}
                        </TableCell>
                        <TableCell className="pr-5!">
                          <div className="flex items-center justify-end gap-1">
                            {!c.archived_at && (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() => setEditingCred(c)}
                                className="text-ddc-icon-muted"
                                aria-label={`${t.common.edit}: ${credName}`}
                                title={t.common.edit}
                              >
                                <PencilIcon />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() =>
                                askConfirm({ kind: "delete-credential", id: c.id, name: credName })
                              }
                              className="text-ddc-icon-muted hover:bg-ddc-tone-danger-bg hover:text-ddc-danger-text"
                              aria-label={`${t.common.delete}: ${credName}`}
                              title={t.common.delete}
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </section>
      </div>

      {showAddCred && (
        <AddCredentialModal
          vault={vault}
          onClose={() => setShowAddCred(false)}
          onCreated={() => {
            setShowAddCred(false);
            reloadCredentials();
          }}
        />
      )}

      {showRename && (
        <RenameVaultModal
          vault={vault}
          onClose={() => setShowRename(false)}
          onSaved={() => {
            setShowRename(false);
            reloadVault();
          }}
        />
      )}

      {editingCred && (
        <EditCredentialModal
          vault={vault}
          credential={editingCred}
          onClose={() => setEditingCred(null)}
          onSaved={() => {
            setEditingCred(null);
            reloadCredentials();
          }}
        />
      )}

      <ConfirmDialog
        open={confirmOpen && pending?.kind === "delete-credential"}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={t.common.delete}
        destructive
        busy={confirmBusy}
        onConfirm={() => void runConfirmed()}
        onCancel={() => setConfirmOpen(false)}
      />
      <DangerDialog
        open={confirmOpen && pending?.kind === "archive-vault"}
        operation="archive"
        target={{ kind: "vault", id }}
        etagPath={id ? `/v1/vaults/${id}` : undefined}
        title="Отправить хранилище в архив?"
        message="Хранилище и его учётные данные станут недоступны агентам."
        confirmLabel={t.common.archive}
        run={(options) => managedApi.vaults.archive(id, options)}
        onDone={() => nav("/vaults")}
        onClose={() => setConfirmOpen(false)}
      />
      <DangerDialog
        open={confirmOpen && pending?.kind === "delete-vault"}
        operation="delete"
        target={{ kind: "vault", id }}
        etagPath={id ? `/v1/vaults/${id}` : undefined}
        title="Удалить хранилище?"
        message="Хранилище и все его учётные данные будут удалены."
        run={(options) => managedApi.vaults.delete(id, options)}
        onDone={() => nav("/vaults")}
        onClose={() => setConfirmOpen(false)}
      />
    </Page>
  );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="console-property-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// =================================================================
// Rename vault
// =================================================================

function RenameVaultModal({
  vault,
  onClose,
  onSaved,
}: {
  vault: Vault;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const { t } = useI18n();
  const [name, setName] = useState(vault.display_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t.common.nameRequired);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await managedApi.vaults.update(vault.id, { display_name: trimmed });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось переименовать хранилище");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.vaults.renameVault}
      closeDisabled={saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t.common.cancel}
          </Button>
          <Button onClick={save} disabled={!name.trim()} loading={saving}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div role="alert" className="callout-danger">
            {error}
          </div>
        )}
        <TextInput
          id="vault-rename"
          label={t.common.name}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
      </div>
    </Modal>
  );
}

// =================================================================
// Edit credential — display name + optional secret rotation
// =================================================================

function EditCredentialModal({
  vault,
  credential,
  onClose,
  onSaved,
}: {
  vault: Vault;
  credential: Credential;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState(credential.display_name ?? "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canRotateToken = credential.auth.type === "static_bearer";
  const typeView = credentialTypeView(credential);

  const save = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError(t.common.nameRequired);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body: Omit<CredentialUpdateParams, "betas"> = {
        vault_id: vault.id,
        display_name: trimmed,
      };
      if (credential.auth.type === "static_bearer" && token.trim()) {
        body.auth = { type: "static_bearer", token: token.trim() };
      }
      await managedApi.vaults.credentials.update(credential.id, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось обновить учётные данные");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.vaults.editCredential}
      subtitle={
        credential.auth.type === "mcp_oauth" ? t.vaults.oauthEditHint : undefined
      }
      closeDisabled={saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t.common.cancel}
          </Button>
          <Button onClick={save} disabled={!displayName.trim()} loading={saving}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div role="alert" className="callout-danger">
            {error}
          </div>
        )}
        <TextInput
          id="cred-edit-name"
          label={t.vaults.displayName}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoFocus
        />
        <div className="rounded-xl bg-ddc-surface-muted p-3 text-xs leading-4 text-muted">
          Тип: <span className="font-medium text-ddc-text">{typeView.label}</span>
          {typeView.target && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="font-mono break-all">{typeView.target}</span>
            </>
          )}
        </div>
        {canRotateToken && (
          <SecretInput
            id="cred-edit-token"
            label={t.vaults.newTokenOptional}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t.vaults.leaveBlankKeepToken}
          />
        )}
      </div>
    </Modal>
  );
}

// =================================================================
// Add credential modal — unified MCP / CLI (Anthropic-style)
// =================================================================

function AddCredentialModal({
  vault,
  onClose,
  onCreated,
}: {
  vault: Vault;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { api } = useApi();
  const managedApi = useManagedApi();
  const { t } = useI18n();

  // Top-level tab inside the modal: MCP server vs CLI. Folds the two
  // previously separate entry points into one modal; matches Anthropic.
  const [addTab, setAddTab] = useState<"mcp" | "cli">("mcp");
  const [connecting, setConnecting] = useState<string | null>(null);

  // Custom MCP server form — single inline form (Anthropic-style). All
  // fields in one view; refresh-token block reveals only when an access
  // token is filled (RFC 6749 §6: refresh_token requires access_token).
  const [customForm, setCustomForm] = useState({
    name: "",
    type: "oauth" as "oauth" | "bearer",
    url: "",
    pickedName: "",
    token: "",
    refreshToken: "",
    tokenEndpoint: "",
    authMethod: "client_secret_post" as
      | "client_secret_basic"
      | "client_secret_post"
      | "none",
    clientId: "",
    clientSecret: "",
  });
  const [tokenSectionOpen, setTokenSectionOpen] = useState(false);
  const [refreshSectionOpen, setRefreshSectionOpen] = useState(false);
  const [clientCredsSectionOpen, setClientCredsSectionOpen] = useState(false);

  // Add-CLI form (cap_cli credentials). Visible under the "CLI" tab.
  const [cliForm, setCliForm] = useState({
    cli_id: "gh",
    display_name: "",
    token: "",
  });

  // OAuth Device Authorization Grant state for cap_cli credentials.
  // Set when "Sign in via OAuth" is clicked; the poll loop fires until
  // ready / failure, then writes a cap_cli credential.
  const [deviceFlow, setDeviceFlow] = useState<{
    cli_id: string;
    session_id: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval_seconds: number;
    expires_at_ms: number;
    status: "polling" | "ready" | "expired" | "denied" | "error";
    error?: string;
  } | null>(null);

  // Listen for OAuth popup completion. Two transports because COOP
  // severs window.opener for providers like Sentry (which set
  // Cross-Origin-Opener-Policy: same-origin on their authorize page) —
  // postMessage from the popup back to us doesn't work in that case.
  // BroadcastChannel is same-origin and survives COOP, so use it as a
  // parallel channel; the popup posts to both. Either firing is enough.
  const handleOAuthMessage = useCallback(
    (event: MessageEvent | { data: unknown }) => {
      const data = (
        event as {
          data?: {
            type?: string;
            service?: string;
            probe_ok?: boolean;
            probe_message?: string | null;
          };
        }
      ).data;
      if (data?.type === "oauth_complete") {
        setConnecting(null);
        onCreated();
        // Surface the MCP probe result so the user knows whether the just-
        // stored credential will actually work. Same toasts as the legacy
        // VaultsList modal.
        const svc = data.service ?? "MCP-сервер";
        if (data.probe_ok === true) {
          toast.success(`Подключено: ${svc}, токен проверен.`);
        } else if (data.probe_ok === false) {
          toast.warning(
            data.probe_message
              ? `Подключено: ${svc}, но сервер вернул ошибку: ${data.probe_message}`
              : `Подключено: ${svc}, но сервер отклонил токен.`,
          );
        }
      }
    },
    [onCreated],
  );

  useEffect(() => {
    window.addEventListener("message", handleOAuthMessage);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("openma-oauth");
      bc.addEventListener("message", handleOAuthMessage);
    } catch {
      // Old browser without BroadcastChannel — fall back to postMessage only.
    }
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      if (bc) {
        bc.removeEventListener("message", handleOAuthMessage);
        bc.close();
      }
    };
  }, [handleOAuthMessage]);

  const connectMcp = (
    entry: McpRegistryEntry | { name: string; url: string },
    opts?: { clientId?: string; clientSecret?: string },
  ) => {
    setConnecting(entry.name);
    const params = new URLSearchParams({
      mcp_server_url: entry.url,
      vault_id: vault.id,
      redirect_uri: window.location.href,
    });
    if (opts?.clientId) params.set("client_id", opts.clientId);
    if (opts?.clientSecret) params.set("client_secret", opts.clientSecret);
    window.open(
      `/v1/oma/oauth/authorize?${params.toString()}`,
      "oauth",
      "width=600,height=700,popup=yes",
    );
  };

  const createBearerCred = async () => {
    setConnecting("custom");
    try {
      // OAuth-standard credential auth shape:
      //   - access_token + refresh_token + token_endpoint → mcp_oauth
      //     (server can refresh on 401 via vault-forward.refreshMcpOAuth).
      //   - access_token only → static_bearer (no auto-refresh).
      const hasRefresh = !!(customForm.refreshToken && customForm.tokenEndpoint);
      const tokenEndpointAuth: NonNullable<
        Extract<CredentialCreateParams["auth"], { type: "mcp_oauth" }>["refresh"]
      >["token_endpoint_auth"] =
        customForm.authMethod === "none"
          ? { type: "none" }
          : {
              type: customForm.authMethod,
              client_secret: customForm.clientSecret,
            };
      const auth: CredentialCreateParams["auth"] = hasRefresh
        ? {
            type: "mcp_oauth",
            access_token: customForm.token,
            mcp_server_url: customForm.url,
            refresh: {
              client_id: customForm.clientId,
              refresh_token: customForm.refreshToken,
              token_endpoint: customForm.tokenEndpoint,
              token_endpoint_auth: tokenEndpointAuth,
            },
          }
        : {
            type: "static_bearer",
            token: customForm.token,
            mcp_server_url: customForm.url,
          };
      await managedApi.vaults.credentials.create(vault.id, {
        display_name:
          customForm.name || customForm.pickedName || "MCP-сервер",
        auth,
      });
      onCreated();
    } finally {
      setConnecting(null);
    }
  };

  const submitCustom = () => {
    // Submit rules for the unified Add-credential MCP form:
    //   - Bearer type or Access token filled → POST a credential
    //     immediately (mcp_oauth if refresh_token present, else
    //     static_bearer). Button reads "Добавить".
    //   - Otherwise → start /v1/oma/oauth/authorize popup. Button reads
    //     "Подключить". Picking a registry row only fills the MCP Server
    //     field, never auto-connects.
    if (!customForm.url) return;
    if (customForm.type === "bearer" || customForm.token) {
      void createBearerCred();
    } else {
      connectMcp(
        {
          name:
            customForm.name || customForm.pickedName || customForm.url,
          url: customForm.url,
        },
        { clientId: customForm.clientId, clientSecret: customForm.clientSecret },
      );
    }
  };

  const createCapCliCred = async () => {
    const defaultName =
      CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.label ?? cliForm.cli_id;
    await api(`/v1/oma/vaults/${vault.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({
        display_name: cliForm.display_name || defaultName,
        auth: {
          type: "cap_cli",
          cli_id: cliForm.cli_id,
          token: cliForm.token,
        },
      }),
    });
    onCreated();
  };

  // Повторный клик по «Создать» не должен создать вторые учётные данные.
  const createCli = useAsyncAction(createCapCliCred);

  // Drive cap's OAuth Device Authorization Grant for the selected CLI.
  // Sequence: POST /initiate → show user_code + URL → poll /poll until
  // ready / terminal failure → write cap_cli credential and close modal.
  const startDeviceFlow = async () => {
    setDeviceFlow(null);
    try {
      const init = await api<{
        session_id: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        interval_seconds: number;
        expires_at_ms: number;
      }>(`/v1/oma/cap-cli/oauth/initiate`, {
        method: "POST",
        body: JSON.stringify({ vault_id: vault.id, cli_id: cliForm.cli_id }),
      });
      const flow = { ...init, cli_id: cliForm.cli_id, status: "polling" as const };
      setDeviceFlow(flow);
      void pollDeviceFlow(flow);
    } catch (err) {
      setDeviceFlow({
        cli_id: cliForm.cli_id,
        session_id: "",
        user_code: "",
        verification_uri: "",
        interval_seconds: 0,
        expires_at_ms: 0,
        status: "error",
        error: (err as Error).message,
      });
    }
  };

  const pollDeviceFlow = async (flow: {
    session_id: string;
    interval_seconds: number;
    expires_at_ms: number;
  }) => {
    let interval = flow.interval_seconds;
    while (Date.now() < flow.expires_at_ms) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      try {
        const r = await api<{
          status:
            | "pending"
            | "slow_down"
            | "ready"
            | "expired"
            | "denied"
            | "error";
          new_interval_seconds?: number;
          oauth_error?: string;
          description?: string;
          credential_id?: string;
        }>(`/v1/oma/cap-cli/oauth/poll`, {
          method: "POST",
          body: JSON.stringify({ session_id: flow.session_id }),
        });
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          interval = r.new_interval_seconds ?? interval + 5;
          continue;
        }
        if (r.status === "ready") {
          setDeviceFlow((prev) => (prev ? { ...prev, status: "ready" } : null));
          // Trigger a refetch so the new credential shows up; close after
          // a short delay so the user gets visual confirmation first.
          onCreated();
          setTimeout(() => {
            setDeviceFlow(null);
          }, 1500);
          return;
        }
        // expired / denied / error
        setDeviceFlow((prev) =>
          prev
            ? {
                ...prev,
                status: r.status as "expired" | "denied" | "error",
                error: r.description ?? r.oauth_error,
              }
            : null,
        );
        return;
      } catch (err) {
        setDeviceFlow((prev) =>
          prev
            ? { ...prev, status: "error", error: (err as Error).message }
            : null,
        );
        return;
      }
    }
    setDeviceFlow((prev) => (prev ? { ...prev, status: "expired" } : null));
  };

  const selectedCli = CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id);

  return (
    <Modal
      open
      onClose={onClose}
      title="Добавить учётные данные"
      maxWidth="max-w-lg"
      footer={
        addTab === "cli" ? (
          deviceFlow?.status === "polling" ? (
            <Button variant="ghost" onClick={() => setDeviceFlow(null)}>
              {t.common.cancel}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={createCli.loading}>
                {t.common.cancel}
              </Button>
              <Button
                onClick={createCli.run}
                disabled={!cliForm.token}
                loading={createCli.loading}
              >
                {t.common.create}
              </Button>
            </>
          )
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={submitCustom}
              loading={connecting === "custom"}
              disabled={
                !customForm.url ||
                !!connecting ||
                (customForm.type === "bearer" && !customForm.token)
              }
            >
              {customForm.token || customForm.type === "bearer"
                ? "Добавить"
                : "Подключить"}
            </Button>
          </>
        )
      }
    >
      <Tabs
        value={addTab}
        onValueChange={(v) => setAddTab(v as "mcp" | "cli")}
        aria-label="Добавить учётные данные"
      >
        <TabsList>
          <TabsTrigger value="mcp">MCP-сервер</TabsTrigger>
          <TabsTrigger value="cli">CLI</TabsTrigger>
        </TabsList>

        <TabsContent value="mcp" className="space-y-4">
          <p className="text-sm text-muted">
            Подключите MCP-сервер с авторизацией от имени пользователя.
          </p>

          <TextInput
            id="vault-mcp-name"
            label="Название (необязательно)"
            value={customForm.name}
            onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
            placeholder="Например, Трекер задач"
          />

          <div>
            <span id="vault-mcp-type-label" className={LABEL_CLS}>
              Тип
            </span>
            <div className="segmented" role="group" aria-labelledby="vault-mcp-type-label">
              {(["oauth", "bearer"] as const).map((kind) => (
                <PlainButton
                  key={kind}
                  type="button"
                  className="segmented-item"
                  aria-pressed={customForm.type === kind}
                  onClick={() => setCustomForm({ ...customForm, type: kind })}
                >
                  {kind === "oauth" ? "OAuth" : "Bearer-токен"}
                </PlainButton>
              ))}
            </div>
          </div>

          <div>
            <Label htmlFor="vault-mcp-server" className={LABEL_CLS}>
              MCP-сервер
            </Label>
            {/* Combobox: input filters the registry as you type. Pick a
                row to fill the URL; type a custom URL to ignore the registry. The
                dropdown renders into document.body via portal so it
                escapes Modal's overflow-y-auto clipping. */}
            <LocalCombobox
              id="vault-mcp-server"
              value={customForm.url}
              onChange={(text) =>
                setCustomForm({
                  ...customForm,
                  url: text,
                  pickedName: "",
                })
              }
              onPick={(entry) =>
                setCustomForm({
                  ...customForm,
                  url: entry.url,
                  pickedName: entry.name,
                })
              }
              options={MCP_REGISTRY}
              filter={(entry, q) =>
                !q ||
                entry.name.toLowerCase().includes(q) ||
                entry.url.toLowerCase().includes(q)
              }
              getKey={(entry) => entry.id}
              renderItem={(entry) => (
                <div className="flex min-w-0 items-center gap-3">
                  <ServerIcon aria-hidden="true" className="size-4 shrink-0 text-ddc-icon-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ddc-heading">
                      {entry.name}
                    </div>
                    <div className="truncate font-mono text-xs text-muted">
                      {entry.url}
                    </div>
                  </div>
                </div>
              )}
              placeholder="Найдите сервер в реестре или введите свой URL"
              emptyHint="Ничего не найдено. Введите свой URL."
            />
          </div>

          {/* Access token — collapsed Optional. Filling this switches the
              submit path to POST static_bearer + button label changes to
              "Добавить". Visible regardless of Type so the user can
              supply a pre-issued OAuth access_token without a handshake. */}
          <Disclosure
            title="Токен доступа"
            meta="Необязательно"
            open={tokenSectionOpen}
            onOpenChange={setTokenSectionOpen}
          >
            <SecretInput
              value={customForm.token}
              onChange={(e) =>
                setCustomForm({ ...customForm, token: e.target.value })
              }
              placeholder="••••••••"
              aria-label="Токен доступа"
            />
            <p className="mt-1.5 text-xs leading-4 text-muted">
              Если заполнить, учётные данные сохранятся как статический
              Bearer-токен, без OAuth-авторизации.
            </p>
          </Disclosure>

          {/* Refresh token block (Optional) — only meaningful when an
              Access token is also set (RFC 6749 §6 refresh_token grant). */}
          {customForm.token && (
            <Disclosure
              title="Токен обновления"
              meta="Необязательно"
              open={refreshSectionOpen}
              onOpenChange={setRefreshSectionOpen}
            >
              <div className="space-y-4">
                <SecretInput
                  value={customForm.refreshToken}
                  onChange={(e) =>
                    setCustomForm({
                      ...customForm,
                      refreshToken: e.target.value,
                    })
                  }
                  placeholder="Токен обновления OAuth"
                  aria-label="Токен обновления"
                />
                <TextInput
                  id="vault-token-endpoint"
                  label="Адрес выдачи токенов (token endpoint)"
                  value={customForm.tokenEndpoint}
                  onChange={(e) =>
                    setCustomForm({
                      ...customForm,
                      tokenEndpoint: e.target.value,
                    })
                  }
                  placeholder="https://auth.example.com/oauth/token"
                />
                <Field
                  label="Способ аутентификации клиента"
                  hint="Значения из token_endpoint_auth_methods_supported (RFC 8414). Нужны, когда сервер обновляет токен после ответа 401."
                >
                  <Select
                    id="vault-auth-method"
                    value={customForm.authMethod}
                    onValueChange={(value) =>
                      setCustomForm({
                        ...customForm,
                        authMethod: value as typeof customForm.authMethod,
                      })
                    }
                  >
                    <SelectOption value="client_secret_post">client_secret_post</SelectOption>
                    <SelectOption value="client_secret_basic">client_secret_basic</SelectOption>
                    <SelectOption value="none">none</SelectOption>
                  </Select>
                </Field>
              </div>
            </Disclosure>
          )}
          {/* OAuth client credentials (Optional) — only shown for the
              OAuth flow. Lets the user override the server's preset
              client_id/secret on a per-credential basis (GitHub, Feishu,
              any provider that doesn't support DCR). */}
          {customForm.type === "oauth" && !customForm.token && (
            <Disclosure
              title="Учётные данные OAuth-клиента"
              meta="Необязательно"
              open={clientCredsSectionOpen}
              onOpenChange={setClientCredsSectionOpen}
            >
              <div className="space-y-4">
                <TextInput
                  value={customForm.clientId}
                  onChange={(e) =>
                    setCustomForm({ ...customForm, clientId: e.target.value })
                  }
                  placeholder="ID клиента"
                  aria-label="ID OAuth-клиента"
                />
                <SecretInput
                  value={customForm.clientSecret}
                  onChange={(e) =>
                    setCustomForm({
                      ...customForm,
                      clientSecret: e.target.value,
                    })
                  }
                  placeholder="Секрет клиента"
                  aria-label="Секрет OAuth-клиента"
                />
                <p className="text-xs leading-4 text-muted">
                  Для OAuth-провайдеров без динамической регистрации клиентов
                  (GitHub, Feishu): укажите client_id и секрет из заранее
                  созданного приложения.
                </p>
              </div>
            </Disclosure>
          )}
        </TabsContent>

        <TabsContent value="cli" className="space-y-4">
          <Field label="CLI" hint={selectedCli?.helper}>
            <Select
              id="vault-cli-id"
              value={cliForm.cli_id}
              onValueChange={(value) => {
                setCliForm({ ...cliForm, cli_id: value });
                setDeviceFlow(null);
              }}
              disabled={deviceFlow?.status === "polling"}
            >
              {CAP_CLIS.map((c) => (
                <SelectOption key={c.cli_id} value={c.cli_id}>
                  {c.label}
                  {c.oauth ? " (есть вход через OAuth)" : ""}
                </SelectOption>
              ))}
            </Select>
          </Field>

          {selectedCli?.oauth && (
            <div className="rounded-xl bg-ddc-surface-muted p-3">
              {!deviceFlow && (
                <Button variant="outline" onClick={startDeviceFlow}>
                  Войти через {cliForm.cli_id} OAuth
                </Button>
              )}
              {deviceFlow?.status === "polling" && (
                <div className="space-y-3 text-sm">
                  <p className="text-ddc-label">
                    Откройте{" "}
                    <a
                      href={
                        deviceFlow.verification_uri_complete ??
                        deviceFlow.verification_uri
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="link break-all"
                    >
                      {deviceFlow.verification_uri_complete ??
                        deviceFlow.verification_uri}
                    </a>{" "}
                    и введите код:
                  </p>
                  <div className="py-2 text-center font-mono text-xl tracking-widest text-ddc-heading select-all">
                    {deviceFlow.user_code}
                  </div>
                  <p className="flex items-center justify-center gap-2 text-xs text-muted">
                    <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                    Ждём подтверждения. Проверка каждые {deviceFlow.interval_seconds} с.
                  </p>
                </div>
              )}
              {deviceFlow?.status === "ready" && (
                <div className="flex items-center gap-2 text-sm text-ddc-success-text">
                  <CheckCircleIcon className="size-4 flex-none" aria-hidden="true" />
                  Токен получен и сохранён.
                </div>
              )}
              {(deviceFlow?.status === "expired" ||
                deviceFlow?.status === "denied" ||
                deviceFlow?.status === "error") && (
                <div role="alert" className="text-sm text-ddc-danger-text">
                  {deviceFlow.status === "denied"
                    ? "Пользователь отклонил доступ."
                    : deviceFlow.status === "expired"
                      ? "Код истёк. Попробуйте ещё раз."
                      : `Ошибка OAuth: ${deviceFlow.error ?? "неизвестная"}`}
                </div>
              )}
            </div>
          )}

          <TextInput
            id="vault-cli-display-name"
            label="Отображаемое имя (необязательно)"
            value={cliForm.display_name}
            onChange={(e) =>
              setCliForm({ ...cliForm, display_name: e.target.value })
            }
            placeholder={selectedCli?.label ?? cliForm.cli_id}
            disabled={deviceFlow?.status === "polling"}
          />
          <SecretInput
            id="vault-cli-token"
            label="Токен"
            hint={
              selectedCli?.oauth
                ? "Только запись. Оставьте пустым, чтобы войти через OAuth выше."
                : "Только запись."
            }
            value={cliForm.token}
            onChange={(e) =>
              setCliForm({ ...cliForm, token: e.target.value })
            }
            placeholder="••••••••"
            disabled={deviceFlow?.status === "polling"}
          />
        </TabsContent>
      </Tabs>
    </Modal>
  );
}
