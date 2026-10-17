import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useManagedApi } from "../../lib/useManagedApi";
import type { MatchOptions } from "../../lib/managed-api";

/**
 * Действия над деплойментом: пауза, продолжение, запуск, архив и возврат из
 * архива. После каждого сбрасываются списки деплойментов и прогонов.
 */
export function useDeploymentActions() {
  const managedApi = useManagedApi();
  const client = useQueryClient();
  return useMemo(() => {
    const refresh = async () => {
      await client.invalidateQueries({
        predicate: (query) => {
          const head = query.queryKey[0];
          return (
            typeof head === "string" &&
            (head.startsWith("/v1/deployments") || head.startsWith("/v1/deployment_runs"))
          );
        },
      });
    };
    const after = <T>(request: Promise<T>) => request.then(async (value) => {
      await refresh();
      return value;
    });
    return {
      pause: (id: string) => after(managedApi.deployments.pause(id)),
      unpause: (id: string) => after(managedApi.deployments.unpause(id)),
      run: (id: string) => after(managedApi.deployments.run(id)),
      archive: (id: string, options?: MatchOptions) =>
        after(managedApi.deployments.archive(id, {}, options)),
      unarchive: (id: string, options?: MatchOptions) =>
        after(managedApi.deployments.unarchive(id, options)),
      refresh,
    };
  }, [managedApi, client]);
}
