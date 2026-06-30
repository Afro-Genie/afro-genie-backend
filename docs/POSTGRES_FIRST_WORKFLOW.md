# PostgreSQL-First Workflow

Afro Genie now treats PostgreSQL as the source of truth for day-to-day development.

## Normal development loop

1. Seed the database:

```bash
npm run prisma:seed
```

2. Build the search index:

```bash
npm run search:index
```

3. Run validation:

```bash
npm run type-check
npm run test:schema
npm run test:translations
```

## Legacy migration

The Firebase import script is archival-only.

Use it only if you still have a historical export to replay:

```bash
npx tsx scripts/migrateFromFirebase.ts --file ./path/to/firebase-export.json
```

Do not depend on a Firebase export for regular development, deployment, or indexing. PostgreSQL seed data is the canonical baseline.