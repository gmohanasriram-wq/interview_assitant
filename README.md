# AI Interview Assistant

An Electron-based AI interview assistant that provides real-time interview support using live speech transcription, screen understanding, and LLM-powered response generation.

> **Note:** This project is based on an open-source Electron interview assistant and has been extensively enhanced with a redesigned transcript processing pipeline, Groq integration, improved push-to-talk behavior, transcript stabilization, and multiple runtime reliability improvements.

---

## Features

- 🎙️ Real-time speech transcription using Gemini Live
- 🤖 Groq-powered interview answer generation
- 🔄 Automatic Gemini fallback for improved reliability
- 🖥️ Screenshot-based contextual understanding
- 🎤 Push-to-Talk recording mode
- 📝 Transcript stabilization and synchronization
- ⚡ Improved runtime performance and application stability
- 🪟 Transparent always-on-top overlay
- 📋 Multiple interview profiles
- 💻 Cross-platform support (Windows, macOS, Linux)

---

## Tech Stack

- Electron
- JavaScript
- Google Gemini Live API
- Google Gemini Flash
- Groq API

---

## Setup

1. Clone the repository

```bash
git clone <your-repository-url>
cd interview_assistant
```

2. Install dependencies

```bash
npm install
```

3. Configure your API keys

- Google Gemini API Key
- Groq API Key

4. Start the application

```bash
npm start
```

---

## Usage

1. Launch the application.
2. Enter your API keys.
3. Start an interview session.
4. Hold the **Space** key to record the interviewer's question.
5. Release **Space** to process the transcript.
6. Receive AI-generated answers in real time.

---

## Architecture

```
Interviewer Audio
        │
        ▼
 Gemini Live
(Speech-to-Text)
        │
        ▼
Transcript Processing Pipeline
        │
        ▼
Groq
Primary Answer Generator
        │
        ▼
Gemini Fallback
(If Groq is unavailable)
        │
        ▼
Interview Assistant Overlay
```

---

## Enhancements

Compared to the original open-source project, this version includes:

- Redesigned transcript processing pipeline
- Groq-powered answer generation
- Automatic Gemini fallback mechanism
- Improved Push-to-Talk workflow
- Transcript stabilization
- Better transcript synchronization
- Runtime reliability improvements
- Performance optimizations
- Extensive debugging and logging enhancements

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl/Cmd + Arrow Keys** | Move overlay window |
| **Ctrl/Cmd + M** | Toggle click-through mode |
| **Ctrl/Cmd + \\** | Close window / Go back |
| **Enter** | Send message |
| **Space (Hold)** | Record interviewer audio |
| **Space (Release)** | Process transcript and generate answer |

---

## Requirements

- Windows, macOS, or Linux
- Node.js
- Google Gemini API Key
- Groq API Key
- Screen recording permission
- Microphone permission

---

## Acknowledgements

This project is based on an open-source Electron interview assistant and has been extensively enhanced with significant architectural improvements, new AI integrations, transcript processing enhancements, and runtime optimizations.
