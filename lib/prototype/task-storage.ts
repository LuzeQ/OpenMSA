export const PROTOTYPE_TASKS_STORAGE_KEY = 'openmaic_prototype_tasks_v1';

export type PrototypeTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface PrototypeTask {
  id: string;
  title: string;
  scene: string;
  status: PrototypeTaskStatus;
  assignedAt: string;
  source: string;
}

export interface UpsertPrototypeTaskInput {
  id: string;
  title: string;
  scene: string;
  source: string;
  status?: PrototypeTaskStatus;
  assignedAt?: string;
}

export interface UpsertPrototypeTaskResult {
  task: PrototypeTask;
  created: boolean;
}

type Subscriber = (tasks: PrototypeTask[]) => void;

const subscribers = new Set<Subscriber>();
let hasStorageListener = false;

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeTask(value: unknown): PrototypeTask | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Partial<PrototypeTask>;

  if (
    typeof task.id !== 'string' ||
    typeof task.title !== 'string' ||
    typeof task.scene !== 'string' ||
    typeof task.assignedAt !== 'string' ||
    typeof task.source !== 'string'
  ) {
    return null;
  }

  if (task.status !== 'pending' && task.status !== 'in_progress' && task.status !== 'completed') {
    return null;
  }

  return {
    id: task.id,
    title: task.title,
    scene: task.scene,
    status: task.status,
    assignedAt: task.assignedAt,
    source: task.source,
  };
}

function writeTasks(tasks: PrototypeTask[]) {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(PROTOTYPE_TASKS_STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Ignore write failures in private mode or quota errors.
  }
}

function notifySubscribers() {
  const tasks = readPrototypeTasks();
  for (const subscriber of subscribers) {
    subscriber(tasks);
  }
}

function handleStorageEvent(event: StorageEvent) {
  if (event.key && event.key !== PROTOTYPE_TASKS_STORAGE_KEY) {
    return;
  }
  notifySubscribers();
}

function ensureStorageListener() {
  if (hasStorageListener || typeof window === 'undefined') return;
  window.addEventListener('storage', handleStorageEvent);
  hasStorageListener = true;
}

function cleanupStorageListener() {
  if (!hasStorageListener || subscribers.size > 0 || typeof window === 'undefined') return;
  window.removeEventListener('storage', handleStorageEvent);
  hasStorageListener = false;
}

export function readPrototypeTasks(): PrototypeTask[] {
  const storage = getStorage();
  if (!storage) return [];

  try {
    const raw = storage.getItem(PROTOTYPE_TASKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const tasks = parsed
      .map((item) => normalizeTask(item))
      .filter((task): task is PrototypeTask => task !== null);

    return tasks.sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  } catch {
    return [];
  }
}

export function upsertPrototypeTask(input: UpsertPrototypeTaskInput): UpsertPrototypeTaskResult {
  const tasks = readPrototypeTasks();
  const existing = tasks.find((task) => task.source === input.source);
  if (existing) {
    return { task: existing, created: false };
  }

  const task: PrototypeTask = {
    id: input.id,
    title: input.title,
    scene: input.scene,
    source: input.source,
    status: input.status ?? 'pending',
    assignedAt: input.assignedAt ?? new Date().toISOString(),
  };

  const nextTasks = [task, ...tasks.filter((item) => item.id !== task.id)];
  writeTasks(nextTasks);
  notifySubscribers();
  return { task, created: true };
}

export function updatePrototypeTaskStatus(
  taskId: string,
  status: PrototypeTaskStatus,
): PrototypeTask | null {
  const tasks = readPrototypeTasks();
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;

  const updatedTask = { ...tasks[index], status };
  const nextTasks = [...tasks];
  nextTasks[index] = updatedTask;

  writeTasks(nextTasks);
  notifySubscribers();
  return updatedTask;
}

export function subscribePrototypeTasks(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  ensureStorageListener();

  return () => {
    subscribers.delete(subscriber);
    cleanupStorageListener();
  };
}
