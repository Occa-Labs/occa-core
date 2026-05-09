// HTTP client + ApiError used by every feature's API hooks.
// Feature-specific methods (queries, mutations) live in
// `features/<name>/api/` — they call `request()` from here.

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";
const TOKEN_KEY = "occa_jwt";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body);
  }
  // 204 No Content + any genuinely empty body → return undefined cast.
  // Calling res.json() on those would throw "Unexpected end of JSON
  // input" and break callers like DELETE that don't expect a payload.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

// Typed error for downstream catch blocks. Once the server adopts the
// `{ error: { code, message, details } }` envelope, narrow the body type
// here and expose `code`/`message`/`details` as fields.
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}`);
    this.name = "ApiError";
  }
}

export { API_BASE };
