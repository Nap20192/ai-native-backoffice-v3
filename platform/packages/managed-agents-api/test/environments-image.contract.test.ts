import { describe, expect, it } from "vitest";
import type { EnvironmentView } from "../src/index";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { buildEnvironmentsTestApi } from "./test-api";

// OMA extensions of the cloud config (docs/plans/environments.md, 1.5 and 7.3):
// `config.image` picks a sandbox image by catalog key, and
// `networking.allow_web_search` lets a limited network use web search.

const BETA = "managed-agents-2026-04-01";

function environmentView(config: EnvironmentView["config"]): EnvironmentView {
  return {
    id: "env_img_01",
    archivedAt: null,
    config,
    createdAt: "2026-10-16T08:00:00.000Z",
    description: null,
    metadata: {},
    name: "workplace",
    updatedAt: "2026-10-16T08:00:00.000Z",
  };
}

const plainCloudConfig: EnvironmentView["config"] = {
  type: "cloud",
  networking: {
    type: "limited",
    allowMcpServers: false,
    allowPackageManagers: true,
    allowedHosts: [],
  },
  packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
};

function post(api: ReturnType<typeof buildEnvironmentsTestApi>, path: string, body: unknown) {
  return api.request(path, {
    method: "POST",
    headers: { "anthropic-beta": BETA, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Managed Agents API — environment image and web search extensions", () => {
  it("maps config.image and allow_web_search into the create command and back", async () => {
    const createCalls: unknown[] = [];
    const api = buildEnvironmentsTestApi(
      makeEnvironmentsPort({
        createEnvironment: async (command) => {
          createCalls.push(command);
          return {
            type: "created",
            environment: environmentView({
              type: "cloud",
              image: "workplace-office",
              networking: {
                type: "limited",
                allowMcpServers: true,
                allowPackageManagers: true,
                allowWebSearch: true,
                allowedHosts: ["example.org"],
              },
              packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
            }),
          };
        },
      }),
    );

    const response = await post(api, "/v1/environments", {
      name: "workplace",
      config: {
        type: "cloud",
        image: "workplace-office",
        networking: {
          type: "limited",
          allow_mcp_servers: true,
          allow_package_managers: true,
          allow_web_search: true,
          allowed_hosts: ["example.org"],
        },
      },
    });

    expect(response.status).toBe(201);
    expect(createCalls).toEqual([
      {
        name: "workplace",
        config: {
          type: "cloud",
          image: "workplace-office",
          networking: {
            type: "limited",
            allowMcpServers: true,
            allowPackageManagers: true,
            allowWebSearch: true,
            allowedHosts: ["example.org"],
          },
        },
      },
    ]);
    const body = (await response.json()) as { config: Record<string, unknown> };
    expect(body.config).toEqual({
      type: "cloud",
      image: "workplace-office",
      networking: {
        type: "limited",
        allow_mcp_servers: true,
        allow_package_managers: true,
        allow_web_search: true,
        allowed_hosts: ["example.org"],
      },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    });
  });

  it("answers image null and allow_web_search false for environments without them", async () => {
    const api = buildEnvironmentsTestApi(
      makeEnvironmentsPort({
        retrieveEnvironment: async () => ({
          type: "found",
          environment: environmentView(plainCloudConfig),
        }),
      }),
    );

    const response = await api.request("/v1/environments/env_img_01", {
      headers: { "anthropic-beta": BETA },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      config: { image: unknown; networking: Record<string, unknown> };
    };
    expect(body.config.image).toBeNull();
    expect(body.config.networking.allow_web_search).toBe(false);
  });

  it("passes an explicit null image through the update command", async () => {
    const updateCalls: unknown[] = [];
    const api = buildEnvironmentsTestApi(
      makeEnvironmentsPort({
        updateEnvironment: async (command) => {
          updateCalls.push(command);
          return { type: "updated", environment: environmentView(plainCloudConfig) };
        },
      }),
    );

    const response = await post(api, "/v1/environments/env_img_01", {
      config: { type: "cloud", image: null, networking: { type: "unrestricted" } },
    });

    expect(response.status).toBe(200);
    expect(updateCalls).toEqual([
      {
        environmentId: "env_img_01",
        config: { type: "cloud", image: null, networking: { type: "unrestricted" } },
      },
    ]);
  });

  it("rejects allow_web_search outside a limited network and image on a self-hosted config", async () => {
    const api = buildEnvironmentsTestApi(
      makeEnvironmentsPort({
        createEnvironment: async () => {
          throw new Error("the contract must reject the body before the application");
        },
      }),
    );

    const unrestricted = await post(api, "/v1/environments", {
      name: "web",
      config: {
        type: "cloud",
        networking: { type: "unrestricted", allow_web_search: true },
      },
    });
    expect(unrestricted.status).toBe(400);
    expect(JSON.stringify(await unrestricted.json())).toContain("config.networking");

    const selfHosted = await post(api, "/v1/environments", {
      name: "self",
      config: { type: "self_hosted", image: "workplace" },
    });
    expect(selfHosted.status).toBe(400);

    const emptyImage = await post(api, "/v1/environments", {
      name: "empty",
      config: { type: "cloud", image: "" },
    });
    expect(emptyImage.status).toBe(400);
    expect(JSON.stringify(await emptyImage.json())).toContain("config.image");
  });

  it("answers 400 with the field the configuration policy rejected", async () => {
    const api = buildEnvironmentsTestApi(
      makeEnvironmentsPort({
        createEnvironment: async () => ({
          type: "invalid_request",
          message: 'Invalid request field config.image: unknown sandbox image "nope"',
        }),
        updateEnvironment: async () => ({
          type: "invalid_request",
          message: 'Invalid request field config.image: unknown sandbox image "nope"',
        }),
      }),
    );

    for (const path of ["/v1/environments", "/v1/environments/env_img_01"]) {
      const response = await post(api, path, {
        name: "nope",
        config: { type: "cloud", image: "nope" },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toBe(
        'Invalid request field config.image: unknown sandbox image "nope"',
      );
    }
  });
});
