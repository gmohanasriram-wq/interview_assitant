/**
 * Phase 3B-3 — Gemini Live turn-timing diagnostic (READ-ONLY).
 *
 * INVESTIGATION TOOL. Does not import or modify production code paths that
 * dispatch answers. It opens its OWN Live connection with a config replicated
 * from src/utils/gemini.js:697-783 and streams synthesized speech (diag_speech.wav)
 * to observe exactly WHEN each server signal arrives relative to speech end.
 *
 * Measures the generationComplete wait that the audit estimated at 1-2s, and
 * whether an earlier signal (inputTranscription.finished / voiceActivity
 * ACTIVITY_END) is available to dispatch on.
 *
 * Run:  node probe_live_turn_timing.js
 */

const fs = require('fs');
const path = require('path');
const storage = require('./src/storage');
const { GoogleGenAI, Modality } = require('@google/genai');
const { getSystemPrompt } = require('./src/utils/prompts');

const WAV = path.join(__dirname, process.argv[2] || 'diag_speech.wav');
const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // 16-bit mono
const SILENCE_TAIL_MS = 4000;

/** Parse the PCM payload out of a RIFF/WAVE file (do not assume a 44-byte header). */
function readWavPcm(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Not a RIFF/WAVE file');
    }
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
    if (!fmt || !data) throw new Error('Missing fmt or data chunk');
    return { fmt, pcm: data };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const apiKey = storage.getApiKey();
    if (!apiKey) { console.error('No Gemini API key configured.'); process.exit(1); }

    const { fmt, pcm } = readWavPcm(WAV);
    console.log(`WAV fmt: ${fmt.sampleRate}Hz ${fmt.channels}ch ${fmt.bitsPerSample}bit  pcmBytes=${pcm.length}`);
    if (fmt.sampleRate !== SAMPLE_RATE || fmt.channels !== 1 || fmt.bitsPerSample !== 16) {
        console.error('Unexpected WAV format; expected 24000Hz mono 16-bit.');
        process.exit(1);
    }

    const ai = new GoogleGenAI({ apiKey });

    const events = [];          // { t, kind, detail }
    let t0 = 0;
    const mark = (kind, detail) => {
        const t = Date.now() - t0;
        events.push({ t, kind, detail });
        return t;
    };

    let transcript = '';
    let lastTranscriptAt = null;
    let finishedAt = null;
    let generationCompleteAt = null;
    let turnCompleteAt = null;
    let interruptedAt = null;

    console.log('\nConnecting to Live session (production-identical config)...');

    const session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        callbacks: {
            onopen: () => console.log('[onopen] connected'),
            onmessage: (message) => {
                const sc = message.serverContent;
                if (message.voiceActivity) {
                    mark('voiceActivity', message.voiceActivity.voiceActivityType || '(no type)');
                }
                if (message.voiceActivityDetectionSignal) {
                    mark('vadSignal', message.voiceActivityDetectionSignal.vadSignalType || '(no type)');
                }
                if (sc?.inputTranscription) {
                    const it = sc.inputTranscription;
                    if (it.results) {
                        for (const r of it.results) {
                            mark('transcript.speakerResult', JSON.stringify(r));
                            transcript += `[spk${r.speakerId}] ${r.transcript}\n`;
                        }
                    } else if (it.text) {
                        mark('transcript.text', JSON.stringify(it.text));
                        transcript += it.text;
                    }
                    if (it.finished === true && finishedAt === null) {
                        finishedAt = mark('transcript.FINISHED', 'inputTranscription.finished=true');
                    }
                    lastTranscriptAt = Date.now() - t0;
                }
                if (sc?.interrupted && interruptedAt === null) {
                    interruptedAt = mark('interrupted', 'model generation interrupted');
                }
                if (sc?.generationComplete && generationCompleteAt === null) {
                    generationCompleteAt = mark('generationComplete', 'PRODUCTION DISPATCH TRIGGER');
                }
                if (sc?.turnComplete && turnCompleteAt === null) {
                    turnCompleteAt = mark('turnComplete', 'reason=' + (sc.turnCompleteReason || 'n/a'));
                }
            },
            onerror: (e) => console.log('[onerror]', e.message),
            onclose: (e) => console.log('[onclose]', e.reason),
        },
        config: {
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
        },
    });

    await sleep(500);
    t0 = Date.now();
    mark('audio.start', 'begin streaming synthesized speech');

    console.log(`Streaming ${pcm.length} bytes of speech, then ${SILENCE_TAIL_MS}ms silence...\n`);

    let offset = 0;
    while (offset < pcm.length) {
        const slice = pcm.subarray(offset, offset + BYTES_PER_CHUNK);
        await session.sendRealtimeInput({
            audio: { data: Buffer.from(slice).toString('base64'), mimeType: 'audio/pcm;rate=24000' },
        });
        offset += BYTES_PER_CHUNK;
        await sleep(CHUNK_MS);
    }
    const audioEndAt = mark('audio.end', 'speech finished (user stopped talking)');

    // Keep the audio timeline alive with silence so server VAD can commit end-of-speech.
    const silence = Buffer.alloc(BYTES_PER_CHUNK);
    const silenceUntil = Date.now() + SILENCE_TAIL_MS;
    while (Date.now() < silenceUntil && generationCompleteAt === null) {
        await session.sendRealtimeInput({
            audio: { data: silence.toString('base64'), mimeType: 'audio/pcm;rate=24000' },
        });
        await sleep(CHUNK_MS);
    }

    // Grace period for any late signals.
    await sleep(2500);

    console.log('=== EVENT TIMELINE (ms relative to audio.start) ===');
    for (const e of events) {
        console.log(`  +${String(e.t).padStart(6)}ms  ${e.kind.padEnd(26)} ${e.detail || ''}`);
    }

    const rel = v => (v === null ? null : v);
    const delta = (a, b) => (a === null || b === null ? null : a - b);

    const summary = {
        audioEndAtMs: audioEndAt,
        lastTranscriptAtMs: rel(lastTranscriptAt),
        transcriptFinishedAtMs: rel(finishedAt),
        generationCompleteAtMs: rel(generationCompleteAt),
        turnCompleteAtMs: rel(turnCompleteAt),
        interruptedAtMs: rel(interruptedAt),
        // The delay this phase is about: speech end -> production dispatch trigger
        speechEndToGenerationCompleteMs: delta(generationCompleteAt, audioEndAt),
        // Best-case saving if we could dispatch on the last transcript instead
        lastTranscriptToGenerationCompleteMs: delta(generationCompleteAt, lastTranscriptAt),
        generationCompleteToTurnCompleteMs: delta(turnCompleteAt, generationCompleteAt),
        transcriptChars: transcript.length,
        transcriptPreview: transcript.slice(0, 200),
        sawFinishedFlag: finishedAt !== null,
        sawVoiceActivity: events.some(e => e.kind === 'voiceActivity'),
        sawVadSignal: events.some(e => e.kind === 'vadSignal'),
        transcriptChunkCount: events.filter(e => e.kind.startsWith('transcript.')).length,
    };

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify(summary, null, 2));

    fs.writeFileSync(
        path.join(__dirname, 'probe_live_turn_timing_results.json'),
        JSON.stringify({ timestamp: new Date().toISOString(), summary, events }, null, 2)
    );
    console.log('\nSaved to probe_live_turn_timing_results.json');

    try { session.close(); } catch { /* ignore */ }
    process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
