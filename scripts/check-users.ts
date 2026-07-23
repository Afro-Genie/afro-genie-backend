import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

(async () => {
  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true }, take: 5 });
  console.log('Users in DB:', JSON.stringify(users, null, 2));
  const count = await prisma.user.count();
  console.log('Total users:', count);

  // Also check existing translations
  const translations = await prisma.translation.findMany({ take: 5, orderBy: { createdAt: 'desc' } });
  console.log('\nExisting translations:', translations.length);
  for (const t of translations) {
    console.log(`  - songId=${t.songId} status=${t.status} lang=${t.targetLang} userId=${t.userId}`);
  }
  
  await prisma.$disconnect();
})();
