# Phase 3B-4A — Short-Fragment Dispatch Guard: Implementation Report

Implements the accepted (`DECISION: MODIFY`) short-fragment guard from
`PHASE_3B_4A_SHORT_FRAGMENT_ACCEPTANCE_REPORT.md`: suspicious fragments are held for a
500 ms grace window and stitched with a continuation, while syntactically complete
questions dispatch with zero added latency.

**Preemptible FIFO was NOT implemented** — see [Remaining Risks](#remaining-risks) and
[Preemptible FIFO decision](#preemptible-fifo-decision) for the evidence and the reason.

---

## Files Changed

| File | Change |
| :--- | :--- |
| `src/utils/gemini.js` | **+99 / −3** — the entire production change |
| `test_short_fragment_guard.js` | **New** — acceptance test harness (test artifact, not shipped logic) |
| `phase3b4a_guard_test_results.json` | **New** — raw test output |

No other production file was touched. `src/components/views/AssistantView.js` remains the
pre-existing Phase 3B-1 renderer optimization and is unrelated to this phase.

### `src/utils/gemini.js` change sites

1. **Guard state** (after `pendingTranscript`): `pendingFragmentBuffer`, `fragmentGraceTimer`, `FRAGMENT_GRACE_MS = 500`.
2. **`isSuspiciousFragment(text)`** — the exact accepted classifier.
3. **`cancelFragmentGrace()` / `resetFragmentGuard()`** — timer lifecycle.
4. **`dispatchTranscript(rawTranscript)`** — routes a committed transcript: stitch a held fragment if present, else hold if suspicious, else dispatch immediately.
5. **`generationComplete` handler** — now calls `dispatchTranscript(committed)` instead of assigning `pendingTranscript` and calling `processPendingTranscript()` directly.
6. **`resetFragmentGuard()`** added to `initializeNewSession()`, `attemptReconnect()`, and the `close-session` IPC handler.
7. **`module.exports`** — `isSuspiciousFragment`, `dispatchTranscript`, `resetFragmentGuard` exported so the tests drive the real production functions (matching the file's existing `formatSpeakerResults` / `getCurrentSessionData` test-export pattern).

---

## Exact Behavior Implemented

```
generationComplete(committed transcript)
        │
        ├─ held fragment present?  ──yes──▶  stitch "frag + continuation",
        │                                     cancel grace timer, re-classify
        │
        ├─ isSuspiciousFragment(text)?  ──yes──▶  hold in pendingFragmentBuffer,
        │                                          arm 500 ms timer, dispatch nothing
        │
        └─ no ──▶  dispatch immediately (0 ms added)
```

- **Suspicious** = `words < 4 && chars < 20`, **unless** the text ends with `?` and has ≥ 2 words, **or** starts with `explain|describe|define|compare|implement|summarize|detail` and has ≥ 2 words.
- **Grace expiry** (no continuation) → the held fragment is dispatched normally, so a genuine short query such as `"tell me"` is never dropped.
- **Stitching** → exactly one `generateAnswer()` for the combined transcript.
- **Teardown** → a held fragment and its timer are discarded on session reset, reconnect, and close, so a late timer cannot dispatch into a dead session.

FIFO (`generateAnswer` / `generateAnswerQueue`) was **not modified**. The guard simply
declines to enqueue a fragment; it does not reorder, abort, or preempt anything.

---

## Tests Performed

`test_short_fragment_guard.js` drives the **real exported `dispatchTranscript()`** with
`global.fetch` stubbed to a fake Groq SSE stream, so call counts and timings are
deterministic and no live API quota is consumed.

| Test | Requirement | Result |
| :--- | :--- | :--- |
| 1 | `isSuspiciousFragment()` over the 14-input benchmark | **PASS** — 0 false positives, 0 false negatives |
| A | Fragments `question`, `um`, `okay`, `tell me` | **PASS** — held (0 immediate calls), then exactly 1 call at 503–518 ms |
| B/D | 8 legitimate short questions | **PASS** — exactly 1 call each, first call at **2–3 ms** (no grace delay) |
| C | `"question"` + continuation after 300 ms | **PASS** — exactly 1 call, prompt = `"question two, explain the difference between SQL and NoSQL"` |
| E | Normal long query | **PASS** — 1 call at 2 ms |
| — | `resetFragmentGuard()` cancels a held timer | **PASS** — 0 calls after reset |
| F | Telemetry still increments per dispatch | **PASS** — `generateAnswer` 14 → 15 |

**21/21 checks passed.**

### Regression suites (all required by the brief)

| Suite | Result |
| :--- | :--- |
| `test_quota_model_selection.js` | **18 passed, 0 failed** |
| `test_fallback_audit.js` | **4/4 PASS** + timeout check OBSERVED-PASS |
| `test_timeout_fallback.js` | **5/5 PASS** (10 s abort, FIFO release, 404/429/network) |
| `verify_vad_production.js` | **5/5 PASS** — Live connected, transcription, 1 `generateAnswer`, Groq reached, no fallback |
| `node --check src/utils/gemini.js` | OK |

---

## Confirmation: VAD Configuration Unchanged

`git diff src/utils/gemini.js` contains **no change** to the Live session config. The block
is byte-identical to Phase 3B-3:

```js
realtimeInputConfig: {
    automaticActivityDetection: {
        disabled: false,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        silenceDurationMs: 1500,
    },
},
```

`END_SENSITIVITY_LOW` and `silenceDurationMs: 1500` are preserved. No speculative VAD
tuning was applied (brief item 10).

## Confirmation: Groq Primary / Fallback Behavior Unchanged

- `sendToGroq` — untouched. Model selection still `getModelForToday()` → `openai/gpt-oss-120b`; the 10 s `AbortSignal.timeout` is unchanged.
- `sendToGemma` — untouched; `thinkingConfig: { thinkingBudget: 0 }` (Phase 3B-2) intact.
- Fallback trigger path in `executeGenerateAnswer` — untouched.
- Confirmed by the passing fallback audit (Groq 500/404/429/network → Gemini) and timeout suite (10,013 ms abort → fallback, FIFO released).

---

## Latency Impact

| Input class | Added latency | Measured |
| :--- | :---: | :--- |
| Complete questions (any length) | **0 ms** | first Groq call 2–3 ms after commit |
| Long/normal queries | **0 ms** | 2 ms |
| Suspicious fragments, continuation within 500 ms | **0 ms** (1 call instead of 2) | stitched, 1 call |
| Suspicious fragments, no continuation | **+500 ms** | 503–518 ms to first call |

The guard adds latency only to the class of input it is designed to suppress, and only
when suppression does not materialise.

---

## Remaining Risks

### 1. The 500 ms window is shorter than the VAD commit floor — the stitching path is likely unreachable for genuine VAD-induced splits

This is the most important finding of this implementation.

A turn is only committed prematurely because the server saw enough silence to end the
turn — with `silenceDurationMs: 1500` that is **≥ 1500 ms of silence**. So at the moment a
fragment is committed, the speaker has already been quiet for ≥ 1.5 s. For the continuation
to reach us, the speaker must resume *and* finish the continuation, after which the server
must again see ≥ 1500 ms of silence before the next `generationComplete`.

The floor for the fragment→continuation commit gap is therefore roughly
`1500 ms + (duration of the continuation speech)`, not 500 ms.

The real incident in `PHASE_3B_4A_PREMATURE_DISPATCH_INVESTIGATION.md` confirms this — its
own timeline has the fragment committed at `t = +8.8 s` and the continuation committed at
`t = +11.8 s`, a **3,000 ms** gap, six times the grace window.

Consequence: in that incident's shape the guard holds `"question"` for 500 ms and then
dispatches it anyway. The wasted Groq call and the FIFO occupation still occur — only
500 ms later. The stitching half of the guard is exercised by Test C (a synthetic 300 ms
continuation) but is **not demonstrated to fire under real VAD timing**.

The guard is still strictly an improvement — it never delays a complete question, it
cancels a fragment dispatch whenever a continuation *does* arrive inside the window, and
it removes the fragment's queue occupation from the pre-commit instant. But it should not
be reported as having resolved the Phase 3B-4 incident. **A window derived from the VAD
floor (e.g. ≥ 1500 ms) is the change that would actually exercise the stitch path**, and
that is a tuning decision for the next phase, not something to slip in here.

### 2. Preemptible FIFO decision

**Not implemented, and not required for the guard's correctness.**

The brief permits it only "if the existing architecture makes it necessary for
correctness". It does not: the guard is self-consistent, never drops input, never
double-dispatches, and leaves FIFO semantics intact. Test C proves exactly one
`generateAnswer()` per combined utterance, and Test A proves a held fragment is still
answered if nothing follows.

What the FIFO change would address is *effectiveness*, not correctness — per risk 1, the
fragment is still dispatched in the real-world timing, so `"question"` can still occupy
the queue ahead of the real question. Aborting an in-flight fragment generation when a
complete question arrives would neutralise that residue.

Per the brief this is reported rather than implemented. Recommendation: decide between
(a) widening the grace window toward the 1500 ms VAD floor, (b) preemptible FIFO, or
(c) both, as an explicitly scoped next phase.

### 3. Re-hold can extend the window for chained fragments

If a stitched result is itself still suspicious (e.g. `"um"` + `"okay"`), it is re-held
for another 500 ms. This matches the accepted design and terminates as soon as the
accumulated text clears the threshold, but a speaker emitting a long chain of sub-threshold
fragments would see repeated 500 ms extensions. Not observed in testing.

### 4. Server-side VAD variance dominates total latency

The VAD verification run measured **5,332 ms** speech-end → first UI chunk (previous runs
of the same probe: 2,094 ms and 2,262 ms). That transcript was 362 characters — **not
suspicious, so the guard contributed 0 ms**. This is upstream server-side turn
finalization variance, consistent with the 1.8–4.5 s range documented in
`PHASE_3B_4_REAL_LATENCY_INVESTIGATION_REPORT.md`. It is recorded here so the number is
not misattributed to this change.

### 5. Threshold is a heuristic

The classifier whitelists `?` and seven imperative verbs. A fragment that happens to end in
`?` (e.g. a mis-transcribed `"question?"`) is treated as complete. The 14-input benchmark
shows 0/0, but real transcripts are unbounded; the benchmark is not a proof of general
accuracy.

### 6. Test surface widened

Three guard internals are now exported from `src/utils/gemini.js`. This mirrors existing
test exports in the file but does enlarge the public surface of the module.

---

## Confirmation

- VAD configuration unchanged (`END_SENSITIVITY_LOW`, `silenceDurationMs: 1500`).
- Groq model selection and Gemini fallback unchanged.
- FIFO behavior unchanged.
- No speculative VAD changes; change isolated to premature-fragment dispatch.
- **Not committed.**
