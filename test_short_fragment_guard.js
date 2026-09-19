/**
 * Phase 3B-4A — Short-fragment dispatch guard acceptance tests.
 *
 * Drives the REAL production dispatchTranscript() from src/utils/gemini.js (not a copy),
 * with global.fetch stubbed to a fake Groq SSE stream so call counts and timings are
 * deterministic and no live API is consumed.
 *
 * Covers the required cases A-F from the Phase 3B-4A implementation brief.
 *
 * Run:  env -u ELECTRON_RUN_AS_NODE npx electron test_short_fragment_guard.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    win.webContents.send = () => { }; // no renderer under test

    const gemini = require('./src/utils/gemini');
    const { getTelemetry } = require('./src/utils/telemetry');

    const results = { timestamp: new Date().toISOString(), tests: {}, benchmarks: [] };
    let failed = 0;
    const check = (name, pass, detail) => {
        results.tests[name] = { pass, detail };
        if (!pass) failed++;
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
    };

    // ---- Groq stub -------------------------------------------------------
    const groqCalls = [];
    const originalFetch = global.fetch;
    const makeSse = (text) => {
        const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
        const bytes = new TextEncoder().encode(payload);
        let sent = false;
        return {
            ok: true, status: 200, statusText: 'OK', headers: new Map(),
            body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })) }) },
            text: async () => payload,
        };
    };
    global.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('api.groq.com')) {
            const body = JSON.parse(options.body);
            const userMsgs = body.messages.filter(m => m.role === 'user');
            groqCalls.push({ t: Date.now(), prompt: userMsgs[userMsgs.length - 1]?.content || '', model: body.model, messages: body.messages.length });
            return makeSse('ok');
        }
        return originalFetch(url, options);
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const reset = () => { gemini.resetFragmentGuard(); gemini.initializeNewSession(); groqCalls.length = 0; };

    try {
        // ================= UNIT: classifier benchmark =====================
        console.log('\n=== TEST 1: isSuspiciousFragment() benchmark (14 inputs) ===');
        const BENCH = [
            ['question', true], ['um', true], ['okay', true], ['tell me', true],
            ['What is Python?', false], ['What is REST?', false], ['Why use Redis?', false],
            ['What is SQL?', false], ['Explain closures', false], ['Why use FastAPI?', false],
            ['What is an API?', false], ['Difference between SQL and NoSQL?', false],
            ['Can you explain what REST APIs are and why they are commonly used in backend development?', false],
            ['How would you design a scalable backend system for an application with thousands of concurrent users?', false],
        ];
        let fp = 0, fn = 0;
        for (const [text, expected] of BENCH) {
            const actual = gemini.isSuspiciousFragment(text);
            const ok = actual === expected;
            if (!ok && actual) fp++;
            if (!ok && !actual) fn++;
            results.benchmarks.push({ text, expected, actual, ok });
            console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${String(actual).padEnd(5)} ${JSON.stringify(text.slice(0, 60))}`);
        }
        check('classifier_matches_benchmark', fp === 0 && fn === 0, `false positives=${fp}, false negatives=${fn}`);

        // ================= A: suspicious fragments held ===================
        console.log('\n=== TEST A: suspicious fragments receive the 500ms grace ===');
        for (const frag of ['question', 'um', 'okay', 'tell me']) {
            reset();
            const t0 = Date.now();
            await gemini.dispatchTranscript(frag);
            const immediate = groqCalls.length;
            await sleep(750);
            const total = groqCalls.length;
            const delay = total ? groqCalls[0].t - t0 : -1;
            check(`A[${frag}] held then dispatched once`, immediate === 0 && total === 1 && delay >= 450,
                `immediate=${immediate}, total=${total}, delay=${delay}ms`);
        }

        // ================= D/B: complete short questions ==================
        console.log('\n=== TEST B/D: complete short questions dispatch with no grace delay ===');
        const SHORT = ['What is Python?', 'What is REST?', 'Why use Redis?', 'What is SQL?',
            'Explain closures', 'Why use FastAPI?', 'What is an API?', 'Difference between SQL and NoSQL?'];
        for (const q of SHORT) {
            reset();
            const t0 = Date.now();
            await gemini.dispatchTranscript(q);
            const delay = groqCalls.length ? groqCalls[0].t - t0 : -1;
            await sleep(750); // would surface a stray grace timer
            check(`B/D[${q}] immediate, exactly one call`, groqCalls.length === 1 && delay >= 0 && delay < 400,
                `calls=${groqCalls.length}, firstCallAfter=${delay}ms`);
        }

        // ================= C: stitching ==================================
        console.log('\n=== TEST C: fragment + continuation after 300ms stitches into ONE call ===');
        reset();
        await gemini.dispatchTranscript('question');
        const afterFragment = groqCalls.length;
        await sleep(300);
        await gemini.dispatchTranscript('two, explain the difference between SQL and NoSQL');
        const afterContinuation = groqCalls.length;
        const stitched = groqCalls[0]?.prompt || '';
        await sleep(750);
        check('C[stitch] exactly one generateAnswer for combined transcript',
            afterFragment === 0 && afterContinuation === 1 && groqCalls.length === 1,
            `afterFragment=${afterFragment}, afterContinuation=${afterContinuation}, total=${groqCalls.length}`);
        check('C[stitch] prompt contains both fragment and continuation',
            /question/i.test(stitched) && /explain the difference between SQL and NoSQL/i.test(stitched),
            JSON.stringify(stitched.slice(0, 90)));

        // ================= E: long query =================================
        console.log('\n=== TEST E: normal long query dispatches immediately ===');
        reset();
        const longQ = 'Can you explain what REST APIs are and why they are commonly used in backend development?';
        const t0e = Date.now();
        await gemini.dispatchTranscript(longQ);
        const delayE = groqCalls.length ? groqCalls[0].t - t0e : -1;
        check('E[long] immediate dispatch', groqCalls.length === 1 && delayE < 400, `calls=${groqCalls.length}, delay=${delayE}ms`);

        // ================= Teardown: timer cancellation ==================
        console.log('\n=== TEST: resetFragmentGuard() cancels a held fragment ===');
        reset();
        await gemini.dispatchTranscript('question');
        await sleep(100);
        gemini.resetFragmentGuard();
        await sleep(750);
        check('reset_cancels_pending_timer', groqCalls.length === 0, `calls=${groqCalls.length} (expected 0)`);

        // ================= F: telemetry sanity ===========================
        console.log('\n=== TEST F: telemetry still records each dispatch ===');
        reset();
        const before = getTelemetry().counts.generateAnswer;
        await gemini.dispatchTranscript('What is Python?');
        const after = getTelemetry().counts.generateAnswer;
        check('telemetry_generateAnswer_increments', after === before + 1, `${before} -> ${after}`);

    } catch (err) {
        console.error('FATAL:', err);
        results.fatal = String(err && err.stack || err);
        failed++;
    }

    global.fetch = originalFetch;
    console.log(`\n=== ${failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED'} ===`);
    results.summary = { failed, total: Object.keys(results.tests).length };
    fs.writeFileSync('./phase3b4a_guard_test_results.json', JSON.stringify(results, null, 2));
    console.log('Saved phase3b4a_guard_test_results.json');
    app.exit(failed === 0 ? 0 : 1);
});
