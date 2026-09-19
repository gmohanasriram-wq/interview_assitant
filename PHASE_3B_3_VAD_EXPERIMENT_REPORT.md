# Phase 3B-3 — Controlled Gemini Live VAD Experiment Report

A controlled 15-trial empirical experiment was conducted to evaluate the Gemini Live premature `generationComplete` defect across three configurations using `diag_speech_long.wav` (23.32s speech utterance + 5.0s trailing silence, containing a 361-character interview response with an 800ms natural intra-utterance pause).

---

## Results

### Complete 15-Trial Experimental Dataset

| Configuration | Trial | Speech End (ms) | First VoiceActivity (ms) | Chunks | First Transcript (ms) | Last Transcript (ms) | GenComplete Count | GenComplete Time(s) (ms) | TurnComplete | Interrupted? | Premature (< Speech End)? | Latency Post-Speech (ms) | Final Chars / 361 | Final Question Captured? |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Baseline** | 1 | 25,708 | 337 | 2 | 20,985 | 26,258 | 1 | 28,769 | 1 (21,867ms) | 1 (21,854ms) | **NO** | +3,061 | 346 | **YES** |
| **Baseline** | 2 | 25,572 | 319 | 2 | 20,909 | 26,021 | 1 | 30,417 | 1 (21,727ms) | 1 (21,719ms) | **NO** | +4,845 | 346 | **YES** |
| **Baseline** | 3 | 25,621 | 341 | 2 | 20,944 | 26,110 | 1 | 28,567 | 1 (21,862ms) | 1 (21,855ms) | **NO** | +2,946 | 346 | **YES** |
| **Baseline** | 4 | 25,692 | 338 | 2 | 20,980 | 26,261 | 1 | 27,467 | 1 (32,472ms) | 1 (21,854ms) | **NO** | +1,775 | 346 | **YES** |
| **Baseline** | 5 | 25,626 | 328 | 2 | 20,879 | 26,086 | **2** | **20,881**, 26,087 | 2 (20,882, 26,087ms) | 0 | **YES (-4,745ms)** | **-4,745** | 346 | **YES** (Split) |
| **Candidate A** | 1 | 25,641 | 448 | 1 | 26,749 | 26,749 | 1 | 30,158 | 0 | 0 | **NO** | +4,517 | 362 | **YES** |
| **Candidate A** | 2 | 25,652 | 342 | 1 | 26,711 | 26,711 | 1 | 28,392 | 0 | 0 | **NO** | +2,740 | 362 | **YES** |
| **Candidate A** | 3 | 25,662 | 339 | 1 | 26,728 | 26,728 | 1 | 26,728 | 0 | 0 | **NO** | +1,066 | 362 | **YES** |
| **Candidate A** | 4 | 25,673 | 439 | 1 | 26,688 | 26,688 | 1 | 26,688 | 0 | 0 | **NO** | +1,015 | 362 | **YES** |
| **Candidate A** | 5 | 25,645 | 345 | 1 | 26,732 | 26,732 | 1 | 28,276 | 0 | 0 | **NO** | +2,631 | 362 | **YES** |
| **Candidate B** | 1 | 25,651 | 449 | 1 | 26,740 | 26,740 | 1 | 27,500 | 0 | 0 | **NO** | +1,849 | 362 | **YES** |
| **Candidate B** | 2 | 25,671 | 338 | 1 | 26,739 | 26,739 | 1 | 29,477 | 0 | 0 | **NO** | +3,806 | 362 | **YES** |
| **Candidate B** | 3 | 25,649 | 341 | 1 | 26,722 | 26,722 | 1 | 29,995 | 0 | 0 | **NO** | +4,346 | 362 | **YES** |
| **Candidate B** | 4 | 25,646 | 345 | 1 | 27,367 | 27,367 | 1 | 30,307 | 0 | 0 | **NO** | +4,661 | 362 | **YES** |
| **Candidate B** | 5 | 25,714 | 345 | 1 | 27,264 | 27,264 | 1 | 32,235 | 0 | 0 | **NO** | +6,521 | 362 | **YES** |

---

## Baseline

- **Configuration:** Unconfigured default server-side automatic activity detection.
- **Premature `generationComplete`:** Occurred in **1 of 5 trials (20.0%)**. In Trial 5, `generationComplete` fired at `t = 20,881 ms`, which was **4,745 ms before speech input finished**. Audio was actively streaming when the server prematurely concluded the turn, triggering a second `generationComplete` at `t = 26,087 ms`.
- **Interruption & Fragmentation:** In **4 of 5 trials (80.0%)**, the model issued an `interrupted: true` event and `turnComplete` at `t ≈ 21.8 s` triggered by the speaker's ~800ms natural intra-utterance pause. Consequently, the transcript was fractured into **2 separate chunks in 100% of Baseline trials** (the initial clause, followed ~5.2 seconds later by the final question fragment).
- **Transcript Quality:** Average length `346.0 chars` (several words dropped at the boundary where the turn fragmented).
- **Average Post-Speech Latency:** `3,157 ms` (excluding premature Trial 5).

---

## Candidate A

- **Configuration:** `endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW`, `silenceDurationMs: 1500`.
- **Premature `generationComplete`:** **0 of 5 trials (0.0%)**. In 100% of runs, `generationComplete` occurred strictly after the speaker finished talking.
- **Interruption & Fragmentation:** **0 interruptions (0/5)** and **0 premature turnCompletes (0/5)**. The 800ms natural pause was correctly tolerated as intra-turn speech.
- **Transcript Quality:** Clean, unified, single-chunk delivery in 100% of trials with **100.0% capture of the final question** and complete fidelity (`362.0 chars` vs 361 ground truth).
- **Average Post-Speech Latency:** **`2,394 ms`** (ranging between `1,015 ms` and `4,517 ms`).

---

## Candidate B

- **Configuration:** `endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW`, `silenceDurationMs: 2000`.
- **Premature `generationComplete`:** **0 of 5 trials (0.0%)**. Zero premature completions.
- **Interruption & Fragmentation:** **0 interruptions (0/5)** and **0 premature turnCompletes (0/5)**. 100% unified transcript across all trials.
- **Transcript Quality:** Identical perfect fidelity (`362.0 chars`), preserving the entire utterance and final question.
- **Average Post-Speech Latency:** **`4,237 ms`** (ranging between `1,849 ms` and `6,521 ms`). This adds an average of **+1,843 ms** of unnecessary waiting latency compared to Candidate A.

---

## Comparison

| Metric | Baseline | Candidate A (`LOW`, `1500ms`) | Candidate B (`LOW`, `2000ms`) |
| :--- | :---: | :---: | :---: |
| **Premature `generationComplete` Rate** | **20.0%** (1/5) | **0.0%** (0/5) | **0.0%** (0/5) |
| **Interrupted Turns Rate** | **80.0%** (4/5) | **0.0%** (0/5) | **0.0%** (0/5) |
| **Multiple `generationComplete` Rate** | **20.0%** (1/5) | **0.0%** (0/5) | **0.0%** (0/5) |
| **Transcript Fragmentation (Split Chunks)** | **100.0%** (5/5) | **0.0%** (0/5) | **0.0%** (0/5) |
| **Final Question Captured** | 100% (fragmented) | 100% (intact) | 100% (intact) |
| **Average Post-Speech Latency** | `3,157 ms` | **`2,394 ms`** | `4,237 ms` |

Candidate A and Candidate B both completely eliminate premature turn cuts and turn interruptions. However, Candidate A is **~1.84 seconds faster** to finalize the turn than Candidate B.

---

## Recommendation

**Adopt Candidate A (`endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW`, `silenceDurationMs: 1500`)**.

Empirical rationale:
1. Candidate A achieves **100% stability** against premature `generationComplete` across all 5 runs.
2. It completely resolves the 800ms natural clause pause issue, preventing turn fragmentation and transcript loss.
3. It achieves an average post-speech latency of **`2,394 ms`**, which is **1,843 ms faster than Candidate B** while maintaining identical 100% correctness.

---

## Early-Dispatch Decision

**Early transcript dispatch remains strictly blocked.**

- **Rationale:** Under the default VAD (Baseline), early transcript dispatch would have dispatched incomplete clauses prematurely, missing the core interview question. Even under candidate VAD settings, the full unified transcript text arrives in close temporal proximity to `generationComplete` (or concurrently).
- Before early dispatch can even be reconsidered, the VAD configuration must first be stabilized and verified in production to ensure the transcript stream cannot fracture mid-speech.

---

## Files Created / Associated

- `PHASE_3B_3_VAD_EXPERIMENT_REPORT.md` — Complete markdown report document for project agents and audit history.
- `test_vad_experiment.js` — Diagnostic test harness executing the 15 controlled trials with exact audio frame pacing and timestamp collection.
- `vad_experiment_results.json` — Complete raw telemetry, timestamps, event timelines, and summary metrics for all 15 trials.
- `probe_candidate_acceptance.js` — Verification probe ensuring the Live API schema accepts `automaticActivityDetection` configuration.
- `probe_live_turn_timing.js` / `probe_live_turn_timing_results.json` — Turn timing probe script and empirical results.
- `diag_speech_long.wav` — Standardized 23.32s synthetic interview speech audio test asset.

---

## Production Modifications

**None.**
- `src/utils/gemini.js` remains **untouched** (`git diff src/utils/gemini.js` confirmed empty).
- No production files, Groq logic, FIFO queue, renderer, or telemetry were modified.

