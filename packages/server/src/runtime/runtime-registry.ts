import type { RuntimeType } from '@agent-tower/shared';
import type { RuntimeDriver, RuntimeRegistry } from './contracts.js';
import { AgentRuntimeError } from './errors.js';

export class StaticRuntimeRegistry implements RuntimeRegistry {
  private readonly drivers = new Map<RuntimeType, RuntimeDriver>();

  constructor(drivers: RuntimeDriver[]) {
    for (const driver of drivers) {
      this.drivers.set(driver.type, driver);
    }
  }

  get(runtimeType: RuntimeType): RuntimeDriver {
    const driver = this.drivers.get(runtimeType);
    if (!driver) {
      throw new AgentRuntimeError(
        'runtime_not_supported',
        'open',
        `Runtime '${runtimeType}' is not registered`,
        false,
      );
    }
    return driver;
  }
}
