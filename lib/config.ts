/* bosai — connection settings for A.A.S (A2S).
   The browser never talks to A.A.S directly; it only uses the same-origin
   proxy implemented by the Route Handlers under app/api/a2s. The access
   token exists solely as a server-side environment variable on the host
   and is never present in the browser or in this repository.
   The A2S contract itself is defined by the aegis-alert-system repo. */
export const A2S_BASE_URL = "/api/a2s";
