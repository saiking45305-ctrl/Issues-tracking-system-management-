# IssueFlow

IssueFlow is a private company error tracker adapted from the visual spirit of the liquid-buttons starter. It has Google sign-in, email/password company accounts, company-scoped error records, monthly reports, CSV export, and an assistant that analyzes an error and records a cautious fix plan without pretending that source code changed.

## Login setup

Google sign-in uses the protected `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` project values. In Google Cloud Console, create a Web application OAuth client and add this redirect URI:

`https://issueflow-cterkbqm.manus.space/api/auth/google/callback`

Email/password signup creates a company workspace and keeps records scoped to that company.

## Run locally

Use the managed project environment for the full database-backed app. Start the server with:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`. The one command to start it again is `npm run dev`.

## Build and production

```bash
npm run build
npm start
```

The managed deployment supplies `DATABASE_URL`, the Manus service credentials, and the protected Google OAuth values at runtime.
