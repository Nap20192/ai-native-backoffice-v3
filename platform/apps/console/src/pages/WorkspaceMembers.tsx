import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { AlertCircleIcon, CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadError } from "../components/LoadError";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { ApiError, useApi, setActiveTenantId } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { formatDateTime } from "./ru-format";

const copy = {
  title: "Участники",
  subtitle: "Кто имеет доступ к этому рабочему пространству.",
  shared:
    "Участники работают с общими ресурсами пространства. Владельцы управляют ролями, администраторы приглашают и удаляют участников.",
  owner: "Владелец",
  admin: "Администратор",
  member: "Участник",
  name: "Участник",
  role: "Роль",
  remove: "Удалить",
  cancel: "Отмена",
  invite: "Создать ссылку-приглашение",
  invites: "Ожидающие приглашения",
  inviteHelp:
    "По ссылке можно присоединиться один раз в течение 7 дней. Передайте её только тому, кого приглашаете.",
  link: "Ссылка-приглашение",
  copy: "Скопировать ссылку",
  copied: "Скопировано",
  revoke: "Отозвать",
  expires: "Действует до",
  noInvites: "Ожидающих приглашений нет.",
  loading: "Загрузка участников…",
  retry: "Повторить",
  loadFailed: "Не удалось загрузить участников",
  actionFailed: "Не удалось выполнить действие. Проверьте соединение и повторите попытку.",
  copyFailed: "Не удалось скопировать ссылку",
  expired:
    "Срок действия приглашения истёк. Попросите администратора прислать новую ссылку.",
  removeTitle: (name: string) => `Удалить участника ${name}?`,
  removeHelp:
    "Участник потеряет доступ к рабочему пространству и свои личные API-ключи для него. Если у него была копия общих ключей пространства, замените их.",
  join: "Присоединиться к рабочему пространству",
  joinHelp:
    "Примите приглашение, чтобы работать с ресурсами пространства вместе с остальными участниками.",
  login: "Войти и принять приглашение",
  missing:
    "Ссылка-приглашение неполная. Попросите администратора пространства прислать новую.",
  back: "К рабочему пространству",
  loadingAuth: "Проверяем вход…",
};
type Role = "owner" | "admin" | "member";
interface Member {
  user_id: string;
  name?: string;
  email?: string;
  role: Role;
}
interface Invitation {
  id: string;
  role: Role;
  expires_at: number;
}
interface Members {
  data: Member[];
  role: Role;
  user_id: string;
}

/** Плитка роли: владелец и администратор в тоне brand, участник нейтральный. */
function RoleChip({ role, label }: { role: Role; label: string }) {
  return (
    <span className={`chip ${role === "member" ? "tone-neutral" : "tone-brand"}`}>{label}</span>
  );
}

/** Аватар 40px с первой буквой имени (размеры аватара DDC: 24, 32, 40, 64, 96). */
function MemberAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-10 flex-none items-center justify-center rounded-full bg-ddc-primary text-sm font-semibold tracking-tight text-ddc-on-primary shadow-xs select-none"
    >
      {name.charAt(0).toUpperCase() || "·"}
    </span>
  );
}

export function WorkspaceMembers() {
  const { api } = useApi();
  const t = copy;
  const [workspace, setWorkspace] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [members, setMembers] = useState<Members | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  // Ошибка загрузки страницы (рисует LoadError) и ошибка действия в окне
  // удаления (рисует окно) хранятся отдельно: страница не краснеет из-за сбоя
  // в окне, а окно не показывает сбой загрузки.
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  // Имя удаляемого участника остаётся в заголовке, пока окно закрывается.
  const [removeName, setRemoveName] = useState("");
  const load = useCallback(async () => {
    const me = await api<{ tenant: { id: string; name: string } }>(
      "/v1/oma/me",
      { quiet: true },
    );
    const base = `/v1/oma/tenants/${encodeURIComponent(me.tenant.id)}`;
    const result = await api<Members>(`${base}/members`, { quiet: true });
    const pending =
      result.role === "member"
        ? []
        : (await api<{ data: Invitation[] }>(`${base}/invitations`, { quiet: true })).data;
    setWorkspace(me.tenant);
    setMembers(result);
    setInvitations(pending);
  }, [api]);
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      await load();
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : t.actionFailed);
    } finally {
      setLoading(false);
    }
  }, [load, t.actionFailed]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const action = useAsyncAction(async (work: () => Promise<void>) => {
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.actionFailed);
    }
  });
  const base = `/v1/oma/tenants/${encodeURIComponent(workspace?.id ?? "")}`;
  const canManage = members?.role === "owner" || members?.role === "admin";
  const createInvite = () =>
    action.run(async () => {
      const result = await api<{ token: string }>(`${base}/invitations`, {
        method: "POST",
        body: JSON.stringify({ role: inviteRole }),
      });
      setLink(`${window.location.origin}/join#${result.token}`);
      setCopied(false);
    });
  return (
    <div className="page w-full max-w-4xl space-y-6">
      <PageHeader
        title={t.title}
        description={`${workspace?.name ? `${workspace.name} · ` : ""}${t.subtitle}`}
      />
      {loadError && !loading && (
        <LoadError
          title={t.loadFailed}
          message={loadError}
          retryLabel={t.retry}
          onRetry={() => void refresh()}
        />
      )}
      {loading ? (
        <div role="status" aria-busy="true" className="card overflow-hidden">
          <span className="sr-only">{t.loading}</span>
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 border-t border-ddc-divider px-5 py-3 first-of-type:border-t-0"
            >
              <Skeleton className="size-10 flex-none" rounded="full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
              <Skeleton className="h-5 w-24" rounded="md" />
            </div>
          ))}
        </div>
      ) : (
        members && (
          <>
            <section className="card overflow-hidden" aria-label={t.title}>
              <div className="border-b border-ddc-divider px-5 py-4">
                <h2 className="section-title">
                  {t.title}
                  <span className="count-pill">{members.data.length}</span>
                </h2>
                <p className="mt-1 max-w-2xl text-xs text-muted">{t.shared}</p>
              </div>
              <ul className="divide-y divide-ddc-divider">
                {members.data.map((member) => {
                  const name = member.name || member.email || member.user_id;
                  const removable =
                    member.role !== "owner" &&
                    (members.role === "owner" ||
                      (members.role === "admin" && member.role === "member"));
                  return (
                    <li
                      key={member.user_id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                    >
                      <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
                        <MemberAvatar name={name} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ddc-heading" title={name}>
                            {name}
                          </p>
                          {member.email && (
                            <p className="truncate text-xs text-muted" title={member.email}>
                              {member.email}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-none items-center gap-2">
                        {members.role === "owner" && member.role !== "owner" ? (
                          <Select
                            value={member.role}
                            disabled={action.loading}
                            onValueChange={(role) =>
                              void action.run(async () => {
                                await api(
                                  `${base}/members/${encodeURIComponent(member.user_id)}`,
                                  {
                                    method: "PATCH",
                                    body: JSON.stringify({ role }),
                                  },
                                );
                              })
                            }
                          >
                            <SelectTrigger aria-label={`${t.role}: ${name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="member">{t.member}</SelectItem>
                              <SelectItem value="admin">{t.admin}</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <RoleChip role={member.role} label={t[member.role]} />
                        )}
                        {removable && (
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            disabled={action.loading}
                            aria-label={`${t.remove} ${name}`}
                            onClick={() => {
                              setError("");
                              setRemoveName(name);
                              setRemoving(member);
                            }}
                          >
                            {t.remove}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
            {canManage && (
              <section
                className="card space-y-4 p-5"
                aria-labelledby="workspace-invitations"
              >
                <div>
                  <h2 id="workspace-invitations" className="section-title">
                    {t.invites}
                    {invitations.length > 0 && (
                      <span className="count-pill">{invitations.length}</span>
                    )}
                  </h2>
                  <p className="mt-1 max-w-2xl text-xs text-muted">{t.inviteHelp}</p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  {members.role === "owner" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="invite-role" className="text-xs leading-4 text-ddc-label">
                        {t.role}
                      </Label>
                      <Select
                        value={inviteRole}
                        onValueChange={(role) =>
                          setInviteRole(role as "admin" | "member")
                        }
                        disabled={action.loading}
                      >
                        <SelectTrigger id="invite-role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="member">{t.member}</SelectItem>
                          <SelectItem value="admin">{t.admin}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <Button
                    onClick={() => void createInvite()}
                    disabled={action.loading}
                  >
                    {t.invite}
                  </Button>
                </div>
                {link && (
                  <div className="space-y-1.5">
                    <Label htmlFor="invitation-link" className="text-xs leading-4 text-ddc-label">
                      {t.link}
                    </Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        id="invitation-link"
                        className="min-w-0 flex-1 basis-56 font-mono text-xs"
                        readOnly
                        value={link}
                        onFocus={(e) => e.target.select()}
                      />
                      <Button
                        variant="outline"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(link);
                            setCopied(true);
                          } catch {
                            toast.error(t.copyFailed);
                          }
                        }}
                      >
                        {copied ? <CheckIcon /> : <CopyIcon />}
                        {copied ? t.copied : t.copy}
                      </Button>
                    </div>
                  </div>
                )}
                {invitations.length === 0 ? (
                  <p className="text-sm text-muted">{t.noInvites}</p>
                ) : (
                  <ul className="-mx-5 divide-y divide-ddc-divider border-t border-ddc-divider">
                    {invitations.map((invitation) => (
                      <li
                        key={invitation.id}
                        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                          <RoleChip role={invitation.role} label={t[invitation.role]} />
                          <p className="text-sm text-muted tabular-nums">
                            {t.expires}: {formatDateTime(invitation.expires_at)}
                          </p>
                        </div>
                        {(members.role === "owner" ||
                          invitation.role === "member") && (
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            disabled={action.loading}
                            onClick={() =>
                              void action.run(async () => {
                                await api(
                                  `${base}/invitations/${invitation.id}`,
                                  { method: "DELETE" },
                                );
                                setLink("");
                              })
                            }
                          >
                            {t.revoke}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )
      )}
      <ConfirmDialog
        open={!!removing}
        title={t.removeTitle(removeName)}
        message={
          <>
            {t.removeHelp}
            {error && (
              <span role="alert" className="text-error mt-2 block">
                {error}
              </span>
            )}
          </>
        }
        confirmLabel={t.remove}
        cancelLabel={t.cancel}
        destructive
        busy={action.loading}
        onCancel={() => {
          if (!action.loading) {
            setRemoving(null);
            setError("");
          }
        }}
        onConfirm={() =>
          void action.run(async () => {
            if (!removing) return;
            await api(
              `${base}/members/${encodeURIComponent(removing.user_id)}`,
              { method: "DELETE", quiet: true },
            );
            setRemoving(null);
          })
        }
      />
    </div>
  );
}

export function JoinWorkspace() {
  const { api } = useApi();
  const t = copy;
  const auth = useAuth();
  const location = useLocation();
  const token = location.hash.slice(1);
  const [error, setError] = useState("");
  const join = useAsyncAction(async () => {
    setError("");
    try {
      const result = await api<{ tenant_id: string }>(
        "/v1/oma/tenants/invitations/accept",
        {
          method: "POST",
          headers: { "x-active-tenant": "" },
          body: JSON.stringify({ token }),
        },
      );
      setActiveTenantId(result.tenant_id);
      window.location.replace("/members");
    } catch (e) {
      // 410: приглашение просрочено или уже использовано.
      setError(
        e instanceof ApiError
          ? e.status === 410
            ? t.expired
            : e.message
          : t.actionFailed,
      );
    }
  });
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ddc-bg p-6">
      <div className="card w-full max-w-md space-y-5 p-6 sm:p-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ddc-heading">{t.join}</h1>
          <p className="mt-1 text-sm text-muted">{token ? t.joinHelp : t.missing}</p>
        </div>
        {error && (
          <div role="alert" className="callout-danger">
            <AlertCircleIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}
        {token &&
          (auth.isLoading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted">
              <Spinner aria-hidden="true" />
              {t.loadingAuth}
            </p>
          ) : auth.isAuthenticated ? (
            <Button className="w-full" loading={join.loading} onClick={() => void join.run()}>
              {t.join}
            </Button>
          ) : (
            <Button asChild className="w-full">
              <Link
                to={`/login?next=${encodeURIComponent(location.pathname + location.hash)}`}
              >
                {t.login}
              </Link>
            </Button>
          ))}
        <Link to="/" className="link inline-flex text-sm">
          {t.back}
        </Link>
      </div>
    </main>
  );
}
