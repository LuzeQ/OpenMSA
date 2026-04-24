import { NextRequest, NextResponse } from 'next/server';

function base64UrlToBytes(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binString = atob(b64);
  return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const binString = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join('');
  return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type SessionRole = 'student' | 'teacher' | 'admin';

async function verifySessionCookie(token: string, secret: string): Promise<{
  uid: string;
  role: SessionRole;
} | null> {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const payloadB64 = token.substring(0, dotIndex);
  const signatureB64 = token.substring(dotIndex + 1);

  // HMAC(secret, payloadB64)
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encoder.encode(payloadB64);
  const expectedSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  const expectedB64 = bytesToBase64Url(expectedSig);

  if (signatureB64.length !== expectedB64.length) return null;
  let mismatch = 0;
  for (let i = 0; i < signatureB64.length; i++) {
    mismatch |= signatureB64.charCodeAt(i) ^ expectedB64.charCodeAt(i);
  }
  if (mismatch !== 0) return null;

  let payload: { uid?: string; role?: string; exp?: number; ver?: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
  } catch {
    return null;
  }

  if (!payload.uid || !payload.role || !payload.exp || payload.ver !== 1) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.role !== 'student' && payload.role !== 'teacher' && payload.role !== 'admin') {
    return null;
  }

  return { uid: payload.uid, role: payload.role };
}

function isPublicPage(pathname: string): boolean {
  return pathname === '/login' || pathname === '/register';
}

function isPublicApi(pathname: string): boolean {
  return pathname.startsWith('/api/auth/') || pathname === '/api/health';
}

function isTeacherOnlyArea(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/generation-preview') || pathname.startsWith('/teacher');
}

export async function middleware(request: NextRequest) {
  const authSecret = process.env.AUTH_SECRET;
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');
  const publicPage = isPublicPage(pathname);
  const publicApi = isPublicApi(pathname);

  let session: { uid: string; role: SessionRole } | null = null;
  const sessionCookie = request.cookies.get('openmaic_session')?.value;
  if (authSecret && sessionCookie) {
    session = await verifySessionCookie(sessionCookie, authSecret);
  }

  if (!session) {
    if (publicPage || publicApi) {
      return NextResponse.next();
    }

    if (isApi) {
      return NextResponse.json(
        { success: false, errorCode: 'INVALID_REQUEST', error: 'Authentication required' },
        { status: 401 },
      );
    }

    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (publicPage) {
    const url = request.nextUrl.clone();
    url.pathname = session.role === 'teacher' || session.role === 'admin' ? '/teacher' : '/student';
    return NextResponse.redirect(url);
  }

  if (isTeacherOnlyArea(pathname) && session.role !== 'teacher' && session.role !== 'admin') {
    const url = request.nextUrl.clone();
    url.pathname = '/student';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
