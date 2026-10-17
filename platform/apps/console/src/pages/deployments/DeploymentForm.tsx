import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type {
  DeploymentCreateParams,
  DeploymentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/deployments";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { Combobox } from "../../components/Combobox";
import { Page } from "../../components/Page";
import { PageHeader } from "../../components/PageHeader";
import { Select, SelectOption } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import {
  ResourceListEditor,
  ResourceSchema,
  resourcesToWire,
  type FilePick,
  type MemoryStorePick,
} from "../../components/ResourceListEditor";
import { useCrumbName } from "../../lib/crumb-names";
import { useApiQuery } from "../../lib/useApiQuery";
import { useManagedApi } from "../../lib/useManagedApi";
import { initialMessageText, type Deployment } from "./deployment-state";

const FormSchema = z
  .object({
    name: z.string().trim().min(1, "Укажите название"),
    agent: z.string().min(1, "Выберите агента"),
    environment_id: z.string().min(1, "Выберите окружение"),
    message: z.string().trim().min(1, "Напишите начальное сообщение"),
    trigger: z.enum(["manual", "cron"]),
    expression: z.string(),
    timezone: z.string(),
    resources: z.array(ResourceSchema),
  })
  .superRefine((value, ctx) => {
    if (value.trigger !== "cron") return;
    if (value.expression.trim().split(/\s+/).length !== 5) {
      ctx.addIssue({ code: "custom", path: ["expression"], message: "Укажите расписание из пяти полей, например 0 9 * * 1-5" });
    }
    if (!value.timezone.trim()) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "Укажите часовой пояс" });
    }
  });

type FormValues = z.infer<typeof FormSchema>;

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const labelClass = "mb-1.5 flex text-xs leading-4 font-medium text-ddc-label";

/**
 * Создание и правка деплоймента (docs/plans/crud.md, 4.1). Новый деплоймент
 * создаётся на паузе: сервер получает `_oma.paused`, продолжить его можно на
 * карточке. Агента подставляет адрес `/deployments/new?agent=<id>`.
 */
export function DeploymentForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const managedApi = useManagedApi();
  const [files, setFiles] = useState<FilePick[]>([]);
  const [memoryStores, setMemoryStores] = useState<MemoryStorePick[]>([]);
  const [replaceResources, setReplaceResources] = useState(false);
  const [initialAgent, setInitialAgent] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const existing = useApiQuery<Deployment>(id ? `/v1/deployments/${id}` : null, undefined, { enabled: editing });
  useCrumbName(id, existing.data?.name);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema as never) as Resolver<FormValues>,
    mode: "onChange",
    defaultValues: {
      name: "",
      agent: params.get("agent") ?? "",
      environment_id: "",
      message: "",
      trigger: "manual",
      expression: "",
      timezone: browserTimezone(),
      resources: [],
    },
  });
  const { control, register, handleSubmit, reset, watch, formState } = form;
  const trigger = watch("trigger");

  useEffect(() => {
    void Promise.allSettled([
      managedApi.files.list({ limit: 200 }),
      managedApi.memoryStores.list({ limit: 200 }),
    ]).then(([f, m]) => {
      if (f.status === "fulfilled") setFiles(f.value.data);
      if (m.status === "fulfilled") setMemoryStores(m.value.data);
    });
  }, [managedApi]);

  const deployment = existing.data;
  useEffect(() => {
    if (!deployment) return;
    setInitialAgent(deployment.agent.id);
    reset({
      name: deployment.name,
      agent: deployment.agent.id,
      environment_id: deployment.environment_id,
      message: initialMessageText(deployment),
      trigger: deployment.schedule ? "cron" : "manual",
      expression: deployment.schedule?.expression ?? "",
      timezone: deployment.schedule?.timezone ?? browserTimezone(),
      resources: [],
    });
  }, [deployment, reset]);

  const title = editing ? "Правка деплоймента" : "Новый деплоймент";

  const onSubmit = async (data: FormValues) => {
    setSubmitError(null);
    const initial_events = [
      { type: "user.message" as const, content: [{ type: "text" as const, text: data.message }] },
    ];
    const schedule =
      data.trigger === "cron"
        ? { type: "cron" as const, expression: data.expression.trim(), timezone: data.timezone.trim() }
        : null;
    try {
      if (editing && id) {
        const body: DeploymentUpdateParams = {
          name: data.name,
          environment_id: data.environment_id,
          initial_events,
          schedule,
          ...(data.agent !== initialAgent ? { agent: data.agent } : {}),
          ...(replaceResources ? { resources: resourcesToWire(data.resources) } : {}),
        };
        const updated = await managedApi.deployments.update(id, body);
        nav(`/deployments/${updated.id}`);
        return;
      }
      const resources = resourcesToWire(data.resources);
      const body: DeploymentCreateParams & { _oma: { paused: boolean } } = {
        name: data.name,
        agent: data.agent,
        environment_id: data.environment_id,
        initial_events,
        ...(schedule ? { schedule } : {}),
        ...(resources.length > 0 ? { resources } : {}),
        _oma: { paused: true },
      };
      const created = await managedApi.deployments.create(body);
      nav(`/deployments/${created.id}`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Не удалось сохранить деплоймент");
    }
  };

  const showError = (touched: boolean | undefined, message: string | undefined) =>
    message && (touched || formState.isSubmitted) ? message : undefined;
  const resourcesMemo = useMemo(() => deployment?.resources ?? [], [deployment]);

  if (editing && existing.isLoading) {
    return (
      <Page header={<Skeleton className="mb-6 h-8 w-64" />}>
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }

  return (
    <Page
      header={
        <PageHeader
          title={title}
          description={
            editing
              ? "Изменения применятся к следующим запускам."
              : "Деплоймент создаётся на паузе. Продолжите его на карточке, когда всё готово."
          }
          actions={
            <>
              <Button variant="ghost" onClick={() => nav(editing && id ? `/deployments/${id}` : "/deployments")} disabled={formState.isSubmitting}>
                Отмена
              </Button>
              <Button
                onClick={handleSubmit(onSubmit)}
                disabled={!formState.isValid || formState.isSubmitting}
                loading={formState.isSubmitting}
              >
                {editing ? "Сохранить" : "Создать"}
              </Button>
            </>
          }
        />
      }
    >
      <form className="card max-w-3xl space-y-4 p-5" onSubmit={(event) => event.preventDefault()} autoComplete="off">
        {submitError && (
          <div role="alert" className="callout-danger">
            {submitError}
          </div>
        )}
        <div>
          <Label htmlFor="deployment-name" className={labelClass}>Название</Label>
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <>
                <Input
                  id="deployment-name"
                  ref={field.ref}
                  name="oma-deployment-name"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  placeholder="Например, утренний отчёт"
                  autoComplete="off"
                />
                {showError(fieldState.isTouched, fieldState.error?.message) && (
                  <p className="mt-1.5 text-xs leading-4 text-error">{fieldState.error?.message}</p>
                )}
              </>
            )}
          />
        </div>
        <div>
          <Label className={labelClass}>Агент</Label>
          <Controller
            control={control}
            name="agent"
            render={({ field }) => (
              <Combobox<{ id: string; name: string }>
                value={field.value}
                onValueChange={field.onChange}
                endpoint="/v1/agents"
                getValue={(a) => a.id}
                getLabel={(a) => (
                  <span>
                    {a.name} <span className="text-xs text-ddc-text-muted">({a.id})</span>
                  </span>
                )}
                getTextLabel={(a) => `${a.name} (${a.id})`}
                placeholder="Выберите агента…"
              />
            )}
          />
        </div>
        <div>
          <Label className={labelClass}>Окружение</Label>
          <Controller
            control={control}
            name="environment_id"
            render={({ field }) => (
              <Combobox<{ id: string; name: string }>
                value={field.value}
                onValueChange={field.onChange}
                endpoint="/v1/environments"
                getValue={(e) => e.id}
                getLabel={(e) => (
                  <span>
                    {e.name} <span className="text-xs text-ddc-text-muted">({e.id})</span>
                  </span>
                )}
                getTextLabel={(e) => `${e.name} (${e.id})`}
                placeholder="Выберите окружение…"
              />
            )}
          />
        </div>
        <div>
          <Label htmlFor="deployment-message" className={labelClass}>Начальное сообщение</Label>
          <Textarea
            id="deployment-message"
            {...register("message")}
            className="min-h-24"
            placeholder="Что агент должен сделать при каждом запуске"
          />
        </div>
        <div>
          <Label htmlFor="deployment-trigger" className={labelClass}>Триггер</Label>
          <Controller
            control={control}
            name="trigger"
            render={({ field }) => (
              <Select id="deployment-trigger" name="trigger" value={field.value} onValueChange={field.onChange}>
                <SelectOption value="manual">Вручную</SelectOption>
                <SelectOption value="cron">По расписанию (cron)</SelectOption>
              </Select>
            )}
          />
        </div>
        {trigger === "cron" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="deployment-cron" className={labelClass}>Расписание</Label>
              <Input id="deployment-cron" {...register("expression")} placeholder="0 9 * * 1-5" className="font-mono" />
              {showError(formState.touchedFields.expression, formState.errors.expression?.message) && (
                <p className="mt-1.5 text-xs leading-4 text-error">{formState.errors.expression?.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="deployment-timezone" className={labelClass}>Часовой пояс</Label>
              <Input id="deployment-timezone" {...register("timezone")} placeholder="Europe/Moscow" />
            </div>
          </div>
        )}
        {editing && !replaceResources ? (
          <div>
            <Label className={labelClass}>Ресурсы</Label>
            <p className="text-sm text-ddc-text-muted">
              {resourcesMemo.length === 0 ? "Ресурсов нет." : `Подключено ресурсов: ${resourcesMemo.length}.`} Токены
              репозиториев сервер не отдаёт, поэтому список можно только заменить целиком.
            </p>
            <Button type="button" variant="outline" className="mt-2" onClick={() => setReplaceResources(true)}>
              Заменить ресурсы
            </Button>
          </div>
        ) : (
          <ResourceListEditor form={form} files={files} memoryStores={memoryStores} />
        )}
      </form>
    </Page>
  );
}
