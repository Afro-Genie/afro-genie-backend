export type UserRole = 'USER' | 'ADMIN' | 'ARTIST' | 'MODERATOR';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface ApiErrorResponse {
  error: string;
  code: string;
}

export interface HealthResponse {
  status: 'ok';
  uptime: number;
  version: string;
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}
