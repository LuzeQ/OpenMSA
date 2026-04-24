export type UserRole = 'student' | 'teacher' | 'admin';

export interface AuthUserRecord {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt?: string;
}

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt?: string;
}

