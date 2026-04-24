import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeJsonFileAtomic } from '@/lib/server/classroom-storage';
import type { AuthUserRecord, PublicUser, UserRole } from './types';
import { hashPassword } from './password';

const AUTH_DIR = path.join(process.cwd(), 'data', 'auth');
const USERS_FILE = path.join(AUTH_DIR, 'users.json');

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

async function readUsersFile(): Promise<AuthUserRecord[]> {
  try {
    const content = await fs.readFile(USERS_FILE, 'utf-8');
    const parsed = JSON.parse(content) as AuthUserRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeUsersFile(users: AuthUserRecord[]): Promise<void> {
  await writeJsonFileAtomic(USERS_FILE, users);
}

export async function ensureSeedAdminUser(): Promise<void> {
  const seedUsernameRaw = process.env.AUTH_SEED_ADMIN_USERNAME;
  const seedPassword = process.env.AUTH_SEED_ADMIN_PASSWORD;
  if (!seedUsernameRaw || !seedPassword) return;

  const seedUsername = normalizeUsername(seedUsernameRaw);
  const users = await readUsersFile();
  if (users.length > 0) return;

  const { hash, salt } = await hashPassword(seedPassword);
  const now = new Date().toISOString();
  const record: AuthUserRecord = {
    id: crypto.randomUUID(),
    username: seedUsername,
    passwordHash: hash,
    passwordSalt: salt,
    role: 'admin',
    createdAt: now,
    lastLoginAt: now,
  };
  await writeUsersFile([record]);
}

export async function listUsers(): Promise<AuthUserRecord[]> {
  await ensureSeedAdminUser();
  return readUsersFile();
}

export async function getUserByUsername(username: string): Promise<AuthUserRecord | null> {
  const normalized = normalizeUsername(username);
  const users = await listUsers();
  return users.find((u) => u.username === normalized) || null;
}

export async function getUserById(id: string): Promise<AuthUserRecord | null> {
  const users = await listUsers();
  return users.find((u) => u.id === id) || null;
}

export async function createUser(params: {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  role: UserRole;
}): Promise<AuthUserRecord> {
  const users = await listUsers();
  const normalized = normalizeUsername(params.username);
  if (users.some((u) => u.username === normalized)) {
    throw new Error('USERNAME_TAKEN');
  }

  const now = new Date().toISOString();
  const record: AuthUserRecord = {
    id: crypto.randomUUID(),
    username: normalized,
    passwordHash: params.passwordHash,
    passwordSalt: params.passwordSalt,
    role: params.role,
    createdAt: now,
    lastLoginAt: now,
  };

  users.push(record);
  await writeUsersFile(users);
  return record;
}

export async function updateLastLoginAt(id: string): Promise<void> {
  const users = await listUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx < 0) return;
  users[idx] = { ...users[idx], lastLoginAt: new Date().toISOString() };
  await writeUsersFile(users);
}

export function toPublicUser(user: AuthUserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

