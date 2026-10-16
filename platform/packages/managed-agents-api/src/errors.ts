export interface AnthropicErrorEnvelope {
  type: "error";
  error:
    | {
        type:
          | "invalid_request_error"
          | "not_found_error"
          | "conflict_error"
          | "precondition_failed_error"
          | "api_error";
        message: string;
      }
    | {
        type: "memory_precondition_failed_error";
        message: string;
      }
    | {
        type: "memory_path_conflict_error";
        message: string;
        conflicting_memory_id?: string;
        conflicting_path?: string;
      };
}

export function apiError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: {
      type: "api_error",
      message,
    },
  };
}

export function invalidRequest(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message,
    },
  };
}

export function notFound(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: {
      type: "not_found_error",
      message,
    },
  };
}

export function conflict(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: {
      type: "conflict_error",
      message,
    },
  };
}

/** 412: `If-Match` names another revision than the stored one. */
export function preconditionFailed(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: {
      type: "precondition_failed_error",
      message,
    },
  };
}

export function memoryPreconditionFailed(
  message: string,
): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "memory_precondition_failed_error", message },
  };
}

export function memoryPathConflict(conflictDetails: {
  message: string;
  conflictingMemoryId?: string;
  conflictingPath?: string;
}): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: {
      type: "memory_path_conflict_error",
      message: conflictDetails.message,
      ...(conflictDetails.conflictingMemoryId !== undefined && {
        conflicting_memory_id: conflictDetails.conflictingMemoryId,
      }),
      ...(conflictDetails.conflictingPath !== undefined && {
        conflicting_path: conflictDetails.conflictingPath,
      }),
    },
  };
}
