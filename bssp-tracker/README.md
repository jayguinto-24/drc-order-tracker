BSSP order tracker — three-way blind count reconciliation between DRC and Border, built on Next.js (App Router) with a Postgres backend via Prisma, and email notifications via Resend.

## First-time setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in real values (see below).
3. Push the schema to your database:
   ```bash
   npx prisma db push
   ```
4. (Optional) load demo data:
   ```bash
   npm run db:seed
   ```
5. Run the dev server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. On Vercel/serverless, use your provider's **pooled** connection string (Neon: "pooled connection"; Supabase: the port-6543 "Transaction" pooler) — otherwise serverless functions exhaust the database's connection limit. |
| `RESEND_API_KEY` | API key from [resend.com](https://resend.com). Without it, the app runs fine but skips sending emails (logs a warning instead). |
| `EMAIL_FROM` | Sender address — must be on a domain verified in Resend. |
| `NOTIFY_DISPATCH_EMAILS` | Comma-separated recipients notified when a new despatch is created. |
| `NOTIFY_DISCREPANCY_EMAILS` | Comma-separated recipients notified when a dispatch/receipt count doesn't reconcile. |

## What's in here

- **DRC tab** — order creation (manual entry or CSV/TSV import) and the master ledger, combined into one PIN-gated tab.
- **Jason tab** — the same master ledger, plus an editable "Jason count" column (Jason's own tally, independent of the PO qty).
- **Packing crew / Goods in** — blind count entry for Border's dispatch and DRC's goods-in, unchanged from the original prototype.
- Discrepancy and new-despatch emails fire from the server actions in `lib/actions.ts` — see `lib/email.ts` for the templates.

No live sync between browser sessions: each device fetches the ledger on page load and after its own actions, but won't see another device's update until it refreshes. Fine for the current one-device-per-role usage; would need polling or websockets if that changes.

## Useful scripts

```bash
npm run db:push     # apply prisma/schema.prisma to the database
npm run db:migrate   # create a migration (use instead of db:push once this is past prototyping)
npm run db:seed      # load two demo orders
npm run db:studio    # browse the database in Prisma Studio
```

## Deploying

Standard Next.js deploy (Vercel or otherwise) — see the [Next.js deployment docs](https://nextjs.org/docs/app/getting-started/deploying). Set the environment variables above in your host's dashboard. `postinstall` runs `prisma generate` automatically.
