// Platform MCP server of the assistant (docs/plans/builder-agent.md).

export * from "./ports";
export { SECRET_FIELDS, isSecretName, secretFieldsOf, type SecretField } from "./secret-fields";
export { buildPlatformMcpRoutes, buildConfirmRoutes, type PlatformMcpVariables } from "./routes";
export { handleJsonRpc, callTool, listTools } from "./handler";
export { TOOL_TABLE, DRAFT_SET, defaultPolicy, routeAllowlist, allRouteRules } from "./tool-table";
export { shapeResponse, scanValue, cleanObject, hiddenPaths } from "./response-shape";
export { buildPreview, previewJson } from "./preview";
export { MESSAGES } from "./gate";
