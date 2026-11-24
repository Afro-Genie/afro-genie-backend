import { prisma } from '../lib/prisma';

export interface ArtistTranslationAnalytics {
  rangeDays: number;
  summary: {
    translationViews: number;
    translationReaders: number;
    returningReaders: number;
    translationRequests: number;
    fulfilledRequests: number;
    approvalRate: number;
    correctionOpened: number;
    correctionResolved: number;
    avgResolutionHours: number;
    downvoteRate: number;
    lyricsViews: number;
    translatedSongViews: number;
  };
  reachSeries: Array<{ date: string; translationViews: number; translationReaders: number; returningReaders: number }>;
  topSongs: Array<{ id: string; title: string; translationViews: number; requests: number; completionRate: number; upvoteRatio: number; languages: number }>;
  demandHeatmap: Array<{ songId: string; title: string; targetLang: string; count: number }>;
  qualityTrust: {
    approvalRate: number;
    correctionOpened: number;
    correctionResolved: number;
    avgResolutionHours: number;
    downvoteRate: number;
  };
  audienceUnderstanding: {
    countries: Array<{ country: string; views: number }>;
    languages: Array<{ language: string; views: number }>;
    returningReaders: number;
    translationReaders: number;
    translatedSongViews: number;
    lyricsOnlyViews: number;
  };
}

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);

export async function getArtistTranslationAnalytics(artistId: string, rangeDays: number): Promise<ArtistTranslationAnalytics> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - rangeDays);
  startDate.setHours(0, 0, 0, 0);

  const [dailyRows, viewEvents, songs, translations, correctionRequests, translationRequests] = await Promise.all([
    prisma.artistAnalyticsDaily.findMany({ where: { artistId, date: { gte: startDate } }, orderBy: { date: 'asc' } }),
    prisma.translationViewEvent.findMany({ where: { artistId, viewedAt: { gte: startDate } }, select: { viewedAt: true, userId: true, sessionId: true, targetLang: true, country: true, songId: true } }),
    prisma.song.findMany({ where: { artistId, softDeleted: false }, select: { id: true, title: true, views: true, _count: { select: { translations: { where: { status: { in: ['APPROVED','PUBLISHED'] } } } } } } }),
    prisma.translation.findMany({ where: { song: { artistId }, status: { in: ['APPROVED', 'PUBLISHED', 'PENDING', 'REJECTED'] } }, select: { id: true, songId: true, status: true, upvotes: true, downvotes: true, targetLang: true } }),
    prisma.correctionRequest.findMany({ where: { song: { artistId }, createdAt: { gte: startDate } }, select: { status: true, createdAt: true, resolvedAt: true } }),
    prisma.translationRequest.findMany({ where: { song: { artistId }, createdAt: { gte: startDate } }, select: { songId: true, targetLang: true, status: true } }),
  ]);

  const viewsByDay = new Map<string, { translationViews: number; readers: Set<string>; returningReaders: Set<string> }>();
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(startDate); d.setDate(startDate.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    viewsByDay.set(key, { translationViews: 0, readers: new Set(), returningReaders: new Set() });
  }
  const readerSeen = new Set<string>();
  const countries = new Map<string, number>();
  const languages = new Map<string, number>();
  const songViewCounts = new Map<string, number>();

  for (const ev of viewEvents) {
    const key = ev.viewedAt.toISOString().slice(0, 10);
    const bucket = viewsByDay.get(key);
    const readerKey = ev.userId ? `u:${ev.userId}` : ev.sessionId ? `s:${ev.sessionId}` : null;
    if (bucket) {
      bucket.translationViews += 1;
      if (readerKey) {
        bucket.readers.add(readerKey);
        if (readerSeen.has(readerKey)) bucket.returningReaders.add(readerKey);
      }
    }
    if (readerKey) readerSeen.add(readerKey);
    if (ev.country) countries.set(ev.country.toUpperCase(), (countries.get(ev.country.toUpperCase()) ?? 0) + 1);
    const lang = ev.targetLang.toLowerCase();
    languages.set(lang, (languages.get(lang) ?? 0) + 1);
    songViewCounts.set(ev.songId, (songViewCounts.get(ev.songId) ?? 0) + 1);
  }

  const reachSeries = Array.from(viewsByDay.entries()).map(([date, v]) => ({ date, translationViews: v.translationViews, translationReaders: v.readers.size, returningReaders: v.returningReaders.size }));
  const translationViews = viewEvents.length;
  const translationReaders = readerSeen.size;
  const returningReaders = reachSeries.reduce((s, r) => s + r.returningReaders, 0);
  const approved = translations.filter((t) => t.status === 'APPROVED' || t.status === 'PUBLISHED');
  const approvalRate = pct(approved.length, translations.length || 0);
  const upvotes = approved.reduce((s, t) => s + t.upvotes, 0);
  const downvotes = approved.reduce((s, t) => s + t.downvotes, 0);
  const downvoteRate = pct(downvotes, upvotes + downvotes);
  const correctionOpened = correctionRequests.length;
  const correctionResolved = correctionRequests.filter((c) => c.status === 'APPROVED' && c.resolvedAt).length;
  const resolved = correctionRequests.filter((c) => c.status === 'APPROVED' && c.resolvedAt);
  const avgResolutionHours = resolved.length ? Math.round(resolved.reduce((s, c) => s + (c.resolvedAt!.getTime() - c.createdAt.getTime()), 0) / resolved.length / 36e5) : 0;
  const fulfilledRequests = translationRequests.filter((r) => r.status === 'FULFILLED' as any).length;
  const lyricsViews = dailyRows.reduce((s, r) => s + (r.lyricsViews ?? 0), 0);

  const requestsBySong = new Map<string, number>();
  const requestsBySongLang = new Map<string, { songId: string; title: string; targetLang: string; count: number }>();
  for (const r of translationRequests) {
    requestsBySong.set(r.songId, (requestsBySong.get(r.songId) ?? 0) + 1);
    const songTitle = songs.find((s) => s.id === r.songId)?.title ?? 'Unknown song';
    const k = `${r.songId}:${r.targetLang.toLowerCase()}`;
    const cur = requestsBySongLang.get(k) ?? { songId: r.songId, title: songTitle, targetLang: r.targetLang.toLowerCase(), count: 0 };
    cur.count += 1; requestsBySongLang.set(k, cur);
  }

  const topSongs = songs.map((s) => {
    const songTranslations = approved.filter((t) => t.songId === s.id);
    const sUp = songTranslations.reduce((sum, t) => sum + t.upvotes, 0);
    const sDown = songTranslations.reduce((sum, t) => sum + t.downvotes, 0);
    const req = requestsBySong.get(s.id) ?? 0;
    const completedForSong = translationRequests.filter((r) => r.songId === s.id && (r.status === 'FULFILLED' as any)).length;
    return {
      id: s.id,
      title: s.title,
      translationViews: songViewCounts.get(s.id) ?? 0,
      requests: req,
      completionRate: pct(completedForSong, req),
      upvoteRatio: pct(sUp, sUp + sDown),
      languages: new Set(songTranslations.map((t) => t.targetLang.toLowerCase())).size,
    };
  }).sort((a, b) => b.translationViews - a.translationViews || b.requests - a.requests).slice(0, 10);

  const translatedSongViews = songs.filter((s) => s._count.translations > 0).reduce((sum, s) => sum + s.views, 0);
  const lyricsOnlyViews = Math.max(0, songs.reduce((sum, s) => sum + s.views, 0) - translatedSongViews);

  return {
    rangeDays,
    summary: { translationViews, translationReaders, returningReaders, translationRequests: translationRequests.length, fulfilledRequests, approvalRate, correctionOpened, correctionResolved, avgResolutionHours, downvoteRate, lyricsViews, translatedSongViews },
    reachSeries,
    topSongs,
    demandHeatmap: Array.from(requestsBySongLang.values()).sort((a, b) => b.count - a.count).slice(0, 20),
    qualityTrust: { approvalRate, correctionOpened, correctionResolved, avgResolutionHours, downvoteRate },
    audienceUnderstanding: {
      countries: Array.from(countries.entries()).map(([country, views]) => ({ country, views })).sort((a, b) => b.views - a.views).slice(0, 10),
      languages: Array.from(languages.entries()).map(([language, views]) => ({ language, views })).sort((a, b) => b.views - a.views).slice(0, 10),
      returningReaders,
      translationReaders,
      translatedSongViews,
      lyricsOnlyViews,
    },
  };
}
