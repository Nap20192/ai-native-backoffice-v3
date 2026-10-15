import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type RowData,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { useLocation } from "react-router";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

import { usePhoneLayout } from "../hooks/use-phone-layout";
import { useI18n } from "../i18n";
import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { PageHeader } from "./PageHeader";
import { RowActionsMenu, RowContextMenu, type RowAction } from "./RowContextMenu";
import { Skeleton } from "./Skeleton";

declare module "@tanstack/react-table" {
  // Параметры типа обязаны совпадать с объявлением библиотеки.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Столбец забирает свободную ширину карточки (DDC: одна длинная колонка
     *  `w-full`, остальные по содержимому). Его `size` служит минимумом. */
    grow?: boolean;
    /** Вторичный столбец. Когда столбцы не помещаются в карточку списка,
     *  скрываются столбцы с `priority`, начиная с наибольшего числа, пока
     *  таблица не уложится в ширину. Без `priority` столбец не скрывается. */
    priority?: number;
  }
}

export interface DataTableProps<T> {
  /** Заголовок страницы (`PageHeader`). Без него шапка не рисуется. */
  title?: string;
  /** Описание раздела под заголовком. */
  subtitle?: ReactNode;
  /** Главное действие страницы. Стоит в шапке первым, до `headerActions`. */
  createLabel?: string;
  onCreate?: () => void;
  headerActions?: ReactNode;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  filters?: ReactNode;
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId: (item: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptySubtitle?: ReactNode;
  emptyAction?: ReactNode;
  emptyKind?: EmptyStateKind;
  emptyIcon?: ReactNode;
  onRowClick?: (item: T) => void;
  rowActions?: (item: T) => RowAction[];
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** Столбцы, скрытые, пока пользователь не включил их в меню «Столбцы».
   *  По умолчанию скрыт технический `id`: он занимает место и нужен редко.
   *  Список без названия (запуски оценки) передаёт `[]`. */
  defaultHiddenColumns?: string[];
  children?: ReactNode;
}

const DEFAULT_HIDDEN_COLUMNS = ["id"];

/** Отступ столбцов внутри карточки списка слева и справа (card p-5). */
const LIST_FRAME_INSET = 20;

function defaultVisibility(hidden: string[]): VisibilityState {
  return Object.fromEntries(hidden.map((id) => [id, false]));
}

/** Канонический список: шапка страницы (`PageHeader`) с названием, описанием
 * и действиями, под ней карточка со списком. На экранах шире телефона:
 * замороженная панель и шапка
 * над прокручиваемым телом; шапка и тело это две таблицы с одинаковыми
 * colgroup, горизонтальная прокрутка тела повторяется в шапке. На телефоне
 * (до 640px) вместо таблицы рисуется стопка карточек без горизонтальной
 * прокрутки: первый видимый столбец становится заголовком карточки, остальные
 * идут парами «подпись: значение» (правило 13 DDC). */
export function DataTable<T>({
  title,
  subtitle,
  createLabel,
  onCreate,
  headerActions,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  filters,
  columns,
  data,
  getRowId,
  loading,
  emptyTitle = "Пока ничего нет",
  emptySubtitle,
  emptyAction,
  emptyKind,
  emptyIcon,
  onRowClick,
  rowActions,
  hasMore,
  onLoadMore,
  loadingMore,
  defaultHiddenColumns = DEFAULT_HIDDEN_COLUMNS,
  children,
}: DataTableProps<T>) {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const phone = usePhoneLayout();
  const storageKey = `dt-cols:v2:${pathname}`;
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as VisibilityState) : defaultVisibility(defaultHiddenColumns);
    } catch {
      return defaultVisibility(defaultHiddenColumns);
    }
  });
  const [gridScrolled, setGridScrolled] = useState(false);
  const [rootWidth, setRootWidth] = useState<number | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const headerIdPrefix = useId();

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(columnVisibility));
    } catch {
      // Persistence is a convenience; private-mode failures must not block lists.
    }
  }, [storageKey, columnVisibility]);

  // Ширина карточки списка: по ней скрываются вторичные столбцы (`hideBelow`).
  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRootWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;
  // Столбцы, которым не хватило места в карточке: вторичные (`priority`)
  // скрываются по одному, пока таблица не уложится в ширину. Телефон их не
  // прячет: там список идёт стопкой карточек и показывает все видимые поля.
  const narrowHidden = new Set<string>();
  if (rootWidth !== null && !phone) {
    const available = rootWidth - 2 * LIST_FRAME_INSET;
    const shown = table.getAllColumns().filter((column) => column.getIsVisible());
    let total = shown.reduce((sum, column) => sum + column.getSize(), 0);
    const candidates = shown
      .filter((column) => column.columnDef.meta?.priority !== undefined)
      .sort(
        (a, b) => (b.columnDef.meta?.priority ?? 0) - (a.columnDef.meta?.priority ?? 0),
      );
    for (const column of candidates) {
      if (total <= available) break;
      narrowHidden.add(column.id);
      total -= column.getSize();
    }
  }
  const visibleColumns = table
    .getAllColumns()
    .filter((column) => column.getIsVisible() && !narrowHidden.has(column.id));
  const isEmpty = !loading && rows.length === 0;
  const showCreate = Boolean(onCreate && createLabel);
  const tableWidth = Math.max(
    visibleColumns.reduce((sum, column) => sum + column.getSize(), 0),
    1,
  );
  const tableMinWidth = `${tableWidth}px`;
  const trackMinWidth = `calc(${tableWidth}px + var(--list-frame-inset) + var(--list-frame-inset))`;
  const renderColgroup = () => (
    <colgroup>
      {visibleColumns.map((column) => (
        <col
          key={column.id}
          style={column.columnDef.meta?.grow ? undefined : { width: `${column.getSize()}px` }}
        />
      ))}
    </colgroup>
  );

  const pageActions =
    showCreate || headerActions ? (
      <>
        {showCreate && (
          <Button onClick={onCreate}>
            <PlusIcon />
            {createLabel}
          </Button>
        )}
        {headerActions}
      </>
    ) : undefined;

  return (
    <>
      <div className="console-list-page" data-testid="data-table-page">
        {title && <PageHeader title={title} description={subtitle} actions={pageActions} />}
        <section
          ref={rootRef}
          className="console-list-root"
          data-list-root
          data-testid="data-table-list-root"
          aria-label={title}
        >
          <div
            className="console-list-fixed-header"
            data-scrolled={String(gridScrolled)}
            data-testid="frozen-data-header"
          >
            <div
              className="console-list-toolbar"
              data-list-toolbar
              role="toolbar"
              aria-label={title ? `${title}: управление` : "Управление списком"}
            >
              {!title && pageActions}
              {filters}
              <div className="console-list-toolbar-spacer" />
              {onSearchChange && (
                <InputGroup className="console-list-search">
                  <InputGroupAddon>
                    <SearchIcon className="size-4" />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    value={searchValue ?? ""}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder={searchPlaceholder ?? "Поиск…"}
                    autoComplete="off"
                    name="oma-list-search"
                  />
                </InputGroup>
              )}
              {!phone && <ColumnVisibilityMenu table={table} />}
            </div>

            {!isEmpty && !phone && (
              <div
                ref={headerScrollRef}
                className="console-data-head-viewport"
                data-testid="data-header-scroll"
              >
                <div
                  className="console-data-track console-data-header-cushion"
                  style={{ minWidth: trackMinWidth }}
                >
                  <Table
                    container={false}
                    className="console-data-table console-data-header-table"
                    style={{ minWidth: tableMinWidth }}
                    data-testid="data-header-table"
                    aria-label={title ? `${title}: столбцы` : "Столбцы списка"}
                  >
                    {renderColgroup()}
                    <TableHeader variant="wireless" className="console-data-head">
                      {table.getHeaderGroups().map((headerGroup) => (
                        <TableRow variant="wireless" key={headerGroup.id}>
                          {headerGroup.headers
                            .filter((header) => !narrowHidden.has(header.column.id))
                            .map((header) => (
                              <TableHead
                                key={header.id}
                                id={`${headerIdPrefix}-${header.column.id}`}
                                scope="col"
                              >
                                <div className="console-data-cell-inner">
                                  {header.isPlaceholder
                                    ? null
                                    : flexRender(header.column.columnDef.header, header.getContext())}
                                </div>
                              </TableHead>
                            ))}
                        </TableRow>
                      ))}
                    </TableHeader>
                  </Table>
                </div>
              </div>
            )}
          </div>

          <div
            className="console-data-grid-viewport"
            data-grid-viewport
            data-testid="data-grid-viewport"
            onScroll={(event) => {
              if (headerScrollRef.current) {
                headerScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
              const next = event.currentTarget.scrollTop > 0;
              setGridScrolled((current) => (current === next ? current : next));
            }}
          >
            {isEmpty ? (
              <div className="console-list-empty">
                <EmptyState
                  title={emptyTitle}
                  body={emptySubtitle}
                  action={emptyAction}
                  kind={emptyKind}
                  icon={emptyIcon}
                  size="lg"
                />
              </div>
            ) : phone ? (
              <PhoneRows
                table={table}
                rows={rows}
                title={title}
                loading={Boolean(loading)}
                rowActions={rowActions}
                onRowClick={onRowClick}
                actionsLabel={t.common.actions}
                hasMore={hasMore}
                onLoadMore={onLoadMore}
                loadingMore={Boolean(loadingMore)}
              />
            ) : (
              <div
                className="console-data-track console-data-grid-cushion"
                style={{ minWidth: trackMinWidth }}
              >
                <Table
                  container={false}
                  className="console-data-table console-data-body-table"
                  style={{ minWidth: tableMinWidth }}
                  data-testid="data-body-table"
                  aria-label={title ?? "Данные списка"}
                >
                  {renderColgroup()}
                  <TableBody>
                    {loading ? (
                      <SkeletonRows columnCount={visibleColumns.length} />
                    ) : (
                      rows.map((row) => {
                        const actions = rowActions?.(row.original) ?? [];
                        const rowElement = (
                          <TableRow
                            key={row.id}
                            variant="wireless"
                            className={cn(
                              "console-data-row",
                              onRowClick && "is-interactive",
                              actions.length > 0 && "has-context-menu",
                            )}
                            data-context-menu={actions.length > 0 || undefined}
                            tabIndex={actions.length > 0 ? 0 : undefined}
                            onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                          >
                            {row
                              .getVisibleCells()
                              .filter((cell) => !narrowHidden.has(cell.column.id))
                              .map((cell) => (
                                <TableCell
                                  key={cell.id}
                                  headers={`${headerIdPrefix}-${cell.column.id}`}
                                >
                                  <div className="console-data-cell-inner">
                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                  </div>
                                </TableCell>
                              ))}
                          </TableRow>
                        );
                        return actions.length > 0 ? (
                          <RowContextMenu key={row.id} actions={actions}>
                            {rowElement}
                          </RowContextMenu>
                        ) : (
                          rowElement
                        );
                      })
                    )}
                    {!loading && onLoadMore && hasMore && (
                      <LoadMoreRow
                        colSpan={visibleColumns.length}
                        loading={Boolean(loadingMore)}
                        onLoadMore={onLoadMore}
                      />
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </section>
      </div>
      {children}
    </>
  );
}

function ColumnVisibilityMenu<T>({ table }: { table: TanstackTable<T> }) {
  const hideableColumns = table.getAllColumns().filter((column) => column.getCanHide());
  const { t } = useI18n();
  if (hideableColumns.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="shrink-0">
          <SettingsIcon />
          {t.common.columns}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-semibold tracking-wider text-ddc-text-muted uppercase">
          {t.common.visibleColumns}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hideableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
            onSelect={(event) => event.preventDefault()}
          >
            {column.getIsVisible() ? <EyeIcon /> : <EyeOffIcon />}
            {typeof column.columnDef.header === "string"
              ? column.columnDef.header
              : String(column.id)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonRows({ columnCount }: { columnCount: number }) {
  return Array.from({ length: 10 }).map((_, rowIndex) => (
    <TableRow variant="wireless" key={`skeleton-${rowIndex}`} className="console-data-row console-data-row-skeleton">
      {Array.from({ length: columnCount }).map((__, columnIndex) => (
        <TableCell key={columnIndex}>
          <div className="console-data-cell-inner">
            <Skeleton
              className={cn(
                "h-4",
                columnIndex === 0
                  ? rowIndex % 2 === 0
                    ? "w-[55%]"
                    : "w-[42%]"
                  : rowIndex % 3 === 0
                    ? "w-[80%]"
                    : "w-[62%]",
              )}
            />
          </div>
        </TableCell>
      ))}
    </TableRow>
  ));
}

/** Следит за невидимой меткой в конце списка и дозагружает страницу, когда
 * до неё остаётся 400px. Общая для таблицы и для карточек на телефоне. */
function useLoadMoreSentinel<E extends Element>(loading: boolean, onLoadMore: () => void) {
  const ref = useRef<E>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !loading) onLoadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, onLoadMore]);

  return ref;
}

function LoadMoreRow({
  colSpan,
  loading,
  onLoadMore,
}: {
  colSpan: number;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useI18n();
  const ref = useLoadMoreSentinel<HTMLTableRowElement>(loading, onLoadMore);

  return (
    <TableRow variant="wireless" ref={ref} className="console-data-load-more">
      <TableCell colSpan={colSpan}>{loading ? t.common.loadingMore : " "}</TableCell>
    </TableRow>
  );
}

interface PhoneRowsProps<T> {
  table: TanstackTable<T>;
  rows: Row<T>[];
  title?: string;
  loading: boolean;
  rowActions?: (item: T) => RowAction[];
  onRowClick?: (item: T) => void;
  actionsLabel: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore: boolean;
}

/** Список на телефоне: стопка карточек вместо таблицы. Первый видимый столбец
 * это заголовок карточки, остальные пары «подпись и значение». Действия строки
 * доступны и по долгому нажатию (контекстное меню), и по кнопке «⋯». */
function PhoneRows<T>({
  table,
  rows,
  title,
  loading,
  rowActions,
  onRowClick,
  actionsLabel,
  hasMore,
  onLoadMore,
  loadingMore,
}: PhoneRowsProps<T>) {
  const { t } = useI18n();
  const sentinelRef = useLoadMoreSentinel<HTMLDivElement>(loadingMore, onLoadMore ?? (() => undefined));
  const headers = new Map(table.getFlatHeaders().map((header) => [header.column.id, header]));

  if (loading) {
    return (
      <ul
        className="console-data-stack"
        data-testid="data-stack"
        aria-busy="true"
        aria-label={title ?? "Данные списка"}
      >
        {Array.from({ length: 6 }).map((_, index) => (
          <li key={index} className="console-stack-row" aria-hidden="true">
            <Skeleton className="h-5 w-[55%]" />
            <Skeleton className="mt-3 h-4 w-[80%]" />
            <Skeleton className="mt-2 h-4 w-[62%]" />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <ul className="console-data-stack" data-testid="data-stack" aria-label={title ?? "Данные списка"}>
        {rows.map((row) => {
          const [first, ...rest] = row.getVisibleCells();
          const actions = rowActions?.(row.original) ?? [];
          const item = (
            <li
              key={row.id}
              className={cn(
                "console-stack-row",
                onRowClick && "is-interactive",
                actions.length > 0 && "has-context-menu",
              )}
              data-testid="data-stack-row"
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRowClick(row.original);
                      }
                    }
                  : undefined
              }
            >
              {first && (
                <div className="console-stack-head">
                  <div className="console-stack-title">
                    {flexRender(first.column.columnDef.cell, first.getContext())}
                  </div>
                  <RowActionsMenu actions={actions} label={actionsLabel} />
                </div>
              )}
              {rest.length > 0 && (
                <dl className="console-stack-fields">
                  {rest.map((cell) => {
                    const header = headers.get(cell.column.id);
                    return (
                      <div key={cell.id} className="console-stack-field">
                        <dt>
                          {header
                            ? flexRender(header.column.columnDef.header, header.getContext())
                            : cell.column.id}
                        </dt>
                        <dd>{flexRender(cell.column.columnDef.cell, cell.getContext())}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </li>
          );
          return actions.length > 0 ? (
            <RowContextMenu key={row.id} actions={actions}>
              {item}
            </RowContextMenu>
          ) : (
            item
          );
        })}
      </ul>
      {onLoadMore && hasMore && (
        <div ref={sentinelRef} className="console-stack-more" aria-live="polite">
          {loadingMore ? t.common.loadingMore : " "}
        </div>
      )}
    </>
  );
}

export { type ColumnDef } from "@tanstack/react-table";
