// The dependency check of archive and delete (docs/plans/crud.md, A2). It
// reads the stores directly, so it needs no resource module.
import { DependenciesApplicationService } from "@open-managed-agents/managed-agents-application";

import { workspaceContextPort } from "../capabilities";
import { bindPort, defineAppModule, type AppModule } from "../index";
import { agentStorePort } from "./agents";
import { credentialStorePort } from "./credentials";
import { dependenciesPort } from "./dependency-port";
import { deploymentStorePort } from "./deployments";
import { environmentStorePort } from "./environments";
import { environmentWorkStorePort } from "./environment-work";
import { fileStorePort } from "./files";
import { memoryDocumentStorePort } from "./memories";
import { memoryStoreStorePort } from "./memory-stores";
import { sessionStorePort } from "./sessions";
import { skillStorePort } from "./skills";
import { vaultStorePort } from "./vaults";

export { dependenciesPort } from "./dependency-port";

export function dependenciesModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:dependencies",
    provides: [dependenciesPort],
    requires: [
      workspaceContextPort,
      agentStorePort,
      credentialStorePort,
      deploymentStorePort,
      environmentStorePort,
      environmentWorkStorePort,
      fileStorePort,
      memoryDocumentStorePort,
      memoryStoreStorePort,
      sessionStorePort,
      skillStorePort,
      vaultStorePort,
    ],
    setup({ port }) {
      return {
        ports: [bindPort(
          dependenciesPort,
          new DependenciesApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            agents: port(agentStorePort),
            credentials: port(credentialStorePort),
            deployments: port(deploymentStorePort),
            environments: port(environmentStorePort),
            environmentWork: port(environmentWorkStorePort),
            files: port(fileStorePort),
            memories: port(memoryDocumentStorePort),
            memoryStores: port(memoryStoreStorePort),
            sessions: port(sessionStorePort),
            skills: port(skillStorePort),
            vaults: port(vaultStorePort),
          }),
        )],
      };
    },
  });
}
