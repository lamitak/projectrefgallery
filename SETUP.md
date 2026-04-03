# Lamitak Project Reference Gallery — Cloud Setup Guide

## Overview

This deploys your gallery as a fully cloud-backed app where all 50+ colleagues see the same data.

**Stack (all Cloudflare, $5/month):**
- Cloudflare Pages → hosts the frontend
- Cloudflare D1 → database for SKUs, projects, categories
- Cloudflare R2 → image storage  
- Cloudflare Zero Trust → access control (already set up)

---

## Prerequisites

- Node.js installed on your computer (download from nodejs.org)
- Wrangler CLI: run `npm install -g wrangler`
- Your Cloudflare account (already have this)

---

## Step 1: Upgrade to Workers Paid Plan ($5/month)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages → Plans**
3. Select **Workers Paid** ($5/month)
4. This unlocks D1 and R2 with generous limits

---

## Step 2: Create the D1 Database

Open a terminal in the project folder and run:

```bash
# Login to Cloudflare (opens browser)
wrangler login

# Create the database
wrangler d1 create gallery-db
```

This outputs something like:
```
✅ Successfully created DB 'gallery-db'
database_id = "abc123-def456-ghi789"
```

**Copy that `database_id`** and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "gallery-db"
database_id = "abc123-def456-ghi789"   ← paste your ID here
```

Now apply the database schema:

```bash
wrangler d1 execute gallery-db --remote --file=schema.sql
```

You should see "Successfully executed" with the table creation statements.

---

## Step 3: Create the R2 Bucket

```bash
wrangler r2 bucket create gallery-images
```

The bucket name must match what's in `wrangler.toml` (already set to `gallery-images`).

---

## Step 4: Push to GitHub

Your repo should contain these files:

```
your-repo/
├── index.html              ← The app frontend
├── wrangler.toml            ← D1 + R2 config
├── schema.sql               ← Database schema (for reference)
├── functions/
│   └── api/
│       └── [[path]].js      ← API handler (Pages Function)
```

```bash
git add .
git commit -m "Cloud-backed gallery with D1 + R2"
git push
```

---

## Step 5: Configure Cloudflare Pages

1. Go to **Workers & Pages** in the Cloudflare dashboard
2. Select your Pages project (or create a new one connected to your GitHub repo)
3. Go to **Settings → Functions → D1 database bindings**
4. Add binding:
   - Variable name: `DB`
   - D1 database: select `gallery-db`
5. Go to **Settings → Functions → R2 bucket bindings**
6. Add binding:
   - Variable name: `IMAGES`
   - R2 bucket: select `gallery-images`
7. **Trigger a new deployment** (push a small change to GitHub, or click "Retry deployment")

---

## Step 6: Verify

1. Visit your site URL
2. The app should load and show an empty gallery (no sample data)
3. Click **Admin** → login with `admin` / `admin123`
4. Go to **Categories** tab → add your categories
5. Go to **SKU List** tab → add SKUs (or use Import tab for Excel upload)
6. Go to **Projects** tab → create projects, tag them with SKUs, upload images
7. Switch to **Directory** → you should see SKUs with project images
8. Open the same URL on a different device → same data appears

---

## Step 7: Add Zero Trust Protection (Already Done)

Your existing Zero Trust Access policy continues to work. It sits in front of the entire site, so the D1 API endpoints are also protected.

---

## Troubleshooting

### "Failed to load data" error on the page
- Check that D1 and R2 bindings are configured in Pages → Settings → Functions
- Ensure the database_id in wrangler.toml matches your actual D1 database
- Retrigger deployment after adding bindings

### Images don't load
- Verify R2 bucket binding variable name is exactly `IMAGES`
- Check that the `gallery-images` bucket exists in R2

### API returns 500 errors
- Open your site → press F12 → Network tab → look at the failing request
- The error response body will show the exact D1 error
- Common fix: re-run `wrangler d1 execute gallery-db --remote --file=schema.sql`

### Changes made by one user don't appear for another
- The app fetches fresh data from D1 on every page load
- If data seems stale, do a hard refresh (Ctrl+Shift+R)

---

## Monthly Cost Breakdown

| Service | Included | Your Usage | Cost |
|---------|----------|-----------|------|
| Workers Paid plan | — | — | $5.00 |
| D1 reads | 25B rows/month | ~500K rows | $0.00 |
| D1 writes | 50M rows/month | ~10K rows | $0.00 |
| D1 storage | 5 GB | ~50 MB | $0.00 |
| R2 storage | 10 GB free | varies | $0.015/GB over 10GB |
| R2 egress | ∞ (free) | unlimited | $0.00 |
| Zero Trust | 50 users free | your team | $0.00 |
| **Total** | | | **~$5/month** |

---

## Default Admin Credentials

- Username: `admin`
- Password: `admin123`
- **Change these immediately** in Admin → Settings → Account Security
