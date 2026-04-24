import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserById } from '@/lib/server/auth/storage';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/server/auth/session';
import { StudentDashboardClient } from '@/components/dashboard/student-dashboard-client';

export default async function StudentDashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const payload = token ? verifySessionToken(token) : null;
  const user = payload ? await getUserById(payload.uid) : null;

  if (!user) {
    redirect('/login');
  }

  return <StudentDashboardClient username={user.username} />;
}
