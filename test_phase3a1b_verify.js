const { app, BrowserWindow } = require('electron');
const fs = require('fs');

app.whenReady().then(async () => {
    console.log('[VERIFY_3A1B] Initializing verification window...');
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    const storage = require('./src/storage');
    const { initializeNewSession, generateAnswer } = require('./src/utils/gemini');

    const originalFetch = global.fetch;

    try {
        console.log('[VERIFY_3A1B] Checking getModelForToday():', storage.getModelForToday());
        if (storage.getModelForToday() !== 'openai/gpt-oss-120b') {
            throw new Error(`Expected openai/gpt-oss-120b but got ${storage.getModelForToday()}`);
        }

        // Test 1: Direct Groq failure falls back directly to Gemini
        console.log('\n--- VERIFY TEST 1: Direct Groq Failure -> Gemini Fallback ---');
        initializeNewSession();
        global.fetch = async (url, options) => {
            if (typeof url === 'string' && url.includes('api.groq.com')) {
                return {
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                    headers: new Map(),
                    text: async () => JSON.stringify({ error: { message: 'Simulated 500' } })
                };
            }
            return originalFetch(url, options);
        };

        let t1Success = false;
        try {
            await generateAnswer('Test fallback verification after Kimi removal.');
            t1Success = true;
        } catch (e) {
            console.error('Fallback failed:', e);
        }

        console.log('[VERIFY TEST 1 RESULT] Fallback Success:', t1Success);
        if (!t1Success) throw new Error('Direct fallback to Gemini failed');

        // Test 2: Verify timeout setting is intact
        console.log('\n--- VERIFY TEST 2: Verify 10-second timeout on Groq fetch ---');
        const geminiSrc = fs.readFileSync('./src/utils/gemini.js', 'utf8');
        const timeoutPresent = geminiSrc.includes('signal: AbortSignal.timeout(10000)');
        console.log('[VERIFY TEST 2 RESULT] Timeout Present:', timeoutPresent);
        if (!timeoutPresent) throw new Error('AbortSignal.timeout(10000) is missing');

        global.fetch = originalFetch;
        console.log('\n[VERIFY_3A1B] All Phase 3A-1B verifications PASSED.');
        app.quit();
    } catch (err) {
        console.error('[VERIFY_3A1B] Verification failed:', err);
        global.fetch = originalFetch;
        app.exit(1);
    }
});

