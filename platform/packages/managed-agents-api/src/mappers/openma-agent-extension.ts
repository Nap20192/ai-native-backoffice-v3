import type { AgentOpenMaExtensions } from "@open-managed-agents/managed-agents-application";

/** Project a versioned OpenMA Agent extension onto its public wire shape. */
export function fromOpenMaAgentExtension(
  extension: AgentOpenMaExtensions,
): object {
  return {
    ...(extension.auxiliaryModel !== undefined && {
      aux_model: {
        id: extension.auxiliaryModel.id,
        ...(extension.auxiliaryModel.effort !== undefined && {
          effort: { type: extension.auxiliaryModel.effort },
        }),
        ...(extension.auxiliaryModel.inferenceGeo !== undefined && {
          inference_geo: extension.auxiliaryModel.inferenceGeo,
        }),
        ...(extension.auxiliaryModel.providerOptions !== undefined && {
          provider_options: extension.auxiliaryModel.providerOptions,
        }),
        ...(extension.auxiliaryModel.speed !== undefined && {
          speed: extension.auxiliaryModel.speed,
        }),
      },
    }),
    ...(extension.appendablePrompts !== undefined && {
      appendable_prompts: extension.appendablePrompts,
    }),
    ...(extension.contextManagement !== undefined && {
      context_management: extension.contextManagement,
    }),
    ...(extension.openaiModelSettings !== undefined && {
      model_settings: extension.openaiModelSettings,
    }),
    ...(extension.harness !== undefined && { harness: extension.harness }),
    ...(extension.enableGeneralSubagent !== undefined && {
      enable_general_subagent: extension.enableGeneralSubagent,
    }),
  };
}
