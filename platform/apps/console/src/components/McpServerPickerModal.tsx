import { SearchIcon, ServerIcon } from "lucide-react";
import { PlainButton } from "@/components/ui/plain-button";
import { useState, type JSX } from "react";

import { Input } from "@/components/ui/input";

import { MCP_REGISTRY, type McpRegistryEntry } from "../data/mcp-registry";
import { Modal } from "./Modal";

// Выбор известного MCP-сервера из общего реестра MCP_REGISTRY. Тот же реестр
// используется в потоке «Подключить сервис» хранилища секретов, поэтому форма
// агента и хранилище не расходятся: новый сервер в реестре появляется везде.
//
// Пример:
//
//   <McpServerPickerModal
//     open={...}
//     onClose={...}
//     alreadyAddedUrls={form.mcpServers.map((s) => s.url)}  // строка неактивна, подпись «Добавлен»
//     onPick={(entry) => { addToYourForm(entry); }}
//   />
//
// Окно закрывается само после выбора, вызывающему коду закрывать его не нужно.

export interface McpServerPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** URL, которые уже есть в форме вызывающего кода: строки с ними
   *  неактивны и подписаны «Добавлен», чтобы не добавить сервер дважды. */
  alreadyAddedUrls?: ReadonlyArray<string>;
  onPick: (entry: McpRegistryEntry) => void;
}

export function McpServerPickerModal({
  open,
  onClose,
  alreadyAddedUrls = [],
  onPick,
}: McpServerPickerModalProps): JSX.Element {
  const [search, setSearch] = useState("");
  const addedSet = new Set(alreadyAddedUrls);
  const needle = search.trim().toLocaleLowerCase();
  const filtered = needle
    ? MCP_REGISTRY.filter(
        (e) =>
          e.name.toLocaleLowerCase().includes(needle) ||
          e.url.toLocaleLowerCase().includes(needle),
      )
    : MCP_REGISTRY;

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSearch("");
      }}
      title="Выбор MCP-сервера"
      subtitle="Реестр известных MCP-серверов."
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ddc-placeholder"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            placeholder="Поиск сервисов"
            aria-label="Поиск сервисов"
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="-mx-1.5 max-h-80 overflow-y-auto">
          {filtered.map((entry) => {
            const alreadyAdded = addedSet.has(entry.url);
            return (
              <PlainButton
                type="button"
                key={entry.id}
                onClick={() => {
                  if (alreadyAdded) return;
                  onPick(entry);
                  onClose();
                  setSearch("");
                }}
                disabled={alreadyAdded}
                className="menu-item gap-3 py-2.5"
              >
                <ServerIcon aria-hidden="true" className="size-4 shrink-0 text-ddc-icon-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ddc-heading" title={entry.name}>
                    {entry.name}
                  </div>
                  <div className="truncate font-mono text-xs text-ddc-text-muted" title={entry.url}>
                    {entry.url}
                  </div>
                </div>
                {alreadyAdded && (
                  <span className="shrink-0 text-xs text-ddc-text-muted">Добавлен</span>
                )}
              </PlainButton>
            );
          })}
          {filtered.length === 0 && (
            <div className="py-6 text-center text-sm text-ddc-text-muted">
              Ничего не найдено. Добавьте свой сервер кнопкой «Свой сервер».
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
