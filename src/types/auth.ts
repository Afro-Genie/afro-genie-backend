export type UserRole = 'USER' | 'ADMIN' | 'ARTIST' | 'MODERATOR';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface JwtClaims {
  userId?: string;
  sub?: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}
