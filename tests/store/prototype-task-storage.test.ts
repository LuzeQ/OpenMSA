import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function createMockWindow() {
  const eventTarget = new EventTarget() as EventTarget & { localStorage: Storage };
  eventTarget.localStorage = new MemoryStorage();
  return eventTarget as unknown as Window & typeof globalThis;
}

describe('prototype task storage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', createMockWindow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deduplicates by source when dispatching tasks', async () => {
    const { upsertPrototypeTask, readPrototypeTasks } = await import('@/lib/prototype/task-storage');

    const first = upsertPrototypeTask({
      id: 'task-a1',
      title: 'Task A',
      scene: 'Scene A',
      source: 'alert-a1',
    });
    const second = upsertPrototypeTask({
      id: 'task-a1-duplicate',
      title: 'Task A Duplicate',
      scene: 'Scene A',
      source: 'alert-a1',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(readPrototypeTasks()).toHaveLength(1);
    expect(readPrototypeTasks()[0].id).toBe('task-a1');
  });

  it('supports status transitions pending -> in_progress -> completed', async () => {
    const { upsertPrototypeTask, updatePrototypeTaskStatus, readPrototypeTasks } = await import(
      '@/lib/prototype/task-storage'
    );

    upsertPrototypeTask({
      id: 'task-a2',
      title: 'Task B',
      scene: 'Scene B',
      source: 'alert-a2',
    });

    const inProgress = updatePrototypeTaskStatus('task-a2', 'in_progress');
    const completed = updatePrototypeTaskStatus('task-a2', 'completed');

    expect(inProgress?.status).toBe('in_progress');
    expect(completed?.status).toBe('completed');
    expect(readPrototypeTasks()[0].status).toBe('completed');
  });

  it('notifies subscribers on same-tab writes and cross-tab storage events', async () => {
    const {
      PROTOTYPE_TASKS_STORAGE_KEY,
      subscribePrototypeTasks,
      upsertPrototypeTask,
      readPrototypeTasks,
    } = await import('@/lib/prototype/task-storage');

    const callback = vi.fn();
    const unsubscribe = subscribePrototypeTasks(callback);

    upsertPrototypeTask({
      id: 'task-a3',
      title: 'Task C',
      scene: 'Scene C',
      source: 'alert-a3',
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0][0].id).toBe('task-a3');

    window.localStorage.setItem(
      PROTOTYPE_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'task-a4',
          title: 'Task D',
          scene: 'Scene D',
          status: 'pending',
          assignedAt: new Date().toISOString(),
          source: 'alert-a4',
        },
      ]),
    );

    const storageEvent = new Event('storage') as Event & { key?: string | null };
    Object.defineProperty(storageEvent, 'key', { value: PROTOTYPE_TASKS_STORAGE_KEY });
    window.dispatchEvent(storageEvent);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(readPrototypeTasks()[0].id).toBe('task-a4');

    unsubscribe();
  });
});
