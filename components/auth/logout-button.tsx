'use client';

import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export function LogoutButton() {
  const onLogout = async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        toast.error('退出失败');
        return;
      }
      window.location.href = '/login';
    } catch {
      toast.error('退出失败');
    }
  };

  return (
    <Button variant="outline" onClick={onLogout}>
      退出登录
    </Button>
  );
}
