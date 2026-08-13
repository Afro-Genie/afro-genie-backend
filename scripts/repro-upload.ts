import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import { prisma } from '../src/lib/prisma';

config();

const API = 'http://localhost:3001/api';
const JWT_SECRET = process.env.JWT_SECRET!;

async function req(method: string, path: string, body: any, token?: string, isForm = false) {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// Tiny valid 1x1 PNG
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngBuffer = Buffer.from(PNG_BASE64, 'base64');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const suffix = Date.now().toString(36);
  const email = `repro-${suffix}@afro-genie.test`;
  const password = 'TestPassword123!';

  // 1. Register
  const reg = await req('POST', '/auth/register', { email, password, displayName: `Repro ${suffix}` });
  console.log('REGISTER:', reg.status, reg.data?.user ? 'ok' : JSON.stringify(reg.data));
  const userId = reg.data?.user?.id;
  const token = reg.data?.accessToken;
  if (!userId) throw new Error('No user id');

  // 2. Create artist row directly
  const artist = await prisma.artist.create({
    data: { userId, name: `Repro Artist ${suffix}`, genres: ['Afrobeats'] },
  });
  console.log('ARTIST:', artist.id);

  // 3. ARTIST token
  const artistToken = jwt.sign({ userId, sub: userId, email, role: 'ARTIST' }, JWT_SECRET, { expiresIn: '1h' });

  // 4. Upload image
  const formImg = new FormData();
  formImg.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'cover.png');
  const img = await req('POST', '/upload', formImg, artistToken, true);
  console.log('IMAGE UPLOAD:', img.status, JSON.stringify(img.data));

  // 5. Verify the returned image URL actually serves
  if (img.status < 300 && img.data?.url) {
    const imgRes = await fetch(`http://localhost:3001${img.data.url}`);
    console.log('IMAGE SERVE:', imgRes.status, 'bytes:', (await imgRes.arrayBuffer()).byteLength);
  }

  // 6. Upload audio
  const audioBytes = Buffer.alloc(2048, 1);
  const formAudio = new FormData();
  formAudio.append('file', new Blob([audioBytes], { type: 'audio/mpeg' }), 'track.mp3');
  const aud = await req('POST', '/upload/audio', formAudio, artistToken, true);
  console.log('AUDIO UPLOAD:', aud.status, JSON.stringify(aud.data));

  // 7. Create song exactly as AddSongModal does
  const song = await req('POST', '/artists/me/songs', {
    title: `Repro Song ${suffix}`,
    lyrics: { rawText: 'Test lyrics line one\nTest lyrics line two' },
    genres: ['Afrobeats'],
    languages: ['en'],
    audioUrl: aud.data?.url,
    audioDurationMs: 123000,
    imageUrl: img.data?.url,
  }, artistToken);
  console.log('SONG CREATE:', song.status, JSON.stringify(song.data));

  // 8. Create a release with that song
  const release = await req('POST', '/artists/me/releases', {
    title: `Repro Single ${suffix}`,
    type: 'SINGLE',
    releaseDate: new Date(Date.now() - 86400000).toISOString(),
    songIds: song.data?.songId ? [song.data.songId] : [],
  }, artistToken);
  console.log('RELEASE CREATE:', release.status, JSON.stringify(release.data));

  // 9. Public catalog visibility of the released song
  const cat = await req('GET', `/catalog/songs?search=${encodeURIComponent(`Repro Song ${suffix}`)}`);
  console.log('CATALOG:', cat.status, 'visible:', JSON.stringify(cat.data?.songs ?? cat.data));

  await prisma.$disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
