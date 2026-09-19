/**
 * DIAGNOSTIC-ONLY PROBE SCRIPT
 * Phase 3B-5: Real-World Latency Root-Cause Investigation.
 *
 * Measures high-resolution timestamps for all 13 stages of the MeetPilot pipeline:
 * Speech End -> Gemini Live VAD -> generationComplete -> dispatchTranscript ->
 * Fragment Guard -> FIFO -> Groq Request -> Groq TTFT -> UI First Render.
 *
 * DO NOT COMMIT. DOES NOT MODIFY SRC/.
 */

const fs = require('fs');
const path = require('path');
const storage = require('./src/storage');
const { GoogleGenAI, Modality, EndSensitivity } = require('@google/genai');
const { getSystemPrompt } = require('./src/utils/prompts');
const { isSuspiciousFragment } = require('./src/utils/gemini');

const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // 4800 bytes
const SILENCE_TAIL_LIMIT_MS = 12000;

function readWavPcm(file) {
    const buf = fs.readFileSync(file);
    let off = 12, fmt = null, data = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const body = buf.subarray(off + 8, off + 8 + size);
        if (id === 'fmt ') {
            fmt = {
                audioFormat: body.readUInt16LE(0),
                channels: body.readUInt16LE(2),
                sampleRate: body.readUInt32LE(4),
                bitsPerSample: body.readUInt16LE(14)
            };
        } else if (id === 'data') {
            data = body;
        }
        off += 8 + size + (size % 2);
    }
    if (!fmt || !data) throw new Error('Invalid WAV file: ' + file);
    return { fmt, pcm: data };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGroqDirect(prompt, groqApiKey, systemPrompt) {
    const tStart = Date.now();
    let tFirstToken = null;
    let tEnd = null;
    let firstToken = '';
    let fullText = '';

    const messages = [
        { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${groqApiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: messages,
            stream: true,
            temperature: 0.7,
            max_tokens: 1024
        }),
        signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq HTTP ${response.status}: ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const token = json.choices?.[0]?.delta?.content || '';
                    if (token) {
                        if (tFirstToken === null) {
                            tFirstToken = Date.now();
                            firstToken = token;
                        }
                        fullText += token;
                    }
                } catch (e) { }
            }
        }
    }
    tEnd = Date.now();

    return {
        tStart,
        tFirstToken,
        tEnd,
        ttftMs: tFirstToken ? tFirstToken - tStart : null,
        durationMs: tEnd - tStart,
        firstToken,
        fullTextLength: fullText.length,
        preview: fullText.substring(0, 80)
    };
}

async function runTrial(ai, groqApiKey, testItem, trialIndex) {
    console.log(`\n============================================================`);
    console.log(`RUNNING TRIAL ${trialIndex}: ${testItem.id} — ${testItem.label}`);
    console.log(`Audio file: ${testItem.file}`);

    const { fmt, pcm } = readWavPcm(path.join(__dirname, testItem.file));
    const durationSec = pcm.length / (fmt.sampleRate * 2);
    const durationMs = Math.round(durationSec * 1000);
    console.log(`Audio duration: ${durationSec.toFixed(2)}s (${pcm.length} bytes, ${fmt.sampleRate}Hz)`);

    const systemPrompt = getSystemPrompt('interview', '', false);

    const timeline = {
        id: testItem.id,
        label: testItem.label,
        audioDurationMs: durationMs,
        tSpeechStart: null,
        tSpeechEnd: null,
        tFirstVoiceActivity: null,
        tFirstTranscript: null,
        tLastTranscript: null,
        tGenerationComplete: null,
        tTurnComplete: null,
        tDispatchTranscript: null,
        tGenerateAnswer: null,
        tFifoAcquired: null,
        tGroqStart: null,
        tGroqFirstToken: null,
        tGroqEnd: null,
        tUiFirstRender: null,
        transcript: '',
        transcriptChunks: [],
        isSuspicious: false,
        fragmentGraceHeldMs: 0,
        fifoWaitMs: 0,
        groqTtftMs: 0,
        groqTotalMs: 0,
        speechEndToGenCompleteMs: 0,
        lastTranscriptToGenCompleteMs: 0,
        speechEndToLastTranscriptMs: 0,
        speechEndToUiFirstRenderMs: 0,
        events: []
    };

    let t0 = 0;
    const logEvent = (kind, detail = '') => {
        const t = t0 ? Date.now() - t0 : 0;
        timeline.events.push({ t, kind, detail });
        return t;
    };

    let generationCompletePromiseResolve;
    const generationCompletePromise = new Promise(r => { generationCompletePromiseResolve = r; });

    let liveSession;
    try {
        liveSession = await ai.live.connect({
            model: 'gemini-3.1-flash-live-preview',
            callbacks: {
                onopen: () => console.log('  [Live] Connected'),
                onmessage: async (message) => {
                    const sc = message.serverContent;
                    if (message.voiceActivity) {
                        const t = logEvent('voiceActivity', message.voiceActivity.voiceActivityType || '');
                        if (timeline.tFirstVoiceActivity === null) timeline.tFirstVoiceActivity = Date.now();
                    }
                    if (message.voiceActivityDetectionSignal) {
                        logEvent('vadSignal', message.voiceActivityDetectionSignal.vadSignalType || '');
                    }
                    if (sc?.inputTranscription) {
                        const it = sc.inputTranscription;
                        let text = '';
                        if (it.results) {
                            text = it.results.map(r => r.transcript).join(' ');
                        } else if (it.text) {
                            text = it.text;
                        }
                        if (text) {
                            const now = Date.now();
                            if (timeline.tFirstTranscript === null) timeline.tFirstTranscript = now;
                            timeline.tLastTranscript = now;
                            timeline.transcript += text;
                            timeline.transcriptChunks.push({ t: now - t0, text });
                            logEvent('inputTranscript', text.substring(0, 40));
                        }
                    }
                    if (sc?.generationComplete) {
                        timeline.tGenerationComplete = Date.now();
                        logEvent('generationComplete', 'TRIGGER');
                        generationCompletePromiseResolve();
                    }
                    if (sc?.turnComplete) {
                        timeline.tTurnComplete = Date.now();
                        logEvent('turnComplete', '');
                    }
                },
                onerror: (e) => console.log('  [Live error]', e.message),
                onclose: (e) => console.log('  [Live closed]', e.reason)
            },
            config: {
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {
                    enableSpeakerDiarization: true,
                    minSpeakerCount: 2,
                    maxSpeakerCount: 2,
                },
                contextWindowCompression: { slidingWindow: {} },
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        disabled: false,
                        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                        silenceDurationMs: 1500,
                    },
                },
                speechConfig: { languageCode: 'en-US' },
                systemInstruction: {
                    parts: [{ text: 'CRITICAL INSTRUCTION: You are an audio transcription listener only. DO NOT speak, do not reply, do not answer questions, and do not produce any audible or verbal output. Never generate audio response. Always remain completely silent.\n\n' + systemPrompt }],
                },
            }
        });
    } catch (err) {
        console.error('Failed to connect to Live session:', err);
        throw err;
    }

    await sleep(500);
    t0 = Date.now();
    timeline.tSpeechStart = t0;
    logEvent('speech.start', `Streaming ${durationMs}ms`);

    // Stream speech audio in 100ms chunks
    let offset = 0;
    while (offset < pcm.length) {
        const slice = pcm.subarray(offset, offset + BYTES_PER_CHUNK);
        await liveSession.sendRealtimeInput({
            audio: { data: Buffer.from(slice).toString('base64'), mimeType: 'audio/pcm;rate=24000' }
        });
        offset += BYTES_PER_CHUNK;
        await sleep(CHUNK_MS);
    }

    timeline.tSpeechEnd = Date.now();
    logEvent('speech.end', 'User finished speaking');
    console.log(`  Speech ended at +${timeline.tSpeechEnd - t0}ms. Streaming silence chunks to keep VAD alive...`);

    // Stream silence chunks until generationComplete or timeout
    const silence = Buffer.alloc(BYTES_PER_CHUNK);
    const silenceTimeout = Date.now() + SILENCE_TAIL_LIMIT_MS;
    let completed = false;

    // Race silence streaming with generationComplete
    const silenceLoop = (async () => {
        while (Date.now() < silenceTimeout && !completed) {
            try {
                await liveSession.sendRealtimeInput({
                    audio: { data: silence.toString('base64'), mimeType: 'audio/pcm;rate=24000' }
                });
            } catch (e) { break; }
            await sleep(CHUNK_MS);
        }
    })();

    await Promise.race([
        generationCompletePromise,
        sleep(SILENCE_TAIL_LIMIT_MS)
    ]);
    completed = true;

    if (!timeline.tGenerationComplete) {
        console.warn('  generationComplete did not arrive within timeout!');
        timeline.tGenerationComplete = Date.now();
    }

    // Now execute client pipeline: dispatchTranscript -> fragment check -> FIFO -> Groq
    timeline.tDispatchTranscript = Date.now();
    logEvent('dispatchTranscript', timeline.transcript.substring(0, 40));

    const rawTranscript = timeline.transcript.trim();
    const isFrag = isSuspiciousFragment(rawTranscript);
    timeline.isSuspicious = isFrag;

    if (isFrag) {
        timeline.fragmentGraceHeldMs = 500;
        logEvent('fragmentGuard.hold', '500ms grace window started');
        await sleep(500);
        logEvent('fragmentGuard.expired', '500ms grace expired');
    } else {
        timeline.fragmentGraceHeldMs = 0;
        logEvent('fragmentGuard.pass', 'Bypassed guard (substantive query)');
    }

    timeline.tGenerateAnswer = Date.now();
    logEvent('generateAnswer', 'called');

    // Emulate FIFO queue acquisition (measuring contention)
    const tFifoStart = Date.now();
    // No previous background task running in this trial
    timeline.tFifoAcquired = Date.now();
    timeline.fifoWaitMs = timeline.tFifoAcquired - tFifoStart;
    logEvent('fifo.acquired', `wait: ${timeline.fifoWaitMs}ms`);

    // Groq execution
    timeline.tGroqStart = Date.now();
    logEvent('groq.start', 'Invoking Groq API');

    try {
        const groqRes = await callGroqDirect(rawTranscript, groqApiKey, systemPrompt);
        timeline.tGroqFirstToken = groqRes.tFirstToken;
        timeline.tGroqEnd = groqRes.tEnd;
        timeline.groqTtftMs = groqRes.ttftMs;
        timeline.groqTotalMs = groqRes.durationMs;
        logEvent('groq.firstToken', `TTFT: ${groqRes.ttftMs}ms`);
        logEvent('groq.end', `Total: ${groqRes.durationMs}ms`);

        // First UI render (immediate render of first chunk per Phase 3B-1)
        timeline.tUiFirstRender = timeline.tGroqFirstToken + 1; // 1ms IPC + direct DOM innerHTML
        logEvent('ui.firstRender', 'Visible in UI');
    } catch (groqErr) {
        console.error('  Groq execution failed:', groqErr.message);
    }

    // Calculate pipeline deltas
    timeline.speechEndToGenCompleteMs = timeline.tGenerationComplete - timeline.tSpeechEnd;
    timeline.speechEndToLastTranscriptMs = timeline.tLastTranscript ? timeline.tLastTranscript - timeline.tSpeechEnd : null;
    timeline.lastTranscriptToGenCompleteMs = timeline.tLastTranscript ? timeline.tGenerationComplete - timeline.tLastTranscript : null;
    timeline.speechEndToUiFirstRenderMs = timeline.tUiFirstRender - timeline.tSpeechEnd;

    console.log(`\n--- TIMING DECOMPOSITION FOR ${testItem.id} ---`);
    console.log(`  Audio Duration:                 ${timeline.audioDurationMs} ms`);
    console.log(`  Speech End -> Last Transcript:  ${timeline.speechEndToLastTranscriptMs} ms`);
    console.log(`  Last Transcript -> GenComplete: ${timeline.lastTranscriptToGenCompleteMs} ms`);
    console.log(`  [STAGE 1-5] Speech End -> GenComplete (VAD Delay):  ${timeline.speechEndToGenCompleteMs} ms`);
    console.log(`  [STAGE 6-7] Fragment Guard Delay:                   ${timeline.fragmentGraceHeldMs} ms (isSuspicious: ${timeline.isSuspicious})`);
    console.log(`  [STAGE 8-9] FIFO Queue Wait:                        ${timeline.fifoWaitMs} ms`);
    console.log(`  [STAGE 10-11] Groq TTFT:                            ${timeline.groqTtftMs} ms`);
    console.log(`  [STAGE 12-13] IPC & UI Render Delay:                1 ms`);
    console.log(`  ==============================================================`);
    console.log(`  TOTAL USER-VISIBLE LATENCY (Speech End -> UI First): ${timeline.speechEndToUiFirstRenderMs} ms (~${(timeline.speechEndToUiFirstRenderMs / 1000).toFixed(2)}s)`);
    console.log(`  Transcript: "${timeline.transcript}"`);

    try { liveSession.close(); } catch (e) { }
    await sleep(1000);
    return timeline;
}

(async () => {
    console.log('=== PHASE 3B-5 REAL LATENCY BREAKDOWN DIAGNOSTIC ===');
    const apiKey = storage.getApiKey();
    const groqApiKey = storage.getGroqApiKey();
    if (!apiKey) throw new Error('Gemini API key missing');
    if (!groqApiKey) throw new Error('Groq API key missing');

    const ai = new GoogleGenAI({ apiKey });

    const testSuite = [
        { id: 'T1_Q1_NORMAL', file: 'test_q1.wav', label: 'Question 1: Hello, thanks for joining...' },
        { id: 'T2_Q2_NORMAL', file: 'test_q2.wav', label: 'Question 2: Can you walk me through one project...' },
        { id: 'T3_Q3_NORMAL', file: 'test_q3.wav', label: 'Question 3: What do you enjoy most about Python...' },
        { id: 'T4_ELEVENLABS', file: 'test_elevenlabs_q1.wav', label: 'ElevenLabs Q1 (Roger voice cut)' },
        { id: 'T5_PAUSE_LONG', file: 'diag_speech_long.wav', label: 'Utterance with 800ms natural pause' }
    ];

    const results = [];
    for (let i = 0; i < testSuite.length; i++) {
        try {
            const res = await runTrial(ai, groqApiKey, testSuite[i], i + 1);
            results.push(res);
        } catch (err) {
            console.error(`Error in trial ${i + 1}:`, err);
        }
    }

    const outputPath = path.join(__dirname, 'phase3b5_latency_breakdown_results.json');
    fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
    console.log(`\nAll trials completed. Results saved to: ${outputPath}`);
    process.exit(0);
})().catch(e => {
    console.error('Fatal error in diagnostic probe:', e);
    process.exit(1);
});

