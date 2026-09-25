import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const rawUrl = process.env.DATABASE_URL || '';
const parsedUrl = new URL(rawUrl);
parsedUrl.searchParams.delete('channel_binding');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts'
  },
  datasource: {
    url: parsedUrl.toString(),
    shadowDatabaseUrl: 'postgresql://neondb_owner:npg_Li12PMrIHnZC@ep-old-rice-ataoe41y-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
  }
});
