import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { env } from '../lib/env';

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';

const SEARCH_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MATCH_DELAY_MS = 100; // YouTube free tier: 10,000 units/day

export interface YouTubeMatch {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string | null;
  durationSeconds: number;
}

export type PlaybackSourceKind = 'AUDIO_URL' | 'YOUTUBE' | 'SPOTIFY_PREVIEW' | 'NONE';

export interface PlaybackSource {
  source: PlaybackSourceKind;
  audioUrl?: string;
  youtubeVideoId?: string;
  previewUrl?: string;
  song?: {
    id: string;
    title: string;
    artist: string;
    coverImageUrl: string | null;
    durationMs: number | null;
  };
}

class YouTubeService {
  private isConfigured(): boolean {
    return Boolean(env.YOUTUBE_API_KEY);
  }

  /** Search YouTube for the best match for a song title + artist. */
  async searchMatch(songTitle: string, artistName: string): Promise<YouTubeMatch | null> {
    if (!this.isConfigured()) {
      logger.debug('YouTube search skipped — YOUTUBE_API_KEY is not configured');
      return null;
    }

    const cacheKey = `youtube:match:${songTitle.toLowerCase()}:${artistName.toLowerCase()}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as YouTubeMatch;
    } catch (err) {
      logger.warn({ err }, 'YouTube cache read failed');
    }

    const query = `${songTitle} ${artistName} official audio`;
    let best: { id?: { videoId?: string }; snippet?: Record<string, any> } | undefined;

    try {
      const res = await fetch(
        `${YOUTUBE_API}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=3&key=${env.YOUTUBE_API_KEY}`,
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, 'YouTube search failed');
        return null;
      }
      const data = (await res.json()) as { items?: Array<{ id?: { videoId?: string }; snippet?: Record<string, any> }> };
      best = data.items?.[0];
    } catch (err) {
      logger.warn({ err }, 'YouTube search request errored');
      return null;
    }

    const videoId = best?.id?.videoId;
    if (!videoId || !best?.snippet) return null;

    const thumbnails = (best.snippet.thumbnails ?? {}) as Record<string, { url?: string }>;
    const match: YouTubeMatch = {
      videoId,
      title: best.snippet.title ?? songTitle,
      channelTitle: best.snippet.channelTitle ?? artistName,
      thumbnailUrl: thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null,
      durationSeconds: 0,
    };

    try {
      const detailsRes = await fetch(
        `${YOUTUBE_API}/videos?part=contentDetails&id=${videoId}&key=${env.YOUTUBE_API_KEY}`,
      );
      if (detailsRes.ok) {
        const details = (await detailsRes.json()) as {
          items?: Array<{ contentDetails?: { duration?: string } }>;
        };
        match.durationSeconds = this.parseISO8601Duration(details.items?.[0]?.contentDetails?.duration);
      }
    } catch (err) {
      logger.warn({ err, videoId }, 'YouTube duration lookup failed');
    }

    try {
      await redis.set(cacheKey, JSON.stringify(match), 'EX', SEARCH_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'YouTube cache write failed');
    }

    return match;
  }

  /** Batch match up to `limit` unmatched songs, highest-viewed first. */
  async batchMatchSongs(limit = 50): Promise<{ matched: number; failed: number }> {
    const songs = await prisma.song.findMany({
      where: { softDeleted: false, youtubeVideoId: null },
      include: { artist: { select: { name: true } } },
      orderBy: { views: 'desc' },
      take: limit,
    });

    let matched = 0;
    let failed = 0;

    for (const song of songs) {
      try {
        const match = await this.searchMatch(song.title, song.artist.name);
        if (match) {
          await prisma.song.update({
            where: { id: song.id },
            data: { youtubeVideoId: match.videoId, youtubeMatchedAt: new Date() },
          });
          matched++;
        } else {
          failed++;
        }
      } catch (err) {
        logger.warn({ songId: song.id, err }, 'YouTube match failed for song');
        failed++;
      }
      await new Promise((r) => setTimeout(r, MATCH_DELAY_MS));
    }

    return { matched, failed };
  }

  /** Match a single song by id. */
  async matchSong(songId: string): Promise<YouTubeMatch | null> {
    const song = await prisma.song.findUnique({
      where: { id: songId },
      include: { artist: { select: { name: true } } },
    });
    if (!song) return null;

    const match = await this.searchMatch(song.title, song.artist.name);
    if (!match) return null;

    await prisma.song.update({
      where: { id: song.id },
      data: { youtubeVideoId: match.videoId, youtubeMatchedAt: new Date() },
    });
    return match;
  }

  /**
   * Resolve the best available playback source for a song using the 3-tier
   * fallback: own uploaded audio → YouTube → Spotify preview → none.
   */
  async getPlaybackSource(songId: string): Promise<PlaybackSource> {
    const song = await prisma.song.findUnique({
      where: { id: songId },
      include: { artist: { select: { name: true } } },
    });
    if (!song) return { source: 'NONE' };

    const songInfo = {
      id: song.id,
      title: song.title,
      artist: song.artist?.name ?? 'Unknown Artist',
      coverImageUrl: song.imageUrl ?? null,
      durationMs: song.durationMs ?? null,
    };

    // Tier 1: own uploaded audio
    if (song.audioUrl) {
      return { source: 'AUDIO_URL', audioUrl: song.audioUrl, song: songInfo };
    }

    // Tier 2: matched YouTube video. Carry the Spotify preview URL so the
    // frontend can fall back to Tier 3 if the embed is blocked or errors.
    if (song.youtubeVideoId) {
      return {
        source: 'YOUTUBE',
        youtubeVideoId: song.youtubeVideoId,
        previewUrl: song.spotifyPreviewUrl ?? undefined,
        song: songInfo,
      };
    }

    // Tier 3: Spotify 30s preview
    if (song.spotifyPreviewUrl) {
      return { source: 'SPOTIFY_PREVIEW', previewUrl: song.spotifyPreviewUrl, song: songInfo };
    }

    return { source: 'NONE', song: songInfo };
  }

  private parseISO8601Duration(iso?: string | null): number {
    const match = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    return (
      parseInt(match[1] || '0', 10) * 3600 +
      parseInt(match[2] || '0', 10) * 60 +
      parseInt(match[3] || '0', 10)
    );
  }
}

export const youtubeService = new YouTubeService();
