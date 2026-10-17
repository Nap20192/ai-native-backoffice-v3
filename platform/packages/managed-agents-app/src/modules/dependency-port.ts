// Port of the dependency check (docs/plans/crud.md, A2). Resource modules
// read it as an optional Port, so this file imports no module file.
import type { DependenciesApplicationPort } from "@open-managed-agents/managed-agents-application";

import { createPortToken } from "../index";

export const dependenciesPort = createPortToken<DependenciesApplicationPort>(
  "managed-agents.application.dependencies",
);
