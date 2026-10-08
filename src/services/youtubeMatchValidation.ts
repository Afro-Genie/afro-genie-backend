/**
 * YouTube match validation (Phase B).
 *
 * ---------------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------------
 * `youtubeService.lookupMatch()` used to accept `search.items[0]` and store it
 * as the song's playback video. A live probe against the production catalog
 * showed what that buys you:
 *
 *   query "Soweto Victony ft. Burna Boy official audio"
 *     -> "Burna Boy - Soweto, Tshwala Bam (Feat. Victony, Rema, Omah Lay,
 *         TitoM & Yuppe) REMIX"  (Soundkravt Music)
 *
 * That is a six-artist remix stored against a song titled "Soweto". It is
 * embeddable, it is public, and it is not the song. Persisting it means users
 * press play on a track and hear something else entirely — which is strictly
 * worse than hearing nothing, because nothing is honest.
 *
 * So matching is now a *decision* rather than a lookup: every candidate is
 * scored, hard gates are applied, and the result is only persisted when it
 * survives. Pure and dependency-free so it can be unit-tested without a network,
 * a database, or an API key.
 *
 * ---------------------------------------------------------------------------
 * Design notes
 * ---------------------------------------------------------------------------
 * - Hard gates reject; the score only orders what survived. A candidate that
 *   fails a gate is not rescued by a high score, so a stray keyword in a
 *   500-character description cannot outweigh a duration mismatch.
 * - Signals are returned alongside the verdict so `--dry-run` reports can show
 *   *why* something was rejected, not just that it was.
 * - Strictness is a parameter, not a constant. `strict` is the shipping default;
 *   `loose` exists to measure coverage when evaluating the threshold, and is
 *   never used by the backfill script's default path.
 */

/** What the catalog says it wants. */
export interface SongIdentity {
  title: string;
  artist: string;
  /** Catalog duration. `null` means unknown — never coerce it to 0 (see 2.21). */
  durationMs: number | null;
}

/** What YouTube offered. */
export interface MatchCandidate {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSeconds: number | null;
  /**
   * `status.embeddable`. A video with `embeddable: false` cannot play in the
   * IFrame player at all, so accepting one yields a song that appears matched
   * and then silently fails in the browser.
   *
   * `null` means "not fetched" (e.g. the channel-enumeration path, where
   * `playlistItems.list` carries title and duration but not status). Such
   * candidates are accepted and flagged `needsEmbeddableCheck` so an operator
   * can review them, rather than rejected — the field is unavailable on the
   * cheap path, and a missing lookup is not evidence of a bad match.
   */
  embeddable: boolean | null;
  thumbnailUrl?: string | null;
}

export type RejectionReason =
  | 'not_embeddable'
  | 'title_mismatch'
  | 'artist_not_found'
  | 'duration_mismatch'
  | 'derivative_content'
  | 'low_score';

export type Strictness = 'strict' | 'loose';

export interface ValidationThresholds {
  /** Minimum fraction of the song title's significant tokens that must appear
   *  in the candidate title. 0.6 rejects "Soweto" -> a remix whose title leads
   *  with six other artists. */
  minTitleOverlap: number;
  /** Max |videoDuration - catalogDuration| / catalogDuration. */
  maxDurationDrift: number;
  /** Minimum total score to accept. */
  minScore: number;
  /** When false, derivative-content titles (remix/cover/live/...) are allowed. */
  rejectDerivative: boolean;
}

export const STRICT_THRESHOLDS: ValidationThresholds = {
  minTitleOverlap: 0.6,
  maxDurationDrift: 0.15,
  minScore: 70,
  rejectDerivative: true,
};

export const LOOSE_THRESHOLDS: ValidationThresholds = {
  minTitleOverlap: 0.34,
  maxDurationDrift: 0.35,
  minScore: 45,
  rejectDerivative: false,
};

export interface CandidateSignals {
  titleOverlap: number;
  titleExact: boolean;
  artistInTitle: boolean;
  artistInChannel: boolean;
  officialChannel: boolean;
  /** Signed relative drift: (video - catalog) / catalog. `null` if either is unknown. */
  durationDrift: number | null;
  durationKnown: boolean;
  derivative: string | null;
  score: number;
  accepted: boolean;
  reason: RejectionReason | null;
  needsEmbeddableCheck: boolean;
}

/**
 * Tokens that carry no identity: they describe the upload, not the track.
 * Without this, "Turbulence" overlaps "Turbulence (Official Video)" only 50%
 * and a correct match scores as a partial one.
 */
const NOISE_TOKENS = new Set([
  'official', 'video', 'audio', 'music', 'mv', 'visualizer', 'visualiser',
  'lyric', 'lyrics', 'lyrical', 'hd', 'hq', '4k', 'hqv', 'full', 'version',
  'ft', 'feat', 'featuring', 'prod', 'out', 'now', 'new', 'hdvideo',
  'by', 'and',
]);

/**
 * Titles that are not the catalog track. Checked against the *candidate* title
 * only when the song's own title does not already contain the marker — a song
 * genuinely titled "X (Remix)" must be allowed to match a remix.
 */
const DERIVATIVE_MARKERS: Array<[RegExp, string]> = [
  [/\bremix(ed)?\b/i, 'remix'],
  [/\bmashup\b/i, 'mashup'],
  [/\bcover\b/i, 'cover'],
  [/\bkaraoke\b/i, 'karaoke'],
  [/\binstrumental\b/i, 'instrumental'],
  [/\bnightcore\b/i, 'nightcore'],
  [/\bslowed\b/i, 'slowed'],
  [/\breverb\b/i, 'reverb'],
  [/\bsped[\s-]?up\b/i, 'sped-up'],
  [/\b8d\b/i, '8d'],
  [/\blive\b/i, 'live'],
];

/**
 * Tokens that are part of an artist's *role or label*, not their identity.
 *
 * These are excluded from the artist gate ONLY — they still count toward title
 * overlap. A live Phase 1 dry run caught the cost of ignoring this:
 *
 *   catalog: "2026 Party Mixtape Vol 4" by "Dj Chizzy"
 *   matched: "Party Mixtape 2026 (Full Mix) DJ 2EFFECTS - Topic"
 *
 * The artist gate passed because the artist's token `dj` appears in the other
 * DJ's channel name. The song is a compil DJ's full mix, not Chizzy's track —
 * exactly the "user presses play and hears something else" failure this module
 * exists to prevent, and it scored 75, above the strict threshold of 70.
 *
 * "Chizzy" was in neither title nor channel, so requiring at least one
 * meaningful artist token (rather than any) is what rejects it.
 */
const ARTIST_ROLE_TOKENS = new Set([
  'dj', 'mc', 'the', 'official', 'records', 'recordings', 'music',
  'entertainment', 'ent', 'inc', 'ltd', 'llc', 'group', 'band', 'boy', 'girl',
]);

/**
 * Artist tokens that carry identity.
 *
 * A name made entirely of role tokens ("DJ", "The Boyz" with no other part)
 * yields an empty list, and the caller treats that as "do not gate on the
 * artist" — the same deliberate choice as an unknown artist, because there is
 * nothing left to compare against.
 */
export const artistIdentityTokens = (artistName: string): string[] =>
  tokenize(artistName).filter((t) => !ARTIST_ROLE_TOKENS.has(t));

const stripDiacritics = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Lowercase, de-accent, and reduce punctuation to spaces.
 *
 * Bracketed segments are deliberately NOT stripped. An earlier version removed
 * them to keep "(Official Video)" out of the overlap score, but that also erased
 * the artist name whenever it appeared in a feature credit — and credits are
 * exactly where it lives:
 *
 *   "Burna Boy - Soweto, Tshwala Bam (Feat. Victony, Rema, Omah Lay) REMIX"
 *
 * Stripping the bracket lost "Victony", so the candidate looked artist-less and
 * was rejected by the artist gate for the wrong reason. Noise is now handled by
 * `NOISE_TOKENS` instead, which drops the upload-describing words while keeping
 * the names.
 */
export const normalizeText = (s: string): string =>
  stripDiacritics(String(s ?? ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const tokenize = (s: string): string[] =>
  normalizeText(s)
    .split(' ')
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t));

/** Fraction of `songTokens` present in `candidateTokens`. */
const overlapRatio = (songTokens: string[], candidateTokens: string[]): number => {
  if (songTokens.length === 0) return 0;
  const bag = new Set(candidateTokens);
  let hits = 0;
  for (const t of songTokens) if (bag.has(t)) hits++;
  return hits / songTokens.length;
};

/**
 * An artist is "present" if any of its significant tokens appears in the
 * candidate title or channel. Token-level rather than substring so
 * "Victony" does not match "Victorious" and "Rema" does not match "Remake".
 */
const artistPresent = (artistTokens: string[], ...haystacks: string[]): boolean => {
  if (artistTokens.length === 0) return true; // unknown artist: do not gate on it
  const bag = new Set(haystacks.flatMap((h) => tokenize(h)));
  return artistTokens.some((t) => bag.has(t));
};

/**
 * Does the channel name carry the artist's identity?
 *
 * Official upload channels concatenate the name rather than separating it:
 * "WizkidVEVO", "Burna BoyVEVO", "TemsVEVO". Token matching cannot see that,
 * because `tokenize("WizkidVEVO")` yields `["wizkidvevo"]` — one token that
 * equals no artist token. Without this, a correct official upload of any single-
 * word artist name fails the artist gate.
 *
 * Prefix matching is applied ONLY to VEVO/Topic channels, where the concatenated
 * form is a known convention. Applying it to arbitrary channels would let "Remake
 * Channel" pass for an artist named "Rema".
 */
const channelNamesArtist = (channelTitle: string, artistTokens: string[]): boolean => {
  if (artistTokens.length === 0) return true;
  // Only official upload channels concatenate the artist name with a suffix, so
  // the check is confined to them. Without this restriction, "Remake Channel"
  // ends with the artist "Rema" and would pass.
  //
  // No `\b` anchor: the name and the suffix are glued together ("WizkidVEVO"), so
  // there is no word boundary between them and a `\bvevo\b` test never matches.
  if (!/(vevo|topic)/i.test(channelTitle)) return false;
  const channel = normalizeText(channelTitle).replace(/[\s._-]+/g, '');
  const artist = artistTokens.join('');
  if (!artist) return true;
  return channel.startsWith(artist) || channel.endsWith(artist);
};

/**
 * Is this a channel we are willing to attribute a catalog song to?
 *
 * True for VEVO and auto-generated Topic channels, and for any channel that
 * names the artist outright.
 */
const isOfficialChannel = (channelTitle: string, artistTokens: string[]): boolean => {
  // Unanchored on purpose — see `channelNamesArtist`.
  if (/(vevo|topic)/i.test(channelTitle)) return true;
  return artistPresent(artistTokens, channelTitle);
};

/**
 * Does the candidate's title announce a derivative of the song?
 *
 * A marker is only disqualifying when the song's own title does NOT contain it:
 * a catalog row genuinely titled "Soweto (Remix)" must be able to match a remix.
 * The song side is tested against the RAW title, not the normalized one —
 * `normalizeText` strips bracketed segments, so "Soweto (Remix)" would otherwise
 * normalize to "soweto" and lose the very marker being checked for.
 */
const findDerivative = (candidateTitle: string, songTitle: string): string | null => {
  for (const [re, label] of DERIVATIVE_MARKERS) {
    if (re.test(candidateTitle) && !re.test(songTitle)) return label;
  }
  return null;
};

/**
 * Score one candidate against the song. Pure — no I/O, no clock, no randomness.
 */
export const scoreCandidate = (
  song: SongIdentity,
  candidate: MatchCandidate,
  thresholds: ValidationThresholds = STRICT_THRESHOLDS,
): CandidateSignals => {
  const songTitleTokens = tokenize(song.title);
  // Identity tokens, not raw ones: see `ARTIST_ROLE_TOKENS`. Using `tokenize`
  // here let a catalog artist named "Dj Chizzy" satisfy the artist gate against
  // any channel whose name contains "DJ".
  const artistTokens = artistIdentityTokens(song.artist);
  const candTitleTokens = tokenize(candidate.title);

  const titleOverlap = overlapRatio(songTitleTokens, candTitleTokens);
  const titleExact =
    songTitleTokens.length > 0 &&
    songTitleTokens.every((t) => candTitleTokens.includes(t)) &&
    candTitleTokens.every((t) => songTitleTokens.includes(t));

  const artistInTitle = artistPresent(artistTokens, candidate.title);
  const artistInChannel =
    artistPresent(artistTokens, candidate.channelTitle) ||
    channelNamesArtist(candidate.channelTitle, artistTokens);
  const officialChannel = isOfficialChannel(candidate.channelTitle, artistTokens);
  const derivative = findDerivative(candidate.title, song.title);

  let durationDrift: number | null = null;
  let durationKnown = candidate.durationSeconds !== null && song.durationMs !== null;
  if (durationKnown && song.durationMs! > 0) {
    durationDrift = (candidate.durationSeconds! - song.durationMs! / 1000) / (song.durationMs! / 1000);
  } else {
    durationKnown = false;
  }

  let score = 0;
  score += Math.round(titleOverlap * 50);
  if (titleExact) score += 10;
  if (artistInTitle) score += 20;
  if (artistInChannel) score += 15;
  if (officialChannel) score += 15;
  if (durationKnown) score += 15;
  if (derivative) score -= 60;

  const base: Omit<CandidateSignals, 'accepted' | 'reason'> = {
    titleOverlap,
    titleExact,
    artistInTitle,
    artistInChannel,
    officialChannel,
    durationDrift,
    durationKnown,
    derivative,
    score,
    needsEmbeddableCheck: candidate.embeddable === null,
  };

  // ---- hard gates -----------------------------------------------------------
  // Ordered cheapest-and-most-decisive first so the reported reason is the most
  // informative one when several gates fail at once.
  if (candidate.embeddable === false) return { ...base, accepted: false, reason: 'not_embeddable' };
  if (titleOverlap < thresholds.minTitleOverlap) return { ...base, accepted: false, reason: 'title_mismatch' };
  if (!artistInTitle && !artistInChannel) return { ...base, accepted: false, reason: 'artist_not_found' };
  if (thresholds.rejectDerivative && derivative) return { ...base, accepted: false, reason: 'derivative_content' };
  if (durationKnown && Math.abs(durationDrift!) > thresholds.maxDurationDrift) {
    return { ...base, accepted: false, reason: 'duration_mismatch' };
  }
  if (score < thresholds.minScore) return { ...base, accepted: false, reason: 'low_score' };

  return { ...base, accepted: true, reason: null };
};

/**
 * Score every candidate and return the best accepted one.
 *
 * Ties break on the signals that matter most: exact title, then channel
 * credibility, then a video closer to the catalog duration. This makes the
 * choice deterministic, so a re-run cannot silently change which video a song
 * points at.
 */
export const selectBestCandidate = (
  song: SongIdentity,
  candidates: MatchCandidate[],
  thresholds: ValidationThresholds = STRICT_THRESHOLDS,
): { match: MatchCandidate | null; signals: CandidateSignals[] } => {
  const signals = candidates.map((c) => scoreCandidate(song, c, thresholds));
  const accepted = signals
    .map((s, i) => ({ s, c: candidates[i] }))
    .filter((x) => x.s.accepted);

  if (accepted.length === 0) return { match: null, signals };

  accepted.sort((a, b) => {
    if (a.s.titleExact !== b.s.titleExact) return a.s.titleExact ? -1 : 1;
    if (a.s.officialChannel !== b.s.officialChannel) return a.s.officialChannel ? -1 : 1;
    if (a.s.score !== b.s.score) return b.s.score - a.s.score;
    const aDrift = a.s.durationDrift === null ? Number.POSITIVE_INFINITY : Math.abs(a.s.durationDrift);
    const bDrift = b.s.durationDrift === null ? Number.POSITIVE_INFINITY : Math.abs(b.s.durationDrift);
    return aDrift - bDrift;
  });

  return { match: accepted[0].c, signals };
};

/**
 * Aggregate rejection reasons for a report, most common first.
 */
export const summarizeRejections = (
  signals: CandidateSignals[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const s of signals) {
    if (s.accepted || !s.reason) continue;
    counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
};