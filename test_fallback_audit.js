const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
    console.log('[FALLBACK_AUDIT] Initializing test window...');
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    const storage = require('./src/storage');
    const { initializeNewSession, generateAnswer } = require('./src/utils/gemini');
    const { getTelemetry } = require('./src/utils/telemetry');

    const results = {
        timestamp: new Date().toISOString(),
        tests: {}
    };

    // Track IPC events sent to renderer
    const rendererMessages = [];
    const origSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
        rendererMessages.push({ channel, args });
        return origSend(channel, ...args);
    };

    // Intercept global.fetch for Groq requests
    const originalFetch = global.fetch;

    try {
        console.log('[FALLBACK_AUDIT] Gemini Key:', storage.getApiKey() ? 'Present' : 'Missing');
        console.log('[FALLBACK_AUDIT] Groq Key:', storage.getGroqApiKey() ? 'Present' : 'Missing');

        // ========================================================
        // TEST 1: CONTROLLED FAILURE -> GEMINI FALLBACK VERIFICATION
        // ========================================================
        console.log('\n--- TEST 1: Simulating Groq HTTP 500 Failure ---');
        initializeNewSession();
        rendererMessages.length = 0;

        let groqIntercepted = false;
        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                groqIntercepted = true;
                console.log('[MOCK] Intercepting Groq fetch -> Returning HTTP 500');
                return {
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                    headers: new Map(),
                    text: async () => JSON.stringify({ error: { message: 'Groq simulated internal error' } })
                };
            }
            return originalFetch(url, options);
        };

        const test1Prompt = 'What is idempotency in distributed systems? Answer in one short sentence.';
        let test1Success = false;
        let test1Error = null;

        try {
            await generateAnswer(test1Prompt);
            test1Success = true;
        } catch (err) {
            test1Error = err.message;
        }

        // Read history from session & telemetry
        const sessionData = require('./src/utils/gemini').getCurrentSessionData();
        const telemetryData = getTelemetry().getBaselineReportData();
        const lastGroqReq = telemetryData.requests.filter(r => r.type === 'groq').pop();
        const lastGeminiReq = telemetryData.requests.filter(r => r.type === 'gemini_fallback').pop();

        const receivedUIUpdates = rendererMessages.filter(m => m.channel === 'new-response' || m.channel === 'update-response');

        results.tests.controlled_failure = {
            classification: 'AUTOMATED',
            groqIntercepted,
            success: test1Success,
            error: test1Error,
            geminiCalled: !!lastGeminiReq,
            geminiModel: lastGeminiReq?.model,
            groqFailedRecorded: lastGroqReq ? lastGroqReq.success === false : false,
            geminiSuccessRecorded: lastGeminiReq ? lastGeminiReq.success === true : false,
            uiUpdatesCount: receivedUIUpdates.length,
            lastUIContent: receivedUIUpdates.length > 0 ? receivedUIUpdates[receivedUIUpdates.length - 1].args[0] : null,
            historyMessagesCount: sessionData?.conversationHistory?.length || 0,
            conversationTurns: sessionData?.conversationHistory || []
        };
        console.log('[TEST 1 RESULT]', JSON.stringify(results.tests.controlled_failure, null, 2));

        // ========================================================
        // TEST 2: GROQ 404 (MODEL UNAVAILABLE)
        // ========================================================
        console.log('\n--- TEST 2: Simulating Groq HTTP 404 Model Unavailable ---');
        initializeNewSession();
        rendererMessages.length = 0;

        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                console.log('[MOCK] Intercepting Groq fetch -> Returning HTTP 404');
                return {
                    ok: false,
                    status: 404,
                    statusText: 'Not Found',
                    headers: new Map(),
                    text: async () => JSON.stringify({ error: { message: 'The model does not exist', code: 'model_not_found' } })
                };
            }
            return originalFetch(url, options);
        };

        let test2Success = false;
        let test2Error = null;
        try {
            await generateAnswer('Explain CAP theorem in one sentence.');
            test2Success = true;
        } catch (err) {
            test2Error = err.message;
        }

        results.tests.groq_404 = {
            classification: 'AUTOMATED',
            success: test2Success,
            error: test2Error,
            status: test2Success ? 'PASS' : 'FAIL'
        };
        console.log('[TEST 2 RESULT]', results.tests.groq_404);

        // ========================================================
        // TEST 3: GROQ 429 (RATE LIMIT)
        // ========================================================
        console.log('\n--- TEST 3: Simulating Groq HTTP 429 Rate Limit ---');
        initializeNewSession();
        rendererMessages.length = 0;

        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                console.log('[MOCK] Intercepting Groq fetch -> Returning HTTP 429');
                return {
                    ok: false,
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: new Map([['retry-after', '60']]),
                    text: async () => JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } })
                };
            }
            return originalFetch(url, options);
        };

        let test3Success = false;
        let test3Error = null;
        try {
            await generateAnswer('Explain ACID properties in one sentence.');
            test3Success = true;
        } catch (err) {
            test3Error = err.message;
        }

        results.tests.groq_429 = {
            classification: 'AUTOMATED',
            success: test3Success,
            error: test3Error,
            status: test3Success ? 'PASS' : 'FAIL'
        };
        console.log('[TEST 3 RESULT]', results.tests.groq_429);

        // ========================================================
        // TEST 4: GROQ NETWORK / API FAILURE (CONNECTION REFUSED)
        // ========================================================
        console.log('\n--- TEST 4: Simulating Groq Network Connection Error ---');
        initializeNewSession();
        rendererMessages.length = 0;

        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                console.log('[MOCK] Intercepting Groq fetch -> Throwing Network Error');
                throw new TypeError('fetch failed: connect ECONNREFUSED 104.18.2.161:443');
            }
            return originalFetch(url, options);
        };

        let test4Success = false;
        let test4Error = null;
        try {
            await generateAnswer('Explain two-phase commit in one sentence.');
            test4Success = true;
        } catch (err) {
            test4Error = err.message;
        }

        results.tests.groq_network_error = {
            classification: 'AUTOMATED',
            success: test4Success,
            error: test4Error,
            status: test4Success ? 'PASS' : 'FAIL'
        };
        console.log('[TEST 4 RESULT]', results.tests.groq_network_error);

        // ========================================================
        // TEST 5: GROQ TIMEOUT / HANG (CLIENT-SIDE TIMEOUT CHECK)
        // ========================================================
        console.log('\n--- TEST 5: Inspecting Groq Timeout Handling ---');
        const geminiSrc = fs.readFileSync('./src/utils/gemini.js', 'utf8');
        const sendToGroqBlock = geminiSrc.slice(geminiSrc.indexOf('async function sendToGroq'), geminiSrc.indexOf('async function sendToGemma'));
        const hasTimeout = sendToGroqBlock.includes('AbortSignal') || sendToGroqBlock.includes('timeout');

        results.tests.groq_timeout = {
            classification: 'OBSERVED',
            hasClientTimeout: hasTimeout,
            status: hasTimeout ? 'PASS' : 'VULNERABLE',
            details: hasTimeout ? 'AbortSignal/timeout present' : 'No AbortSignal/timeout configured in fetch. A frozen socket will hang indefinitely.'
        };
        console.log('[TEST 5 RESULT]', results.tests.groq_timeout);

        // Restore fetch
        global.fetch = originalFetch;

        fs.writeFileSync('./phase3a1_audit_results.json', JSON.stringify(results, null, 2));
        console.log('\n[FALLBACK_AUDIT] All tests complete. Output saved to phase3a1_audit_results.json');
        app.quit();
    } catch (auditErr) {
        console.error('[FALLBACK_AUDIT] Fatal test error:', auditErr);
        global.fetch = originalFetch;
        app.exit(1);
    }
});

