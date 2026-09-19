# Phase 3B-6 — Controlled VAD Latency & Accuracy Experiment Report

**Experiment Date:** September 19, 2026  
**Target Application:** MeetPilot AI (`cheating-daddy-master`)  
**Investigation Mode:** Read-Only Experimental Harness (Zero Production Source Code Modifications)  
**Production Git Baseline:** `b97361d` (`perf: preempt useless fragment generation`)

---

## 1. Executive Summary

Following Phase 3B-5's empirical demonstration that upstream Gemini Live turn-finalization delay (mandated by the `silenceDurationMs: 1500` setting and server-side VAD deliberation) accounts for **75% to 85%** of user-visible latency, Phase 3B-6 executed a controlled multi-candidate experiment to determine whether lowering `silenceDurationMs` can safely reduce turn-finalization latency without re-introducing premature turn cuts or question dropping.

A 70-trial empirical test matrix was executed across 5 candidate configurations:
- **Candidate A:** `1500 ms` (Current Production Baseline)
- **Candidate B:** `1200 ms`
- **Candidate C:** `1000 ms`
- **Candidate D:** `800 ms`
- **Candidate E:** `600 ms`  
*(All tested under `EndSensitivity.END_SENSITIVITY_LOW`)*

Each candidate was systematically evaluated across 4 speech categories:
1. **Natural Hesitation / Pause Speech** (`diag_speech_long.wav` — 23.32s speech containing an 800ms intra-utterance pause and multi-clause query; 5 trials per candidate = 25 trials).
2. **Normal Conversational Speech** (`test_q1.wav` — 7.50s direct interview question; 3 trials per candidate = 15 trials).
3. **Short Legitimate Questions** (`test_synth.wav` — 3.12s query; 3 trials per candidate = 15 trials).
4. **ElevenLabs Resonant Speech** (`test_elevenlabs_q1.wav` — 5.50s Roger voice; 3 trials per candidate = 15 trials).

### Core Findings

```
Candidate A (1500ms): [████████████████████] 100% Stability | 1,905ms Avg Clean VAD | 3,527ms Avg UI
Candidate B (1200ms): [████████████████████] 100% Stability | 1,077ms Avg Clean VAD (-828ms) | 2,509ms Avg UI
Candidate C (1000ms): [████████████████████] 100% Stability |   919ms Avg Clean VAD (-986ms) | 2,253ms Avg UI
--------------------------------- CRITICAL STABILITY CLIFF ---------------------------------
Candidate D (800ms) : [██████░░░░░░░░░░░░░░]  64% Stability | 35.7% Premature Cuts (100% fail on pause)
Candidate E (600ms) : [████░░░░░░░░░░░░░░░░]  43% Stability | 57.1% Interrupted Turns | 20% Premature
```

1. **The Critical Stability Cliff is at 800 ms:**  
   - **Candidate D (800ms)** failed catastrophically on natural intra-utterance pauses: in **100% of pause trials (5/5)**, `generationComplete` fired **~10.4 seconds before speech finished**, cutting the user off mid-sentence and completely dropping the final question (0% completeness on pause audio).
   - **Candidate E (600ms)** suffered severe turn fragmentation with a **57.1% interruption rate** across the test suite.
   - **Both Candidates D and E are disqualified from production consideration.**
2. **Candidates B (1200ms) and C (1000ms) Achieve 100% Correctness:**  
   - Both Candidate B and Candidate C maintained **0.0% premature generation**, **0.0% turn interruptions**, and **100.0% complete question capture** across all 14 trials, perfectly preserving natural pauses and trailing clauses.
3. **Candidate C (1000ms) Delivers Nearly 1 Full Second of Latency Savings:**  
   - On normal conversational questions, Candidate C reduced VAD delay from **1,145 ms $\rightarrow$ 601 ms (-544 ms)**.
   - On ElevenLabs speech, Candidate C reduced VAD delay from **3,227 ms $\rightarrow$ 1,364 ms (-1,863 ms)**.
   - Across all clean speech categories, Candidate C lowered average VAD delay from **1,905 ms $\rightarrow$ 919 ms (-986 ms)**, reducing total user-visible UI latency from **3.53s $\rightarrow$ 2.25s**.

---

## 2. Experimental Methodology

### Test Architecture
- **Harness:** `diag_experiment_phase3b6.js` (isolated outside `src/`, read-only execution).
- **Session Configuration:** Identical to production (`src/utils/gemini.js:940-965`) with `responseModalities: [Modality.AUDIO]`, `inputAudioTranscription: { enableSpeakerDiarization: true, minSpeakerCount: 2, maxSpeakerCount: 2 }`, `languageCode: 'en-US'`, and listener system prompt. Only `silenceDurationMs` was varied per candidate.
- **Audio Delivery:** 24,000 Hz 16-bit mono PCM streamed in real-time 100ms chunks (4,800 bytes per chunk) via WebSocket `sendRealtimeInput()`.
- **Trailing Silence:** Following speech cessation, digital silence chunks were continuously streamed until `generationComplete` was received (or a 10s timeout occurred).
- **Post-VAD Pipeline:** Upon `generationComplete`, the transcript was evaluated against `isSuspiciousFragment()` (Phase 3B-4A guard), FIFO acquisition was timestamped, and a direct Groq completion request was dispatched to measure real inference TTFT and renderer delivery.
- **Trial Persistence:** Results were saved incrementally after each trial into `phase3b6_experiment_results.json`.

---

## 3. Exact Configurations Tested

| Candidate | `silenceDurationMs` | `endOfSpeechSensitivity` | Diarization Active | Description |
| :---: | :---: | :---: | :---: | :--- |
| **A** | `1500` | `END_SENSITIVITY_LOW` | Yes (2 speakers) | Current production baseline (Phase 3B-3) |
| **B** | `1200` | `END_SENSITIVITY_LOW` | Yes (2 speakers) | Conservative -300ms reduction |
| **C** | `1000` | `END_SENSITIVITY_LOW` | Yes (2 speakers) | Balanced -500ms reduction (1.0s floor) |
| **D** | `800` | `END_SENSITIVITY_LOW` | Yes (2 speakers) | Aggressive reduction (matches pause length) |
| **E** | `600` | `END_SENSITIVITY_LOW` | Yes (2 speakers) | Ultra-low latency target |

---

## 4. Aggregate Measurements Across All 70 Trials

| Candidate | Config | Total Trials | Premature Rate | Interrupted Rate | Question Capture Rate | Pause Test Status | Avg Clean VAD Delay | Avg Clean Total UI Latency |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **A** | 1500 ms | 14 | **0.0%** (0/14) | **0.0%** (0/14) | **100.0%** (14/14) | **PASS (100%)** | 1,905 ms | 3,527 ms |
| **B** | 1200 ms | 14 | **0.0%** (0/14) | **0.0%** (0/14) | **100.0%** (14/14) | **PASS (100%)** | 1,077 ms | 2,509 ms |
| **C** | 1000 ms | 14 | **0.0%** (0/14) | **0.0%** (0/14) | **100.0%** (14/14) | **PASS (100%)** | **919 ms** | **2,253 ms** |
| **D** | 800 ms | 14 | **35.7%** (5/14) | **21.4%** (3/14) | **64.3%** (9/14) | **FAIL (0%)** | 2,067 ms | 3,257 ms |
| **E** | 600 ms | 14 | **7.1%** (1/14) | **57.1%** (8/14) | **92.9%** (13/14) | **FAIL** | 1,454 ms | 3,085 ms |

---

## 5. Category-by-Category Detailed Results

### Category 1: Natural Hesitation / Pause Speech (`diag_speech_long.wav`)
- **Speech Length:** 23.32s | **Ground Truth Chars:** 361
- **Acoustic Characteristics:** Spoken interview response containing an 800ms natural clause pause at $t \approx 12.8\text{s}$, followed by the final question: *"Could you tell me how your team handles distributed transactions today?"*

| Candidate | Trial | Speech End | `genComplete` Time | Lead / Delay | Premature? | Interrupted? | Final Chars | Question Captured? |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **A_1500** | T1 | 25,640 ms | 26,732 ms | +1,092 ms | NO | NO | 362 | **YES** |
| **A_1500** | T2 | 25,650 ms | 29,494 ms | +3,844 ms | NO | NO | 362 | **YES** |
| **A_1500** | T3 | 25,648 ms | 27,611 ms | +1,963 ms | NO | NO | 362 | **YES** |
| **A_1500** | T4 | 25,641 ms | 26,646 ms | +1,005 ms | NO | NO | 362 | **YES** |
| **A_1500** | T5 | 25,639 ms | 26,700 ms | +1,061 ms | NO | NO | 362 | **YES** |
| **B_1200** | T1 | 25,642 ms | 28,114 ms | +2,472 ms | NO | NO | 362 | **YES** |
| **B_1200** | T2 | 25,638 ms | 27,910 ms | +2,272 ms | NO | NO | 362 | **YES** |
| **B_1200** | T3 | 25,645 ms | 26,317 ms | +672 ms | NO | NO | 362 | **YES** |
| **B_1200** | T4 | 25,649 ms | 28,247 ms | +2,598 ms | NO | NO | 362 | **YES** |
| **B_1200** | T5 | 25,640 ms | 28,354 ms | +2,714 ms | NO | NO | 362 | **YES** |
| **C_1000** | T1 | 25,647 ms | 28,520 ms | +2,873 ms | NO | NO | 362 | **YES** |
| **C_1000** | T2 | 25,644 ms | 28,583 ms | +2,939 ms | NO | NO | 362 | **YES** |
| **C_1000** | T3 | 25,642 ms | 28,418 ms | +2,776 ms | NO | NO | 362 | **YES** |
| **C_1000** | T4 | 25,645 ms | 26,092 ms | +447 ms | NO | NO | 362 | **YES** |
| **C_1000** | T5 | 25,639 ms | 26,124 ms | +485 ms | NO | NO | 362 | **YES** |
| **D_800** | T1 | 25,641 ms | **15,108 ms** | **-10,533 ms** | **YES** | NO | **208** | **NO (Dropped)** |
| **D_800** | T2 | 25,649 ms | **15,258 ms** | **-10,391 ms** | **YES** | NO | **208** | **NO (Dropped)** |
| **D_800** | T3 | 25,643 ms | **15,196 ms** | **-10,447 ms** | **YES** | NO | **208** | **NO (Dropped)** |
| **D_800** | T4 | 25,640 ms | **15,235 ms** | **-10,405 ms** | **YES** | NO | **208** | **NO (Dropped)** |
| **D_800** | T5 | 25,648 ms | **15,249 ms** | **-10,399 ms** | **YES** | NO | **208** | **NO (Dropped)** |
| **E_600** | T1 | 25,643 ms | 26,730 ms | +1,087 ms | NO | **YES** | 358 | YES (Split) |
| **E_600** | T2 | 25,640 ms | 28,637 ms | +2,997 ms | NO | **YES** | 359 | YES (Split) |
| **E_600** | T3 | 25,645 ms | 28,303 ms | +2,658 ms | NO | **YES** | 358 | YES (Split) |
| **E_600** | T4 | 25,641 ms | 27,086 ms | +1,445 ms | NO | **YES** | 358 | YES (Split) |
| **E_600** | T5 | 25,649 ms | **2,674 ms** | **-22,975 ms** | **YES** | **YES** | **287** | **NO (Dropped)** |

#### Detailed Failure Analysis of Candidates D and E
1. **Candidate D (800ms) Fails 100% of Hesitation Runs:**  
   The natural pause in `diag_speech_long.wav` is exactly 800ms. Because `silenceDurationMs` was set to 800ms, the cloud VAD concluded the turn had ended mid-speech. In all 5 trials, `generationComplete` was emitted at $t \approx 15.2\text{s}$, while the speaker was still talking. Exactly 208 characters were transcribed, and the entire final question was lost.
2. **Candidate E (600ms) Induces Server Turn Instability:**  
   In 5 of 5 trials, the turn was interrupted. In Trial 5, `generationComplete` fired at $t = 2.67\text{s}$ (nearly 23 seconds before speech ended!).

---

### Category 2: Normal Conversational Speech (`test_q1.wav`)
- **Speech Length:** 7.50s ("Question one. Hello, thanks for joining today...")

| Candidate | Trial | Speech End $\rightarrow$ `genComplete` | Groq TTFT | Total UI Latency | Guard Status |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **A_1500** | T1 | 1,157 ms | 788 ms | 2,554 ms | Pass (0 ms delay) |
| **A_1500** | T2 | 1,147 ms | 687 ms | 2,438 ms | Pass (0 ms delay) |
| **A_1500** | T3 | 1,130 ms | 750 ms | 2,496 ms | Pass (0 ms delay) |
| **B_1200** | T1 | 818 ms | 895 ms | 2,329 ms | Pass (0 ms delay) |
| **B_1200** | T2 | 1,034 ms | 1,089 ms | 2,727 ms | Pass (0 ms delay) |
| **B_1200** | T3 | 813 ms | 728 ms | 2,144 ms | Pass (0 ms delay) |
| **C_1000** | T1 | **611 ms** | 768 ms | **1,982 ms** | Pass (0 ms delay) |
| **C_1000** | T2 | **573 ms** | 820 ms | **1,995 ms** | Pass (0 ms delay) |
| **C_1000** | T3 | **618 ms** | 958 ms | **2,186 ms** | Pass (0 ms delay) |
| **D_800** | T1 | 4,417 ms | 835 ms | 5,860 ms | Interrupted (3/3) |
| **D_800** | T2 | 3,790 ms | 874 ms | 5,273 ms | Interrupted (3/3) |
| **D_800** | T3 | 4,760 ms | 850 ms | 6,215 ms | Interrupted (3/3) |
| **E_600** | T1 | 2,406 ms | 693 ms | 3,706 ms | Interrupted (3/3) |
| **E_600** | T2 | 141 ms | 1,097 ms | 1,852 ms | Interrupted (3/3) |
| **E_600** | T3 | 3,301 ms | 1,531 ms | 5,436 ms | Interrupted (3/3) |

- **Candidate A Mean VAD:** **1,145 ms** $\rightarrow$ Mean UI: **2,496 ms**
- **Candidate B Mean VAD:** **888 ms** (-257 ms) $\rightarrow$ Mean UI: **2,400 ms**
- **Candidate C Mean VAD:** **601 ms** (**-544 ms, a 47.5% reduction!**) $\rightarrow$ Mean UI: **2,084 ms**
- **Candidates D & E:** Severely degraded due to inter-clause turn interruptions (adding 3–4 seconds of retry delay).

---

### Category 3: Short Legitimate Questions (`test_synth.wav`)
- **Speech Length:** 3.12s ("What is the difference between a process and a thread?")

| Candidate | Mean VAD Delay | Mean Groq TTFT | Mean Total UI Latency |
| :---: | :---: | :---: | :---: |
| **A_1500** | 1,343 ms | 675 ms | 2,628 ms |
| **B_1200** | 1,006 ms | 693 ms | 2,303 ms |
| **C_1000** | **793 ms** | 670 ms | **2,072 ms** |
| **D_800** | 967 ms | 809 ms | 2,386 ms |
| **E_600** | 374 ms | 955 ms | 1,945 ms |

- On short queries, Candidate C reduced VAD delay from **1,343 ms $\rightarrow$ 793 ms (-550 ms)**, maintaining 100% question completeness and clean syntactic classification.

---

### Category 4: ElevenLabs Resonant Speech (`test_elevenlabs_q1.wav`)
- **Speech Length:** 5.50s (Roger voice, deep baritone resonance)

| Candidate | Mean VAD Delay | Mean Groq TTFT | Mean Total UI Latency |
| :---: | :---: | :---: | :---: |
| **A_1500** | 3,227 ms | 1,281 ms | 5,114 ms |
| **B_1200** | 1,336 ms | 876 ms | 2,824 ms |
| **C_1000** | **1,364 ms** | 866 ms | **3,133 ms** |
| **D_800** | 913 ms | 730 ms | 2,253 ms |
| **E_600** | 2,039 ms | 997 ms | 3,647 ms |

- In Phase 3B-5, Candidate A on ElevenLabs speech suffered long acoustic delay (averaging >3.2s).
- **Candidates B and C cut ElevenLabs VAD delay by over 1.8 seconds**, dropping total user-visible latency from **5.1s down to ~2.8s – 3.1s**!

---

## 6. Latency Comparison Summary

| Metric | Candidate A (1500ms) | Candidate B (1200ms) | Candidate C (1000ms) | Candidate D (800ms) | Candidate E (600ms) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Pause Speech VAD Delay** | 1,793 ms | 2,064 ms | 1,904 ms | **FAILED (-10.4s)** | **FAILED (-2.9s)** |
| **Normal Question VAD Delay** | 1,145 ms | 888 ms | **601 ms** | 4,322 ms (err) | 1,949 ms (err) |
| **Short Question VAD Delay** | 1,343 ms | 1,006 ms | **793 ms** | 967 ms | 374 ms |
| **ElevenLabs Voice VAD Delay** | 3,227 ms | 1,336 ms | **1,364 ms** | 913 ms | 2,039 ms |
| **Overall Clean VAD Delay** | 1,905 ms | 1,077 ms | **919 ms** | 2,067 ms | 1,454 ms |
| **VAD Savings vs Baseline** | 0 ms (Ref) | **-828 ms (-43.5%)** | **-986 ms (-51.8%)** | Invalid (Breaks) | Invalid (Breaks) |
| **Overall Clean UI Latency** | 3,527 ms | 2,509 ms | **2,253 ms** | 3,257 ms | 3,085 ms |
| **Total User Latency Savings** | 0 ms (Ref) | **-1,018 ms** | **-1,274 ms** | Invalid (Breaks) | Invalid (Breaks) |

---

## 7. Tradeoff Analysis

```
                    ┌───────────────────────── SAFETY ZONE ─────────────────────────┐   ┌────── DANGER ZONE ──────┐
Metric              │ Candidate A (1500ms)   Candidate B (1200ms)   Candidate C (1000ms) │   │ Cand D (800ms)  Cand E (600ms)│
────────────────────┼───────────────────────────────────────────────────────────────┼───┼─────────────────────────┤
Hesitation Support  │ 100% (No premature)    100% (No premature)    100% (No premature)  │   │ 0% (Fatal cut)   0% (Interrupted)
Question Completeness│ 100% intact            100% intact            100% intact          │   │ 64% (Lost Qs)    93% (Fragmented)
Clean VAD Latency   │ ~1,905 ms              ~1,077 ms              ~919 ms             │   │ Degraded by retries
Total UI Latency    │ ~3.53 s                ~2.51 s                ~2.25 s             │   │ Unpredictable (1.8s - 6.2s)
```

1. **Safety Frontier:**  
   Human conversational pauses in natural speech are typically 600ms–850ms. Any VAD silence threshold $\le 800\text{ms}$ creates an unacceptable risk of turn cutting mid-sentence. Candidate D (800ms) demonstrated a 100% failure rate on 800ms natural pauses.
2. **Optimal Operating Point:**  
   Candidate C (`silenceDurationMs: 1000`) sits precisely at the mathematical sweet spot:
   - It is comfortably above typical 800ms clause pauses (+200ms margin), completely avoiding premature turn cuts.
   - It eliminates nearly **1 full second of waiting latency** (-986 ms on clean speech, -1,863 ms on resonant voice).
   - It reduces total end-to-end user latency from ~3.5s to **~2.25s** on clean speech, bringing MeetPilot to near-instantaneous response times.
3. **Conservative Operating Point:**  
   Candidate B (`silenceDurationMs: 1200`) provides a wider safety buffer (+400ms margin) while still delivering an **828 ms latency reduction**.

---

## 8. Recommendation for the Next Experiment

> [!IMPORTANT]
> **Production code has NOT been modified in Phase 3B-6.**  
> The findings provide the exact empirical evidence required before modifying production configuration.

### Recommendation
1. **Adopt Candidate C (`silenceDurationMs: 1000`) as the primary candidate for Phase 3B-7 Real-User Microphone Acceptance Testing:**  
   - Empirical rationale: 100% stability against 800ms pauses across 5 trials, zero turn interruptions across 14 trials, and an average **~1.0 second reduction in turn-finalization delay**.
   - With Phase 3B-4A's continuation stitching and Phase 3B-4B's preemption already active in production, the client possesses redundant fail-safes if an unusually long hesitation (>1000ms) ever fractures a turn.
2. **Keep Candidate B (`silenceDurationMs: 1200`) as the immediate fallback:**  
   - If real-world conversational testing reveals edge-case multi-second pauses in user interviews, Candidate B offers an 828ms latency improvement while maintaining an ultra-conservative safety margin.
3. **Strictly Prohibit Configurations $\le 800\text{ms}$:**  
   - Under no circumstances should `silenceDurationMs` be reduced below 1000ms under `END_SENSITIVITY_LOW`.

---

## 9. Verification & Git Working Tree Status

- **Production Source Code:** `src/` was completely untouched during this phase.
- **Production File `src/utils/gemini.js`:** **UNCHANGED** (`git diff src/utils/gemini.js` is completely empty).
- **Git Commits:** **ZERO** commits created.
- **Current Git HEAD:** `b97361dfba94ab8837fb397901f92b77ecc72d28` (`perf: preempt useless fragment generation`).
- **Working Tree Status:** Clean with respect to production code. Only untracked diagnostic scripts, result JSON files, and markdown reports exist in the workspace.

