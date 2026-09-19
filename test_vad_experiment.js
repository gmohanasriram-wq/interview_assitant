/**
 * Phase 3B-3: Controlled Gemini Live VAD Experiment
 * Compares Baseline vs Candidate A vs Candidate B on diag_speech_long.wav (5 trials each).
 */

const fs = require('fs');
const path = require('path');
const storage = require('./src/storage');
const { GoogleGenAI, Modality, EndSensitivity } = require('@google/genai');
const { getSystemPrompt } = require('./src/utils/prompts');

const WAV_FILE = path.join(__dirname, 'diag_speech_long.wav');
const RESULTS_FILE = path.join(__dirname, 'vad_experiment_results.json');
const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // 4800 bytes
const SILENCE_TAIL_MS = 5000;
const GRACE_PERIOD_MS = 2500;

const GROUND_TRUTH_TEXT = "Thank you for that question. In my previous role I led a team that migrated a monolithic service to a microservice architecture. The main challenge was maintaining data consistency across service boundaries. We addressed it by introducing an event-driven pattern with idempotent consumers. Could you tell me how your team handles distributed transactions today?";
const GROUND_TRUTH_CHARS = GROUND_TRUTH_TEXT.length; // 347
const FINAL_QUESTION_MARKER = "distributed transactions";

function readWavPcm(file) {
    const buf = fs.readFileSync(file);
    let off = 12;
    let fmt = null;
    let data = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const body = buf.subarray(off + 8, off + 8 + size);
        if (id === 'fmt ') {
            fmt = {
                audioFormat: body.readUInt16LE(0),
                channels: body.readUInt16LE(2),
                sampleRate: body.readUInt32LE(4),
                bitsPerSample: body.readUInt16LE(14),
            };
        } else if (id === 'data') {
            data = body;
        }
        off += 8 + size + (size % 2);
    }
    return { fmt, pcm: data };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runSingleTrial(ai, pcm, configType, trialIndex) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`Starting [${configType}] - Trial ${trialIndex}/5...`);

    const baseConfig = {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {
            enableSpeakerDiarization: true,
            minSpeakerCount: 2,
            maxSpeakerCount: 2,
        },
        contextWindowCompression: { slidingWindow: {} },
        speechConfig: { languageCode: 'en-US' },
        systemInstruction: {
            parts: [{ text: 'CRITICAL INSTRUCTION: You are an audio transcription listener only. DO NOT speak, do not reply, do not answer questions, and do not produce any audible or verbal output. Never generate audio response. Always remain completely silent.\n\n' + getSystemPrompt('interview', '', false) }],
        },
    };

    if (configType === 'Candidate_A') {
        baseConfig.realtimeInputConfig = {
            automaticActivityDetection: {
                disabled: false,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                silenceDurationMs: 1500,
            }
        };
    } else if (configType === 'Candidate_B') {
        baseConfig.realtimeInputConfig = {
            automaticActivityDetection: {
                disabled: false,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                silenceDurationMs: 2000,
            }
        };
    }

    const events = [];
    let t0 = 0;
    const mark = (kind, detail = '') => {
        const t = t0 ? Date.now() - t0 : 0;
        events.push({ t, kind, detail });
        return t;
    };

    let fullTranscript = '';
    const transcriptChunks = [];
    const generationCompleteTimes = [];
    const turnCompleteEvents = [];
    const interruptedEvents = [];
    let firstVoiceActivityTime = null;
    let isConnected = false;

    const session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
            onopen: () => { isConnected = true; },
            onmessage: (msg) => {
                const sc = msg.serverContent;
                if (msg.voiceActivity && firstVoiceActivityTime === null) {
                    firstVoiceActivityTime = mark('voiceActivity', msg.voiceActivity.voiceActivityType || '');
                }
                if (sc?.inputTranscription) {
                    const it = sc.inputTranscription;
                    let text = '';
                    if (it.results) {
                        for (const r of it.results) {
                            text += r.transcript + ' ';
                        }
                    } else if (it.text) {
                        text = it.text;
                    }
                    if (text.trim()) {
                        fullTranscript += text;
                        const t = mark('transcript', text.trim());
                        transcriptChunks.push({ t, text: text.trim(), finished: it.finished === true });
                    }
                }
                if (sc?.interrupted) {
                    const t = mark('interrupted', 'model interrupted');
                    interruptedEvents.push(t);
                }
                if (sc?.generationComplete) {
                    const t = mark('generationComplete', 'generationComplete event');
                    generationCompleteTimes.push(t);
                }
                if (sc?.turnComplete) {
                    const t = mark('turnComplete', sc.turnCompleteReason || 'UNSPECIFIED');
                    turnCompleteEvents.push({ t, reason: sc.turnCompleteReason || 'UNSPECIFIED' });
                }
            },
            onerror: (e) => console.error(`  [${configType} #${trialIndex} error]`, e.message),
            onclose: (e) => { },
        },
        config: baseConfig
    });

    // Wait for connection to establish
    await sleep(600);
    t0 = Date.now();
    mark('audio.start', 'start speech streaming');

    // 1. Stream speech
    let offset = 0;
    while (offset < pcm.length) {
        const slice = pcm.subarray(offset, offset + BYTES_PER_CHUNK);
        await session.sendRealtimeInput({
            audio: { data: Buffer.from(slice).toString('base64'), mimeType: 'audio/pcm;rate=24000' },
        });
        offset += BYTES_PER_CHUNK;
        await sleep(CHUNK_MS);
    }
    const audioEndAtMs = mark('audio.end', 'speech finished');

    // 2. Stream silence tail (5000ms)
    const silence = Buffer.alloc(BYTES_PER_CHUNK);
    const silenceUntil = Date.now() + SILENCE_TAIL_MS;
    while (Date.now() < silenceUntil) {
        await session.sendRealtimeInput({
            audio: { data: silence.toString('base64'), mimeType: 'audio/pcm;rate=24000' },
        });
        await sleep(CHUNK_MS);
    }
    mark('silence.end', 'silence tail finished');

    // 3. Grace period for remaining server events
    await sleep(GRACE_PERIOD_MS);

    try { session.close(); } catch { }

    // Evaluate trial results
    const firstGenComplete = generationCompleteTimes[0] || null;
    const isPremature = firstGenComplete !== null && firstGenComplete < audioEndAtMs;
    const audioSentAfterGenComplete = isPremature;
    const speechEndToGenCompleteLatency = firstGenComplete !== null ? firstGenComplete - audioEndAtMs : null;
    const hasFinalQuestion = fullTranscript.toLowerCase().includes(FINAL_QUESTION_MARKER);
    const cleanedTranscript = fullTranscript.replace(/\[spk\d+\]/g, '').replace(/\s+/g, ' ').trim();
    const finalCharCount = cleanedTranscript.length;
    const isCompleteGroundTruth = finalCharCount >= 330 && hasFinalQuestion;
    const hasMultipleGenCompletes = generationCompleteTimes.length > 1;

    const trialResult = {
        configType,
        trialIndex,
        audioEndAtMs,
        firstVoiceActivityTime,
        transcriptChunksCount: transcriptChunks.length,
        firstTranscriptTime: transcriptChunks[0]?.t || null,
        lastTranscriptTime: transcriptChunks[transcriptChunks.length - 1]?.t || null,
        generationCompleteCount: generationCompleteTimes.length,
        firstGenerationCompleteMs: firstGenComplete,
        allGenerationCompleteMs: generationCompleteTimes,
        turnCompleteCount: turnCompleteEvents.length,
        firstTurnCompleteMs: turnCompleteEvents[0]?.t || null,
        turnCompleteReasons: turnCompleteEvents.map(tc => tc.reason),
        interruptedCount: interruptedEvents.length,
        interruptedTimes: interruptedEvents,
        isPremature,
        audioSentAfterGenComplete,
        speechEndToGenCompleteLatency,
        finalCharCount,
        hasFinalQuestion,
        isCompleteGroundTruth,
        hasMultipleGenCompletes,
        cleanedTranscriptPreview: cleanedTranscript.substring(0, 150) + '...',
        events
    };

    console.log(`  Audio End: ${audioEndAtMs}ms`);
    console.log(`  First GenComplete: ${firstGenComplete}ms (diff from speech end: ${speechEndToGenCompleteLatency}ms)`);
    console.log(`  Premature (< audio.end): ${isPremature ? 'YES (CUT OFF!)' : 'NO (Clean)'}`);
    console.log(`  Multiple GenCompletes: ${hasMultipleGenCompletes} (count: ${generationCompleteTimes.length})`);
    console.log(`  Final Transcript Chars: ${finalCharCount} / ${GROUND_TRUTH_CHARS}`);
    console.log(`  Final Question Captured: ${hasFinalQuestion ? 'YES' : 'NO (MISSING)'}`);
    console.log(`  Interrupted count: ${interruptedEvents.length}`);

    return trialResult;
}

(async () => {
    const apiKey = storage.getApiKey();
    if (!apiKey) {
        console.error('No Gemini API key configured.');
        process.exit(1);
    }

    const { fmt, pcm } = readWavPcm(WAV_FILE);
    console.log('============================================================');
    console.log('       CONTROLLED GEMINI LIVE VAD EXPERIMENT');
    console.log('============================================================');
    console.log(`WAV file: ${WAV_FILE}`);
    console.log(`Format: ${fmt.sampleRate}Hz, ${fmt.channels} channel, ${fmt.bitsPerSample} bit`);
    console.log(`Speech duration: ${(pcm.length / 2 / fmt.sampleRate).toFixed(2)}s`);
    console.log(`Ground truth length: ${GROUND_TRUTH_CHARS} chars`);
    console.log(`Target question: "${FINAL_QUESTION_MARKER}"`);
    console.log('Configurations to test (5 trials each):');
    console.log('  1. Baseline (Unconfigured / default)');
    console.log('  2. Candidate A (END_SENSITIVITY_LOW, silenceDurationMs: 1500)');
    console.log('  3. Candidate B (END_SENSITIVITY_LOW, silenceDurationMs: 2000)');
    console.log('============================================================\n');

    const ai = new GoogleGenAI({ apiKey });
    const allResults = {
        startedAt: new Date().toISOString(),
        groundTruth: {
            text: GROUND_TRUTH_TEXT,
            chars: GROUND_TRUTH_CHARS,
            finalQuestion: FINAL_QUESTION_MARKER
        },
        configs: {
            Baseline: [],
            Candidate_A: [],
            Candidate_B: []
        },
        summary: {}
    };

    const configs = ['Baseline', 'Candidate_A', 'Candidate_B'];

    for (const cfg of configs) {
        for (let i = 1; i <= 5; i++) {
            try {
                const trialRes = await runSingleTrial(ai, pcm, cfg, i);
                allResults.configs[cfg].push(trialRes);
                // Flush after each trial
                fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
                // Wait 2s between trials to allow clean session teardown
                await sleep(2000);
            } catch (err) {
                console.error(`Trial ${cfg} #${i} failed:`, err);
                allResults.configs[cfg].push({ configType: cfg, trialIndex: i, error: err.message });
                fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
                await sleep(3000);
            }
        }
    }

    // Compute summaries
    for (const cfg of configs) {
        const trials = allResults.configs[cfg].filter(t => !t.error);
        const prematureCount = trials.filter(t => t.isPremature).length;
        const capturedQuestionCount = trials.filter(t => t.hasFinalQuestion).length;
        const avgChars = (trials.reduce((acc, t) => acc + t.finalCharCount, 0) / trials.length).toFixed(1);
        const latencies = trials.filter(t => !t.isPremature && t.speechEndToGenCompleteLatency !== null).map(t => t.speechEndToGenCompleteLatency);
        const avgLatencyPostSpeech = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0) : 'N/A';

        allResults.summary[cfg] = {
            totalTrials: trials.length,
            prematureCount,
            prematureRatePct: ((prematureCount / trials.length) * 100).toFixed(1) + '%',
            questionCapturedCount: capturedQuestionCount,
            questionCapturedRatePct: ((capturedQuestionCount / trials.length) * 100).toFixed(1) + '%',
            avgFinalChars: avgChars,
            avgLatencyPostSpeechMs: avgLatencyPostSpeech
        };
    }

    allResults.completedAt = new Date().toISOString();
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));

    console.log('\n============================================================');
    console.log('                   EXPERIMENT SUMMARY');
    console.log('============================================================');
    console.table(allResults.summary);
    console.log(`\nFull results written to: ${RESULTS_FILE}`);
    process.exit(0);
})().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});

