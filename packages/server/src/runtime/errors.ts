import type { RuntimeErrorDto } from '@agent-tower/shared';

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentRuntimeError';
  }
}

export function toRuntimeError(error: unknown, stage = 'runtime'): RuntimeErrorDto {
  if (error instanceof AgentRuntimeError) {
    return {
      code: error.code,
      stage: error.stage,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'unexpected_error',
    stage,
    message: error instanceof Error ? error.message : 'Unknown runtime error',
    retryable: false,
  };
}
