const { app, BrowserWindow } = require('electron');
const fs = require('fs');

app.whenReady().then(async () => {
    console.log('[TIMEOUT_TEST] Initializing test window...');
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    const storage = require('./src/storage');
    const { initializeNewSession, generateAnswer, getCurrentSessionData } = require('./src/utils/gemini');
    const { getTelemetry } = require('./src/utils/telemetry');

    const testResults = {
        timestamp: new Date().toISOString(),
        timeoutDurationMs: null,
        fallbackLatencyMs: null,
        totalElapsedMs: null,
        tests: {}
    };

    const rendererMessages = [];
    const origSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
        rendererMessages.push({ channel, args, timestamp: Date.now() });
        return origSend(channel, ...args);
    };

    const originalFetch = global.fetch;

    try {
        // ========================================================
        // TEST 1: GROQ HANGING REQUEST (NEVER RESOLVES) -> TIMEOUT TEST
        // ========================================================
        console.log('\n--- TEST 1: Simulating Hanging Groq Connection (10s Timeout) ---');
        initializeNewSession();
        rendererMessages.length = 0;

        let abortSignalFired = false;
        let abortTime = null;
        const test1Start = Date.now();

        global.fetch = (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                console.log('[MOCK] Intercepting Groq fetch -> Stalling request indefinitely...');
                return new Promise((resolve, reject) => {
                    if (options?.signal) {
                        options.signal.addEventListener('abort', () => {
                            abortSignalFired = true;
                            abortTime = Date.now();
                            const elapsed = abortTime - test1Start;
                            console.log(`[MOCK] AbortSignal fired after ${elapsed}ms! Reason:`, options.signal.reason?.message || options.signal.reason);
                            const err = new Error('The operation was aborted due to timeout');
                            err.name = 'TimeoutError';
                            reject(err);
                        });
                    }
                });
            }
            return originalFetch(url, options);
        };

        const test1Prompt = 'What is a race condition in multi-threaded programming? Answer in one short sentence.';
        let test1Success = false;
        let test1Error = null;

        try {
            await generateAnswer(test1Prompt);
            test1Success = true;
        } catch (err) {
            test1Error = err.message;
        }

        const test1End = Date.now();
        const timeoutDuration = abortTime ? abortTime - test1Start : null;
        const totalDuration = test1End - test1Start;
        const fallbackLatency = abortTime ? test1End - abortTime : null;

        testResults.timeoutDurationMs = timeoutDuration;
        testResults.fallbackLatencyMs = fallbackLatency;
        testResults.totalElapsedMs = totalDuration;

        const session1 = getCurrentSessionData();
        const telemetry1 = getTelemetry().getBaselineReportData();
        const lastGroq = telemetry1.requests.filter(r => r.type === 'groq').pop();
        const lastGemini = telemetry1.requests.filter(r => r.type === 'gemini_fallback').pop();
        const uiUpdates1 = rendererMessages.filter(m => m.channel === 'new-response' || m.channel === 'update-response');

        testResults.tests.stalled_request_timeout = {
            classification: 'AUTOMATED',
            success: test1Success,
            error: test1Error,
            abortSignalFired,
            timeoutDurationMs: timeoutDuration,
            fallbackLatencyMs: fallbackLatency,
            totalDurationMs: totalDuration,
            groqFailedRecorded: lastGroq ? lastGroq.success === false : false,
            geminiSuccessRecorded: lastGemini ? lastGemini.success === true : false,
            geminiModel: lastGemini?.model,
            uiUpdatesCount: uiUpdates1.length,
            finalUiAnswer: uiUpdates1.length > 0 ? uiUpdates1[uiUpdates1.length - 1].args[0] : null,
            historyLength: session1?.history?.length || 0,
            userMessageRecordedOnce: session1?.history?.length === 1 && session1.history[0].transcription === test1Prompt
        };

        console.log('[TEST 1 RESULTS]', JSON.stringify(testResults.tests.stalled_request_timeout, null, 2));

        // ========================================================
        // TEST 2: FIFO QUEUE RELEASE VERIFICATION
        // ========================================================
        console.log('\n--- TEST 2: Verifying FIFO Queue Released After Timeout ---');
        // Immediately dispatch another call without stall to ensure queue is not stuck
        global.fetch = originalFetch; // restore real fetch
        rendererMessages.length = 0;

        const test2Start = Date.now();
        let test2Success = false;
        let test2Error = null;

        try {
            await generateAnswer('What is a deadlock? Answer in one sentence.');
            test2Success = true;
        } catch (err) {
            test2Error = err.message;
        }

        const test2Duration = Date.now() - test2Start;
        const session2 = getCurrentSessionData();

        testResults.tests.fifo_queue_release = {
            classification: 'AUTOMATED',
            success: test2Success,
            error: test2Error,
            durationMs: test2Duration,
            queueUnblocked: test2Success && test2Duration < 5000,
            totalSessionHistoryLength: session2?.history?.length || 0
        };
        console.log('[TEST 2 RESULTS]', testResults.tests.fifo_queue_release);

        // ========================================================
        // TEST 3: REGRESSION TEST - GROQ 404
        // ========================================================
        console.log('\n--- TEST 3: Regression Test - Groq 404 ---');
        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                return {
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    headers: new Map(),
                    text: async () => JSON.stringify({ error: { message: 'Model not found' } })
                };
            }
            return originalFetch(url, options);
        };

        let test3Success = false;
        try {
            await generateAnswer('Test 404 prompt');
            test3Success = true;
        } catch (e) { }
        testResults.tests.regression_404 = { classification: 'AUTOMATED', pass: test3Success };
        console.log('[TEST 3 RESULTS]', testResults.tests.regression_404);

        // ========================================================
        // TEST 4: REGRESSION TEST - GROQ 429
        // ========================================================
        console.log('\n--- TEST 4: Regression Test - Groq 429 ---');
        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                return {
                    ok: false,
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: new Map(),
                    text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } })
                };
            }
            return originalFetch(url, options);
        };

        let test4Success = false;
        try {
            await generateAnswer('Test 429 prompt');
            test4Success = true;
        } catch (e) { }
        testResults.tests.regression_429 = { classification: 'AUTOMATED', pass: test4Success };
        console.log('[TEST 4 RESULTS]', testResults.tests.regression_429);

        // ========================================================
        // TEST 5: REGRESSION TEST - NETWORK FAILURE
        // ========================================================
        console.log('\n--- TEST 5: Regression Test - Network Connection Failure ---');
        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                throw new TypeError('fetch failed: connect ECONNREFUSED');
            }
            return originalFetch(url, options);
        };

        let test5Success = false;
        try {
            await generateAnswer('Test network prompt');
            test5Success = true;
        } catch (e) { }
        testResults.tests.regression_network = { classification: 'AUTOMATED', pass: test5Success };
        console.log('[TEST 5 RESULTS]', testResults.tests.regression_network);

        // Restore fetch
        global.fetch = originalFetch;

        fs.writeFileSync('./phase3a1a_test_results.json', JSON.stringify(testResults, null, 2));
        console.log('\n[TIMEOUT_TEST] All verification tests complete. Output saved to phase3a1a_test_results.json');
        app.quit();
    } catch (fatalErr) {
        console.error('[TIMEOUT_TEST] Fatal test error:', fatalErr);
        global.fetch = originalFetch;
        app.exit(1);
    }
});

