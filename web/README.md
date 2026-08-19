# Quoin Property Intelligence

Authenticated conversational access to Quoin's existing property MCP. The app uses Gemini on Vertex AI Express Mode through the Vercel AI SDK, discovers the existing read-only MCP tools at runtime, keeps workspaces in browser IndexedDB, and exports conversations as PDF, Excel, Word, or Markdown. It does not add or modify a database.

## Local setup

For this workstation, the app can use the active WorkOS CLI environment and a `GOOGLE_VERTEX_API_KEY` from the shell without copying either secret into the repository:

```powershell
npm install
npm run dev:local
```

The local runner defaults to port 3001 because the Quoin website currently uses port 3000. Both callback URLs are registered in the active WorkOS sandbox.

For a conventional environment-based setup, copy `.env.example` to `.env.local` and set:

- `GOOGLE_VERTEX_API_KEY` and `GEMINI_MODEL`
- the existing `MCP_SERVER_URL`
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and a 32-character `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback`

The WorkOS application must allow that callback. The MCP Worker must also have `WORKOS_CHAT_CLIENT_ID` set to this web application's exact WorkOS client ID; no other audience is accepted.

Then run `npm run dev`.

## Verify

```powershell
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
```

## Vercel

Create a Vercel project with `web` as its root directory, add the production environment variables above, and change `NEXT_PUBLIC_WORKOS_REDIRECT_URI` to the deployed `/auth/callback` URL. Add that callback to the WorkOS application before promoting the deployment.
