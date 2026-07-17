import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient, UserRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = 'admin@afrogenie.com';
  const password = 'Admin123!';
  const hash = await bcrypt.hash(password, 10);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.user.update({
      where: { email },
      data: { passwordHash: hash, role: UserRole.ADMIN },
    });
    console.log(`Updated existing user ${email} with ADMIN role and new password.`);
  } else {
    await prisma.user.create({
      data: {
        email,
        passwordHash: hash,
        displayName: 'Afro Genie Admin',
        role: UserRole.ADMIN,
      },
    });
    console.log(`Created admin user ${email}`);
  }

  console.log(`\n  Email:    ${email}`);
  console.log(`  Password: ${password}\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect().then(() => pool.end()));
