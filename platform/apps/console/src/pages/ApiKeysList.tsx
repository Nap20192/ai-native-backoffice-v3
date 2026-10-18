import { formatDate } from "../lib/date-format";
import { Input } from "@/components/ui/input";
import { useEffect, useMemo, useState } from "react";
import { CopyIcon, TriangleAlertIcon, XCircleIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Field } from "../components/Field";
import { Button } from "@/components/ui/button";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { useI18n } from "../i18n";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
}

export function ApiKeysList() {
  const { api } = useApi();
  const { t } = useI18n();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [error, setError] = useState("");

  // Отзыв ключа подтверждается окном ConfirmDialog (правило 11 DDC). Ключ
  // не сбрасываем при закрытии: текст окна не должен пропасть, пока оно
  // уходит с экрана.
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setKeys((await api<{ data: ApiKey[] }>("/v1/oma/api_keys")).data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // useAsyncAction guards re-entry: a fast double-click on the Create
  // button used to fire two POSTs and produce two records 0.5-1s apart.
  // The hook + Button loading prop handle this universally now.
  const create = useAsyncAction(async () => {
    setError("");
    try {
      const result = await api<{ key: string }>("/v1/oma/api_keys", {
        method: "POST",
        body: JSON.stringify({ name: name || t.apiKeys.untitledKey }),
      });
      setCreatedKey(result.key);
      setName("");
      load();
    } catch (e: any) {
      setError(e?.message || "Не удалось создать ключ");
    }
  });

  const askRevoke = (key: ApiKey) => {
    setRevokeTarget(key);
    setRevokeOpen(true);
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api(`/v1/oma/api_keys/${revokeTarget.id}`, { method: "DELETE" });
      load();
    } catch {}
    setRevoking(false);
    setRevokeOpen(false);
  };

  const closeDialog = () => {
    setShowCreate(false);
    setCreatedKey("");
    setName("");
    setError("");
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success(t.common.copied);
    } catch {
      // Буфер обмена недоступен (например, не защищённый контекст): ключ
      // остаётся на экране, его можно выделить и скопировать вручную.
    }
  };

  // Поиск по ключам на клиенте: список плоский и короткий.
  const visibleKeys = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return needle
      ? keys.filter((key) => `${key.name}\n${key.prefix}\n${key.id}`.toLocaleLowerCase().includes(needle))
      : keys;
  }, [keys, search]);

  // TanStack column defs. API keys come back as a small flat list (no
  // pagination, no server filters) so there's no per-column sort or
  // filter UI to wire up. `name` and `actions` opt out of the Columns
  // hide menu — without the name you can't tell keys apart, and without
  // Revoke the table becomes read-only.
  const columns = useMemo<ColumnDef<ApiKey>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: t.common.name,
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium text-ddc-heading" title={row.original.name}>
              {row.original.name}
            </div>
            <div className="truncate font-mono text-xs text-muted" title={row.original.id}>
              {row.original.id}
            </div>
          </div>
        ),
        enableHiding: false,
      },
      {
        id: "key",
        accessorKey: "prefix",
        header: "Ключ",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted">{row.original.prefix}...</span>
        ),
      },
      {
        id: "created",
        accessorKey: "created_at",
        header: t.common.created,
        cell: ({ row }) => (
          <span className="text-xs text-muted tabular-nums">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [t],
  );

  return (
    <DataTable<ApiKey>
      title={t.nav.apiKeys}
      subtitle="Ключи для работы с платформой из командной строки и SDK. Значение ключа показывается один раз при создании."
      createLabel={t.apiKeys.newApiKey}
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Поиск ключей…"
      searchValue={search}
      onSearchChange={setSearch}
      data={visibleKeys}
      loading={loading}
      getRowId={(k) => k.id}
      rowActions={(key) => [
        {
          label: t.apiKeys.revokeKey,
          icon: <XCircleIcon className="size-4" />,
          destructive: true,
          onSelect: () => askRevoke(key),
        },
      ]}
      emptyTitle={search.trim() ? "Ключи не найдены" : t.apiKeys.noApiKeysYet}
      emptyKind="api_key"
      emptySubtitle={
        search.trim()
          ? "Измените поисковый запрос."
          : "Создайте API-ключ, чтобы работать с платформой из SDK или скриптов."
      }
      emptyAction={
        !search.trim() && (
          <Button onClick={() => setShowCreate(true)}><PlusIcon />{t.apiKeys.newApiKey}</Button>
        )
      }
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={closeDialog}
        title={createdKey ? "API-ключ создан" : "Новый API-ключ"}
        closeDisabled={create.loading}
        footer={
          createdKey ? (
            <Button onClick={closeDialog}>Готово</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={create.loading}>
                {t.common.cancel}
              </Button>
              <Button onClick={create.run} loading={create.loading}>
                {t.common.create}
              </Button>
            </>
          )
        }
      >
        {createdKey ? (
          <div className="space-y-4">
            <div role="note" className="callout-warning">
              <TriangleAlertIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
              Скопируйте ключ сейчас. Позже он не будет показан.
            </div>
            <div className="rounded-xl bg-ddc-surface-muted p-3">
              <code className="font-mono text-sm break-all text-ddc-text select-all">
                {createdKey}
              </code>
            </div>
            <Button variant="outline" onClick={() => void copyKey()}>
              <CopyIcon />
              Скопировать
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <div role="alert" className="callout-danger">
                {error}
              </div>
            )}
            <Field label="Название (необязательно)">
              <Input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например, CLI или CI/CD"
              />
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={revokeOpen}
        title="Отозвать API-ключ?"
        message={
          revokeTarget
            ? `Ключ «${revokeTarget.name}» перестанет работать. Действие нельзя отменить.`
            : "Действие нельзя отменить."
        }
        confirmLabel={t.apiKeys.revokeKey}
        destructive
        busy={revoking}
        onConfirm={() => void revoke()}
        onCancel={() => setRevokeOpen(false)}
      />
    </DataTable>
  );
}
