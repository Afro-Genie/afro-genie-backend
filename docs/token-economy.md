# Token Economy — Configuration Reference

> Part of Remediation Phase R2.6 (docs & config). Companion to the root
> `TOKEN_ECONOMY_IMPLEMENTATION_PLAN.md`, `TOKEN_ECONOMY_AUDIT_AND_REMEDIATION.md`, and
> `TOKEN_ECONOMY_IMPLEMENTATION_SUMMARY.md`.
>
> All reward amounts, anti-gaming caps, and tier thresholds live in
> `src/config/rewards.ts` (single source of truth) so they can be tuned without
> touching reward wiring. Feature-area toggles live in `src/config/featureFlags.ts`.

---

## 1. Reward knobs (`src/config/rewards.ts` → `REWARD_CONFIG`)

| Knob | Value | Plan § | Event |
|---|---|---|---|
| `AI_TRANSLATION_AMOUNT` | 2 × tier mult | §4 | AI translation actually generated (never cache-served) |
| `AI_TRANSLATION_DAILY_CAP` | 5 | §4 guardrail | per-user/day AI-trigger cap |
| `CORRECTION_APPROVED_AMOUNT` | 20 × tier mult | §4 | Correction approved (contributor) |
| `CORRECTION_DAILY_CAP` | 10 | §4 guardrail | per-user/day correction cap |
| `TRANSLATION_APPROVED_AMOUNT` | 10 (flat) | §4 | Translation approved (moderator) |
| `REPORT_RESOLVED_AMOUNT` | 5 | §4 | Report resolved (moderator) |
| `OVERTURN_PENALTY_AMOUNT` | 20 | §4 | Approval overturned by arbiter (penalty) |
| `COMMUNITY_MODERATION_REWARD` | 5 | §4 | Pin/lock/delete/comment-delete (moderator) |
| `MOD_POOL_TAX_PERCENT` | **0.05 (5%)** | §8.5 (D1 aligned) | On every moderator EARN |
| `MOD_POOL_DISTRIBUTE_MIN` | 50 | §8.5 | Min pool balance before distribution |
| `DAILY_LOGIN_AMOUNT` | 1 | §4 | First login of the UTC day |
| `STREAK_BONUS_PER_DAY` | 5 × (streak − 1), cap 50 | §4 | Consecutive-day streak bonus |
| `TOPIC_SHARE_AMOUNT` | 2 (daily cap 10) | §4 | Topic share |
| `REFERRAL_REWARD` | 10 | §4/§9 (D3: referrer only) | Referral applied |
| `SEASON_TOP3_BONUS` | [50, 40, 30] | §9.4 | Monthly season leaderboard top 3 |
| `REFERRAL_STAR_THRESHOLD` | 3 | §10.2 | Referrals to earn `REFERRAL_STAR` |

### Badge thresholds (`REWARD_CONFIG.BADGE_THRESHOLDS`)

| Badge | Threshold | Evaluator fires at |
|---|---|---|
| `EARLY_ADOPTER` | 1 approved translation | translation approved |
| `TOP_TRANSLATOR` | 10 approved translations | translation approved |
| `CULTURE_CURATOR` | 5 cultural-context contributions | translation approved |
| `COMMUNITY_HELPER` | 10 topics + comments | topic/comment create |
| `DAILY_STREAK_7` | 7-day streak | login/streak |
| `GENEROUS_SUPPORTER` | 3 purchases | store purchase |
| `GUARDIAN` | 10 reports resolved | report resolve |
| `HELPFUL_VOTER` | 50 upvotes cast | vote |
| `FAN_FAVORITE` | 50 upvotes received | vote |
| `REFERRAL_STAR` | 3 referrals | referral apply |
| `SEASON_CHAMPION` | top 3 | season freeze |

### Tier table (`TIER_CONFIG`)

| Tier | Approved translations | Multiplier |
|---|---|---|
| LISTENER | 0 | ×1.0 |
| SCRIBE | 5 | ×1.2 |
| MASTER_TRANSLATOR | 50 | ×1.5 |

Tier recomputes on every translation-approval event (`tierService.recomputeTier`).

---

## 2. Feature flags (`src/config/featureFlags.ts` + frontend `config/featureFlags.ts`)

Backend flags mirror the frontend `VITE_FLAG_*` pattern via `BACKEND_FLAG_*`
env vars. Defaults are ON now that the features are implemented; set the var to
`false`/`0` to 404-gate a route group.

| Flag | Env var | Controls |
|---|---|---|
| `STORE` | `BACKEND_FLAG_STORE` | `/api/store/*` routes |
| `REFERRALS` | `BACKEND_FLAG_REFERRALS` | `/api/referrals/*` routes |
| `SEASONS` | `BACKEND_FLAG_SEASONS` | `/api/community/leaderboard/seasons*` routes |

Frontend flags that gate nav/routes: `tokensPage`, `leaderboardPage`, `storePage`,
`referralsPage`, `leaderboardSeasons`, `genrePages`, `languagePages`.

---

## 3. Observability (R2.4)

- `src/jobs/reconciliationJob.ts` — hourly; compares each `UserWallet.balance`
  against `SUM(TokenLedger.amount)`; logs + returns drift (read-only).
- `src/jobs/overturnRateAlertJob.ts` — daily; attributes `APPROVAL_OVERTURNED`
  logs to the approver via `metadata.previouslyApprovedById` and flags moderators
  over `OVERTURN_ALERT_THRESHOLD` (default 2) overturns in 30 days.
- `GET /api/admin/rewards/stats` already returns `topReasons`.

---

## 4. Plan-vs-code decisions (D1–D5, recorded per audit §5)

| # | Decision | Resolved as |
|---|---|---|
| D1 | Pool tax rate/scope | **5%** on **all moderator EARN** (translation approval, report resolve, community moderation) |
| D2 | Community moderation reward | **+5 EARN** with `moderation:<action>:<targetId>:<moderatorId>` idempotency |
| D3 | Referral reward | **Referrer +10, no friend bonus**; `ReferralsPage` copy matches |
| D4 | Tier counting | `APPROVED` **+ `PUBLISHED`** translations (benign; documented) |
| D5 | `Translation.publishedAt` | Not in schema; not required by any §5 endpoint/UI (skipped) |
| D6 | ModPool cadence | Job repeats every 30 days; service fn `distributeWeekly` (idempotent per week); manual `POST /admin/moderation/pool/distribute` trigger |

---

## 5. Rate limiting (R2.5)

| Route | Limiter | Note |
|---|---|---|
| `POST /api/store/purchase` | 10 / 5 min | `purchaseLimiter` |
| `POST /api/referrals/apply` | 5 / 15 min | `applyLimiter` |
| `POST /api/translations/request` | 10 / 1 min | `translationRequestLimiter` |
| `POST /api/translations/:id/correction-request` | 10 / 5 min | `correctionSubmitLimiter` |
| All `/api/*` | global `apiLimiter` (floor) | `app.ts` |
| `POST /api/auth/login` | `loginLimiter` | existing |

---

*Keep this document in sync whenever a knob, flag, or decision changes.*
