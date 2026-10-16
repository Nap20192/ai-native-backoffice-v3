export type EnvironmentNetwork =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowMcpServers: boolean;
      allowPackageManagers: boolean;
      /** OMA extension: web search for a limited network. Absent means false. */
      allowWebSearch?: boolean;
      allowedHosts: string[];
    };

export interface EnvironmentPackages {
  apt: string[];
  cargo: string[];
  gem: string[];
  go: string[];
  npm: string[];
  pip: string[];
}

export type EnvironmentConfig =
  | {
      type: "cloud";
      /** OMA extension: sandbox image catalog key. Absent or null means the
       *  catalog's default image when the VM is created. */
      image?: string | null;
      networking: EnvironmentNetwork;
      packages: EnvironmentPackages;
    }
  | { type: "self_hosted" };

export interface Environment {
  id: string;
  archivedAt: string | null;
  config: EnvironmentConfig;
  createdAt: string;
  description: string | null;
  metadata: Record<string, string>;
  name: string;
  updatedAt: string;
  scope?: "organization" | "account";
}
