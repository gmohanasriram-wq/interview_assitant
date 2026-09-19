/**
 * Phase 3B-4B — Preemptible Fragment Generation Acceptance Tests
 *
 * Tests requirements A through I:
 * A. Start generation from suspicious fragment.
 * B. Start a complete question while fragment generation is in flight.
 * C. Verify fragment generation is aborted.
 * D. Verify fragment does NOT fall through to Gemini fallback.
 * E. Verify FIFO is released immediately (<50ms, not waiting for slow fragment).
 * F. Verify complete question starts without waiting for the original generation.
 * G. Verify exactly one final answer is produced for the complete question.
 * H. Verify history contains the legitimate question correctly.
 * I. Verify normal legitimate generation is NOT preemptible.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE npx electron test_preemptible_fragment.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    win.webContents.send = () => { }; // no renderer under test

    const gemini = require('./src/utils/gemini');
    const { getTelemetry } = require('./src/utils/telemetry');

    const results = {
        timestamp: new Date().toISOString(),
        tests: {},
        timings: {}
    };

    let totalFailed = 0;
    const check = (name, pass, detail) => {
        results.tests[name] = { pass, detail };
        if (!pass) totalFailed++;
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ---- Groq & Gemini stub -----------------------------------------------
    const groqCalls = [];
    let geminiFallbackCalls = 0;
    const originalFetch = global.fetch;

    const makeSseResponse = (text) => {
        const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
        const bytes = new TextEncoder().encode(payload);
        let sent = false;
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Map(),
            body: {
                getReader: () => ({
                    read: async () => {
                        if (sent) return { done: true, value: undefined };
                        sent = true;
                        return { done: false, value: bytes };
                    }
                })
            },
            text: async () => payload,
        };
    };

    // Replace fetch with mock
    global.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('api.groq.com')) {
            const body = JSON.parse(options.body);
            const userMsgs = body.messages.filter(m => m.role === 'user');
            const prompt = userMsgs[userMsgs.length - 1]?.content || '';

            const callRecord = {
                prompt,
                startTime: Date.now(),
                aborted: false,
                abortTime: null,
                signal: options.signal,
                completed: false,
            };
            groqCalls.push(callRecord);

            // Fragment generation: simulate slow response (2500ms) that will be preempted
            if (prompt === 'question' || prompt === 'um') {
                return new Promise((resolve, reject) => {
                    let timer = null;

                    const onAbort = () => {
                        callRecord.aborted = true;
                        callRecord.abortTime = Date.now();
                        if (timer) clearTimeout(timer);
                        const err = options.signal.reason || new Error('The operation was aborted');
                        err.name = err.name || 'AbortError';
                        reject(err);
                    };

                    if (options.signal?.aborted) {
                        onAbort();
                        return;
                    }

                    if (options.signal) {
                        options.signal.addEventListener('abort', onAbort, { once: true });
                    }

                    timer = setTimeout(() => {
                        callRecord.completed = true;
                        resolve(makeSseResponse('Response to fragment'));
                    }, 2500);
                });
            }

            // Normal or complete question: simulate standard response (30ms)
            if (prompt === 'What is Python?') {
                // Legitimate question with simulated 500ms duration to test non-preemptibility
                return new Promise((resolve, reject) => {
                    if (options.signal) {
                        options.signal.addEventListener('abort', () => {
                            callRecord.aborted = true;
                            callRecord.abortTime = Date.now();
                            reject(options.signal.reason || new Error('Aborted'));
                        }, { once: true });
                    }
                    setTimeout(() => {
                        callRecord.completed = true;
                        resolve(makeSseResponse('Python is a high-level programming language.'));
                    }, 500);
                });
            }

            // Default fast response (30ms)
            await sleep(30);
            callRecord.completed = true;
            return makeSseResponse(`Answer to: ${prompt}`);
        }

        // Intercept Gemini calls to track unexpected fallback
        if (typeof url === 'string' && (url.includes('generativelanguage.googleapis.com') || url.includes('googleapis.com'))) {
            geminiFallbackCalls++;
            return originalFetch(url, options);
        }

        return originalFetch(url, options);
    };

    const resetTestEnv = () => {
        gemini.resetFragmentGuard();
        gemini.initializeNewSession();
        groqCalls.length = 0;
        geminiFallbackCalls = 0;
    };

    try {
        console.log('\n============================================================');
        console.log('=== PHASE 3B-4B: PREEMPTIBLE FRAGMENT GENERATION TESTS   ===');
        console.log('============================================================\n');

        // ===================================================================
        // TEST SUITE 1: Requirements A-H (Preemption of Fragment by Question)
        // ===================================================================
        console.log('--- TEST SUITE 1: Preempting in-flight fragment generation ---');
        resetTestEnv();

        const tStart = Date.now();
        console.log('1. Starting suspicious fragment generation: "question"...');
        const fragmentPromise = gemini.generateAnswer('question'); // Req A

        // Wait 40ms to let the fragment task enter executeGenerateAnswer and fetch
        await sleep(40);

        const fragmentController = gemini.getInFlightFragmentController();
        const initialGroqCalls = groqCalls.length;
        console.log(`   Fragment controller active: ${Boolean(fragmentController)}, groqCalls: ${initialGroqCalls}`);

        const tQuestionArrival = Date.now();
        const completePrompt = 'Can you explain how database indexing works?';
        console.log('2. Incoming complete question arrives while fragment is in flight...');
        const questionPromise = gemini.generateAnswer(completePrompt); // Req B

        // Wait for both to settle
        await Promise.allSettled([fragmentPromise, questionPromise]);
        const tAllSettled = Date.now();

        // Check C: Fragment generation aborted
        const fragmentCall = groqCalls.find(c => c.prompt === 'question');
        const questionCall = groqCalls.find(c => c.prompt === completePrompt);

        check('A_fragment_generation_started', Boolean(fragmentCall), `fragmentCall present=${Boolean(fragmentCall)}`);
        check('B_complete_question_invoked', Boolean(questionCall), `questionCall present=${Boolean(questionCall)}`);
        check('C_fragment_generation_aborted', fragmentCall?.aborted === true,
            `aborted=${fragmentCall?.aborted}, abortDelay=${fragmentCall?.abortTime ? fragmentCall.abortTime - tQuestionArrival : -1}ms`);

        // Check D: No Gemini fallback for the aborted fragment
        check('D_no_gemini_fallback_for_fragment', geminiFallbackCalls === 0, `fallbackCalls=${geminiFallbackCalls}`);

        // Check E & F: FIFO released immediately and complete question started without waiting
        const fifoReleaseDelay = questionCall ? questionCall.startTime - tQuestionArrival : -1;
        results.timings.fifoReleaseDelayMs = fifoReleaseDelay;
        results.timings.totalSettledDurationMs = tAllSettled - tStart;
        console.log(`   FIFO release delay: ${fifoReleaseDelay}ms (threshold: < 50ms, baseline was ~1200ms)`);
        check('E_fifo_released_immediately', fifoReleaseDelay >= 0 && fifoReleaseDelay < 50,
            `fifoReleaseDelay=${fifoReleaseDelay}ms (< 50ms)`);
        check('F_question_started_without_waiting', fifoReleaseDelay < 100 && (tAllSettled - tStart) < 1500,
            `totalTime=${tAllSettled - tStart}ms (vs >2500ms if blocked)`);

        // Check G: Exactly one final answer produced
        const sessionData = gemini.getCurrentSessionData();
        const historyTurns = sessionData.history;
        check('G_exactly_one_final_answer_produced', historyTurns.length === 1,
            `historyTurns.length=${historyTurns.length}`);

        // Check H: History contains legitimate question correctly
        const lastTurn = historyTurns[0];
        check('H_history_contains_legitimate_question',
            lastTurn?.transcription === completePrompt &&
            lastTurn?.ai_response?.includes('Answer to: Can you explain how database indexing works?'),
            `transcription="${lastTurn?.transcription}"`);

        // ===================================================================
        // TEST SUITE 2: Requirement I (Normal Generation NOT Preemptible)
        // ===================================================================
        console.log('\n--- TEST SUITE 2: Verifying normal legitimate generation is NOT preemptible ---');
        resetTestEnv();

        console.log('1. Starting normal legitimate question: "What is Python?" (500ms duration)...');
        const normal1Promise = gemini.generateAnswer('What is Python?');

        await sleep(40);
        const normal1Controller = gemini.getInFlightFragmentController();
        console.log(`   In-flight fragment controller for normal question: ${normal1Controller} (must be null)`);

        check('I_normal_generation_has_no_preemption_controller', normal1Controller === null,
            `inFlightFragmentController=${normal1Controller}`);

        console.log('2. Starting second question: "What is Java?" while first is in flight...');
        const tSecondStart = Date.now();
        const normal2Promise = gemini.generateAnswer('What is Java?');

        await Promise.allSettled([normal1Promise, normal2Promise]);

        const pythonCall = groqCalls.find(c => c.prompt === 'What is Python?');
        const javaCall = groqCalls.find(c => c.prompt === 'What is Java?');

        check('I_normal_generation_not_aborted', pythonCall?.aborted === false && pythonCall?.completed === true,
            `pythonAborted=${pythonCall?.aborted}, pythonCompleted=${pythonCall?.completed}`);

        const javaDelay = javaCall ? javaCall.startTime - tSecondStart : -1;
        check('I_second_question_sequenced_in_fifo', javaCall?.completed === true && javaDelay >= 400,
            `javaDelay=${javaDelay}ms (waited for python generation)`);

        const sessionData2 = gemini.getCurrentSessionData();
        check('I_history_contains_both_legitimate_questions',
            sessionData2.history.length === 2 &&
            sessionData2.history[0].transcription === 'What is Python?' &&
            sessionData2.history[1].transcription === 'What is Java?',
            `historyLength=${sessionData2.history.length}`);

        // ===================================================================
        // TEST SUITE 3: End-to-End Transcript Dispatch Preemption
        // ===================================================================
        console.log('\n--- TEST SUITE 3: End-to-End dispatchTranscript with grace expiry + preemption ---');
        resetTestEnv();

        console.log('1. Dispatching suspicious fragment "question"...');
        await gemini.dispatchTranscript('question');

        console.log('2. Waiting 550ms for grace window to expire and Groq generation to start...');
        await sleep(550);

        const e2eFragmentCall = groqCalls.find(c => c.prompt === 'question');
        check('E2E_fragment_dispatched_after_grace', Boolean(e2eFragmentCall),
            `e2eFragmentCall present=${Boolean(e2eFragmentCall)}`);

        console.log('3. Speaker resumes and emits complete question...');
        await gemini.dispatchTranscript('Why use Redis for caching in web applications?');

        // Allow question generation to finish
        await sleep(200);

        check('E2E_fragment_was_preempted', e2eFragmentCall?.aborted === true,
            `fragmentAborted=${e2eFragmentCall?.aborted}`);

        const sessionData3 = gemini.getCurrentSessionData();
        check('E2E_final_history_has_only_complete_question',
            sessionData3.history.length === 1 &&
            sessionData3.history[0].transcription === 'Why use Redis for caching in web applications?',
            `historyTurns=${sessionData3.history.length}, prompt="${sessionData3.history[0]?.transcription}"`);

        // Summary
        console.log('\n============================================================');
        console.log(`=== TEST SUMMARY: ${Object.keys(results.tests).length - totalFailed} passed, ${totalFailed} failed ===`);
        console.log('============================================================\n');

        fs.writeFileSync('preemptible_fragment_test_results.json', JSON.stringify(results, null, 2));

        if (totalFailed > 0) {
            console.error('Acceptance tests FAILED');
            process.exit(1);
        } else {
            console.log('Acceptance tests PASSED');
            process.exit(0);
        }

    } catch (err) {
        console.error('Test harness exception:', err);
        process.exit(1);
    }
});

