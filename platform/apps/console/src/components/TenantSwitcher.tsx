import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { ChevronsUpDownIcon, PlusIcon, CheckIcon } from "lucide-react";

import { useApi, getActiveTenantId, setActiveTenantId } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { useI18n, type Messages } from "../i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar } from "./Avatar";

// Блок рабочего пространства в шапке бокового меню. Выпадающий список
// показывает все членства и кнопку «Создать рабочее пространство».
// Переключение пишет id в localStorage и перезагружает страницу, чтобы все
// смонтированные запросы заново ушли с новым tenant.
//
// Список построен на DropdownMenu из shadcn (Radix и Floating UI): он сам
// разворачивается вверх или вниз и сдвигается вбок, если упирается в край окна.

interface Tenant {
  id: string;
  name: string;
  role: string;
}

/** Роль из API (`owner`, `admin`, `member`) выводится словарным названием. */
function roleLabel(messages: Messages, role: string): string {
  switch (role) {
    case "owner":
      return messages.profile.roleOwner;
    case "admin":
      return messages.profile.roleAdmin;
    case "member":
      return messages.profile.roleMember;
    default:
      return role;
  }
}

function displayName(t: Tenant): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) return t.id;
  return trimmed;
}

export function TenantSwitcher() {
  const [active, setActive] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const { t } = useI18n();

  // Список членств берётся через TanStack Query: повторный монтаж (свернули и
  // развернули меню) берёт кэш, а не идёт снова в /v1/oma/me/tenants. 401 до
  // входа глушится списком ошибок авторизации в useApi.
  const { data: tenantsRes } = useApiQuery<{ data: Tenant[] }>(
    "/v1/oma/me/tenants",
  );
  const tenants = tenantsRes?.data ?? [];

  // Когда список членств пришёл, сверяем закреплённое пространство. Источник
  // правды между загрузками страницы это localStorage; при первом заходе или
  // если сохранённого id уже нет среди членств, берём то, что выбрал бэкенд
  // (его цепочка выбора заканчивается на user.tenantId).
  useEffect(() => {
    if (tenants.length === 0) return;
    const stored = getActiveTenantId();
    if (stored && tenants.some((t) => t.id === stored)) {
      setActive(stored);
    } else {
      setActive(tenants[0].id);
      setActiveTenantId(tenants[0].id);
    }
  }, [tenants]);

  const switchTo = (id: string) => {
    setActiveTenantId(id);
    // Полная перезагрузка дешевле, чем тянуть активное пространство в запросы
    // каждой страницы. Стоит меньше секунды.
    window.location.reload();
  };

  // Строка рисуется всегда, даже до ответа `/v1/oma/me/tenants`, чтобы высота
  // шапки меню не прыгала между пустым и загруженным видом.
  const current = tenants.find((t) => t.id === active);

  // `current` появляется на втором проходе, когда эффект выбрал активное
  // пространство из списка. До этого строка держит свой размер с заглушкой
  // вместо аватара, и при загрузке меняются только буква и название.
  const ready = current != null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            aria-label={t.profile.switchWorkspace}
            data-sidebar-overlay-trigger
            disabled={!ready}
            className="console-sidebar-row console-sidebar-tenant-trigger disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span data-sidebar-slot data-sidebar-track="icon">
              {ready ? (
                <Avatar name={displayName(current)} size="sm" squared />
              ) : (
                <span className="console-tenant-skeleton" aria-hidden="true" />
              )}
            </span>
            <div className="console-tenant-text" data-sidebar-track="label">
              <div className="console-tenant-name" title={ready ? displayName(current) : undefined}>
                {ready ? displayName(current) : " "}
              </div>
              {ready && tenants.length > 1 && (
                <div className="console-tenant-role">{roleLabel(t, current.role)}</div>
              )}
            </div>
            {ready && (
              <ChevronsUpDownIcon
                className="console-tenant-chevron"
                aria-hidden="true"
              />
            )}
          </Button>
        </DropdownMenuTrigger>

        {/* Предпочтительная сторона `bottom`; Radix сам переворачивает меню
            вверх, если оно не помещается. `align` прижимает левый край к
            триггеру, collisionPadding оставляет зазор до края окна. */}
        <DropdownMenuContent
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="console-tenant-menu"
        >
          {tenants.map((t) => (
            <DropdownMenuItem
              key={t.id}
              onSelect={() => switchTo(t.id)}
              className="console-tenant-menu-item"
            >
              <Avatar name={displayName(t)} size="xs" squared />
              <span className="min-w-0 truncate" title={displayName(t)}>
                {displayName(t)}
              </span>
              {t.id === active && (
                <CheckIcon className="size-4 shrink-0 text-ddc-accent-text" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setCreateOpen(true)}
            className="console-tenant-menu-item"
            data-create-workspace
          >
            <PlusIcon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{t.profile.createWorkspace}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateTenantModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(t) => {
          // Сразу переключаемся на новое пространство. Перезагрузка заставляет
          // каждую страницу запросить данные с новым заголовком tenant.
          setActiveTenantId(t.id);
          window.location.reload();
        }}
      />
    </>
  );
}

function CreateTenantModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Tenant) => void;
}) {
  const { api } = useApi();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setWorking(true);
    setError("");
    try {
      const res = await api<Tenant>("/v1/oma/tenants", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      onCreated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t.profile.createWorkspace.replace("…", "")}>
      <div className="space-y-4">
        <p className="text-sm text-ddc-text-muted">
          {t.profile.createWorkspaceDesc}
        </p>
        <div>
          <Label
            htmlFor="tenant-create-name"
            className="mb-1.5 block text-xs font-medium text-ddc-label"
          >
            {t.profile.workspaceName}
          </Label>
          <Input
            id="tenant-create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={t.profile.workspacePlaceholder}
            autoFocus
            disabled={working}
            className="w-full"
          />
        </div>
        {error && (
          <div
            role="alert"
            className="rounded-xl bg-ddc-tone-danger-bg px-4 py-3 text-sm text-ddc-tone-danger-fg ring-1 ring-inset ring-ddc-tone-danger-ring"
          >
            {error}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={working}>
            {t.common.cancel}
          </Button>
          <Button onClick={submit} disabled={working || !name.trim()}>
            {working ? t.profile.creating : t.profile.createWorkspace.replace("…", "")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
