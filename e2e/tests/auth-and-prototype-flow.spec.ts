import { expect, test } from '@playwright/test';

interface RegisterResult {
  success: boolean;
  user?: { id: string; username: string; role: string };
  error?: string;
}

async function registerUser(
  page: import('@playwright/test').Page,
  options: { username: string; password: string; teacherInviteCode?: string },
): Promise<RegisterResult> {
  const res = await page.request.post('/api/auth/register', {
    data: {
      username: options.username,
      password: options.password,
      teacherInviteCode: options.teacherInviteCode,
    },
  });

  const body = (await res.json()) as RegisterResult;
  return body;
}

test.describe('Auth gate + learning workspace flow', () => {
  test('unauthenticated users are blocked from protected APIs and pages', async ({ page }) => {
    const apiRes = await page.request.get('/api/server-providers');
    expect(apiRes.status()).toBe(401);

    await page.goto('/');
    await page.waitForURL(/\/login/);
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  });

  test('student is redirected from / to /student after login', async ({ page }) => {
    const username = `e2e_student_${Date.now()}`;
    const register = await registerUser(page, {
      username,
      password: 'e2e-pass-123',
    });

    expect(register.success).toBe(true);
    expect(register.user?.role).toBe('student');

    await page.goto('/');
    await page.waitForURL(/\/student/);
    await expect(page.getByRole('heading', { name: `你好，${username}` })).toBeVisible();
  });

  test('teacher can create a program from the integrated workspace', async ({ page }) => {
    const username = `e2e_teacher_${Date.now()}`;
    const register = await registerUser(page, {
      username,
      password: 'e2e-pass-123',
      teacherInviteCode: process.env.TEACHER_INVITE_CODE || 'openmaic-teacher',
    });

    test.skip(
      !register.success || register.user?.role !== 'teacher',
      'Teacher invite code is not configured for E2E.',
    );

    await page.goto('/teacher');
    await expect(page.getByRole('heading', { name: `${username} 老师工作台` })).toBeVisible();

    await page.getByPlaceholder('例如：初中物理进阶系列课').fill('E2E 课程体系');
    await page.getByPlaceholder('课时标题').first().fill('第一课时：概念导入');
    await page.getByRole('button', { name: '保存课程体系' }).click();

    await expect(page.getByText('课程体系创建成功')).toBeVisible();
    await expect(page.getByText('E2E 课程体系')).toBeVisible();
  });
});
