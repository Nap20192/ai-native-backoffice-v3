import { Button } from "@/components/ui/button";
import { SearchIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router";

import { openCommandPalette } from "./CommandPalette";
import { NAV_ICONS, type NavIcon } from "./nav-icons";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserProfile } from "./UserProfile";
import { consolePlugins } from "../plugins/registry";
import { useI18n } from "../i18n";

interface NavItem {
  to: string;
  label: string;
  icon: NavIcon;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Группы бокового меню. Группы интеграций (Linear, GitHub, Slack, Feishu)
 * из меню убраны, их маршруты остаются в main.tsx.
 */
function useNavGroups(): NavGroup[] {
  const { t, locale } = useI18n();
  return [
    {
      label: t.nav.overview,
      items: [{ to: "/", label: t.nav.dashboard, icon: NAV_ICONS.dashboard, end: true }],
    },
    {
      label: t.nav.managedAgents,
      items: [
        { to: "/agents", label: t.nav.agents, icon: NAV_ICONS.agents },
        { to: "/sessions", label: t.nav.sessions, icon: NAV_ICONS.sessions },
        { to: "/deployments", label: t.nav.deployments, icon: NAV_ICONS.deployments },
        { to: "/files", label: t.nav.files, icon: NAV_ICONS.files },
        { to: "/evals", label: t.nav.evalRuns, icon: NAV_ICONS.evals },
      ],
    },
    {
      label: t.nav.infrastructure,
      items: [
        { to: "/environments", label: t.nav.environments, icon: NAV_ICONS.environments },
        { to: "/vaults", label: t.nav.credentialVaults, icon: NAV_ICONS.vaults },
      ],
    },
    {
      label: t.nav.configuration,
      items: [
        { to: "/skills", label: t.nav.skills, icon: NAV_ICONS.skills },
        { to: "/memory", label: t.nav.memoryStores, icon: NAV_ICONS.memory },
        { to: "/model-cards", label: t.nav.modelCards, icon: NAV_ICONS.modelCards },
        { to: "/members", label: t.nav.members, icon: NAV_ICONS.members },
        { to: "/api-keys", label: t.nav.apiKeys, icon: NAV_ICONS.apiKeys },
      ],
    },
  ];
}

export function AppSidebar() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const navGroups = [
    ...useNavGroups(),
    ...consolePlugins.flatMap((plugin) => plugin.navGroups ?? []),
  ];

  return (
    <aside
      className="console-sidebar"
      aria-label={t.shell.workspaceNavigation}
      data-sidebar="sidebar"
    >
      <div className="console-sidebar-tenant">
        <TenantSwitcher />
        <Button
          variant="ghost"
          type="button"
          className="console-sidebar-search"
          aria-label={t.command.title}
          title={t.command.title}
          data-sidebar-search
          onClick={openCommandPalette}
        >
          <SearchIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <nav className="console-sidebar-nav" aria-label={t.shell.sections}>
        {navGroups.map((group, groupIndex) => (
          <section className="console-sidebar-group" key={group.label}>
            {groupIndex > 0 && (
              <div className="console-sidebar-group-label" data-sidebar-track="label">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = item.end
                ? pathname === item.to
                : pathname === item.to || pathname.startsWith(`${item.to}/`);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="console-sidebar-row"
                  data-active={active || undefined}
                  aria-current={active ? "page" : undefined}
                >
                  <span data-sidebar-slot data-sidebar-track="icon">
                    <item.icon className="size-4" />
                  </span>
                  <span data-sidebar-track="label" title={item.label}>
                    {item.label}
                  </span>
                </NavLink>
              );
            })}
          </section>
        ))}
      </nav>

      <footer className="console-sidebar-footer">
        <UserProfile />
      </footer>
    </aside>
  );
}
