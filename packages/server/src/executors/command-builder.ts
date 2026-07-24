/**
 * CommandBuilder - 命令构建器
 * 参考 Rust 实现: crates/executors/src/command.rs
 */

import { which } from '../utils/index.js';

export interface CommandParts {
  program: string;
  args: string[];
}

export interface CmdOverrides {
  /** 覆盖基础命令 */
  baseCommandOverride?: string;
  /** 额外参数 */
  additionalParams?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 从父进程和 Session 环境中显式移除的变量；同一 profile 的 env 值优先。 */
  unsetEnv?: string[];
}

export class CommandBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandBuildError';
  }
}

/**
 * 解析命令行字符串为数组
 * 简单实现，支持引号和转义
 */
function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
      continue;
    }

    if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
      continue;
    }

    if (char === ' ' && !inQuote) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    result.push(current);
  }

  return result;
}

export class CommandBuilder {
  private base: string;
  private params: string[] = [];

  constructor(base: string) {
    this.base = base;
  }

  /**
   * 创建新的 CommandBuilder
   */
  static new(base: string): CommandBuilder {
    return new CommandBuilder(base);
  }

  /**
   * 设置参数（替换现有参数）
   */
  setParams(params: string[]): CommandBuilder {
    this.params = [...params];
    return this;
  }

  /**
   * 扩展参数
   */
  extendParams(more: string[]): CommandBuilder {
    this.params.push(...more);
    return this;
  }

  /**
   * 覆盖基础命令
   */
  overrideBase(base: string): CommandBuilder {
    this.base = base;
    return this;
  }

  /**
   * 构建初始命令
   */
  buildInitial(): CommandParts {
    return this.build([]);
  }

  /**
   * 构建 follow-up 命令
   */
  buildFollowUp(additionalArgs: string[]): CommandParts {
    return this.build(additionalArgs);
  }

  /**
   * 内部构建方法
   */
  private build(additionalArgs: string[]): CommandParts {
    const parts: string[] = [];

    // 解析基础命令
    const baseParts = splitCommandLine(this.base);
    parts.push(...baseParts);

    // 添加参数
    parts.push(...this.params);

    // 添加额外参数
    parts.push(...additionalArgs);

    if (parts.length === 0) {
      throw new CommandBuildError('Command is empty after parsing');
    }

    const program = parts.shift()!;
    return { program, args: parts };
  }
}

/**
 * 应用命令覆盖
 */
export function applyOverrides(
  builder: CommandBuilder,
  overrides?: CmdOverrides
): CommandBuilder {
  if (!overrides) return builder;

  if (overrides.baseCommandOverride) {
    builder.overrideBase(overrides.baseCommandOverride);
  }

  if (overrides.additionalParams) {
    builder.extendParams(overrides.additionalParams);
  }

  return builder;
}

/**
 * 解析命令路径
 */
export async function resolveCommandParts(
  parts: CommandParts
): Promise<{ programPath: string; args: string[] }> {
  const programPath = await which(parts.program);
  if (!programPath) {
    throw new CommandBuildError(`Executable '${parts.program}' not found in PATH`);
  }
  return { programPath, args: parts.args };
}
