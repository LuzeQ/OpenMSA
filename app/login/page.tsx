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
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { success: boolean; user?: { role: string }; error?: string };
      if (!res.ok || !data.success || !data.user) {
        toast.error(data.error || '登录失败');
        setSubmitting(false);
        return;
      }
      toast.success('登录成功');
      const target = data.user.role === 'teacher' || data.user.role === 'admin' ? '/teacher' : '/student';
      // 使用 window.location.href 强制整页刷新跳转，避免 Next.js 客户端路由缓存和 Cookie 同步的竞态问题
      window.location.href = target;
      return; // 成功时不执行 setSubmitting(false)，避免组件卸载时的状态更新报错
    } catch {
      toast.error('网络错误，请重试');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center p-4 bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>登录</CardTitle>
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
                placeholder="例如: zhangsan"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </Button>
            <div className="text-sm text-muted-foreground flex items-center justify-between">
              <Link href="/register" className="hover:underline">
                去注册
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
