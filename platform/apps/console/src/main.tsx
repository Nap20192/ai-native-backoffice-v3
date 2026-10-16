import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  type RouteObject,
  type UIMatch,
} from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { AuthProvider } from "./lib/auth";
import { I18nProvider } from "./i18n";
import { Toaster } from "./components/ui/sonner";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./lib/query-client";
import { loadBranding } from "./lib/branding";
import { crumbName } from "./lib/crumb-names";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AgentsList } from "./pages/AgentsList";
import { AgentDetail } from "./pages/AgentDetail";
import { SessionsList } from "./pages/SessionsList";
import { FilesList } from "./pages/FilesList";
import { EnvironmentsList } from "./pages/EnvironmentsList";
import { EnvironmentDetail } from "./pages/EnvironmentDetail";
import { VaultsList } from "./pages/VaultsList";
import { VaultDetail } from "./pages/VaultDetail";
import { SkillsList } from "./pages/SkillsList";
import { MemoryStoresList } from "./pages/MemoryStoresList";
import { MemoryStoreDetail } from "./pages/MemoryStoreDetail";
import { ModelCardsList } from "./pages/ModelCardsList";
import { WorkspaceMembers, JoinWorkspace } from "./pages/WorkspaceMembers";
import { ApiKeysList } from "./pages/ApiKeysList";
import { CliLogin } from "./pages/CliLogin";
import { RuntimesList } from "./pages/RuntimesList";
import { ConnectRuntime } from "./pages/ConnectRuntime";
import { EvalRunsList } from "./pages/EvalRunsList";
import { EvalRunDetail } from "./pages/EvalRunDetail";
import {
  IntegrationsLinearList,
  IntegrationsLinearWorkspace,
  IntegrationsLinearPublishPage,
  IntegrationsLinearPatInstallPage,
} from "./pages/IntegrationsLinear";
import {
  IntegrationsGitHubList,
  IntegrationsGitHubWorkspace,
  IntegrationsGitHubBindPage,
} from "./pages/IntegrationsGitHub";
import {
  IntegrationsSlackList,
  IntegrationsSlackWorkspace,
  IntegrationsSlackPublishPage,
} from "./pages/IntegrationsSlack";
import {
  IntegrationsFeishuList,
  IntegrationsFeishuWorkspace,
  IntegrationsFeishuPublishPage,
} from "./pages/IntegrationsFeishu";
import { consolePlugins } from "./plugins/registry";

/**
 * Router config. Migrated from declarative `<BrowserRouter><Routes>` to
 * the data router (`createBrowserRouter` + `<RouterProvider>`) so we
 * can use `useMatches()` / per-route `handle` / loaders / actions.
 * Hooks that throw "must be used within a data router" - AppBreadcrumb,
 * future loader-driven pages - now work.
 *
 * Lazy chunks use the data-router-native `lazy:` field, which returns
 * an object with `Component` (and optionally `loader`, `action`,
 * `errorElement` etc). Compared to wrapping `<React.lazy />` in a
 * `<Suspense>`, the data router knows to await the chunk before
 * rendering the route, avoiding a flash of fallback during navigation.
 *
 * Per-route `handle.crumb` publishes a label for AppBreadcrumb. For
 * fixed labels pass a string; for dynamic labels (resource name from
 * the loader) pass a function that reads the match.
 */

const INTEGRATIONS_ENABLED = import.meta.env.VITE_ENABLE_INTEGRATIONS === "1";

const protectedRoutes: RouteObject[] = [
  { index: true, element: <Dashboard />, handle: { crumb: "Сводка" } },
  // Nested route groups so detail pages publish a proper hierarchy
  // through `useMatches()` - `/agents/:id` resolves to
  // [agents-parent, agents/:id], so AppBreadcrumb renders
  // `Agents › Agent` instead of just `Agent` with no link back.
  {
    path: "agents",
    handle: { crumb: "Агенты" },
    children: [
      { index: true, element: <AgentsList /> },
      {
        path: ":id",
        element: <AgentDetail />,
        handle: { crumb: (m: UIMatch) => crumbName(m.params.id, "Агент") },
      },
    ],
  },
  {
    path: "sessions",
    handle: { crumb: "Сессии" },
    children: [
      { index: true, element: <SessionsList /> },
      {
        path: ":id",
        handle: { crumb: (m: UIMatch) => crumbName(m.params.id, "Сессия") },
        // SessionDetail lazy-loads - it pulls in ai-elements + Shiki +
        // Streamdown + mermaid + dozens of language defs (~500 kB
        // gzipped). Splitting it out keeps the initial bundle for
        // /agents, /sessions list, etc. under 350 kB.
        lazy: async () => {
          const { SessionDetail } = await import("./pages/SessionDetail");
          return { Component: SessionDetail };
        },
      },
    ],
  },
  { path: "files", element: <FilesList />, handle: { crumb: "Файлы" } },
  {
    path: "evals",
    handle: { crumb: "Запуски оценки" },
    children: [
      { index: true, element: <EvalRunsList /> },
      {
        path: ":id",
        element: <EvalRunDetail />,
        handle: { crumb: (m: UIMatch) => crumbName(m.params.id, "Запуск оценки") },
      },
    ],
  },
  {
    path: "environments",
    handle: { crumb: "Окружения" },
    children: [
      { index: true, element: <EnvironmentsList /> },
      {
        path: ":id",
        element: <EnvironmentDetail />,
        handle: { crumb: (m: UIMatch) => crumbName(m.params.id, "Окружение") },
      },
    ],
  },
  { path: "skills", element: <SkillsList />, handle: { crumb: "Навыки" } },
  {
    path: "vaults",
    handle: { crumb: "Хранилища секретов" },
    children: [
      { index: true, element: <VaultsList /> },
      {
        path: ":id",
        element: <VaultDetail />,
        handle: { crumb: (m: UIMatch) => crumbName(m.params.id, "Хранилище") },
      },
    ],
  },
  {
    path: "memory",
    handle: { crumb: "Хранилища памяти" },
    children: [
      { index: true, element: <MemoryStoresList /> },
      {
        path: ":id",
        element: <MemoryStoreDetail />,
        handle: { crumb: (m: UIMatch) => crumbName(m.params.id, "Хранилище памяти") },
      },
    ],
  },
  { path: "model-cards", element: <ModelCardsList />, handle: { crumb: "Карточки моделей" } },
  { path: "members", element: <WorkspaceMembers />, handle: { crumb: "Участники" } },
  { path: "api-keys", element: <ApiKeysList />, handle: { crumb: "API-ключи" } },
  { path: "runtimes", element: <RuntimesList />, handle: { crumb: "Локальные среды" } },
  // Интеграции (Linear, GitHub, Slack, Feishu) убраны из меню и со страниц.
  // Код страниц остаётся, маршруты открываются только флагом сборки
  // VITE_ENABLE_INTEGRATIONS=1, иначе адрес /integrations/* уходит на /agents.
  ...(INTEGRATIONS_ENABLED
    ? [
      {
        path: "integrations",
        handle: { crumb: "Интеграции" },
        children: [
          {
            path: "linear",
            handle: { crumb: "Linear" },
            children: [
              { index: true, element: <IntegrationsLinearList /> },
              {
                path: "publish",
                element: <IntegrationsLinearPublishPage />,
                handle: { crumb: "Публикация" },
              },
              {
                path: "install-pat",
                element: <IntegrationsLinearPatInstallPage />,
                handle: { crumb: "Установка по PAT" },
              },
              {
                path: "installations/:id",
                element: <IntegrationsLinearWorkspace />,
                handle: { crumb: "Рабочее пространство" },
              },
            ],
          },
          {
            path: "github",
            handle: { crumb: "GitHub" },
            children: [
              { index: true, element: <IntegrationsGitHubList /> },
              {
                path: "bind",
                element: <IntegrationsGitHubBindPage />,
                handle: { crumb: "Привязка" },
              },
              {
                path: "installations/:id",
                element: <IntegrationsGitHubWorkspace />,
                handle: { crumb: "Рабочее пространство" },
              },
            ],
          },
          {
            path: "slack",
            handle: { crumb: "Slack" },
            children: [
              { index: true, element: <IntegrationsSlackList /> },
              {
                path: "publish",
                element: <IntegrationsSlackPublishPage />,
                handle: { crumb: "Публикация" },
              },
              {
                path: "installations/:id",
                element: <IntegrationsSlackWorkspace />,
                handle: { crumb: "Рабочее пространство" },
              },
            ],
          },
          {
            path: "feishu",
            handle: { crumb: "Feishu" },
            children: [
              { index: true, element: <IntegrationsFeishuList /> },
              {
                path: "publish",
                element: <IntegrationsFeishuPublishPage />,
                handle: { crumb: "Публикация" },
              },
              {
                path: "installations/:id",
                element: <IntegrationsFeishuWorkspace />,
                handle: { crumb: "Рабочее пространство" },
              },
            ],
          },
        ],
      },
      ]
    : []),
  // Plugin-contributed routes (hosted-only extensions). Default empty in
  // OSS - hosted deploy overlays plugins/registry.ts to inject billing
  // / etc. PluginRoute keeps the same `{ path, element }` shape that
  // RouteObject expects.
  ...consolePlugins.flatMap((p) => p.routes ?? []),
  { path: "*", element: <Navigate to="/agents" replace /> },
];

const router = createBrowserRouter([
  { path: "join", element: <JoinWorkspace /> },
  { path: "login", element: <Login /> },
  { path: "cli/login", element: <CliLogin /> },
  { path: "connect-runtime", element: <ConnectRuntime /> },
  {
    element: <AppShell />,
    children: protectedRoutes,
  },
]);

void loadBranding();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
          <Suspense fallback={null}>
              <RouterProvider router={router} />
            </Suspense>
          </AuthProvider>
          <Toaster />
        </QueryClientProvider>
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
