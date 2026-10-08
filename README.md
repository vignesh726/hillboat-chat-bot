# ⚡ Groq Chat — React + Open-Source LLMs (text, images & voice)

A ChatGPT-style chatbot built with **React (Vite)** that talks to open-source models
hosted on **Groq** for very fast responses.

## Features
- 💬 **Chat** — real-time streaming replies, Markdown & code rendering, stop button, model picker
- 🖼️ **Images** — attach (button), paste (Ctrl+V) or drag & drop up to 5 images and ask about them.
  Image messages are answered automatically by a Groq vision model — the server picks
  one your account has (currently `qwen/qwen3.8-27b`) and skips retired ones.
- 🎤 **Voice input** — tap the mic, speak, tap again → transcribed by Groq Whisper and sent.
- 🔊 **Voice output** — "Listen" button on every reply, or turn on auto-read (speaker icon in the top bar).
  Uses the browser's built-in voices, so it's free.
- Chat history saved in the browser, light/dark mode, mobile friendly
- API key stays on the server (small Express proxy) — never exposed in the browser

## Setup

1. Get a free API key: https://console.groq.com/keys
2. Install and configure:
   ```bash
   npm install
   cp .env.example .env      # Windows: copy .env.example .env
   ```
   Open `.env` and paste your key into `GROQ_API_KEY`.
3. Run in development:
   ```bash
   npm run dev
   ```
   Open http://localhost:5173

> The microphone only works on `localhost` or an `https://` site (browser security rule).

## Production
```bash
npm run build
npm start          # serves the app + API on http://localhost:3001
```

## Project structure
```
server.js          Express proxy → Groq API
                   /api/chat (streaming, text + images), /api/models, /api/transcribe (Whisper)
src/App.jsx        Chat UI
src/api.js         Stream reader, image resizing, transcription call
src/useVoice.js    Microphone recorder + text-to-speech hooks
src/App.css        Styles
```

## Customize
- **System prompt / personality:** `SYSTEM_PROMPT` in `src/App.jsx`
- **Default chat model:** `useState("llama-3.3-70b-versatile")` in `src/App.jsx`
- **Vision / speech models:** optional `VISION_MODEL` and `STT_MODEL` in `.env`
  (leave `VISION_MODEL` unset to let the server choose automatically)
- **Transcription language:** Whisper auto-detects (Tamil, Hindi, English, …). To force one,
  change `"/api/transcribe"` in `src/api.js` to e.g. `"/api/transcribe?lang=ta"`.
- **Creativity:** `temperature` in `server.js`

Groq retires models from time to time — if images or voice stop working, check
https://console.groq.com/docs/models and update the model names in `.env`.
