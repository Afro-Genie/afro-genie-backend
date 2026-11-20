# African music catalog policy

The catalog importer uses the YouTube Data API and YouTube video IDs. It does
not use Spotify for song discovery, song identity, or catalog writes.

## Inclusion policy

Every import mode uses the reviewed channel IDs in
`src/data/youtube-african-channel-allowlist.json` and
`src/data/youtube-african-playlist-artists.json`; search terms never establish
African eligibility by themselves. Artist searches must match a reviewed
artist name, genre searches must resolve to an approved African genre and
reviewed channels for that genre, and song-title searches admit results only
from reviewed channels. In all modes, the video must be categorized as Music,
embeddable, longer than 30 seconds, and have a usable title.

Playlist artist entries explicitly map recognized African performers from the
user-provided Nigeria chart playlist to their Topic/official YouTube channel
IDs, African country, and broad African genre(s). The playlist tags mostly
identify artists and song titles, so they are not treated as genre evidence.
Artist-name substrings and arbitrary tag text do not auto-admit channels.
Unknown, deleted, curator, and unclear artist channels remain excluded until
explicitly reviewed and added. Search previews report unknown channels and
sample titles as review suggestions; those suggestions are never import
candidates and do not change the allowlist.

Supported genres include Afrobeat, Afrobeats, Afropop, Afro-fusion, Afro-R&B,
Afro-house, Amapiano, Azonto, Banku, Bongo Flava, Coupé-Décalé, Dancehall,
Fuji, Gengetone, Gqom, Highlife, Juju, Kizomba, Kuduro, Kwaito, Makossa,
Mbalax, Ndombolo, Soukous, Taarab, and African Hip-Hop. Generic Western genres
do not qualify. Unqualified `Dancehall` does not qualify; only African-scene
qualified evidence such as Naija, Ghanaian, or African Dancehall maps to
Dancehall.

The evidence-backed search allowlist records each channel's origin sources,
review date, rationale, and genres. Playlist artist rules are deliberately a
separate, explicit per-channel mapping and should be expanded only for
recognized African artists, not by accepting all playlist entries.

## Safety and idempotency

- Runs default to dry-run. Apply only with `--apply`.
- Existing song data is preserved. An existing exact title/artist match with
  no YouTube ID can be linked; a non-null YouTube ID is never overwritten.
- New songs receive a YouTube video ID and the configured genre(s). Existing
  song, artist, and album details are otherwise not refreshed.
- Database transactions and a video-ID advisory lock protect repeated and
  concurrent importer runs. The catalog currently contains duplicate YouTube
  IDs, so do not add a unique database constraint without separately resolving
  those records.
- `--resume --apply` resumes only a checkpoint matching the current policy,
  limits, playlist, and configured artist/channel rules. Checkpoints are local
  and git-ignored.
- Changing the policy fingerprint invalidates pending previews and older
  resumable checkpoints; create a fresh preview/run rather than applying stale
  discovery results.
- The CLI and admin import jobs share the service in
  `src/services/youtubeCatalogImportService.ts` for playlist and search
  discovery, African-channel filtering, preview planning, quota estimates, and
  idempotent writes.
- YouTube's default quota is 10,000 units/day; each `search.list` call costs
  100 units. The importer caps itself at 80 searches per run by default to
  leave quota for other YouTube operations. Playlist enumeration and
  `videos.list` calls use lower quota-cost endpoints.
- Admin playlist previews are capped at 80 pages (up to 160 units per run).
  Artist, genre, and song searches accept at most 50 results and make at most
  one `search.list` call plus one `videos.list` call (up to 101 units). Search
  and playlist jobs do not automatically retry YouTube requests; an admin must
  explicitly retry a failed job. Import enqueue requests are rate-limited per
  admin.

## Admin import API

All requests require an authenticated `ADMIN` role.

- `POST /api/admin/youtube-catalog/imports/preview` with
  `{ "playlistUrl": "...", "maxPages": 80 }` queues a read-only playlist
  preview. Alternatively, send
  `{ "sourceType": "artist", "query": "Asake", "maxResults": 50 }`,
  `{ "sourceType": "genre", "query": "Afrobeats", "maxResults": 50 }`, or
  `{ "sourceType": "song", "query": "Lonely at the Top", "maxResults": 50 }`.
  Artist names must resolve to the reviewed artist list; genre values must
  resolve to an approved African genre. Song terms can be free text, but only
  results from reviewed African artist channels can enter the preview. Clients
  may include a UUID `requestId`; reusing it for the same admin and source
  returns the existing job, while reusing it for a different source returns
  `409 IDEMPOTENCY_CONFLICT`.
  The enqueue response includes a quota estimate and hard upper bound; the
  completed preview reports the estimated units used.
- `GET /api/admin/youtube-catalog/imports/:jobId?page=1&pageSize=50` returns
  job progress, paginated preview candidates or apply results, and channel
  review suggestions for excluded unknown channels.
- `POST /api/admin/youtube-catalog/imports/:previewJobId/apply` requires
  `{ "confirm": true, "previewHash": "..." }`. The preview must be complete,
  unchanged, and generated under the current African-music policy.
- `POST /api/admin/youtube-catalog/imports/:jobId/resume` continues an
  incomplete playlist preview from its server-held page token.
- `POST /api/admin/youtube-catalog/imports/:jobId/retry` retries only failed
  jobs. Retrying an apply requires the same explicit confirmation and preview
  hash; writes remain idempotent.

BullMQ stores the initiating admin ID with each job and structured logs record
preview, apply, and retry actions. Completed jobs are retained for 14 days and
failed jobs for 30 days. The dashboard uses these APIs to display quota
failures and progress, support paginated preview review, and expose safe
resume/retry actions. Quota exhaustion marks discovery as paused in job
progress and fails the queue job; the admin can explicitly retry after quota
resets. A failed preview makes no catalog writes.

## Commands

Run from `afro-genie-backend` after setting `YOUTUBE_API_KEY` and
`DATABASE_URL` in the local environment:

```text
npm run seed:youtube
npm run seed:youtube -- --playlist "https://youtube.com/playlist?list=PLAYLIST_ID"
npm run seed:youtube:apply
npm run seed:youtube:apply -- --playlist "https://youtube.com/playlist?list=PLAYLIST_ID"
npm run seed:robust:status
npm run seed:robust:resume
```

`seed:youtube` (and the legacy batch/full/robust dry-run aliases) performs no
writes. Review its projected catalog count before the explicit apply command.
Playlist mode reads all playlist pages up to `--max-pages` (80 per run by
default), and imports only tracks whose video-owner channel ID matches the
configured playlist artist rules. Other playlist entries are reported or
skipped. `prisma:seed` only handles general bootstrap data; song catalog
imports are separate.

## Existing songs and lyrics

To match existing songs that do not yet have YouTube IDs, use the validated
YouTube backfill. It also defaults to dry-run:

```text
npm run youtube:backfill:dry
npm run youtube:backfill -- --apply
```

After catalog seeding and YouTube-ID backfill, enqueue lyrics enrichment for
all YouTube-linked songs that have no lyric row or have empty lyric content:

```text
npm run lyrics:backfill
```

This command enqueues jobs; configured lyrics workers process them in the
background. Re-running is safe because the queue uses stable per-song job IDs.
