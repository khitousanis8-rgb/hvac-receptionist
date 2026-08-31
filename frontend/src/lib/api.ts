/**
 * Base URL of the backend API.
 *
 * - Empty string (default): same-origin, requests go through the Vite dev
 *   proxy or a production reverse proxy.
 * - Set `VITE_API_BASE` at build time (e.g. `https://hvac-api.fly.dev`) when
 *   the dashboard is hosted separately from the API (Vercel + Fly.io demo).
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? "").replace(
  /\/$/,
  ""
);

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}