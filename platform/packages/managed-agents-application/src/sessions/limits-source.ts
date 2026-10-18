import type { SessionLimitsInput, SessionLimitsView } from "../domain/session";

export interface ReadSessionLimits {
  workspaceId: string;
  sessionId: string;
}

export interface SetSessionLimits extends ReadSessionLimits {
  limits: SessionLimitsInput;
}

export type RaiseSessionLimitsResult =
  | { type: "raised"; limits: SessionLimitsView }
  /** A new limit is not above the work counted against it. Nothing changed. */
  | { type: "not_above_used"; limits: SessionLimitsView };

/**
 * Where a Session stands against its limits. `at_limit`: its last turn
 * stopped on `budget_reached` or `requires_action`, and the work counted
 * reaches a limit. Then only answers to calls and interrupts are accepted.
 */
export type SessionLimitStanding =
  | { type: "at_limit"; limits: SessionLimitsView }
  | { type: "within_limits" };

/** Reads the limits of a Session with the work counted so far
 * (docs/plans/multiagent.md, 3.Б). */
export interface SessionLimitsSourcePort {
  read(input: ReadSessionLimits): Promise<SessionLimitsView>;
}

/** Reads and changes the limits of a Session (docs/plans/multiagent.md, 3.Б). */
export interface SessionLimitsPort extends SessionLimitsSourcePort {
  standing(input: ReadSessionLimits): Promise<SessionLimitStanding>;
  /** Sets the limits of a new Session before its first turn. */
  set(input: SetSessionLimits): Promise<void>;
  /** New limits for a Session. Each given value must be above the work
   * counted against it, otherwise nothing changes. */
  raise(input: SetSessionLimits): Promise<RaiseSessionLimitsResult>;
  /** A Session whose turn stopped on `budget_reached` and that is now under
   * its token limit goes on with that turn. Otherwise nothing happens. */
  resume(input: ReadSessionLimits): Promise<void>;
}
