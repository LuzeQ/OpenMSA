import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

function createRequest(pathname: string, cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) {
    headers.set('cookie', `openmaic_session=${cookieValue}`);
  }

  return new NextRequest(new Request(`https://example.com${pathname}`, { headers }));
}

async function createSessionCookie(role: 'student' | 'teacher' | 'admin'): Promise<string> {
  const { createSessionToken } = await import('@/lib/server/auth/session');
  return createSessionToken({ uid: `uid-${role}`, role, ttlSeconds: 60 * 60 });
}

describe('middleware auth and role guard', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.AUTH_SECRET = 'test-auth-secret';
  });

  it('allows unauthenticated access to public pages and auth APIs', async () => {
    const { middleware } = await import('@/middleware');

    const pageRes = await middleware(createRequest('/login'));
    const apiRes = await middleware(createRequest('/api/auth/login'));

    expect(pageRes.status).toBe(200);
    expect(apiRes.status).toBe(200);
  });

  it('blocks unauthenticated protected pages and APIs', async () => {
    const { middleware } = await import('@/middleware');

    const pageRes = await middleware(createRequest('/'));
    const apiRes = await middleware(createRequest('/api/server-providers'));
    const apiBody = await apiRes.json();

    expect(pageRes.status).toBe(307);
    expect(pageRes.headers.get('location')).toContain('/login');

    expect(apiRes.status).toBe(401);
    expect(apiBody).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Authentication required',
    });
  });

  it('redirects logged-in users away from /login and /register by role', async () => {
    const { middleware } = await import('@/middleware');
    const studentToken = await createSessionCookie('student');
    const teacherToken = await createSessionCookie('teacher');

    const studentRes = await middleware(createRequest('/login', studentToken));
    const teacherRes = await middleware(createRequest('/register', teacherToken));

    expect(studentRes.status).toBe(307);
    expect(studentRes.headers.get('location')).toContain('/student');
    expect(teacherRes.status).toBe(307);
    expect(teacherRes.headers.get('location')).toContain('/teacher');
  });

  it('enforces teacher-only areas: /, /generation-preview, /teacher', async () => {
    const { middleware } = await import('@/middleware');
    const studentToken = await createSessionCookie('student');
    const teacherToken = await createSessionCookie('teacher');

    const studentRootRes = await middleware(createRequest('/', studentToken));
    const studentPreviewRes = await middleware(createRequest('/generation-preview', studentToken));
    const studentTeacherRes = await middleware(createRequest('/teacher', studentToken));
    const teacherRootRes = await middleware(createRequest('/', teacherToken));
    const teacherPreviewRes = await middleware(createRequest('/generation-preview', teacherToken));
    const teacherTeacherRes = await middleware(createRequest('/teacher', teacherToken));

    expect(studentRootRes.status).toBe(307);
    expect(studentRootRes.headers.get('location')).toContain('/student');
    expect(studentPreviewRes.status).toBe(307);
    expect(studentPreviewRes.headers.get('location')).toContain('/student');
    expect(studentTeacherRes.status).toBe(307);
    expect(studentTeacherRes.headers.get('location')).toContain('/student');

    expect(teacherRootRes.status).toBe(200);
    expect(teacherPreviewRes.status).toBe(200);
    expect(teacherTeacherRes.status).toBe(200);
  });

  it('allows both student and teacher to access /student and /classroom/*', async () => {
    const { middleware } = await import('@/middleware');
    const studentToken = await createSessionCookie('student');
    const teacherToken = await createSessionCookie('teacher');

    const studentDashboardRes = await middleware(createRequest('/student', studentToken));
    const teacherDashboardRes = await middleware(createRequest('/student', teacherToken));
    const studentClassroomRes = await middleware(createRequest('/classroom/stage-1', studentToken));
    const teacherClassroomRes = await middleware(createRequest('/classroom/stage-1', teacherToken));

    expect(studentDashboardRes.status).toBe(200);
    expect(teacherDashboardRes.status).toBe(200);
    expect(studentClassroomRes.status).toBe(200);
    expect(teacherClassroomRes.status).toBe(200);
  });
});
