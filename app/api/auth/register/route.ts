import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { hashPassword } from '@/lib/server/auth/password';
import { createUser, toPublicUser } from '@/lib/server/auth/storage';
import {
  buildSessionCookieOptions,
  createSessionToken,
  SESSION_COOKIE_NAME,
} from '@/lib/server/auth/session';

function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,32}$/.test(username);
}

export async function POST(request: Request) {
  let body: { username?: string; password?: string; teacherInviteCode?: string };
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
  if (!isValidUsername(username)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid username');
  }
  if (password.length < 6) {
    return apiError('INVALID_REQUEST', 400, 'Password too short');
  }

  const teacherInvite = process.env.TEACHER_INVITE_CODE;
  const role =
    teacherInvite && body.teacherInviteCode && body.teacherInviteCode === teacherInvite
      ? 'teacher'
      : 'student';

  const { hash, salt } = await hashPassword(password);

  let user;
  try {
    user = await createUser({ username, passwordHash: hash, passwordSalt: salt, role });
  } catch (err) {
    if (err instanceof Error && err.message === 'USERNAME_TAKEN') {
      return apiError('INVALID_REQUEST', 409, 'Username already taken');
    }
    return apiError('INTERNAL_ERROR', 500, 'Failed to create user');
  }

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

