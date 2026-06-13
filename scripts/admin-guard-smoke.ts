import jwt from 'jsonwebtoken';
import { app } from '../src/app';
import { env } from '../src/lib/env';

const run = async () => {
  const userToken = jwt.sign(
    { userId: 'u1', email: 'u1@example.com', role: 'USER' },
    env.JWT_SECRET,
    { expiresIn: '5m' },
  );

  const server = app.listen(4021);

  try {
    const ping = await fetch('http://127.0.0.1:4021/api/admin/ping', {
      headers: { Authorization: `Bearer ${userToken}` },
    });

    const postUser = await fetch('http://127.0.0.1:4021/api/songs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'x', artistId: 'x' }),
    });

    const postAnon = await fetch('http://127.0.0.1:4021/api/songs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', artistId: 'x' }),
    });

    console.log('admin_ping_user', ping.status);
    console.log('songs_post_user', postUser.status);
    console.log('songs_post_anon', postAnon.status);
  } finally {
    server.close();
  }
};

void run();
