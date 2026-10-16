import { describe, expect, it } from "vitest";
import type { Environment } from "../src/domain/environment";
import {
  EnvironmentsApplicationService,
  type EnvironmentConfigInput,
  type EnvironmentConfigPolicyPort,
} from "../src/index";

// The configuration policy port (docs/plans/environments.md, ES1): create and
// update ask it about `config` and answer invalid_request naming the field.

interface StoredEnvironment {
  environment: Environment;
  revision: number;
}

class TinyEnvironmentStore {
  readonly records = new Map<string, StoredEnvironment>();
  inserts = 0;

  async insert(input: { workspaceId: string; environment: Environment }) {
    this.inserts += 1;
    const record = { environment: structuredClone(input.environment), revision: 1 };
    this.records.set(input.environment.id, record);
    return structuredClone(record);
  }

  async find(input: { workspaceId: string; environmentId: string }) {
    const record = this.records.get(input.environmentId);
    return record === undefined ? null : structuredClone(record);
  }

  async replace(input: {
    workspaceId: string;
    environmentId: string;
    expectedRevision: number;
    next: Environment;
  }) {
    const current = this.records.get(input.environmentId);
    if (current === undefined) return { type: "not_found" as const };
    const record = { environment: structuredClone(input.next), revision: current.revision + 1 };
    this.records.set(input.environmentId, record);
    return { type: "replaced" as const, record: structuredClone(record) };
  }

  async archive(): Promise<never> {
    throw new Error("unexpected archive");
  }

  async delete(): Promise<never> {
    throw new Error("unexpected delete");
  }

  async list(): Promise<never> {
    throw new Error("unexpected list");
  }
}

function rejectImage(key: string): EnvironmentConfigPolicyPort & { seen: Array<EnvironmentConfigInput | null> } {
  const seen: Array<EnvironmentConfigInput | null> = [];
  return {
    seen,
    checkConfig(config) {
      seen.push(config);
      if (config?.type === "cloud" && config.image === key) {
        return { type: "rejected", field: "config.image", message: `unknown sandbox image "${key}"` };
      }
      return { type: "accepted" };
    },
  };
}

function service(store: TinyEnvironmentStore, configPolicy?: EnvironmentConfigPolicyPort) {
  let next = 0;
  return new EnvironmentsApplicationService({
    workspaceId: "workspace_01",
    store,
    clock: { now: () => new Date("2026-10-16T08:00:00.000Z") },
    ids: { nextEnvironmentId: () => `env_${++next}` },
    ...(configPolicy !== undefined && { configPolicy }),
  });
}

describe("EnvironmentsApplicationService configuration policy", () => {
  it("keeps image and allowWebSearch in the stored config", async () => {
    const store = new TinyEnvironmentStore();
    const created = await service(store).createEnvironment({
      name: "documents",
      config: {
        type: "cloud",
        image: "workplace-office",
        networking: { type: "limited", allowPackageManagers: true, allowWebSearch: true },
      },
    });

    expect(created.type).toBe("created");
    if (created.type !== "created") return;
    expect(created.environment.config).toEqual({
      type: "cloud",
      image: "workplace-office",
      networking: {
        type: "limited",
        allowMcpServers: false,
        allowPackageManagers: true,
        allowWebSearch: true,
        allowedHosts: [],
      },
      packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    });
  });

  it("stores no image key when the input leaves it null", async () => {
    const store = new TinyEnvironmentStore();
    const created = await service(store).createEnvironment({
      name: "default",
      config: { type: "cloud", image: null },
    });

    expect(created.type).toBe("created");
    if (created.type !== "created") return;
    expect(created.environment.config).toEqual({
      type: "cloud",
      networking: { type: "unrestricted" },
      packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    });
  });

  it("answers invalid_request with the field and stores nothing on create", async () => {
    const store = new TinyEnvironmentStore();
    const policy = rejectImage("nope");
    const result = await service(store, policy).createEnvironment({
      name: "bad",
      config: { type: "cloud", image: "nope" },
    });

    expect(result).toEqual({
      type: "invalid_request",
      message: 'Invalid request field config.image: unknown sandbox image "nope"',
    });
    expect(store.inserts).toBe(0);
    expect(policy.seen).toEqual([{ type: "cloud", image: "nope" }]);
  });

  it("asks the policy about a missing config as null on create", async () => {
    const store = new TinyEnvironmentStore();
    const policy = rejectImage("nope");
    const result = await service(store, policy).createEnvironment({ name: "bare" });

    expect(result.type).toBe("created");
    expect(policy.seen).toEqual([null]);
  });

  it("answers invalid_request on update and leaves the stored environment as it was", async () => {
    const store = new TinyEnvironmentStore();
    const policy = rejectImage("nope");
    const app = service(store, policy);
    const created = await app.createEnvironment({
      name: "kept",
      config: { type: "cloud", image: "workplace" },
    });
    expect(created.type).toBe("created");

    const result = await app.updateEnvironment({
      environmentId: "env_1",
      config: { type: "cloud", image: "nope" },
    });

    expect(result).toEqual({
      type: "invalid_request",
      message: 'Invalid request field config.image: unknown sandbox image "nope"',
    });
    expect(store.records.get("env_1")?.environment.config).toMatchObject({ image: "workplace" });
    expect(store.records.get("env_1")?.revision).toBe(1);
  });

  it("skips the policy when an update does not touch config", async () => {
    const store = new TinyEnvironmentStore();
    const policy = rejectImage("nope");
    const app = service(store, policy);
    await app.createEnvironment({ name: "renamed", config: { type: "cloud" } });
    policy.seen.length = 0;

    const result = await app.updateEnvironment({ environmentId: "env_1", name: "renamed-2" });

    expect(result.type).toBe("updated");
    expect(policy.seen).toEqual([]);
  });

  it("keeps the stored image when an update leaves it out and clears it on null", async () => {
    const store = new TinyEnvironmentStore();
    const app = service(store);
    await app.createEnvironment({
      name: "office",
      config: { type: "cloud", image: "workplace-office" },
    });

    const kept = await app.updateEnvironment({
      environmentId: "env_1",
      config: { type: "cloud", networking: { type: "limited", allowPackageManagers: true } },
    });
    expect(kept.type === "updated" && kept.environment.config).toMatchObject({
      type: "cloud",
      image: "workplace-office",
      networking: { type: "limited", allowPackageManagers: true },
    });

    const cleared = await app.updateEnvironment({
      environmentId: "env_1",
      config: { type: "cloud", image: null },
    });
    expect(cleared.type === "updated" && cleared.environment.config).toEqual({
      type: "cloud",
      networking: { type: "unrestricted" },
      packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    });

    await app.updateEnvironment({
      environmentId: "env_1",
      config: { type: "cloud", image: "workplace" },
    });
    const selfHosted = await app.updateEnvironment({
      environmentId: "env_1",
      config: { type: "self_hosted" },
    });
    expect(selfHosted.type === "updated" && selfHosted.environment.config).toEqual({
      type: "self_hosted",
    });
  });

  it("works as before without a policy", async () => {
    const store = new TinyEnvironmentStore();
    const result = await service(store).createEnvironment({
      name: "any",
      config: { type: "cloud", image: "whatever" },
    });

    expect(result.type).toBe("created");
  });
});
