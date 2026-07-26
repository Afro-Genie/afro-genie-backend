/**
 * Integration test helpers for the artist management system.
 *
 * Provides shared utilities for:
 * - Making authenticated API requests
 * - Registering/logging in real test users via the API
 * - JWT token generation using the real server secret
 */

import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from backend root
config({ path: resolve(__dirname, '..', '..', '.env') });

const API_BASE = process.env.TEST_API_URL || 'http://localhost:3001/api';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET not found — ensure .env is present in the backend root');
}

// ─── API Request Helpers ──────────────────────────────────────────────────────

export interface ApiResponse<T = any> {
  status: number;
  data: T;
}

export const apiGet = async (path: string, token?: string): Promise<ApiResponse> => {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { method: 'GET', headers });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

export const apiPost = async (path: string, body: any, token?: string): Promise<ApiResponse> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

export const apiPatch = async (path: string, body: any, token?: string): Promise<ApiResponse> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

export const apiPut = async (path: string, body: any, token?: string): Promise<ApiResponse> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

export const apiDelete = async (path: string, token?: string): Promise<ApiResponse> => {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

// ─── Token Generation ─────────────────────────────────────────────────────────

export const generateTestToken = (userId: string, email: string, role: string): string => {
  return jwt.sign(
    { userId, sub: userId, email, role },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
};

// ─── Test User Factory ────────────────────────────────────────────────────────
// Creates user objects with valid JWT tokens (no DB writes needed).
// The auth middleware only verifies the JWT signature, not DB existence.

let testCounter = 0;
const nextId = () => `${Date.now()}-${++testCounter}`;

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  role: string;
}

export const createTestUser = (overrides?: Partial<{ role: string; id: string; email: string }>): TestUser => {
  const id = overrides?.id || nextId();
  const email = overrides?.email || `test-${id}@afro-genie.test`;
  const role = overrides?.role || 'USER';
  const password = 'TestPassword123!';
  const token = generateTestToken(id, email, role);

  return { id, email, password, token, role };
};

/**
 * Register a new USER via POST /api/auth/register and return real tokens.
 */
export const registerTestUser = async (role?: string): Promise<TestUser> => {
  const suffix = nextId();
  const email = `testuser-${suffix}@afro-genie.test`;
  const password = 'TestPassword123!';
  const displayName = `Test User ${suffix}`;

  const res = await apiPost('/auth/register', { email, password, displayName });

  if (res.status !== 201) {
    throw new Error(`Failed to register test user: ${res.status} ${JSON.stringify(res.data)}`);
  }

  return {
    id: res.data.user.id,
    email,
    password,
    token: res.data.accessToken,
    role: res.data.user.role,
  };
};

/**
 * Login an existing user via POST /api/auth/login and return real tokens.
 */
export const loginTestUser = async (email: string, password: string): Promise<TestUser> => {
  const res = await apiPost('/auth/login', { email, password });

  if (res.status !== 200) {
    throw new Error(`Failed to login test user: ${res.status} ${JSON.stringify(res.data)}`);
  }

  return {
    id: res.data.user.id,
    email,
    password,
    token: res.data.accessToken,
    role: res.data.user.role,
  };
};

// ─── Assertion Helpers ────────────────────────────────────────────────────────

export const assertStatus = (response: ApiResponse, expectedStatus: number, label?: string) => {
  if (response.status !== expectedStatus) {
    const msg = `${label ? label + ': ' : ''}Expected status ${expectedStatus}, got ${response.status}. Response: ${JSON.stringify(response.data)}`;
    throw new Error(msg);
  }
};

export const assertHasProperty = (obj: any, prop: string, label?: string) => {
  if (!(prop in obj)) {
    throw new Error(`${label ? label + ': ' : ''}Expected object to have property "${prop}"`);
  }
};

export const assertContains = (str: string, substring: string, label?: string) => {
  if (!str.includes(substring)) {
    throw new Error(`${label ? label + ': ' : ''}Expected "${str}" to contain "${substring}"`);
  }
};
