/**
 * Phase 3B-3 VAD fix — production-path verification (READ-ONLY w.r.t. source).
 *
 * Unlike test_vad_experiment.js (which REPLICATES the Live config), this probe
 * drives the REAL production code path: it calls the exported
 * initializeGeminiSession() from src/utils/gemini.js, so the session is opened
 * with the actual shipped configuration, including the new realtimeInputConfig.
 *
 * It then streams synthesized speech and verifies, end to end:
 *   1. Live connection succeeds with the new config
 *   2. transcription still works
 *   3. generationComplete fires and reaches Groq normally (not the fallback)
 *   4. the response reaches the renderer
 *
 * Run:  env -u ELECTRON_RUN_AS_NODE npx electron verify_vad_production.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const WAV = path.join(__dirname, 'diag_speech_long.wav');
const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
const SILENCE_TAIL_MS = 5000;

function readWavPcm(file) {
    const buf = fs.readFileSync(file);
    let off = 12, fmt = null, data = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const body = buf.subarray(off + 8, off + 8 + size);
        if (id === 'fmt ') fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
        else if (id === 'data') data = body;
        off += 8 + size + (size % 2);
    }
    if (!fmt || !data) throw new Error('bad wav');
    return data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });

    const uiMessages = [];
    const origSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
        if (channel === 'new-response' || channel === 'update-response' || channel === 'update-status') {
            uiMessages.push({ channel, t: Date.now(), chars: (args[0] || '').length });
        }
        return origSend(channel, ...args);
    };

    const storage = require('./src/storage');
    const gemini = require('./src/utils/gemini');
    const { getTelemetry } = require('./src/utils/telemetry');

    const results = { timestamp: new Date().toISOString(), checks: {} };
    const check = (name, pass, detail) => {
        results.checks[name] = { pass, detail };
        console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
    };

    try {
        const apiKey = storage.getApiKey();
        console.log('Gemini key present:', !!apiKey, '| Groq key present:', !!storage.getGroqApiKey());
        if (!apiKey) throw new Error('No Gemini API key');

        console.log('\n1. Opening Live session via PRODUCTION initializeGeminiSession()...');
        const session = await gemini.initializeGeminiSession(apiKey, '', 'interview', 'en-US', false);
        check('live_connection_succeeds_with_new_config', !!session,
            session ? 'session object returned (config accepted by API)' : 'returned null — config rejected or connect failed');
        if (!session) throw new Error('Live session failed to open');

        const pcm = readWavPcm(WAV);
        console.log(`\n2. Streaming speech (${pcm.length} bytes) then ${SILENCE_TAIL_MS}ms silence...`);

        const t0 = Date.now();
        let offset = 0;
        while (offset < pcm.length) {
            await gemini.sendAudioToGemini(Buffer.from(pcm.subarray(offset, offset + BYTES_PER_CHUNK)).toString('base64'), { current: session });
            offset += BYTES_PER_CHUNK;
            await sleep(CHUNK_MS);
        }
        const speechEnd = Date.now();

        const silence = Buffer.alloc(BYTES_PER_CHUNK).toString('base64');
        const until = Date.now() + SILENCE_TAIL_MS;
        while (Date.now() < until) {
            await gemini.sendAudioToGemini(silence, { current: session });
            await sleep(CHUNK_MS);
        }

        // Grace for generationComplete -> processPendingTranscript -> generateAnswer -> Groq
        await sleep(12000);

        const telem = getTelemetry().getBaselineReportData();
        const sessionData = gemini.getCurrentSessionData();
        const groqReqs = telem.requests.filter(r => r.type === 'groq');
        const geminiReqs = telem.requests.filter(r => r.type === 'gemini_fallback');
        const lastGroq = groqReqs[groqReqs.length - 1];
        const responses = uiMessages.filter(m => m.channel === 'new-response' || m.channel === 'update-response');

        console.log('\n3. Verifying behavior:');
        check('transcription_still_works', telem.counts.transcripts > 0, `telemetry transcripts=${telem.counts.transcripts}`);
        check('generationComplete_dispatched', telem.counts.generateAnswer > 0, `generateAnswer calls=${telem.counts.generateAnswer}`);
        check('generation_reached_groq', groqReqs.length > 0 && !!lastGroq, `groq requests=${groqReqs.length}, model=${lastGroq?.model}`);
        check('groq_succeeded_no_fallback', groqReqs.length > 0 && lastGroq?.success === true && geminiReqs.length === 0,
            `groq success=${lastGroq?.success}, fallback requests=${geminiReqs.length}`);
        check('response_reached_renderer', responses.length > 0, `ui stream messages=${responses.length}`);

        // getCurrentSessionData() returns { sessionId, history } — not conversationHistory.
        const turn = (sessionData?.history || [])[0] || {};
        const capturedTranscript = turn.transcription || '';
        console.log('\n4. Outcome:');
        console.log('   transcript captured :', JSON.stringify(capturedTranscript.slice(0, 120)));
        console.log('   chars               :', capturedTranscript.length);
        console.log('   ends with question  :', /handles distributed transactions today\?\s*$/.test(capturedTranscript));
        console.log('   answer              :', JSON.stringify((turn.ai_response || '').slice(0, 120)));
        console.log('   speechEnd->uiFirst  :', responses.length ? (responses[0].t - speechEnd) + 'ms' : 'n/a');
        console.log('   groq ttft           :', lastGroq?.ttft + 'ms');

        results.summary = {
            transcripts: telem.counts.transcripts,
            generateAnswerCalls: telem.counts.generateAnswer,
            groqRequests: groqReqs.length,
            fallbackRequests: geminiReqs.length,
            uiStreamMessages: responses.length,
            transcriptChars: capturedTranscript.length,
            finalQuestionCaptured: /handles distributed transactions today\?\s*$/.test(capturedTranscript),
            answerChars: (turn.ai_response || '').length,
            speechEndToUiFirstMs: responses.length ? responses[0].t - speechEnd : null,
            groqTtftMs: lastGroq?.ttft,
        };

        const allPass = Object.values(results.checks).every(c => c.pass);
        console.log(`\n=== ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} ===`);
        fs.writeFileSync('./verify_vad_production_results.json', JSON.stringify(results, null, 2));
        try { session.close(); } catch { /* ignore */ }
        app.exit(allPass ? 0 : 1);
    } catch (err) {
        console.error('FATAL:', err);
        fs.writeFileSync('./verify_vad_production_results.json', JSON.stringify(results, null, 2));
        app.exit(1);
    }
});
