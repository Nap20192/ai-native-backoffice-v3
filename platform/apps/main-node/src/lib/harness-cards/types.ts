// Harness cards of a workspace (docs/plans/models-harness.md, 3.5 to 3.7).
// A card describes an ACP agent that a session runs in its VM: command,
// arguments, packages the environment must have, model protocols and the
// names of the variables the agent may set. Values never live on a card.

export type HarnessCardProtocol = "anthropic-messages" | "openai-chat" | "openai-responses";

/** A card as the API returns it. `created_by` stays in the table. */
export interface HarnessCard {
  id: string;
  harness_id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  install: { npm: string[]; pip: string[] };
  protocols: HarnessCardProtocol[];
  allowed_env: string[];
  status: "unverified";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** Validated body of POST /v1/oma/harness_cards. */
export interface HarnessCardCreateInput {
  harness_id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  install: { npm: string[]; pip: string[] };
  protocols: HarnessCardProtocol[];
  allowed_env: string[];
}

/** Validated body of POST /v1/oma/harness_cards/:id: only the sent fields. */
export type HarnessCardUpdateInput = Partial<Omit<HarnessCardCreateInput, "harness_id">>;

export interface HarnessCardListOptions {
  q?: string;
  include_archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface HarnessCardPage {
  data: HarnessCard[];
  next_cursor: string | null;
}

/** An error the routes turn into `{"error": message, "field": field}`. */
export class HarnessCardError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 501,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = "HarnessCardError";
  }
}

export function isHarnessCardError(error: unknown): error is HarnessCardError {
  return error instanceof HarnessCardError;
}
