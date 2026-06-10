import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';

const baseUrl = 'http://127.0.0.1:4001/api/auth';

const main = async () => {
  const server = app.listen(4001);
  const seed = Date.now();
  const email = `ratelimit_${seed}@example.com`;
  const password = 'CorrectPwd!123';

  try {
    await prisma.user.deleteMany({ where: { email } });

    const registerRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'Rate Limit User' })
    });

    if (registerRes.status !== 201) {
      throw new Error(`Failed to register rate-limit user: ${registerRes.status}`);
    }

    const statuses: number[] = [];

    for (let i = 1; i <= 6; i += 1) {
      const response = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'DefinitelyWrong!123' })
      });
      statuses.push(response.status);
    }

    const expected = statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429;

    console.log('Rate-limit attempt statuses:', statuses.join(', '));
    console.log(
      expected
        ? 'PASS: Auth endpoints rate limited at 5 attempts / 15 min (6th wrong login returned 429).'
        : 'FAIL: Unexpected rate-limit behavior.'
    );

    process.exitCode = expected ? 0 : 1;
  } finally {
    await prisma.user.deleteMany({ where: { email } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
    await redis.quit();
  }
};

void main();
