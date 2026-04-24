import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { verifyPassword } from '@/lib/server/auth/password';
import { getUserByUsername, toPublicUser, updateLastLoginAt } from '@/lib/server/auth/storage';
import {
  buildSessionCookieOptions,
  createSessionToken,
  SESSION_COOKIE_NAME,
} from '@/lib/server/auth/session';

export async function POST(request: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  const username = body.username?.trim();
  const password = body.password;
  if (!username || !password) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing username or password');
  }

  const user = await getUserByUsername(username);
  if (!user) {
    return apiError('INVALID_REQUEST', 401, 'Invalid credentials');
  }

  const ok = await verifyPassword({
    password,
    salt: user.passwordSalt,
    hash: user.passwordHash,
  });
  if (!ok) {
    return apiError('INVALID_REQUEST', 401, 'Invalid credentials');
  }

  await updateLastLoginAt(user.id);

  let token: string;
  try {
    token = createSessionToken({ uid: user.id, role: user.role });
  } catch (err) {
    return apiError('INTERNAL_ERROR', 500, err instanceof Error ? err.message : 'Auth error');
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    ...buildSessionCookieOptions(),
    maxAge: 60 * 60 * 24 * 7,
  });

  return apiSuccess({ user: toPublicUser(user) });
}

