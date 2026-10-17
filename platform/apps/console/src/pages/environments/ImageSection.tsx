import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { Disclosure } from "../../components/Disclosure";
import { Field } from "../../components/Field";
import { Select, SelectOption } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import {
  contentsSummary,
  describeImageManifest,
  describeResources,
  installHint,
  type ImageContents,
} from "../../lib/image-manifest";
import {
  findCatalogImage,
  shortDigest,
  type SandboxCatalog,
} from "../../lib/sandbox-catalog";
import { SectionCard } from "./SectionCard";

/** Значение пункта «По умолчанию» в списке: у окружения без образа `config.image` равно null. */
export const DEFAULT_IMAGE_VALUE = "__default__";

const SUBTITLE = "Образ, из которого запускаются песочницы этого окружения.";

interface ImageSectionProps {
  /** Каталог сервера или null: каталог грузится, не отвечает или выключен. */
  catalog: SandboxCatalog | null;
  /** Каталог ещё грузится. */
  loading?: boolean;
  /** `config.image` окружения: ключ каталога или null, когда образ по умолчанию. */
  value: string | null;
  onChange: (key: string | null) => void;
  /** Сеть из формы: от неё зависит, сможет ли агент ставить пакеты. */
  networking: { type: "unrestricted" | "limited"; allow_package_managers?: boolean };
  disabled?: boolean;
}

/**
 * Раздел «Образ» карточки окружения (раздел 2.2 плана environments.md): выбор
 * образа из каталога сервера, короткий дайджест, ресурсы песочницы, подсказка
 * про самостоятельную установку пакетов и свёрнутый список «Что есть в
 * образе» из манифеста сборки.
 *
 * Без каталога раздела нет, как и раньше. Исключение: у окружения уже задан
 * образ, а каталог не отвечает. Тогда раздел показывает ключ образа и обещает
 * его не менять.
 */
export function ImageSection({
  catalog,
  loading = false,
  value,
  onChange,
  networking,
  disabled = false,
}: ImageSectionProps) {
  if (loading) {
    return (
      <SectionCard title="Образ" subtitle={SUBTITLE}>
        <div className="space-y-3" aria-busy="true">
          <span role="status" className="sr-only">
            Загружаем образы…
          </span>
          <Skeleton className="h-10 w-full sm:w-96" rounded="lg" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </SectionCard>
    );
  }
  if (catalog === null) {
    if (value === null) return null;
    return (
      <SectionCard title="Образ" subtitle={SUBTITLE}>
        <div className="space-y-1.5">
          <p className="text-sm text-ddc-text">
            Образ окружения: <span className="font-mono">{value}</span>
          </p>
          <p className="text-xs leading-4 text-ddc-text-muted">
            Каталог образов сервера недоступен. Образ при сохранении не изменится.
          </p>
        </div>
      </SectionCard>
    );
  }
  return (
    <CatalogImageSection
      catalog={catalog}
      value={value}
      onChange={onChange}
      networking={networking}
      disabled={disabled}
    />
  );
}

function CatalogImageSection({
  catalog,
  value,
  onChange,
  networking,
  disabled,
}: Omit<ImageSectionProps, "loading" | "catalog"> & { catalog: SandboxCatalog; disabled: boolean }) {
  const effectiveKey = value ?? catalog.default_image;
  const effective = findCatalogImage(catalog, effectiveKey);
  const unknownKey = value !== null && effective === undefined;
  const defaultImage = findCatalogImage(catalog, catalog.default_image);
  const defaultLabel = defaultImage?.label ?? catalog.default_image;
  const contents = useMemo(
    () => (effective?.built ? describeImageManifest(effective.manifest) : null),
    [effective],
  );
  const resources = effective ? describeResources(effective.resources) : null;
  const digest = effective?.image_digest ?? null;
  const short = shortDigest(digest);

  return (
    <SectionCard title="Образ" subtitle={SUBTITLE}>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Образ" className="min-w-0 sm:w-96">
            <Select
              value={value ?? DEFAULT_IMAGE_VALUE}
              disabled={disabled}
              onValueChange={(next) => onChange(next === DEFAULT_IMAGE_VALUE ? null : next)}
            >
              <SelectOption value={DEFAULT_IMAGE_VALUE}>{`По умолчанию: ${defaultLabel}`}</SelectOption>
              {catalog.images.map((image) => (
                <SelectOption
                  key={image.key}
                  value={image.key}
                  disabled={!image.built && image.key !== value}
                >
                  {image.built ? image.label : `${image.label} (не собран)`}
                </SelectOption>
              ))}
              {unknownKey && <SelectOption value={value}>{`${value} (нет в каталоге)`}</SelectOption>}
            </Select>
          </Field>
          {short !== null && digest !== null && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-ddc-text-muted sm:min-h-10">
              <span>Дайджест</span>
              <span className="font-mono text-ddc-text tabular-nums" title={digest}>
                {short}
              </span>
              <CopyDigestButton value={digest} />
            </div>
          )}
        </div>

        {unknownKey && (
          <Warning>
            Образа «{value}» нет в каталоге сервера. Сессии на нём завершатся ошибкой. Выберите другой образ.
          </Warning>
        )}
        {effective && !effective.built && (
          <Warning>
            {effective.reason
              ? `Образ не собран: ${effective.reason.replace(/\.+$/, "")}.`
              : "Образ не собран."}{" "}
            Сессии на нём не запустятся.
          </Warning>
        )}

        {resources && (
          <p className="text-xs leading-4 text-ddc-text-muted">{`Ресурсы песочницы: ${resources}.`}</p>
        )}
        {effective?.built && (
          <p className="text-xs leading-4 text-ddc-text-muted">{installHint(contents, networking)}</p>
        )}

        {effective?.built && (
          <Disclosure
            title="Что есть в образе"
            meta={
              contents ? (
                <span aria-hidden="true" className="hidden sm:inline">
                  {contentsSummary(contents)}
                </span>
              ) : undefined
            }
          >
            {contents ? (
              <ImageContentsView contents={contents} />
            ) : (
              <p className="text-sm text-ddc-text-muted">У образа нет манифеста, поэтому состав неизвестен.</p>
            )}
          </Disclosure>
        )}
      </div>
    </SectionCard>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="callout-warning">
      <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
      <p className="prose-wrap min-w-0">{children}</p>
    </div>
  );
}

/** Кнопка копирования полного дайджеста. Галочка на полторы секунды подтверждает копирование. */
function CopyDigestButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Буфер обмена закрыт: копировать нечем, показывать нечего.
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Копировать дайджест"
      title="Копировать дайджест"
      onClick={() => void copy()}
      className="size-6 text-ddc-icon-muted hover:text-ddc-text"
    >
      {copied ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CopyIcon className="size-3.5" aria-hidden="true" />}
    </Button>
  );
}

function ContentsGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="space-y-1.5">
      <h3 id={id} className="eyebrow">
        {title}
      </h3>
      {children}
    </div>
  );
}

const LIST = "grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3";

function Item({ name, version }: { name: string; version?: string | null }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2">
      <span className="min-w-0 truncate text-ddc-text" title={name}>
        {name}
      </span>{" "}
      {version ? <span className="flex-none text-xs text-ddc-text-muted tabular-nums">{version}</span> : null}
    </li>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ImageContentsView({ contents }: { contents: ImageContents }) {
  const account = [
    contents.user ? `Пользователь ${contents.user}` : null,
    contents.shell ? `оболочка ${contents.shell}` : null,
  ].filter((part): part is string => part !== null);
  const python = contents.python;
  const pythonLine = python.version
    ? python.venv
      ? `Python ${python.version}, виртуальное окружение ${python.venv}`
      : python.hasPip
        ? `Python ${python.version}`
        : `Python ${python.version} без pip`
    : null;
  const nodeLine = contents.node
    ? [contents.node.version ? `Node ${contents.node.version}` : null, contents.node.npm ? `npm ${contents.node.npm}` : null]
        .filter((part): part is string => part !== null)
        .join(", ")
    : null;
  const showSystem = contents.system || account.length > 0 || contents.packageManagers.length > 0;

  return (
    <div className="space-y-4 pt-1 text-sm text-ddc-text">
      {showSystem && (
        <ContentsGroup title="Система">
          {contents.system && <p>{contents.system}</p>}
          {account.length > 0 && <p>{capitalize(account.join(", "))}</p>}
          {contents.packageManagers.length > 0 && (
            <p>{`Менеджеры пакетов: ${contents.packageManagers.join(", ")}`}</p>
          )}
        </ContentsGroup>
      )}
      {(pythonLine || python.libraries.length > 0) && (
        <ContentsGroup title="Python и библиотеки">
          {pythonLine && <p>{pythonLine}</p>}
          {python.libraries.length > 0 && (
            <ul className={LIST}>
              {python.libraries.map((library) => (
                <Item key={library.name} name={library.name} version={library.version} />
              ))}
            </ul>
          )}
        </ContentsGroup>
      )}
      {nodeLine && (
        <ContentsGroup title="Node">
          <p>{nodeLine}</p>
        </ContentsGroup>
      )}
      {contents.utilities.length > 0 && (
        <ContentsGroup title="Утилиты">
          <ul className={LIST}>
            {contents.utilities.map((utility) => (
              <Item key={utility.label} name={utility.label} version={utility.version} />
            ))}
          </ul>
        </ContentsGroup>
      )}
      {contents.fonts.length > 0 && (
        <ContentsGroup title="Шрифты с кириллицей">
          <ul className={LIST}>
            {contents.fonts.map((family) => (
              <Item key={family} name={family} />
            ))}
          </ul>
        </ContentsGroup>
      )}
    </div>
  );
}
