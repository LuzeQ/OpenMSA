'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export default function Page() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [teacherInviteCode, setTeacherInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          teacherInviteCode: teacherInviteCode.trim() ? teacherInviteCode.trim() : undefined,
        }),
      });
      const data = (await res.json()) as { success: boolean; user?: { role: string } };
      if (!res.ok || !data.success || !data.user) {
        toast.error('注册失败');
        setSubmitting(false);
        return;
      }
      toast.success('注册成功');
      window.location.href = data.user.role === 'teacher' || data.user.role === 'admin' ? '/teacher' : '/student';
    } catch {
      toast.error('网络错误，请重试');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center p-4 bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>注册</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="3-32位，字母/数字/下划线"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少6位"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="teacherInviteCode">教师邀请码（可选）</Label>
              <Input
                id="teacherInviteCode"
                value={teacherInviteCode}
                onChange={(e) => setTeacherInviteCode(e.target.value)}
                placeholder="仅教师需要"
              />
            </div>
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? '注册中…' : '注册'}
            </Button>
            <div className="text-sm text-muted-foreground flex items-center justify-between">
              <Link href="/login" className="hover:underline">
                去登录
              </Link>
              <Link href="/" className="hover:underline">
                返回首页
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
