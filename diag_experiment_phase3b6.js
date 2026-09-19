/**
 * DIAGNOSTIC EXPERIMENT HARNESS (READ-ONLY)
 * Phase 3B-6: Controlled VAD Latency/Accuracy Experiment.
 *
 * Tests Candidate Configurations:
 * A = 1500ms (current baseline)
 * B = 1200ms
 * C = 1000ms
 * D = 800ms
 * E = 600ms
 *
 * All under EndSensitivity.END_SENSITIVITY_LOW.
 *
 * DOES NOT MODIFY PRODUCTION SOURCE CODE.
 * DOES NOT MODIFY src/utils/gemini.js.
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
const SILENCE_TAIL_LIMIT_MS = 10000;

const RESULTS_FILE = path.join(__dirname, 'phase3b6_experiment_results.json');

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
    if (!prompt || !prompt.trim()) return { ttftMs: 0, durationMs: 0, error: 'empty prompt' };
    const tStart = Date.now();
    let tFirstToken = null;
    let tEnd = null;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b',
                messages: [
                    { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
                    { role: 'user', content: prompt }
                ],
                stream: true,
                temperature: 0.7,
                max_tokens: 256
            }),
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) {
            const txt = await response.text();
            return { tStart, tFirstToken: null, tEnd: Date.now(), ttftMs: null, durationMs: Date.now() - tStart, error: `HTTP ${response.status}: ${txt}` };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(l => l.trim() !== '');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const json = JSON.parse(data);
                        const token = json.choices?.[0]?.delta?.content || '';
                        if (token && tFirstToken === null) {
                            tFirstToken = Date.now();
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
            durationMs: tEnd - tStart
        };
    } catch (err) {
        return { tStart, tFirstToken: null, tEnd: Date.now(), ttftMs: null, durationMs: Date.now() - tStart, error: err.message };
    }
}

async function executeSingleTrial(ai, groqApiKey, configDef, testItem, trialNumber) {
    const { fmt, pcm } = readWavPcm(path.join(__dirname, testItem.file));
    const durationSec = pcm.length / (fmt.sampleRate * 2);
    const audioDurationMs = Math.round(durationSec * 1000);

    const systemPrompt = getSystemPrompt('interview', '', false);

    const record = {
        trialId: `${configDef.name}_${testItem.category}_T${trialNumber}`,
        configName: configDef.name,
        silenceDurationMs: configDef.silenceDurationMs,
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        category: testItem.category,
        label: testItem.label,
        audioFile: testItem.file,
        audioDurationMs,
        tSpeechStart: null,
        tSpeechEnd: null,
        tFirstVoiceActivity: null,
        tFirstTranscript: null,
        tLastTranscript: null,
        tGenerationComplete: null,
        generationCompleteTimes: [],
        turnCompleteTimes: [],
        interruptedTimes: [],
        transcript: '',
        transcriptChunksCount: 0,
        isTranscriptComplete: false,
        isPremature: false,
        prematureLeadMs: 0,
        isInterrupted: false,
        vadDelayMs: null,
        isSuspiciousFragment: false,
        fragmentGuardDelayMs: 0,
        fifoWaitMs: 0,
        groqTtftMs: null,
        speechEndToFirstGroqTokenMs: null,
        speechEndToFirstUiTokenMs: null,
        groqGenerationsCount: 0
    };

    let t0 = 0;
    let liveSession;
    let resolveGenComplete;
    const genCompletePromise = new Promise(r => { resolveGenComplete = r; });

    try {
        liveSession = await ai.live.connect({
            model: 'gemini-3.1-flash-live-preview',
            callbacks: {
                onmessage: async (message) => {
                    const sc = message.serverContent;
                    const now = Date.now();

                    if (message.voiceActivity) {
                        if (record.tFirstVoiceActivity === null) record.tFirstVoiceActivity = now;
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
                            if (record.tFirstTranscript === null) record.tFirstTranscript = now;
                            record.tLastTranscript = now;
                            record.transcript += text;
                            record.transcriptChunksCount++;
                        }
                    }

                    if (sc?.interrupted) {
                        record.interruptedTimes.push(now);
                        record.isInterrupted = true;
                    }

                    if (sc?.generationComplete) {
                        record.generationCompleteTimes.push(now);
                        if (record.tGenerationComplete === null) {
                            record.tGenerationComplete = now;
                        }
                        resolveGenComplete();
                    }

                    if (sc?.turnComplete) {
                        record.turnCompleteTimes.push(now);
                    }
                }
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
                        silenceDurationMs: configDef.silenceDurationMs,
                    },
                },
                speechConfig: { languageCode: 'en-US' },
                systemInstruction: {
                    parts: [{ text: 'CRITICAL INSTRUCTION: You are an audio transcription listener only. DO NOT speak, do not reply, do not answer questions, and do not produce any audible or verbal output. Never generate audio response. Always remain completely silent.\n\n' + systemPrompt }],
                },
            }
        });
    } catch (e) {
        console.error(`  [${record.trialId}] Live connect error:`, e.message);
        throw e;
    }

    await sleep(400);
    t0 = Date.now();
    record.tSpeechStart = t0;

    // Stream audio
    let offset = 0;
    while (offset < pcm.length) {
        const slice = pcm.subarray(offset, offset + BYTES_PER_CHUNK);
        await liveSession.sendRealtimeInput({
            audio: { data: Buffer.from(slice).toString('base64'), mimeType: 'audio/pcm;rate=24000' }
        });
        offset += BYTES_PER_CHUNK;
        await sleep(CHUNK_MS);
    }
    record.tSpeechEnd = Date.now();

    // Stream trailing silence chunks until generationComplete or timeout
    const silence = Buffer.alloc(BYTES_PER_CHUNK);
    const silenceTimeout = Date.now() + SILENCE_TAIL_LIMIT_MS;
    let streamActive = true;

    const silenceLoop = (async () => {
        while (Date.now() < silenceTimeout && streamActive) {
            try {
                await liveSession.sendRealtimeInput({
                    audio: { data: silence.toString('base64'), mimeType: 'audio/pcm;rate=24000' }
                });
            } catch (e) { break; }
            await sleep(CHUNK_MS);
        }
    })();

    await Promise.race([
        genCompletePromise,
        sleep(SILENCE_TAIL_LIMIT_MS)
    ]);
    streamActive = false;

    // Small grace period for late signals
    await sleep(600);

    try { liveSession.close(); } catch (e) { }

    // Check premature generation
    if (record.generationCompleteTimes.length > 0) {
        const firstGen = record.generationCompleteTimes[0];
        if (firstGen < record.tSpeechEnd) {
            record.isPremature = true;
            record.prematureLeadMs = record.tSpeechEnd - firstGen;
        }
    }

    // Measure VAD Delay
    if (record.tGenerationComplete) {
        record.vadDelayMs = record.tGenerationComplete - record.tSpeechEnd;
    }

    // Check transcript completeness against expected marker
    if (testItem.expectedMarker) {
        record.isTranscriptComplete = record.transcript.toLowerCase().includes(testItem.expectedMarker.toLowerCase());
    } else {
        record.isTranscriptComplete = record.transcript.trim().length > 10;
    }

    // Evaluate Fragment Guard
    const cleanedText = record.transcript.trim();
    const isFrag = isSuspiciousFragment(cleanedText);
    record.isSuspiciousFragment = isFrag;
    if (isFrag) {
        record.fragmentGuardDelayMs = 500;
    } else {
        record.fragmentGuardDelayMs = 0;
    }

    // Execute Groq request
    record.fifoWaitMs = 0; // Uncontented
    record.groqGenerationsCount = 1;

    const groqRes = await callGroqDirect(cleanedText, groqApiKey, systemPrompt);
    record.groqTtftMs = groqRes.ttftMs;

    if (record.tSpeechEnd && groqRes.tFirstToken) {
        record.speechEndToFirstGroqTokenMs = (groqRes.tFirstToken - record.tSpeechEnd) + record.fragmentGuardDelayMs;
        record.speechEndToFirstUiTokenMs = record.speechEndToFirstGroqTokenMs + 1; // +1ms render
    }

    return record;
}

(async () => {
    console.log('================================================================');
    console.log('PHASE 3B-6 — CONTROLLED VAD LATENCY/ACCURACY EXPERIMENT');
    console.log('Testing Candidates: A(1500ms), B(1200ms), C(1000ms), D(800ms), E(600ms)');
    console.log('================================================================');

    const apiKey = storage.getApiKey();
    const groqApiKey = storage.getGroqApiKey();
    if (!apiKey) { console.error('Gemini API key missing'); process.exit(1); }
    if (!groqApiKey) { console.error('Groq API key missing'); process.exit(1); }

    const ai = new GoogleGenAI({ apiKey });

    const candidates = [
        { name: 'A_1500', silenceDurationMs: 1500 },
        { name: 'B_1200', silenceDurationMs: 1200 },
        { name: 'C_1000', silenceDurationMs: 1000 },
        { name: 'D_800', silenceDurationMs: 800 },
        { name: 'E_600', silenceDurationMs: 600 }
    ];

    const testAudioSuite = [
        {
            category: 'PAUSE_HESITATION',
            label: 'Natural pause (800ms pause, 23.3s speech)',
            file: 'diag_speech_long.wav',
            expectedMarker: 'distributed transactions',
            trialsPerCandidate: 5
        },
        {
            category: 'NORMAL_CONVERSATIONAL',
            label: 'Normal question (7.5s speech)',
            file: 'test_q1.wav',
            expectedMarker: 'background',
            trialsPerCandidate: 3
        },
        {
            category: 'SHORT_QUESTION',
            label: 'Short question (3.1s speech)',
            file: 'test_synth.wav',
            expectedMarker: 'thread',
            trialsPerCandidate: 3
        },
        {
            category: 'ELEVENLABS_VOICE',
            label: 'ElevenLabs Roger voice (5.5s speech)',
            file: 'test_elevenlabs_q1.wav',
            expectedMarker: 'background',
            trialsPerCandidate: 3
        }
    ];

    // Load existing results if resuming or create fresh
    let allResults = [];
    if (fs.existsSync(RESULTS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
            if (Array.isArray(data.trials)) allResults = data.trials;
        } catch (e) { }
    }

    let totalTrialsExecuted = 0;

    for (const testItem of testAudioSuite) {
        console.log(`\n================================================================`);
        console.log(`TEST SUITE: [${testItem.category}] — ${testItem.label}`);
        console.log(`================================================================`);

        for (const candidate of candidates) {
            console.log(`\n--- Evaluating Candidate ${candidate.name} (${candidate.silenceDurationMs}ms) ---`);

            for (let t = 1; t <= testItem.trialsPerCandidate; t++) {
                const trialId = `${candidate.name}_${testItem.category}_T${t}`;
                // Check if already executed
                const existing = allResults.find(r => r.trialId === trialId);
                if (existing) {
                    console.log(`  [Skip] Trial ${trialId} already completed.`);
                    continue;
                }

                console.log(`  Starting ${trialId}...`);
                try {
                    const result = await executeSingleTrial(ai, groqApiKey, candidate, testItem, t);
                    allResults.push(result);
                    totalTrialsExecuted++;

                    console.log(`    Result: Premature=${result.isPremature}, Interrupted=${result.isInterrupted}, Complete=${result.isTranscriptComplete}, VAD Delay=${result.vadDelayMs}ms, Groq TTFT=${result.groqTtftMs}ms, Total UI=${result.speechEndToFirstUiTokenMs}ms`);

                    // Save incrementally
                    fs.writeFileSync(RESULTS_FILE, JSON.stringify({
                        updatedAt: new Date().toISOString(),
                        totalTrials: allResults.length,
                        trials: allResults
                    }, null, 2));

                    await sleep(1500); // 1.5s pacing between trials to respect rate limits
                } catch (err) {
                    console.error(`    Trial ${trialId} failed with error:`, err.message);
                    await sleep(2500);
                }
            }
        }
    }

    console.log(`\nAll planned trials completed! Total trials in dataset: ${allResults.length}`);
    process.exit(0);
})().catch(e => {
    console.error('Fatal error in experiment harness:', e);
    process.exit(1);
});

