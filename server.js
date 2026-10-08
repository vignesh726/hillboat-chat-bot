import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const GROQ_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const API_KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 3001;
const STT_MODEL = process.env.STT_MODEL || "whisper-large-v3-turbo";

// Vision models to try, in order. Groq retires models over time, so the server
// picks the first one that your account actually has (see resolveVisionModel).
const VISION_CANDIDATES = [
  process.env.VISION_MODEL,
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
].filter(Boolean);
let VISION_MODEL = VISION_CANDIDATES[0];

if (!API_KEY) {
  console.warn("⚠  GROQ_API_KEY is missing. Copy .env.example to .env and add your key.");
}

// Fallback list of open-source models if the live model list can't be fetched
const FALLBACK_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  VISION_MODEL,
];

const authHeader = { Authorization: `Bearer ${API_KEY}` };

// ---------- Models ----------
let cachedIds = null;
let cachedAt = 0;

async function listModelIds() {
  if (cachedIds && Date.now() - cachedAt < 10 * 60 * 1000) return cachedIds;
  const r = await fetch(`${GROQ_URL}/models`, { headers: authHeader });
  if (!r.ok) throw new Error(`Groq returned ${r.status}`);
  const { data } = await r.json();
  cachedIds = data.filter((m) => m.active !== false).map((m) => m.id);
  cachedAt = Date.now();
  return cachedIds;
}

// Pick the first vision candidate that exists on this Groq account
async function resolveVisionModel() {
  try {
    const ids = await listModelIds();
    const found =
      VISION_CANDIDATES.find((c) => ids.includes(c)) ||
      ids.find((id) => /vision|llama-4|qwen3\.\d+-\d+b|scout|maverick/i.test(id));
    if (found) VISION_MODEL = found;
  } catch {
    /* keep current choice */
  }
  return VISION_MODEL;
}

app.get("/api/models", async (_req, res) => {
  try {
    const ids = await listModelIds();
    const models = ids.filter((id) => !/whisper|tts|guard|orpheus|playai|distil/i.test(id)).sort();
    res.json({ models: models.length ? models : FALLBACK_MODELS, visionModel: await resolveVisionModel() });
  } catch {
    res.json({ models: FALLBACK_MODELS, visionModel: VISION_MODEL });
  }
});

// ---------- Chat (text + images), streamed ----------
const hasImage = (msg) =>
  Array.isArray(msg.content) && msg.content.some((p) => p.type === "image_url");

app.post("/api/chat", express.json({ limit: "20mb" }), async (req, res) => {
  const { messages, model, temperature = 0.7 } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages array is required" });
  }
  if (!API_KEY) return res.status(500).json({ error: "Server is missing GROQ_API_KEY" });

  // Any image in the request → switch to a vision model automatically
  const isVision = messages.some(hasImage);
  const first = isVision ? await resolveVisionModel() : model || FALLBACK_MODELS[0];
  // For images, if the chosen model is missing, fall through to the next candidate
  const toTry = isVision ? [first, ...VISION_CANDIDATES.filter((c) => c !== first)] : [first];

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    let r, useModel, errMsg;
    for (useModel of toTry) {
      r = await fetch(`${GROQ_URL}/chat/completions`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ model: useModel, messages, temperature, stream: true }),
        signal: controller.signal,
      });
      if (r.ok) break;
      const err = await r.json().catch(() => ({}));
      errMsg = err?.error?.message || `Groq error ${r.status}`;
      const missing = r.status === 404 || /does not exist|model_not_found|decommissioned|not have access/i.test(errMsg);
      if (!missing) break; // a real error (rate limit, bad image…) → report it
      console.warn(`Model ${useModel} unavailable, trying next…`);
    }

    if (!r.ok) {
      if (isVision && /does not exist|model_not_found|decommissioned|not have access/i.test(errMsg)) {
        errMsg =
          "No vision model is available on your Groq account. Check https://console.groq.com/docs/vision and set VISION_MODEL in .env.";
      }
      return res.status(r.status).json({ error: errMsg });
    }
    if (isVision) VISION_MODEL = useModel;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Model-Used", useModel);
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    if (e.name === "AbortError") return;
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
});

// ---------- Voice: speech-to-text with Groq Whisper ----------
app.post(
  "/api/transcribe",
  express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: "25mb" }),
  async (req, res) => {
    if (!API_KEY) return res.status(500).json({ error: "Server is missing GROQ_API_KEY" });
    if (!req.body?.length) return res.status(400).json({ error: "No audio received" });

    const mime = (req.headers["content-type"] || "audio/webm").split(";")[0];
    const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";

    const form = new FormData();
    form.append("file", new Blob([req.body], { type: mime }), `speech.${ext}`);
    form.append("model", STT_MODEL);
    form.append("response_format", "json");
    if (req.query.lang) form.append("language", String(req.query.lang));

    try {
      const r = await fetch(`${GROQ_URL}/audio/transcriptions`, {
        method: "POST",
        headers: authHeader,
        body: form,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json({ error: data?.error?.message || `Groq error ${r.status}` });
      }
      res.json({ text: (data.text || "").trim() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ---------- Serve the built React app in production ----------
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res, next) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"), (err) => err && next());
});

app.listen(PORT, () => console.log(`API server running on http://localhost:${PORT}`));
