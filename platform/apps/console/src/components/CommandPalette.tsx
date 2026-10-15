import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

import { NAV_ICONS, type NavIcon } from "./nav-icons";
import { useI18n } from "../i18n";

interface NavCommand {
  label: string;
  to: string;
  icon: NavIcon;
  aliases?: string;
}

const RECENT_STORAGE_KEY = "oma-command-recent";
export const COMMAND_PALETTE_OPEN_EVENT = "openma:command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}

/**
 * Разделы для перехода. Интеграции (Linear, GitHub, Slack, Feishu) в палитру
 * не входят, их маршруты остаются в main.tsx. Псевдонимы русские и английские:
 * по ним ищут, но не показывают.
 */
function useCommands(): NavCommand[] {
  const { t } = useI18n();
  return [
    { label: t.nav.dashboard, to: "/", icon: NAV_ICONS.dashboard, aliases: "dashboard главная" },
    { label: t.nav.agents, to: "/agents", icon: NAV_ICONS.agents },
    { label: t.nav.sessions, to: "/sessions", icon: NAV_ICONS.sessions },
    { label: t.nav.files, to: "/files", icon: NAV_ICONS.files },
    {
      label: t.nav.evalRuns,
      to: "/evals",
      icon: NAV_ICONS.evals,
      aliases: "evaluations evals оценка тесты",
    },
    {
      label: t.nav.environments,
      to: "/environments",
      icon: NAV_ICONS.environments,
      aliases: "envs sandboxes песочницы",
    },
    {
      label: t.nav.credentialVaults,
      to: "/vaults",
      icon: NAV_ICONS.vaults,
      aliases: "secrets credentials vaults секреты учётные данные",
    },
    { label: t.nav.skills, to: "/skills", icon: NAV_ICONS.skills },
    { label: t.nav.memoryStores, to: "/memory", icon: NAV_ICONS.memory, aliases: "memory память" },
    { label: t.nav.modelCards, to: "/model-cards", icon: NAV_ICONS.modelCards, aliases: "models модели" },
    { label: t.nav.apiKeys, to: "/api-keys", icon: NAV_ICONS.apiKeys, aliases: "tokens токены ключи" },
    { label: t.nav.localRuntimes, to: "/runtimes", icon: NAV_ICONS.runtimes, aliases: "runtimes среды" },
  ];
}

function readRecentPaths(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Одна общая командная палитра. Группы идут в постоянном порядке, а список
 * недавних показывает разделы, где человек действительно был. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentPaths, setRecentPaths] = useState<string[]>(readRecentPaths);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useI18n();
  const commands = useCommands();

  const remember = (path: string) => {
    setRecentPaths((current) => {
      const next = [path, ...current.filter((item) => item !== path)].slice(0, 4);
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Без хранилища список недавних живёт только в памяти.
      }
      return next;
    });
  };

  useEffect(() => {
    const command = commands.find((item) =>
      item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`),
    );
    if (command) remember(command.to);
    // Событие здесь только смена маршрута: перевод подписей путь не меняет.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  const go = (to: string) => {
    remember(to);
    setOpen(false);
    setQuery("");
    navigate(to);
  };

  const recentCommands = recentPaths
    .map((path) => commands.find((command) => command.to === path))
    .filter((command): command is NavCommand => Boolean(command));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchResults = normalizedQuery.length >= 2
    ? commands.filter((command) =>
        `${command.label} ${command.aliases ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
      ).slice(0, 6)
    : [];

  const renderCommand = (command: NavCommand, valuePrefix: string) => {
    const Icon = command.icon;
    return (
      <CommandItem
        key={`${valuePrefix}:${command.to}`}
        value={`${valuePrefix} ${command.label} ${command.aliases ?? ""}`}
        onSelect={() => go(command.to)}
        className="cursor-pointer"
      >
        <Icon className="size-4 text-ddc-icon-muted" />
        <span className="min-w-0 flex-1 truncate" title={command.label}>
          {command.label}
        </span>
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      title={t.command.title}
      description={t.command.description}
      className="rounded-2xl!"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t.command.jumpTo}
      />
      <CommandList>
        <CommandEmpty>{t.command.noMatches}</CommandEmpty>
        <CommandGroup heading={t.command.recent}>
          {recentCommands.map((command) => renderCommand(command, "recent"))}
        </CommandGroup>
        <CommandGroup heading={t.command.actions}>
          {renderCommand(commands.find((command) => command.to === "/agents")!, "view")}
          {renderCommand(commands.find((command) => command.to === "/sessions")!, "review")}
        </CommandGroup>
        <CommandGroup heading={t.command.navigate}>
          {commands.map((command) => renderCommand(command, "navigate"))}
        </CommandGroup>
        {searchResults.length > 0 && (
          <CommandGroup heading={t.command.search}>
            {searchResults.map((command) => renderCommand(command, "search"))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
