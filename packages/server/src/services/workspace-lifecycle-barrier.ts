import { AsyncLocalStorage } from 'node:async_hooks';

export class WorkspaceLifecycleBarrier {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly heldWorkspaceIds = new AsyncLocalStorage<ReadonlySet<string>>();

  async withWorkspace<T>(
    workspaceId: string,
    operation: () => Promise<T>,
    options: { allowReentry?: boolean } = {},
  ): Promise<T> {
    const held = this.heldWorkspaceIds.getStore();
    if (options.allowReentry && held?.has(workspaceId)) return operation();

    const previous = this.tails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(workspaceId, tail);
    await previous.catch(() => undefined);

    const nextHeld = new Set(held ?? []);
    nextHeld.add(workspaceId);
    try {
      return await this.heldWorkspaceIds.run(nextHeld, operation);
    } finally {
      release();
      if (this.tails.get(workspaceId) === tail) this.tails.delete(workspaceId);
    }
  }

  async withWorkspaces<T>(workspaceIds: Iterable<string>, operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(workspaceIds)].sort();
    const acquire = (index: number): Promise<T> => (
      index >= ids.length
        ? operation()
        : this.withWorkspace(ids[index]!, () => acquire(index + 1))
    );
    return acquire(0);
  }
}

export const defaultWorkspaceLifecycleBarrier = new WorkspaceLifecycleBarrier();
