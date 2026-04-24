import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(params: {
  password: string;
  salt: string;
  hash: string;
}): Promise<boolean> {
  const derived = (await scryptAsync(params.password, params.salt, 64)) as Buffer;
  const expected = Buffer.from(params.hash, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

