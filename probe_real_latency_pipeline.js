const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // 4800 bytes
const SILENCE_TAIL_MS = 8000;

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
    if (!fmt || !data) throw new Error('bad wav: ' + file);
    return data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });

    const uiEvents = [];
    const origSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => {
        if (channel === 'new-response' || channel === 'update-response' || channel === 'update-status') {
            uiEvents.push({ channel, t: Date.now(), textSnippet: (args[0] || '').substring(0, 60) });
        }
        return origSend(channel, ...args);
    };

    const storage = require('./src/storage');
    const gemini = require('./src/utils/gemini');
    const { getTelemetry } = require('./src/utils/telemetry');

    const report = {
        timestamp: new Date().toISOString(),
        vadConfig: {
            endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
            silenceDurationMs: 1500
        },
        trials: [],
        screenshotTrial: null
    };

    try {
        const apiKey = storage.getApiKey();
        if (!apiKey) throw new Error('Gemini API key missing');

        console.log('=== STARTING REAL LATENCY PIPELINE AUDIT ===');
        const session = await gemini.initializeGeminiSession(apiKey, '', 'interview', 'en-US', false);
        if (!session) throw new Error('Failed to open Gemini Live session');

        const testAudios = [
            { id: 'Q1', file: 'test_q1.wav', label: 'Q1: Hello, thanks for joining...' },
            { id: 'Q2', file: 'test_q2.wav', label: 'Q2: Can you walk me through one project...' },
            { id: 'Q3', file: 'test_q3.wav', label: 'Q3: What do you enjoy most about Python...' }
        ];

        for (const item of testAudios) {
            console.log(`\n--- Testing ${item.id} (${item.label}) ---`);
            const pcm = readWavPcm(path.join(__dirname, item.file));
            const durationSec = pcm.length / (SAMPLE_RATE * 2);
            console.log(`Audio length: ${durationSec.toFixed(2)}s (${pcm.length} bytes)`);

            const trialMetrics = {
                id: item.id,
                label: item.label,
                audioDurationMs: Math.round(durationSec * 1000),
                tSpeechStart: null,
                tSpeechEnd: null,
                tFirstVoiceActivity: null,
                tFirstTranscript: null,
                tLastTranscript: null,
                tGenerationComplete: null,
                tGroqStart: null,
                tGroqFirstToken: null,
                tUiFirstChunk: null,
                groqTtftMs: null,
                vadDelayMs: null,
                speechEndToUiFirstMs: null,
                transcript: '',
                finalAnswerPreview: ''
            };

            const t0 = Date.now();
            trialMetrics.tSpeechStart = t0;

            // Stream audio in real-time chunks (100ms pacing)
            let offset = 0;
            while (offset < pcm.length) {
                const chunk = pcm.subarray(offset, offset + BYTES_PER_CHUNK);
                await gemini.sendAudioToGemini(Buffer.from(chunk).toString('base64'), { current: session });
                offset += BYTES_PER_CHUNK;
                await sleep(CHUNK_MS);
            }
            trialMetrics.tSpeechEnd = Date.now();
            console.log(`Speech playback ended at +${trialMetrics.tSpeechEnd - t0}ms. Now streaming ambient/silence chunks...`);

            // Stream trailing silence / ambient chunks
            const silenceChunk = Buffer.alloc(BYTES_PER_CHUNK).toString('base64');
            const silenceEndLimit = Date.now() + SILENCE_TAIL_MS;
            let capturedGenComplete = false;

            while (Date.now() < silenceEndLimit) {
                await gemini.sendAudioToGemini(silenceChunk, { current: session });
                await sleep(CHUNK_MS);
            }

            // Wait for Groq generation & UI delivery
            await sleep(4000);

            const telem = getTelemetry().getBaselineReportData();
            const groqReqs = telem.requests.filter(r => r.type === 'groq');
            const lastGroq = groqReqs[groqReqs.length - 1];

            const sessionData = gemini.getCurrentSessionData();
            const turns = sessionData?.history || [];
            const lastTurn = turns[turns.length - 1] || {};

            // Find first UI response after speechEnd
            const postSpeechUi = uiEvents.filter(e => (e.channel === 'new-response' || e.channel === 'update-response') && e.t >= trialMetrics.tSpeechEnd);

            trialMetrics.tGroqStart = lastGroq?.startTime || null;
            trialMetrics.tGroqFirstToken = lastGroq?.firstTokenTime || null;
            trialMetrics.groqTtftMs = lastGroq?.ttft || null;
            trialMetrics.transcript = lastTurn.transcription || '';
            trialMetrics.finalAnswerPreview = (lastTurn.ai_response || '').substring(0, 100);

            if (postSpeechUi.length > 0) {
                trialMetrics.tUiFirstChunk = postSpeechUi[0].t;
                trialMetrics.speechEndToUiFirstMs = trialMetrics.tUiFirstChunk - trialMetrics.tSpeechEnd;
            }

            if (lastGroq?.startTime) {
                trialMetrics.vadDelayMs = lastGroq.startTime - trialMetrics.tSpeechEnd;
            }

            console.log(`Results for ${item.id}:`);
            console.log(`  Speech duration: ${trialMetrics.audioDurationMs}ms`);
            console.log(`  VAD delay (speech end -> Groq start): ${trialMetrics.vadDelayMs}ms`);
            console.log(`  Groq TTFT: ${trialMetrics.groqTtftMs}ms`);
            console.log(`  Speech End -> UI First Chunk: ${trialMetrics.speechEndToUiFirstMs}ms`);
            console.log(`  Transcript: "${trialMetrics.transcript.substring(0, 80)}..."`);

            report.trials.push(trialMetrics);
            await sleep(2000); // Settle between turns
        }

        // Test Screenshot Analysis timing
        console.log('\n--- Testing Screenshot Analysis Latency ---');
        const dummyImage = Buffer.alloc(100 * 1024, 0xFF).toString('base64'); // 100KB dummy base64
        const tImgStart = Date.now();
        const imgResult = await gemini.sendImageToGeminiHttp(dummyImage, 'Briefly describe this test image.');
        const tImgEnd = Date.now();

        const telem = getTelemetry().getBaselineReportData();
        const imgReqs = telem.requests.filter(r => r.type === 'gemini_image');
        const lastImg = imgReqs[imgReqs.length - 1];

        report.screenshotTrial = {
            totalMs: tImgEnd - tImgStart,
            ttftMs: lastImg?.ttft || null,
            thoughtsTokens: lastImg?.actualUsage?.thoughts_tokens || 0,
            completionTokens: lastImg?.actualUsage?.completion_tokens || 0,
            model: lastImg?.model || 'gemini-3.5-flash',
            success: imgResult.success
        };
        console.log(`Screenshot total: ${report.screenshotTrial.totalMs}ms, TTFT: ${report.screenshotTrial.ttftMs}ms, Thinking tokens: ${report.screenshotTrial.thoughtsTokens}`);

        fs.writeFileSync(path.join(__dirname, 'real_latency_probe_results.json'), JSON.stringify(report, null, 2));
        console.log('\n=== REAL LATENCY PIPELINE AUDIT COMPLETE ===');

        try { session.close(); } catch { }
        app.exit(0);
    } catch (err) {
        console.error('Fatal error in latency probe:', err);
        fs.writeFileSync(path.join(__dirname, 'real_latency_probe_results.json'), JSON.stringify(report, null, 2));
        app.exit(1);
    }
});

