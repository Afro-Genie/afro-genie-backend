import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export type ArtistBadgeId =
  | 'FIRST_TRANSLATION_UNLOCK'
  | 'BRIDGE_BUILDER'
  | 'LANGUAGE_PIONEER'
  | 'CONTEXT_CURATOR'
  | 'COMMUNITY_TRUSTED'
  | 'CORRECTION_CHAMPION'
  | 'GLOBAL_LISTENER_REACH'
  | 'MOST_REQUESTED'
  | 'CATALOG_CLARITY'
  | 'CULTURAL_MILESTONE';

export interface ArtistBadgeState {
  id: ArtistBadgeId;
  title: string;
  description: string;
  howToEarn: string;
  eligible: boolean;
  unlocked: boolean;
  purchased: boolean;
  progressLabel: string;
  metric: number;
  target?: number;
}

const BADGE_DEFS: Array<Omit<ArtistBadgeState, 'eligible' | 'unlocked' | 'purchased' | 'progressLabel' | 'metric' | 'target'> & { target?: number }> = [
  { id: 'FIRST_TRANSLATION_UNLOCK', title: 'First Translation Unlock', description: 'Your music crossed its first language barrier.', howToEarn: 'First song gets an approved translation.' , target: 1},
  { id: 'BRIDGE_BUILDER', title: 'Bridge Builder', description: 'Your catalog is reaching multiple language communities.', howToEarn: 'Songs translated into N target languages (3/10/25).', target: 3 },
  { id: 'LANGUAGE_PIONEER', title: 'Language Pioneer', description: 'You opened a new language path for your catalog.', howToEarn: 'First approved translation in a new language for that artist/catalog niche.' , target: 1},
  { id: 'CONTEXT_CURATOR', title: 'Context Curator', description: 'You preserve meaning, not just words.', howToEarn: 'N translations include high-quality culturalContext.', target: 3 },
  { id: 'COMMUNITY_TRUSTED', title: 'Community Trusted', description: 'Listeners trust your translations.', howToEarn: 'Translation upvote/approval ratio above threshold.', target: 70 },
  { id: 'CORRECTION_CHAMPION', title: 'Correction Champion', description: 'You keep translations accurate and responsive.', howToEarn: 'Artist/team resolves correction requests quickly.', target: 24 },
  { id: 'GLOBAL_LISTENER_REACH', title: 'Global Listener Reach', description: 'Your translations are reaching the world.', howToEarn: 'Unique listeners/viewers from N countries consuming translations.', target: 5 },
  { id: 'MOST_REQUESTED', title: 'Most Requested', description: 'Fans are actively asking for your music in other languages.', howToEarn: 'High TranslationRequest volume fulfilled.', target: 5 },
  { id: 'CATALOG_CLARITY', title: 'Catalog Clarity', description: 'Your catalog is ready for global discovery.', howToEarn: '% of catalog with lyrics + at least 1 translation + language tags.', target: 60 },
  { id: 'CULTURAL_MILESTONE', title: 'Cultural Milestone', description: 'Your translations are creating sustained cultural impact.', howToEarn: 'X translation views / Y languages reached.', target: 100 },
];

const hasQualityContext = (text: string | null | undefined) => {
  const v = (text ?? '').trim();
  if (v.length < 40) return false;
  // basic quality heuristic: enough detail and not just a URL/short note
  return /[.!?]/.test(v) || v.split(/\s+/).length >= 8;
};

export const ARTIST_BADGE_ENTITLEMENT_PREFIX = 'badge:artist:';

export async function getArtistBadgeStates(artistId: string, userId: string): Promise<ArtistBadgeState[]> {
  const [songs, translations, correctionRequests, translationRequests, viewAgg, countryAgg, entitlements] = await Promise.all([
    prisma.song.findMany({
      where: { artistId, softDeleted: false },
      select: { id: true, _count: { select: { translations: { where: { status: { in: ['APPROVED', 'PUBLISHED'] } } }, songLanguages: true, lyrics: true } } },
    }),
    prisma.translation.findMany({
      where: { song: { artistId }, status: { in: ['APPROVED', 'PUBLISHED'] } },
      select: { id: true, targetLang: true, culturalContext: true, upvotes: true, downvotes: true, status: true, songId: true, createdAt: true },
    }),
    prisma.correctionRequest.findMany({ where: { song: { artistId } }, select: { id: true, status: true, createdAt: true, resolvedAt: true } }),
    prisma.translationRequest.findMany({ where: { song: { artistId } }, select: { id: true, status: true, targetLang: true, createdAt: true } }),
    prisma.translationViewEvent.groupBy({ by: ['targetLang'], where: { artistId }, _count: { _all: true } }),
    prisma.translationViewEvent.groupBy({ by: ['country'], where: { artistId, country: { not: null } }, _count: { _all: true } }),
    prisma.userEntitlement.findMany({ where: { userId, type: { startsWith: ARTIST_BADGE_ENTITLEMENT_PREFIX } }, select: { type: true } }),
  ]);

  const purchased = new Set(entitlements.map((e) => e.type));
  const approvedCount = translations.length;
  const targetLangs = new Set(translations.map((t) => t.targetLang.toLowerCase()));
  const contextCount = translations.filter((t) => hasQualityContext(t.culturalContext)).length;
  const upvotes = translations.reduce((s, t) => s + (t.upvotes ?? 0), 0);
  const downvotes = translations.reduce((s, t) => s + (t.downvotes ?? 0), 0);
  const approvalRatio = upvotes + downvotes > 0 ? Math.round((upvotes / (upvotes + downvotes)) * 100) : (approvedCount > 0 ? 100 : 0);
  const resolvedCorrections = correctionRequests.filter((c) => c.status === 'APPROVED' && c.resolvedAt);
  const avgResolutionHours = resolvedCorrections.length > 0
    ? Math.round((resolvedCorrections.reduce((s, c) => s + (c.resolvedAt!.getTime() - c.createdAt.getTime()), 0) / resolvedCorrections.length) / 36e5)
    : 9999;
  const countries = new Set(countryAgg.map((c) => (c.country ?? '').toUpperCase()).filter(Boolean));
  const fulfilledRequests = translationRequests.filter((r) => r.status === 'FULFILLED' as any).length;
  const catalogTotal = songs.length;
  const catalogClear = songs.filter((s) => s._count.lyrics > 0 && s._count.translations > 0 && s._count.songLanguages > 0).length;
  const catalogClarityPct = catalogTotal > 0 ? Math.round((catalogClear / catalogTotal) * 100) : 0;
  const translationViews = await prisma.translationViewEvent.count({ where: { artistId } });

  const metrics: Record<ArtistBadgeId, { eligible: boolean; progressLabel: string; metric: number; target?: number; unlocked: boolean }> = {
    FIRST_TRANSLATION_UNLOCK: { eligible: approvedCount >= 1, unlocked: approvedCount >= 1, metric: approvedCount, target: 1, progressLabel: `${Math.min(approvedCount,1)}/1 approved translation` },
    BRIDGE_BUILDER: { eligible: targetLangs.size >= 3, unlocked: targetLangs.size >= 3, metric: targetLangs.size, target: 3, progressLabel: `${targetLangs.size}/3 languages (tiers 3/10/25)` },
    LANGUAGE_PIONEER: { eligible: targetLangs.size >= 1, unlocked: targetLangs.size >= 1, metric: targetLangs.size, target: 1, progressLabel: `${Math.min(targetLangs.size,1)}/1 language unlocked` },
    CONTEXT_CURATOR: { eligible: contextCount >= 3, unlocked: contextCount >= 3, metric: contextCount, target: 3, progressLabel: `${contextCount}/3 quality cultural contexts` },
    COMMUNITY_TRUSTED: { eligible: approvedCount >= 3 && approvalRatio >= 70, unlocked: approvedCount >= 3 && approvalRatio >= 70, metric: approvalRatio, target: 70, progressLabel: `${approvalRatio}% positive vote ratio (min 3 approved translations)` },
    CORRECTION_CHAMPION: { eligible: resolvedCorrections.length >= 1 && avgResolutionHours <= 24, unlocked: resolvedCorrections.length >= 1 && avgResolutionHours <= 24, metric: avgResolutionHours, target: 24, progressLabel: resolvedCorrections.length ? `${avgResolutionHours}h avg resolution (<=24h)` : 'No resolved correction requests yet' },
    GLOBAL_LISTENER_REACH: { eligible: countries.size >= 5, unlocked: countries.size >= 5, metric: countries.size, target: 5, progressLabel: `${countries.size}/5 countries consuming translations` },
    MOST_REQUESTED: { eligible: fulfilledRequests >= 5, unlocked: fulfilledRequests >= 5, metric: fulfilledRequests, target: 5, progressLabel: `${fulfilledRequests}/5 translation requests fulfilled` },
    CATALOG_CLARITY: { eligible: catalogClarityPct >= 60 && catalogTotal >= 3, unlocked: catalogClarityPct >= 60 && catalogTotal >= 3, metric: catalogClarityPct, target: 60, progressLabel: `${catalogClarityPct}% catalog clear (${catalogClear}/${catalogTotal})` },
    CULTURAL_MILESTONE: { eligible: translationViews >= 100 && targetLangs.size >= 3, unlocked: translationViews >= 100 && targetLangs.size >= 3, metric: translationViews, target: 100, progressLabel: `${translationViews}/100 translation views and ${targetLangs.size}/3 languages` },
  };

  return BADGE_DEFS.map((def) => {
    const m = metrics[def.id];
    return {
      ...def,
      ...m,
      purchased: purchased.has(`${ARTIST_BADGE_ENTITLEMENT_PREFIX}${def.id}`),
    };
  });
}

export async function getArtistBadgeSummary(artistId: string, userId: string) {
  const badges = await getArtistBadgeStates(artistId, userId);
  return {
    badges,
    unlockedCount: badges.filter((b) => b.unlocked).length,
    purchasedCount: badges.filter((b) => b.purchased).length,
  };
}

export function getArtistBadgeStoreItems(badges: ArtistBadgeState[]) {
  return badges.map((badge) => ({
    id: `artist-badge-${badge.id.toLowerCase()}`,
    name: badge.title,
    description: badge.description,
    tokenCost: 0,
    category: 'artist_badge',
    active: true,
    featured: badge.eligible,
    limitedTime: false,
    originalPrice: null,
    discountedPrice: null,
    discountPercent: null,
    promoStartsAt: null,
    promoEndsAt: null,
    sortOrder: 0,
    stock: null,
    owned: badge.purchased,
    eligible: badge.eligible,
    unlocked: badge.unlocked,
    howToEarn: badge.howToEarn,
    progressLabel: badge.progressLabel,
    metadata: { entitlementType: `${ARTIST_BADGE_ENTITLEMENT_PREFIX}${badge.id}`, artistBadgeId: badge.id },
  }));
}

export async function recordTranslationViewEvent(input: { songId: string; translationId?: string; targetLang: string; country?: string | null; userId?: string | null; sessionId?: string | null; }) {
  const song = await prisma.song.findUnique({ where: { id: input.songId }, select: { id: true, artistId: true, softDeleted: true } });
  if (!song || song.softDeleted) return null;
  const event = await prisma.translationViewEvent.create({
    data: {
      songId: song.id,
      translationId: input.translationId,
      artistId: song.artistId,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      targetLang: input.targetLang.toLowerCase(),
      country: input.country?.toUpperCase() ?? null,
    },
  });
  logger.debug({ songId: song.id, artistId: song.artistId, targetLang: input.targetLang }, 'Recorded translation view event');
  return event;
}
