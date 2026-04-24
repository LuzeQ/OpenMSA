import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { buildSessionCookieOptions, SESSION_COOKIE_NAME } from '@/lib/server/auth/session';

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, '', {
    ...buildSessionCookieOptions(),
    maxAge: 0,
  });
  return apiSuccess({});
}

