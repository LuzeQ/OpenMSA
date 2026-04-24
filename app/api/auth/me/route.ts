import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { getUserById, toPublicUser } from '@/lib/server/auth/storage';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/server/auth/session';

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return apiSuccess({ user: null });
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    return apiSuccess({ user: null });
  }

  const user = await getUserById(payload.uid);
  if (!user) {
    return apiSuccess({ user: null });
  }

  return apiSuccess({ user: toPublicUser(user) });
}

