import { cookies } from 'next/headers';
import { getUserById } from '@/lib/server/auth/storage';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/server/auth/session';

export async function getCurrentUserFromSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = verifySessionToken(token);
  if (!payload) return null;

  return getUserById(payload.uid);
}
