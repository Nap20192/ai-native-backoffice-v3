import { Button } from "@/components/ui/button";
import {
  CheckIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { authClient } from "../lib/auth-client";
import { Avatar } from "./Avatar";
import { useI18n, AVAILABLE_LOCALES } from "../i18n";

/**
 * Меню пользователя внизу бокового меню. Одна точка нажатия открывает список
 * из двух групп настроек учётной записи:
 *
 *   - язык интерфейса (русский, английский, китайский);
 *   - тема (светлая, тёмная, системная) и выход.
 *
 * Пункта документации нет: своей документации у консоли нет, а ссылка вела
 * на сайт OpenMA.
 *
 * Строка-триггер использует тот же класс `console-sidebar-row`, что и пункты
 * меню и блок рабочего пространства: знак стоит в колонке иконок, подпись
 * обрезается многоточием.
 */
const THEME_OPTIONS = [
  { value: "light" as const, Icon: SunIcon },
  { value: "dark" as const, Icon: MoonIcon },
  { value: "system" as const, Icon: MonitorIcon },
];

export function UserProfile() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { t, locale, setLocale } = useI18n();

  if (!user) return null;

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/login";
  };

  const label = user.name || user.email || t.profile.account;
  const title = user.name || user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          aria-label={t.profile.accountMenu}
          className="console-sidebar-row console-user-trigger"
        >
          <span data-sidebar-slot data-sidebar-track="icon">
            <Avatar name={label} size="sm" />
          </span>
          <div className="console-user-text" data-sidebar-track="label">
            <div className="console-user-name" title={title}>
              {title}
            </div>
            {user.email && user.name && (
              <div className="console-user-email" title={user.email}>
                {user.email}
              </div>
            )}
          </div>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        className="console-user-menu w-56"
        collisionPadding={8}
      >
        <DropdownMenuLabel className="console-menu-head font-normal">
          <div className="console-menu-head-name" title={title}>
            {title}
          </div>
          {user.email && user.name && (
            <div className="console-menu-head-email" title={user.email}>
              {user.email}
            </div>
          )}
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="console-menu-eyebrow">
          {t.profile.language}
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {AVAILABLE_LOCALES.map(({ value, label: localeLabel, flag }) => {
            const active = locale === value;
            return (
              <DropdownMenuItem
                key={value}
                onClick={() => setLocale(value)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="console-menu-flag">{flag}</span>
                {localeLabel}
                {active && <CheckIcon className="console-menu-check size-4" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="console-menu-eyebrow">
          {t.profile.theme}
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {THEME_OPTIONS.map(({ value, Icon }) => {
            const active = theme === value;
            return (
              <DropdownMenuItem
                key={value}
                onClick={() => setTheme(value)}
                onSelect={(e) => e.preventDefault()}
              >
                <Icon className="size-4" />
                {t.profile[value]}
                {active && <CheckIcon className="console-menu-check size-4" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleSignOut} className="console-menu-danger">
          <LogOutIcon className="size-4" />
          {t.profile.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
