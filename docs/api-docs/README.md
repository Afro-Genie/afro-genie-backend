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

## Local preview
Open `docs/api-docs/index.html` in a browser after generation.

## Vercel deployment (recommended)
1. Import `afro-genie-backend` repo as a new Vercel project for docs.
2. Set **Root Directory** to `docs/api-docs`.
3. Build Command:

```bash
cd ../.. && npm run docs:api:generate
```

4. Output Directory: `.`
5. Production Branch: `staging`.

## CI note
Always run `npm run docs:api:generate` before deploying docs to keep `openapi.json` in sync with template/version metadata.
