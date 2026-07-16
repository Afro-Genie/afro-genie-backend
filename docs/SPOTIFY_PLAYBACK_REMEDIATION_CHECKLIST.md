# Spotify Playback Remediation Checklist

## Objective

Restore premium full-track playback without changing the existing Spotify OAuth and auth UX that is already working.

This checklist is intentionally non-code and phase-based. It is written for engineering execution only.

---

## Phase 1 — Confirm the failure boundary

### Goal
Verify that the issue is in the premium Web Playback device handshake, not in the login flow itself.

### Diagnostic instrumentation added
- `WebPlaybackContext` now tracks and logs: SDK script presence, SDK global availability, SDK global type, `window.Spotify` keys, `Spotify.Player` type, player creation, ready event, device_id attachment, token state, and premium detection.
- A `PlaybackDiagnosticPanel` overlay is available at runtime (press `Ctrl+Shift+D` or click the "Dx" button in the bottom-right corner).
- `SpotifyPlayer` loading and active states now emit `data-*` attributes for DOM inspection.

### Checklist
- [x] Reproduce the current premium behavior in a real browser session.
- [x] Confirm that a premium user reaches the premium UI path and sees the player in the connecting state.
- [x] Confirm that the auth redirect, token exchange, and premium status sync still complete successfully.
- [x] Validate that the user is still logged in and the Spotify account remains linked.
- [x] Record the exact browser state observed at the moment playback stalls:
  - SDK script present or absent → **Present**
  - SDK global available or unavailable → **Unavailable** (`window.Spotify` is `object`, not `function`)
  - ready event fired or not fired → **Not fired**
  - device id attached or not attached → **Not attached**
  - current playback state after the player enters the connecting screen → **Player instance never created; player stays in "Connecting to Spotify player..." indefinitely**

> **How to use the diagnostics:** Open the app in a browser, log in with a premium Spotify account, and press `Ctrl+Shift+D` to open the diagnostic panel. Expand the event log (`[+]`) to see the full timeline. All events are also logged to the browser console with the `[PlaybackDiagnostic]` prefix.

### Phase 1 findings

**Failure boundary confirmed.** The issue is downstream of auth success and specifically tied to SDK/device readiness:

1. Auth works: premium user is logged in, Spotify token is valid, not expired.
2. SDK script tag is present in the DOM (`https://sdk.scdn.co/spotify-player.js`).
3. `window.Spotify` resolves to an **object** (not a constructor function), so `typeof window.Spotify === 'function'` fails.
4. The player guard at `WebPlaybackContext.tsx` bails silently — no player instance is created, no error is surfaced.
5. The UI stays on "Connecting to Spotify player..." with no timeout or recovery.

The expanded event log in the diagnostic panel will show the exact keys on `window.Spotify` and the type of `window.Spotify.Player`, which will determine whether the fix should use `new Spotify.Player({...})` (namespace pattern) vs `new Spotify({...})` (direct constructor).

### Exit criteria
- The team agrees the issue is downstream of auth success and specifically tied to SDK/device readiness.

---

## Phase 2 — Protect the auth behavior

### Goal
Preserve the current login experience and avoid regressing the existing Spotify auth UX.

### Checklist
- [ ] Do not change the Spotify OAuth redirect flow.
- [ ] Do not change the current sign-in / sign-up UX pattern.
- [ ] Do not alter redirect-after-auth behavior.
- [ ] Do not change any user-facing “Connect Spotify” or premium messaging unless it is required for diagnostic clarity.
- [ ] Keep the current premium entitlement detection behavior intact while the playback fix is being validated.

### Exit criteria
- The auth UX remains exactly as it is today.
- The remediation work focuses only on the playback readiness path.

---

## Phase 3 — Verify the SDK bootstrap path

### Goal
Confirm whether the Web Playback SDK is actually becoming available in the browser runtime.

### Checklist
- [ ] Open the app in a browser and inspect the global SDK state.
- [ ] Verify whether the Spotify SDK script is loaded from the expected CDN endpoint.
- [ ] Verify whether the callback used to initialize the player is registered before or after the SDK script arrives.
- [ ] Determine whether the SDK is blocked by page load timing, environment mismatch, or script initialization sequencing.
- [ ] Check for any browser or domain-specific issues that would prevent the Spotify player instance from being constructed.

### Exit criteria
- The team can state whether the SDK is loading and initializing, or whether it is failing before it can become ready.

---

## Phase 4 — Separate premium entitlement from playback readiness

### Goal
Make sure the app distinguishes between:
- the user being Premium on Spotify
- the player actually being ready to play full tracks

### Checklist
- [ ] Confirm that premium entitlement still flows correctly into the app state.
- [ ] Confirm that premium entitlement alone is not treated as proof that playback is ready.
- [ ] Treat Spotify Premium as a prerequisite only.
- [ ] Require SDK readiness and a valid device id before allowing the full-track playback path to proceed.
- [ ] If playback readiness is incomplete, fall back to preview playback or a clearly actionable error state instead of a permanent connecting screen.

### Exit criteria
- The app no longer assumes “premium user” means “playback-ready user.”

---

## Phase 5 — Fix the device handshake reliability issue

### Goal
Repair the gap that prevents premium users from reaching a working player device.

### Checklist
- [ ] Validate that the player instance is created only when the SDK is actually available.
- [ ] Validate that the player connects only after the token is fresh and valid.
- [ ] Validate that the ready event is received and that a device id is stored.
- [ ] Validate that the device id is actually used when calling play requests.
- [ ] Identify whether the issue is caused by:
  - the SDK never loading
  - the callback not firing
  - the player instance not attaching listeners correctly
  - the token not being available at the moment of creation
  - the device id never becoming available

### Exit criteria
- The premium user can reach the SDK ready state and the player can proceed to playback command execution.

---

## Phase 6 — Eliminate the dead-end “connecting” state

### Goal
Remove the misleading permanent “Connecting to Spotify player...” experience for premium users.

### Checklist
- [ ] Build a timeout or bounded waiting state for the SDK connection attempt.
- [ ] Show a recovery message only when the connection has genuinely failed or timed out.
- [ ] Avoid leaving the player in a forever-loading state with no actionable recovery.
- [ ] Add a recovery path that can be triggered by the user without losing the auth session.
- [ ] Ensure the play button does not stay permanently greyed out if the SDK never becomes ready.

### Exit criteria
- The premium user sees a concrete recovery state rather than an endless connection spinner.

---

## Phase 7 — Implement a browser-level smoke path for premium playback

### Goal
Add a reliable regression check that proves the premium full-track path works in a browser session.

### Checklist
- [ ] Verify homepage load and catalog data load normally.
- [ ] Verify anonymous users receive preview access only.
- [ ] Verify a premium-linked user enters the premium playback branch.
- [ ] Verify the SDK reaches ready state.
- [ ] Verify the full-track play action is attempted only after the player is ready.
- [ ] Verify the player transitions out of the connecting state and playback begins.
- [ ] Verify the preview-only path still works unchanged for non-premium users.

### Exit criteria
- The premium playback regression is covered by a real browser smoke flow.

---

## Phase 8 — Restore backend verification confidence

### Goal
Make sure the product-sync side of Spotify auth is validated in a working test environment.

### Checklist
- [ ] Repair the backend test runner or module execution configuration so Spotify auth acceptance tests can run cleanly.
- [ ] Re-run the Spotify-specific backend verification after the test harness is corrected.
- [ ] Confirm product sync continues to return the expected premium status after OAuth.
- [ ] Confirm the backend still accepts and stores Spotify subscription state correctly.

### Exit criteria
- The backend validation path for Spotify product sync is reliable again.

---

## Phase 9 — Release gate for the remediation

### Goal
Ship only when the playback path is proven to work without breaking the currently stable auth UX.

### Checklist
- [ ] Premium auth still logs in correctly.
- [ ] Premium account status still syncs correctly.
- [ ] Preview-only mode remains available for non-premium users.
- [ ] Full-track playback becomes available only for premium users with a ready SDK player.
- [ ] No regression is introduced in homepage browsing, catalog loading, or public playback behavior.
- [ ] The browser smoke test passes after the fix.
- [ ] The team documents the final known behavior for support and QA.

### Exit criteria
- The premium playback fix is confirmed and the existing auth UX remains intact.

---

## Recommended execution order

1. Phase 1 — Confirm the failure boundary
2. Phase 2 — Protect the auth behavior
3. Phase 3 — Verify the SDK bootstrap path
4. Phase 4 — Separate premium entitlement from playback readiness
5. Phase 5 — Fix the device handshake reliability issue
6. Phase 6 — Eliminate the dead-end “connecting” state
7. Phase 7 — Implement a browser-level smoke path
8. Phase 8 — Restore backend verification confidence
9. Phase 9 — Release gate

---

## Notes for the engineering team

- Do not change the existing Spotify OAuth UX.
- Do not redesign the premium sign-in flow.
- Do not remove the preview fallback path.
- Focus only on the handoff between premium entitlement and actual Spotify Web Playback readiness.
- The goal is to preserve the current auth experience while fixing the premium playback capability gap.
