# Phase 3B-4B — Preemptible Fragment Generation: Implementation & Acceptance Report

## Executive Summary

Phase 3B-4B implements client-side **preemptible generation** for premature short fragments in MeetPilot AI.

In Phase 3B-4A, a two-tier defense was identified to resolve the premature partial transcript dispatch problem (where Gemini Live finalized an intra-turn natural hesitation such as `"question"`, dispatching it to Groq and blocking the actual question behind a ~1.2s FIFO lock). Phase 3B-4A implemented Tier 1 (a 500ms grace hold and stitching window). Phase 3B-4B implements Tier 2: when a short fragment's grace window has expired and Groq generation is actively in flight, arrival of the user's complete question immediately aborts the in-flight fragment request via `AbortController`, rolls back history, releases the FIFO lock in **< 5ms**, suppresses Gemini fallback, and begins generating the complete question with zero queue delay.

Crucially:
- **Only fragment-originated generations are preemptible.**
- **Normal legitimate questions can never be preempted** by subsequent questions.
- **Gemini Live VAD settings are kept strictly unchanged** (`END_SENSITIVITY_LOW`, `silenceDurationMs: 1500`).
- **All 6 regression and acceptance test suites pass (100%).**

---

## 1. Investigation of Architecture & Code Path

Prior to code modification, the 9 architectural points required by the brief were investigated:

1. **How fetch/stream cancellation works:**
   Groq requests are initiated with standard Node.js/Electron `fetch()` with streaming SSE parsing via `response.body.getReader()`.
2. **Whether AbortController can safely cancel an in-flight Groq request:**
   Yes. Calling `abortController.abort(reason)` aborts both in-flight HTTP connections and active `reader.read()` stream loops immediately, closing the underlying socket without leaking memory.
3. **How cancellation is classified by telemetry/error handling:**
   A dedicated `isPreemptionError(err, signal)` classifier distinguishes client preemption from true Groq failures (HTTP errors, network drops, timeouts). Preemptions are logged and recorded in telemetry, but suppressed from displaying false `Groq error: ...` alerts to the renderer UI.
4. **How cancellation interacts with Groq → Gemini fallback:**
   In `executeGenerateAnswer()`, an unhandled Groq failure normally triggers `sendToGemma(prompt)`. With preemption, `executeGenerateAnswer` explicitly detects `isPreemptionError` and returns immediately, preventing accidental fallback to Gemini for useless fragments.
5. **How cancellation interacts with the FIFO promise chain:**
   Generations are sequenced via `generateAnswerQueue` chained onto `taskPromise.catch(() => {})`. When an in-flight fragment aborts, its `executeGenerateAnswer()` finishes and resolves `taskResolve()`, immediately unblocking `await previousQueue.catch(() => {})` for the waiting question in **< 5ms**.
6. **How history is updated before/after generation:**
   `groqConversationHistory` previously pushed the user turn before `fetch()`. On preemption, `sendToGroq()` pops the preempted user prompt from `groqConversationHistory`. `saveConversationTurn()` is only called on successful completion, so the fragment never reaches persistent conversation history or IndexedDB.
7. **Whether an aborted fragment can accidentally trigger Gemini fallback:**
   Guarded. `executeGenerateAnswer()` intercepts `isPreemptionError` before the `catch` block can reach `sendToGemma(prompt)`.
8. **Whether an aborted fragment releases the FIFO correctly:**
   Yes. `executeGenerateAnswer` exits cleanly, its promise resolves, and the waiting task immediately takes the lock.
9. **Whether the legitimate question can start immediately:**
   Yes. Preemption occurs at the start of `generateAnswer()`. Within 4ms of the complete question arriving, the fragment is aborted and the legitimate question begins its Groq request.

---

## 2. Files Changed

| File | Change | Description |
| :--- | :---: | :--- |
| `src/utils/gemini.js` | **+76 / −7** | Production implementation of preemptible fragment generation |
| `test_preemptible_fragment.js` | **New (+270 lines)** | Acceptance test suite verifying requirements A through I |
| `preemptible_fragment_test_results.json` | **New** | Test execution results artifact |

No other production files were modified.

---

## 3. Exact Implementation Details

### A. Preemption Controller & Classifier State (`src/utils/gemini.js`)

```javascript
// Phase 3B-4B: Preemptible fragment generation
let inFlightFragmentController = null;

class PreemptionError extends Error {
    constructor(reason = 'Preempted by incoming query') {
        super(reason);
        this.name = 'PreemptionError';
        this.isPreemption = true;
    }
}

function isPreemptionError(err, signal) {
    if (!err && !signal) return false;
    if (signal && signal.aborted) {
        if (signal.reason?.isPreemption || signal.reason?.name === 'PreemptionError') {
            return true;
        }
    }
    if (err) {
        if (err.isPreemption || err.name === 'PreemptionError') return true;
        if (err.cause?.isPreemption || err.cause?.name === 'PreemptionError') return true;
        if (signal?.aborted && (signal.reason?.isPreemption || signal.reason?.name === 'PreemptionError')) return true;
    }
    return false;
}

function preemptInFlightFragment(reasonText = 'Preempted by incoming query') {
    if (inFlightFragmentController) {
        console.log(`[Preemption] Aborting in-flight fragment generation: ${reasonText}`);
        const controller = inFlightFragmentController;
        inFlightFragmentController = null;
        controller.abort(new PreemptionError(reasonText));
        return true;
    }
    return false;
}
```

### B. Selective Preemptibility in `executeGenerateAnswer`

```javascript
async function executeGenerateAnswer(prompt, options = {}) {
    const isFragment = options.isFragment !== undefined
        ? Boolean(options.isFragment)
        : isSuspiciousFragment(prompt);

    let fragmentController = null;
    if (isFragment) {
        fragmentController = new AbortController();
        inFlightFragmentController = fragmentController;
        console.log(`[Preemption] Registered in-flight fragment controller for: "${prompt}"`);
    }
    ...
    try {
        try {
            await sendToGroq(prompt, fragmentController ? fragmentController.signal : null);
            getTelemetry().onGenerateAnswerEnd(genContext, true);
            return;
        } catch (groqError) {
            if (isPreemptionError(groqError, fragmentController?.signal)) {
                console.log(`[Preemption] Fragment generation aborted for prompt: "${prompt}". Skipping fallback.`);
                getTelemetry().onGenerateAnswerEnd(genContext, false, groqError);
                return;
            }
            // Fallback to Gemini only for real errors (404, 429, 500, network, timeout)
            ...
        }
    } finally {
        if (inFlightFragmentController === fragmentController) {
            inFlightFragmentController = null;
        }
    }
}
```

### C. Preemption Trigger at FIFO Entry in `generateAnswer`

```javascript
async function generateAnswer(prompt, options = {}) {
    if (!prompt || prompt.trim() === '') return;

    // Preempt any in-flight fragment generation before waiting on the FIFO queue
    preemptInFlightFragment(`Preempted by incoming prompt: "${prompt.substring(0, 30)}..."`);

    const previousQueue = generateAnswerQueue;
    ...
    await previousQueue.catch(() => { });

    try {
        const result = await executeGenerateAnswer(prompt, options);
        taskResolve(result);
        return result;
    } catch (err) {
        taskReject(err);
        throw err;
    }
}
```

### D. Signal Composition and History Rollback in `sendToGroq`

```javascript
async function sendToGroq(transcription, customSignal = null) {
    ...
    const signals = [AbortSignal.timeout(10000)];
    if (customSignal) {
        signals.push(customSignal);
    }
    const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    const response = await fetch(..., { signal: combinedSignal });
    ...
    } catch (error) {
        if (isPreemptionError(error, customSignal)) {
            console.log(`[Preemption] Groq generation aborted (${modelToUse}) for fragment: "${transcription}"`);
            if (groqConversationHistory.length > 0 &&
                groqConversationHistory[groqConversationHistory.length - 1].role === 'user' &&
                groqConversationHistory[groqConversationHistory.length - 1].content === transcription.trim()) {
                groqConversationHistory.pop();
                console.log('[Preemption] Rolled back aborted fragment from groqConversationHistory');
            }
            getTelemetry().onGroqEnd(groqReqId, false, error, 0);
            throw error;
        }

        getTelemetry().onGroqEnd(groqReqId, false, error, 0);
        console.error('Error calling Groq API:', error);
        sendToRenderer('update-status', 'Groq error: ' + error.message);
        throw error;
    }
}
```

---

## 4. Measured Timing: Before vs After

| Metric | Before (Phase 3B-4 Incident) | After (Phase 3B-4B Preemptible) | Improvement |
| :--- | :---: | :---: | :---: |
| **FIFO queue wait for legitimate question** | **1,174 ms** (blocked behind fragment) | **4 ms** (instant release) | **-1,170 ms (-99.6%)** |
| **Useless Groq generation tokens** | 220 tokens consumed for `"question"` | Aborted on arrival of real question | Significant token savings |
| **Gemini fallback on fragment failure** | Not triggered (fragment completed) | **0 calls** (explicitly suppressed) | Preserved |
| **Complete question start latency** | t = +12.002s (waited for Groq #1) | **t = +0.004s** after arrival | Instant execution |
| **Legitimate questions sequencing** | Normal FIFO wait | Normal FIFO wait (512ms observed) | 100% Preserved |

---

## 5. Acceptance Test Results (`test_preemptible_fragment.js`)

All 15 assertions passed:

| ID | Test Requirement | Measured Result | Status |
| :--- | :--- | :--- | :---: |
| **A** | Start generation from suspicious fragment | Fragment registered; Groq call initiated | **PASS** |
| **B** | Complete question arrives while fragment in flight | Question invoked; preemption triggered | **PASS** |
| **C** | Fragment generation is aborted | `aborted = true`, abort delay = 0 ms | **PASS** |
| **D** | Fragment does NOT fall through to Gemini fallback | `geminiFallbackCalls = 0` | **PASS** |
| **E** | FIFO released immediately (< 50ms) | `fifoReleaseDelay = 4ms` | **PASS** |
| **F** | Question starts without waiting for original generation | `totalSettledDuration = 97ms` (vs > 2500ms) | **PASS** |
| **G** | Exactly one final answer produced for complete question | `historyTurns.length = 1` | **PASS** |
| **H** | History contains legitimate question correctly | Full question and answer saved; no fragment | **PASS** |
| **I.1**| Normal generation has no preemption controller | `inFlightFragmentController = null` | **PASS** |
| **I.2**| Normal generation NOT aborted by subsequent question | `pythonAborted = false`, `completed = true` | **PASS** |
| **I.3**| Second question correctly queued in FIFO behind normal Q | `javaDelay = 477ms` (waited for Python) | **PASS** |
| **I.4**| History contains both legitimate questions | Both turns saved in FIFO order | **PASS** |
| **E2E.1**| Fragment dispatched after 500ms grace expiry | Fragment dispatched at t = 550ms | **PASS** |
| **E2E.2**| Fragment aborted when real question arrives | In-flight fragment aborted | **PASS** |
| **E2E.3**| Final history contains only complete question | Exactly 1 turn saved | **PASS** |

---

## 6. Full Regression Suite Results

All five pre-existing regression test suites were executed against the modified codebase:

| Test Suite | Command | Result |
| :--- | :--- | :---: |
| **1. Quota Model Selection** | `node test_quota_model_selection.js` | **18/18 PASS** |
| **2. Fallback Audit** | `npx electron test_fallback_audit.js` | **5/5 PASS** (4 HTTP/network + 1 timeout) |
| **3. Timeout Fallback** | `npx electron test_timeout_fallback.js` | **5/5 PASS** (10s abort, 404, 429, network) |
| **4. Short-Fragment Acceptance** | `npx electron test_short_fragment_guard.js` | **21/21 PASS** (14 benchmark + A-F) |
| **5. VAD Production Verification** | `npx electron verify_vad_production.js` | **5/5 PASS** (Live session, Groq 120b) |
| **6. Preemptible Acceptance** | `npx electron test_preemptible_fragment.js` | **15/15 PASS** (Requirements A-I) |

Total checks across all suites: **69 passed, 0 failed.**

---

## 7. Telemetry, Fallback, and FIFO Behaviors

- **Telemetry:**
  - When a fragment is aborted, `onGroqEnd(groqReqId, false, error, 0)` is recorded, and `onGenerateAnswerEnd(genContext, false, groqError)` is recorded.
  - Telemetry generation counts (`counts.generateAnswer`) remain strictly 1:1 with dispatches.
- **Fallback:**
  - Real Groq failures (HTTP 500, 404, 429, network failure, 10-second timeout) continue to trigger Gemini HTTP fallback (`sendToGemma()`) with zero regression.
  - Preemption errors explicitly bypass `sendToGemma()`.
- **FIFO:**
  - The sequential FIFO queue design is preserved intact.
  - In-flight fragment tasks yield their turn in < 5ms upon preemption, enabling immediate processing of the subsequent question.
  - Normal questions retain mutual exclusion and sequential execution.

---

## 8. Remaining Risks & Architectural Observations

1. **Partial Token Rendering if Stream Started:**
   If a fragment Groq request streams tokens to the UI before preemption occurs, the subsequent question's initial `new-response` event replaces the response text in `CheatingDaddyApp.js`. Because the fragment is aborted within ~4ms of question arrival, this window is brief.
2. **Push-to-Talk Interactions:**
   The preemption logic operates on `generateAnswer()`, which is agnostic to whether transcripts originated from Gemini Live or typed text. This provides consistent protection across all input modalities.
3. **VAD Settings Preserved:**
   VAD settings (`END_SENSITIVITY_LOW`, `silenceDurationMs: 1500`) remain untouched, ensuring acoustic sensitivity and transcription accuracy are fully preserved.

---

## 9. Git Status and Confirmation

- No Git commits were created.
- Only `src/utils/gemini.js` was modified in production code.
- All test artifacts and regression suites are cleanly documented.

