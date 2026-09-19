# MeetPilot AI — Coding Context

## 1. Product Goal

MeetPilot is a real-time AI meeting/interview assistant.

Primary priorities:
1. Very low latency
2. Natural, human-like answers
3. Strong follow-up/context understanding

Do not optimize for unnecessarily long or overly technical answers.

---

## 2. Current Architecture

- Electron desktop application
- Node.js main process
- LitElement renderer
- Gemini Live → speech/transcription
- Groq → primary answer generation
- Gemini HTTP → fallback answer generation
- Screenshots → Gemini vision
- FIFO generation queue
- Telemetry already implemented

Runtime answer path:

User question
→ Groq
→ if Groq fails
→ Gemini HTTP fallback
→ UI

There is NO runtime Groq model rotation.

---

## 3. Completed Work

### Phase 1 — API Usage Fixes
Completed:
- Gemini Live audio generation eliminated
- Screenshot resizing/locking
- Typed text removed from Gemini Live path
- Fallback history duplication fixed
- Generation concurrency protected

### Phase 3A — Reliability
Completed:
- Groq → Gemini direct fallback verified
- Groq 10-second timeout added
- Obsolete Kimi configuration removed

### Phase 3B-1 — Renderer Latency
Completed:
- Removed wrapWordsInSpans() from hot streaming path
- Preserved Markdown + DOMPurify
- Added requestAnimationFrame render coalescing
- Preserved immediate first-token rendering
- Added cleanup

Measured result:
- Renderer renders: 72 → 19
- Groq TTFT: 713ms → 525ms
- UI first render: 719ms → 527ms
- Total response: 883ms → 688ms
- Tests: 16 passed, 0 failed

---

## 4. Current Latency Findings

Major remaining bottlenecks:

1. Gemini Live waits for generationComplete
   ~1–2 seconds

2. Gemini fallback reasoning
   ~3.2 seconds TTFT in previous benchmark

3. Groq server queue
   ~324ms in latest benchmark

4. FIFO queue can delay rapid follow-up questions

---

## 5. Current Phase

We are continuing Priority 1 latency optimization.

Next work must be performed ONE change at a time.

Process:

INSPECT
→ IMPLEMENT
→ TEST
→ BENCHMARK
→ COMPARE
→ CHECKPOINT

Do not perform broad refactors.

---

## 6. Important Constraints

Do not change unrelated systems.

Preserve:
- security architecture
- telemetry
- Groq → Gemini fallback
- conversation history
- FIFO/concurrency protection
- streaming
- UI behavior
- screenshot functionality

Before changing architecture, measure it.

---

## 7. Coding-Agent Rules

Before modifying code:
1. Inspect relevant implementation.
2. Explain the current behavior.
3. Identify the exact bottleneck.
4. Propose the smallest change.

After modifying:
1. Run tests.
2. Run build/typecheck where available.
3. Run the relevant latency benchmark.
4. Report BEFORE vs AFTER.
5. Do not claim improvement without measurements.

Never make unrelated changes.

Do not rewrite working architecture without evidence.

---

## 8. Current Objective

Continue improving MeetPilot's latency while preserving:

FAST + NATURAL + CONTEXT-AWARE

The next task will be provided separately by the user.