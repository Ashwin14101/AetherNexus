// Shared API origin for the dashboard.
// - VITE_API_GATEWAY_URL always wins when set.
// - In production the control-plane server hosts this build (see server.ts
//   static serving), so same-origin ('') is correct.
// - In dev, default to the local backend on :4000.
export const API_BASE =
  import.meta.env.VITE_API_GATEWAY_URL || (import.meta.env.PROD ? '' : 'http://localhost:4000');
