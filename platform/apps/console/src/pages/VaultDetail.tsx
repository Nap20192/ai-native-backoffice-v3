import { useCrumbName } from "../lib/crumb-names";
import { formatDateTime } from "../lib/date-format";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  KeyRoundIcon,
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

import { MCP_REGISTRY } from "../data/mcp-registry";
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
  // Мёртвая ветка, уходит в шаге 2 плана cleanup. Мост GitHub пишет cap_cli
  // через старый credentialService в таблицу `credentials`, а эта страница
  // читает /v1/vaults/:id/credentials из `managed_credentials`. В контракте
  // /v1 такого вида нет, поэтому сюда строка cap_cli не доходит.
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
                  body="Подключите MCP-сервер."
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
// Add credential modal: MCP server (Anthropic-style)
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
  const managedApi = useManagedApi();
  const { t } = useI18n();

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
  // Submit needs the access token for both types, so its section starts open.
  const [tokenSectionOpen, setTokenSectionOpen] = useState(true);
  const [refreshSectionOpen, setRefreshSectionOpen] = useState(false);

  // The OAuth popup flow is gone: the Node server has no
  // /v1/oma/oauth/authorize route (404), so the popup could never finish.
  // Both types now need an access token and go through the direct create.

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
    //   - MCP server URL and access token filled → POST a credential
    //     (mcp_oauth if refresh_token present, else static_bearer).
    //   - No access token → nothing to send. The OAuth popup flow is not
    //     available on this server, so the submit button stays disabled
    //     and the OAuth type shows a note instead.
    // Picking a registry row only fills the MCP Server field, never
    // auto-connects.
    if (!customForm.url || !customForm.token) return;
    void createBearerCred();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Добавить учётные данные"
      maxWidth="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            onClick={submitCustom}
            loading={connecting === "custom"}
            disabled={!customForm.url || !!connecting || !customForm.token}
          >
            Добавить
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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

        {/* Access token. Submit needs it for both types: the OAuth popup
            flow is not available on this server, so an OAuth credential
            is a pre-issued access_token. Required, so no "optional" meta
            and the section starts open. */}
        <Disclosure
          title="Токен доступа"
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
            Без токена обновления учётные данные сохранятся как статический
            Bearer-токен.
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
              {/* OAuth client credentials: createBearerCred reads them only
                  for mcp_oauth (refresh.client_id and the client_secret of
                  token_endpoint_auth), so they live with the refresh token. */}
              <TextInput
                value={customForm.clientId}
                onChange={(e) =>
                  setCustomForm({ ...customForm, clientId: e.target.value })
                }
                placeholder="ID клиента"
                aria-label="ID OAuth-клиента"
              />
              <div>
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
                <p className="mt-1.5 text-xs leading-4 text-muted">
                  ID и секрет OAuth-клиента нужны, чтобы сервер обновил токен.
                </p>
              </div>
            </div>
          </Disclosure>
        )}
        {customForm.type === "oauth" && !customForm.token && (
          <div role="note" className="callout-warning">
            <TriangleAlertIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            Вход через OAuth на этом сервере пока не работает. Вставьте токен доступа, он нужен для
            подключения.
          </div>
        )}
      </div>
    </Modal>
  );
}
