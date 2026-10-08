/**
 * Report the project's YouTube Data API quota limits (Phase 1 decision input).
 *
 * ---------------------------------------------------------------------------
 * Why this script exists
 * ---------------------------------------------------------------------------
 * The backfill's design assumes `search.list` has a small, separate daily cap
 * (~100 calls) while everything else draws on a much larger shared pool. Phase 1
 * measures what the cheap channel-enumeration path covers so we can tell whether
 * that assumption even matters. If coverage is high, no quota grant is needed and
 * this script never has to authenticate.
 *
 * If a grant IS needed, this is the only reliable way to confirm it landed. The
 * Google Cloud Console renders the effective and default meters identically, so
 * "the number looks bigger" is not a verification. A grant exists exactly when
 * `effectiveLimit !== defaultLimit` for the metric.
 *
 * ---------------------------------------------------------------------------
 * Authentication — the constraint that trips people up
 * ---------------------------------------------------------------------------
 * `serviceusage.googleapis.com` does NOT accept an API key. It requires an OAuth
 * 2.0 bearer token with Service Usage Viewer (`roles/serviceusage.serviceUsageViewer`)
 * on the project. That is why this script fails with a clear message rather than
 * guessing: `YOUTUBE_API_KEY` is genuinely insufficient here.
 *
 * Authenticate with Application Default Credentials:
 *
 *   gcloud auth application-default login
 *   gcloud config set project <PROJECT_ID>
 *
 * or point at a service-account key:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\sa.json
 *
 * ADC is resolved via `google-auth-library`, which is already a dependency
 * (transitively, via googleapis). No YouTube quota unit is spent by this script —
 * `consumerQuotaMetrics` is a Service Usage call, not a YouTube one.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   npx tsx scripts/check-youtube-quota.ts
 *   npx tsx scripts/check-youtube-quota.ts --project my-project-id
 */

import 'dotenv/config';

import { google } from 'googleapis';

const args = process.argv.slice(2);
const projectArgIndex = args.indexOf('--project');
const PROJECT_ARG = projectArgIndex !== -1 ? args[projectArgIndex + 1] : undefined;
const PROJECT_ID = PROJECT_ARG || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';

/** The one metric whose cap decides whether the backfill needs a grant. */
const SEARCH_METRIC = 'youtube.googleapis.com/search.list';

interface QuotaLimit {
  name: string;
  quotaLimit: string;
  metric?: string;
  unit?: string;
}

interface ConsumerQuotaMetric {
  metric?: string;
  consumerQuotaLimits?: QuotaLimit[];
}

const CREDENTIAL_HELP = `

Could not obtain OAuth credentials.

serviceusage.googleapis.com does not accept YOUTUBE_API_KEY — it needs an OAuth
bearer token. Authenticate with Application Default Credentials:

  gcloud auth application-default login
  gcloud config set project <PROJECT_ID>

or point at a service-account key:

  set GOOGLE_APPLICATION_CREDENTIALS=C:\\path\\to\\service-account.json

The account needs roles/serviceusage.serviceUsageViewer on the project.
`;

/**
 * Print one metric, flagging whether a quota increase is in effect.
 *
 * A grant is present when the effective limit differs from the default; when
 * they are equal, the project is on Google's out-of-the-box allowance and the
 * console's larger-looking number is not evidence of anything.
 */
const reportMetric = (metric: ConsumerQuotaMetric) => {
  const limits = metric.consumerQuotaLimits ?? [];
  if (limits.length === 0) {
    console.log(`  ${metric.metric ?? '(unnamed)'}: no limits reported`);
    return;
  }

  for (const limit of limits) {
    const effective = Number(limit.quotaLimit);
    const defaultLimit = Number(limit.defaultLimit ?? limit.quotaLimit);
    const granted = Number.isFinite(defaultLimit) && effective !== defaultLimit;

    console.log(`  ${limit.name ?? metric.metric ?? '(unnamed)'}`);
    console.log(`      effective  ${effective.toLocaleString('en-US')}`);
    console.log(`      default    ${Number.isFinite(defaultLimit) ? defaultLimit.toLocaleString('en-US') : 'n/a'}`);
    console.log(`      unit       ${limit.unit ?? 'n/a'}`);
    console.log(
      granted
        ? `      status     GRANT ACTIVE (${effective - defaultLimit > 0 ? '+' : ''}${(effective - defaultLimit).toLocaleString('en-US')})`
        : `      status     default allowance — no increase applied`,
    );
  }
};

async function main() {
  if (!PROJECT_ID) {
    console.error(
      'No project id. Pass --project <id>, set GOOGLE_CLOUD_PROJECT, or run `gcloud config set project <id>`.',
    );
    process.exit(1);
  }

  console.log(`YouTube quota for project: ${PROJECT_ID}\n`);

  let auth: Awaited<ReturnType<typeof google.auth.getClient>>;
  try {
    auth = await google.auth.getClient({
      scopes: ['https://www.googleapis.com/auth/cloud-platform.read-only'],
    });
  } catch (err) {
    console.error(`OAuth unavailable: ${(err as Error).message}`);
    console.error(CREDENTIAL_HELP);
    process.exit(1);
    return;
  }

  const serviceusage = google.serviceusage({ version: 'v1beta1', auth });

  let payload: { metrics?: ConsumerQuotaMetric[] };
  try {
    const res = await serviceusage.services.consumerQuotaMetrics.list({
      name: `projects/${PROJECT_ID}`,
      filter: `metric = "${SEARCH_METRIC}"`,
    });
    payload = res.data as { metrics?: ConsumerQuotaMetric[] };
  } catch (err) {
    console.error(`consumerQuotaMetrics.list failed: ${(err as Error).message}`);
    console.error(CREDENTIAL_HELP);
    process.exit(1);
    return;
  }

  const metrics = payload.metrics ?? [];
  if (metrics.length === 0) {
    // Not an error: the metric exists for every project, so an empty result
    // usually means the filter syntax or the project's API enablement.
    console.log(`No consumerQuotaMetrics returned for ${SEARCH_METRIC}.`);
    console.log('Check that the YouTube Data API v3 is enabled for this project.');
    process.exit(1);
  }

  console.log(`${SEARCH_METRIC}`);
  for (const metric of metrics) reportMetric(metric);

  console.log(
    '\nInterpretation: a grant is confirmed when effective differs from default.\n' +
      'Run the Phase 1 dry run (npm run youtube:backfill:nosearch) to measure whether\n' +
      'the catalog actually needs more than the default search allowance.',
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});