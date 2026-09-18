const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Target file for persisting telemetry baseline
const TELEMETRY_FILE = path.join(__dirname, '../../telemetry_baseline.json');

// Fingerprint helper: 16-char SHA-256 (preserves privacy, no plain text stored)
function fingerprint(text) {
    if (!text || typeof text !== 'string') return '';
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Simple token estimation: 4 chars per token rule of thumb
function estimateTokens(chars) {
    return Math.max(1, Math.round(chars / 4));
}

class TelemetryCollector {
    constructor() {
        this.startTime = Date.now();
        this.activeGenerations = 0;
        this.maxConcurrentGenerations = 0;
        this.overlappingGenerationsCount = 0;

        this.counts = {
            transcripts: 0,
            generateAnswer: 0,
            groqRequests: 0,
            geminiHttpRequests: 0,
            geminiLiveAudioTurns: 0,
            screenshotRequests: 0,
            fallbackRequests: 0,
            typedMessages: 0,
            totalAiRequests: 0
        };

        this.audio = {
            inputChunks: 0,
            inputBytes: 0,
            firstInputTime: null,
            lastInputTime: null,
            outputAudioChunks: 0,
            outputAudioBytes: 0,
            outputAudioConsumed: false,
            outputHandling: 'discarded'
        };

        this.requests = [];
        this.transcriptsSeen = new Map(); // fingerprint -> count
        this.activeRequests = new Map();

        this.historySnapshots = [];

        this.overhead = {
            totalCalls: 0,
            totalOverheadMs: 0,
            errors: []
        };

        this.flushTimer = null;
        this.startPeriodicFlush();
    }

    _measure(fn) {
        const t0 = process.hrtime.bigint();
        try {
            return fn();
        } catch (err) {
            this.overhead.errors.push(err.message);
        } finally {
            const t1 = process.hrtime.bigint();
            const elapsedMs = Number(t1 - t0) / 1e6;
            this.overhead.totalCalls++;
            this.overhead.totalOverheadMs += elapsedMs;
        }
    }

    startPeriodicFlush() {
        if (this.flushTimer) clearInterval(this.flushTimer);
        this.flushTimer = setInterval(() => {
            this.flushNow();
        }, 2000);
        if (typeof this.flushTimer.unref === 'function') {
            this.flushTimer.unref();
        }
    }

    onTranscript(text, source = 'gemini-live') {
        this._measure(() => {
            this.counts.transcripts++;
            const fp = fingerprint(text);
            const count = (this.transcriptsSeen.get(fp) || 0) + 1;
            this.transcriptsSeen.set(fp, count);
        });
    }

    onGenerateAnswerStart(prompt, source = 'transcript') {
        return this._measure(() => {
            this.counts.generateAnswer++;
            this.activeGenerations++;
            if (this.activeGenerations > this.maxConcurrentGenerations) {
                this.maxConcurrentGenerations = this.activeGenerations;
            }
            if (this.activeGenerations > 1) {
                this.overlappingGenerationsCount++;
            }

            const genId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const fp = fingerprint(prompt);

            return {
                genId,
                fp,
                promptChars: prompt ? prompt.length : 0,
                startTime: Date.now(),
                source
            };
        }) || { genId: `gen_${Date.now()}`, fp: '', promptChars: 0, startTime: Date.now(), source };
    }

    onGenerateAnswerEnd(genContext, success = true, error = null) {
        this._measure(() => {
            this.activeGenerations = Math.max(0, this.activeGenerations - 1);
            this.flushNow();
        });
    }

    onGroqStart(requestId, model, transcription, messages = []) {
        this._measure(() => {
            this.counts.groqRequests++;
            this.counts.totalAiRequests++;

            let systemChars = 0;
            let historyChars = 0;
            let userCount = 0;
            let assistantCount = 0;
            let systemCount = 0;

            messages.forEach(msg => {
                const len = (msg.content || '').length;
                if (msg.role === 'system') {
                    systemCount++;
                    systemChars += len;
                } else if (msg.role === 'user') {
                    userCount++;
                    historyChars += len;
                } else if (msg.role === 'assistant') {
                    assistantCount++;
                    historyChars += len;
                }
            });

            const promptChars = transcription ? transcription.length : 0;
            const fp = fingerprint(transcription);

            const record = {
                id: requestId,
                type: 'groq',
                model: model,
                fingerprint: fp,
                promptChars,
                systemChars,
                historyChars,
                messagesCount: messages.length,
                userMessagesCount: userCount,
                assistantMessagesCount: assistantCount,
                systemMessagesCount: systemCount,
                startTime: Date.now(),
                firstTokenTime: null,
                ttft: null,
                endTime: null,
                duration: null,
                success: false,
                error: null,
                isFallback: false,
                actualUsage: null,
                actualTokensAvailable: false,
                estimatedTokens: {
                    input: estimateTokens(systemChars + historyChars + promptChars),
                    output: 0,
                    total: estimateTokens(systemChars + historyChars + promptChars)
                }
            };

            this.activeRequests.set(requestId, record);

            this.historySnapshots.push({
                timestamp: Date.now(),
                type: 'groq_pre_request',
                messagesCount: messages.length,
                userCount,
                assistantCount,
                systemCount,
                totalChars: systemChars + historyChars
            });
        });
    }

    onGroqChunk(requestId, chunkJson) {
        this._measure(() => {
            const record = this.activeRequests.get(requestId);
            if (!record) return;

            // Check TTFT
            const token = chunkJson.choices?.[0]?.delta?.content;
            if (token && !record.firstTokenTime) {
                record.firstTokenTime = Date.now();
                record.ttft = record.firstTokenTime - record.startTime;
            }

            // Check provider usage metadata
            const usage = chunkJson.x_groq?.usage || chunkJson.usage;
            if (usage && typeof usage.total_tokens === 'number') {
                record.actualUsage = {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                    queue_time: usage.queue_time,
                    prompt_time: usage.prompt_time,
                    completion_time: usage.completion_time
                };
                record.actualTokensAvailable = true;
            }
        });
    }

    onGroqEnd(requestId, success, error, outputChars = 0) {
        this._measure(() => {
            const record = this.activeRequests.get(requestId);
            if (!record) return;

            record.endTime = Date.now();
            record.duration = record.endTime - record.startTime;
            record.success = success;
            record.error = error ? error.message || String(error) : null;
            record.outputChars = outputChars;

            record.estimatedTokens.output = estimateTokens(outputChars);
            record.estimatedTokens.total = record.estimatedTokens.input + record.estimatedTokens.output;

            this.requests.push(record);
            this.activeRequests.delete(requestId);
            this.flushNow();
        });
    }

    onGeminiFallbackStart(requestId, model, transcription, messages = []) {
        this._measure(() => {
            this.counts.fallbackRequests++;
            this.counts.geminiHttpRequests++;
            this.counts.totalAiRequests++;

            let historyChars = 0;
            let userCount = 0;
            let assistantCount = 0;
            let systemCount = 0;

            messages.forEach(msg => {
                const len = (msg.parts?.[0]?.text || msg.content || '').length;
                if (msg.role === 'user') userCount++;
                else if (msg.role === 'model' || msg.role === 'assistant') assistantCount++;
                historyChars += len;
            });

            const promptChars = transcription ? transcription.length : 0;
            const fp = fingerprint(transcription);

            const record = {
                id: requestId,
                type: 'gemini_fallback',
                model: model,
                fingerprint: fp,
                promptChars,
                historyChars,
                messagesCount: messages.length,
                userMessagesCount: userCount,
                assistantMessagesCount: assistantCount,
                startTime: Date.now(),
                firstTokenTime: null,
                ttft: null,
                endTime: null,
                duration: null,
                success: false,
                error: null,
                isFallback: true,
                actualUsage: null,
                actualTokensAvailable: false,
                estimatedTokens: {
                    input: estimateTokens(historyChars + promptChars),
                    output: 0,
                    total: estimateTokens(historyChars + promptChars)
                }
            };

            this.activeRequests.set(requestId, record);

            this.historySnapshots.push({
                timestamp: Date.now(),
                type: 'gemini_fallback_pre_request',
                messagesCount: messages.length,
                userCount,
                assistantCount,
                totalChars: historyChars
            });
        });
    }

    onGeminiChunk(requestId, chunk) {
        this._measure(() => {
            const record = this.activeRequests.get(requestId);
            if (!record) return;

            if (chunk.text && !record.firstTokenTime) {
                record.firstTokenTime = Date.now();
                record.ttft = record.firstTokenTime - record.startTime;
            }

            if (chunk.usageMetadata) {
                record.actualUsage = {
                    prompt_tokens: chunk.usageMetadata.promptTokenCount,
                    completion_tokens: chunk.usageMetadata.candidatesTokenCount,
                    total_tokens: chunk.usageMetadata.totalTokenCount,
                    thoughts_tokens: chunk.usageMetadata.thoughtsTokenCount || 0
                };
                record.actualTokensAvailable = true;
            }
        });
    }

    onGeminiEnd(requestId, success, error, outputChars = 0) {
        this._measure(() => {
            const record = this.activeRequests.get(requestId);
            if (!record) return;

            record.endTime = Date.now();
            record.duration = record.endTime - record.startTime;
            record.success = success;
            record.error = error ? error.message || String(error) : null;
            record.outputChars = outputChars;

            record.estimatedTokens.output = estimateTokens(outputChars);
            record.estimatedTokens.total = record.estimatedTokens.input + record.estimatedTokens.output;

            this.requests.push(record);
            this.activeRequests.delete(requestId);
            this.flushNow();
        });
    }

    onImageRequestStart(requestId, model, prompt, base64Data) {
        this._measure(() => {
            this.counts.screenshotRequests++;
            this.counts.geminiHttpRequests++;
            this.counts.totalAiRequests++;

            const imageBytes = base64Data ? Math.round((base64Data.length * 3) / 4) : 0;
            const promptChars = prompt ? prompt.length : 0;
            const fp = fingerprint(prompt || 'screenshot_no_prompt');

            const record = {
                id: requestId,
                type: 'gemini_image',
                model: model,
                fingerprint: fp,
                promptChars,
                imageBytes,
                startTime: Date.now(),
                firstTokenTime: null,
                ttft: null,
                endTime: null,
                duration: null,
                success: false,
                error: null,
                isFallback: false,
                actualUsage: null,
                actualTokensAvailable: false,
                multimodal: {
                    hasImage: true,
                    imageBytes
                },
                estimatedTokens: {
                    input: estimateTokens(promptChars) + 258, // standard Gemini 258 image token baseline
                    output: 0,
                    total: estimateTokens(promptChars) + 258
                }
            };

            this.activeRequests.set(requestId, record);
        });
    }

    onLiveAudioInput(byteCount) {
        this._measure(() => {
            this.audio.inputChunks++;
            this.audio.inputBytes += byteCount;
            if (!this.audio.firstInputTime) this.audio.firstInputTime = Date.now();
            this.audio.lastInputTime = Date.now();
        });
    }

    onLiveAudioOutput(byteCount) {
        this._measure(() => {
            this.audio.outputAudioChunks++;
            this.audio.outputAudioBytes += byteCount;
            // The code currently has zero audio output playback or routing
            this.audio.outputAudioConsumed = false;
            this.audio.outputHandling = 'discarded';
        });
    }

    onTextMessage(text) {
        this._measure(() => {
            this.counts.typedMessages++;
        });
    }

    flushNow() {
        this._measure(() => {
            const data = this.getBaselineReportData();
            try {
                fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(data, null, 2), 'utf8');
            } catch (err) {
                this.overhead.errors.push(`Flush error: ${err.message}`);
            }
        });
    }

    getBaselineReportData() {
        const audioDurationSec = (this.audio.firstInputTime && this.audio.lastInputTime)
            ? Math.max(0.1, (this.audio.lastInputTime - this.audio.firstInputTime) / 1000)
            : 0;
        const inputBytesPerSec = audioDurationSec > 0 ? Math.round(this.audio.inputBytes / audioDurationSec) : 0;

        return {
            timestamp: new Date().toISOString(),
            elapsedMs: Date.now() - this.startTime,
            counts: { ...this.counts },
            concurrency: {
                maxConcurrentGenerations: this.maxConcurrentGenerations,
                overlappingGenerationsCount: this.overlappingGenerationsCount,
                overlapPercentage: this.counts.generateAnswer > 0
                    ? Number(((this.overlappingGenerationsCount / this.counts.generateAnswer) * 100).toFixed(1))
                    : 0
            },
            audio: {
                ...this.audio,
                audioDurationSec: Number(audioDurationSec.toFixed(2)),
                inputBytesPerSec
            },
            requests: this.requests,
            transcriptsSeen: Object.fromEntries(this.transcriptsSeen),
            historySnapshots: this.historySnapshots,
            overhead: {
                ...this.overhead,
                totalOverheadMs: Number(this.overhead.totalOverheadMs.toFixed(3))
            }
        };
    }
}

// Global singleton instance
let instance = null;
function getTelemetry() {
    if (!instance) {
        instance = new TelemetryCollector();
    }
    return instance;
}

module.exports = {
    getTelemetry,
    fingerprint
};

