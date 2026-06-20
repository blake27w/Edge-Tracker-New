# Decisions & Deferred Work

A running log of architecture decisions and work we've intentionally
parked. Newest first.

---

## 2026-06-20 — Standardize hosting across projects (Railway + Vercel)

**Decision:** Edge Tracker and Alpha Radar should use the same stack.
Converge on the tools we prefer:

- **Backends → Railway** (we like it; it works). *Not* Fly.io.
- **Frontends → Vercel.**
- **Data → keep each project's existing DB** (Edge Tracker: Supabase).

**Why Railway (not Fly):** no technical reason to move Edge Tracker to
Fly — Railway is preferred and already in use. Consistency should
converge on the preferred tool, so the direction is to bring Alpha Radar
*to* Railway, not push Edge Tracker to Fly.

### Status by project

| Piece | Edge Tracker | Alpha Radar |
|---|---|---|
| Backend | ✅ already on Railway | ⬜ Fly → Railway (pending) |
| Frontend | ✅ Vercel-ready (PR #58); user to connect repo in Vercel | ✅ already on Vercel |
| Data | Supabase (keep) | Fly volume → Railway volume or Supabase (pending) |

### DEFERRED — saved for later

1. **Alpha Radar engine: Fly.io → Railway.**
   - App code ports easily; the real task is migrating the **570k+
     signals** off the **Fly volume** to a Railway volume (or Railway
     Postgres / Supabase).
   - **Blocker:** this work can't be done from an Edge Tracker session —
     it needs a Claude Code session scoped to the `alpha-radar-engine`
     repo (the repo-add tool isn't available in the Edge Tracker session;
     GitHub access here is scoped to `blake27w/edge-tracker-new`).
   - Also fix the noted CORS wrinkle: the Alpha Radar API's CORS list
     still points at old "vantyx" URLs; the Vercel project serving the
     dashboard is named "alpha-brain". One-line CORS fix.

2. **Edge Tracker frontend follow-ups (after Vercel is live):**
   - Repoint the **PWA / Capacitor app** `server.url` from
     `blake27w.github.io` to the new `*.vercel.app` (or custom) domain.
   - Optional **custom domain** on Vercel.
   - Retire **GitHub Pages** once the Vercel URL is confirmed good.

### Done in this session
- Mobile no-data fix: dashboard now defaults its backend URL to the
  Railway engine (`edge-tracker-new-production.up.railway.app`) so every
  device loads data with zero setup (PR #57).
- Vercel hosting setup: `vercel.json` + `.vercelignore`; backend CORS now
  allows `*.vercel.app` origins (PR #58).
