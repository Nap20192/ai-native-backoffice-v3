// Public surface — every mount factory and the shared types.
//
// CF + Node both `import { buildXxxRoutes, type RouteServices } from
// "@open-managed-agents/http-routes"`, build their services bundle, and
// mount the routes under the same paths.

export type {
  RouteServices,
  RouteServicesArg,
  EventStreamHub,
  BackgroundRunner,
  SessionRegistryLike,
} from "./types";
export { resolveServices } from "./types";

export { buildModelCardRoutes } from "./model-cards";
export { modelCardProbeUrl } from "./model-cards";
export type {
  ModelCardDependencyCheck,
  ModelCardDependencyReport,
  ModelCardRoutesDeps,
} from "./model-cards";
export { modelCardDependencies } from "./model-cards";

export { buildSessionRoutes } from "./sessions";
export type {
  SessionRoutesDeps,
  SessionLifecycleHooks,
  OutputsAdapter,
} from "./sessions";

export { buildTenantRoutes, buildMeRoutes } from "./tenants";
export type { TenantRoutesDeps, MeRoutesDeps } from "./tenants";

export {
  buildApiKeyRoutes,
  sha256Hex,
} from "./api-keys";
export type {
  ApiKeyRoutesDeps,
  ApiKeyStorage,
  ApiKeyRecord,
  ApiKeyMeta,
} from "./api-keys";

export { buildEvalRoutes } from "./evals";
export type { EvalRoutesDeps, EvalTaskSpec } from "./evals";
