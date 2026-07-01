# Afro Genie API Docs (Staging)

This folder is deployable as a static Vercel project.

## Files
- `openapi.template.json`: editable contract source
- `openapi.json`: generated artifact (used by docs UI)
- `index.html`: ReDoc page
- `vercel.json`: static serving headers/config

## Local generation
From `afro-genie-backend`:

```bash
npm run docs:api:generate
```

Optionally override the staging server URL in the generated spec:

```bash
OPENAPI_STAGING_SERVER_URL="https://afro-genie-backend-staging-production.up.railway.app/api" npm run docs:api:generate
```

## Local preview
Open `docs/api-docs/index.html` in a browser after generation.

## Vercel deployment (recommended)
1. Import `afro-genie-backend` repo as a new Vercel project for docs.
2. Set **Root Directory** to `docs/api-docs`.
3. Build Command:

```bash
cd ../.. && OPENAPI_STAGING_SERVER_URL="https://afro-genie-backend-staging-production.up.railway.app/api" npm run docs:api:generate
```

4. Output Directory: `.`
5. Production Branch: `staging`.

## CI note
Always run `npm run docs:api:generate` before deploying docs to keep `openapi.json` in sync with template/version metadata.

## Safe update checklist
1. Update route contracts in `openapi.template.json` whenever backend routes change.
2. Set `OPENAPI_STAGING_SERVER_URL` to the live backend base path (`.../api`) in the docs build step.
3. Regenerate spec with `npm run docs:api:generate`.
4. Verify key endpoints before deploy:
	- `GET /api/health` should be `200`.
	- Protected routes (for example `/api/admin/ping`) should be `401` without token, not `404`.
	- Public routes should never return `404` unless path params truly do not exist.
5. Deploy docs only after backend deployment and database migrations complete.
