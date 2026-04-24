import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserById } from '@/lib/server/auth/storage';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/server/auth/session';
import { TeacherDashboardClient } from '@/components/dashboard/teacher-dashboard-client';

export default async function TeacherDashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    redirect('/login');
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    redirect('/login');
  }

  const user = await getUserById(payload.uid);
  if (!user || (user.role !== 'teacher' && user.role !== 'admin')) {
    redirect('/login');
  }

  return <TeacherDashboardClient username={user.username} />;
}
