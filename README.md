# Agent Factory

Single-admin Software Factory Orchestrator built with Next.js 16 (App Router), Drizzle ORM, Neon Serverless Postgres, and Tailwind CSS v4.

## Local Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local` and fill in all 8 server-side variables:
   ```bash
   cp .env.example .env.local
   ```

3. Push the Drizzle schema to Neon Postgres and seed the initial project (`ankul01/task-manager`):
   ```bash
   npm run db:push && npm run db:seed
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

## Verification Commands

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

## GitHub Webhook Configuration

Configure a repository webhook on each target GitHub repository:
- **Payload URL:** `https://<your-domain>/api/webhooks/github`
- **Content type:** `application/json`
- **Secret:** `<GITHUB_WEBHOOK_SECRET>`
- **Events:** `pull_request`, `workflow_run`, `issue_comment`, `release`

## Vercel Hobby Deployment

1. Import `ankul01/agent-factory` into Vercel.
2. Add all 8 environment variables from `.env.example` in Vercel Project Settings (do **not** prefix any with `NEXT_PUBLIC_`).
3. Deploy with the default Next.js build command (`npm run build`).
4. Run `npm run db:push && npm run db:seed` against your production Neon database.
