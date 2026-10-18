import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { AgentCreateBody, AgentMultiagentBody } from "../src/contracts/agents";

type OfficialAgentCreateBody = Omit<AgentCreateParams, "betas">;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

const agentCreateBodyMatchesOfficialContract: Equal<
  Omit<AgentCreateBody, "_oma" | "mcp_servers" | "multiagent">,
  Omit<OfficialAgentCreateBody, "mcp_servers" | "multiagent">
> = true;

// The multiagent wire adds `multiagent_20261001` and keeps every SDK form
// (API_LAYER.md, "Multiagent block").
type OfficialMultiagent = Exclude<OfficialAgentCreateBody["multiagent"], null | undefined>;
const officialMultiagentStillAccepted: OfficialMultiagent extends AgentMultiagentBody
  ? true
  : false = true;

void agentCreateBodyMatchesOfficialContract;
void officialMultiagentStillAccepted;
