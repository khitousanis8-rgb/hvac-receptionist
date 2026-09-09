/**
 * Base URL of the backend API.
 *
 * - Empty string (default): same-origin, requests go through the Vite dev
 *   proxy or a production reverse proxy.
 * - Set `VITE_API_BASE` at build time (e.g. `https://hvac-api.fly.dev`) when
 *   the dashboard is hosted separately from the API (Vercel + Fly.io demo).
 */
export const API_BASE: string = (
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE) ??
  (typeof import.meta !== "undefined" && import.meta.env?.DEV ? "" : "https://hvac-receptionist.onrender.com")
).replace(
  /\/$/,
  ""
);

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let errorDetail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.detail) {
        errorDetail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      }
    } catch {
      // ignore non-json errors
    }
    throw new Error(errorDetail);
  }
  return res.json() as Promise<T>;
}
