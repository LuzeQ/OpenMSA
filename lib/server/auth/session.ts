import crypto from 'crypto';
import type { UserRole } from './types';

export const SESSION_COOKIE_NAME = 'openmaic_session';

export interface SessionPayload {
  uid: string;
  role: UserRole;
  exp: number;
  ver: number;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  const padLen = (4 - (input.length % 4)) % 4;
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Buffer.from(base64, 'base64');
}

function sign(payloadB64: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadB64);
  return base64UrlEncode(hmac.digest());
}

export function createSessionToken(params: {
  uid: string;
  role: UserRole;
  ttlSeconds?: number;
}): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET_NOT_SET');
  }
  const ttl = params.ttlSeconds ?? 7 * 24 * 60 * 60;
  const payload: SessionPayload = {
    uid: params.uid,
    role: params.role,
    exp: Math.floor(Date.now() / 1000) + ttl,
    ver: 1,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(payloadB64, secret);
  const sigBuf = base64UrlDecodeToBuffer(sig);
  const expectedBuf = base64UrlDecodeToBuffer(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlDecodeToBuffer(payloadB64).toString('utf-8')) as SessionPayload;
  } catch {
    return null;
  }

  if (!payload?.uid || !payload?.role || !payload?.exp) return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.ver !== 1) return null;
  return payload;
}

export function buildSessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd,
    path: '/',
  };
}

