import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = 'nia.soul@afrogenie.com';
  const password = 'NiaSoul123!';
  const hash = await bcrypt.hash(password, 10);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`User ${email} not found. Run seed-artist-portal.ts first.`);
    process.exitCode = 1;
    return;
  }

  await prisma.user.update({
    where: { email },
    data: { passwordHash: hash },
  });

  console.log(`\n  Email:    ${email}`);
  console.log(`  Password: ${password}\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect().then(() => pool.end()));
