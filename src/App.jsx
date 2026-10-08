import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamChat, fetchModels, transcribe, imageToDataUrl } from "./api.js";
import { useRecorder, useSpeaker } from "./useVoice.js";

const SYSTEM_PROMPT = {
  role: "system",
  content: "You are a helpful, friendly assistant. Answer clearly and concisely.",
};

const SUGGESTIONS = [
  "Explain React hooks in simple terms",
  "Write a Python function to reverse a string",
  "Plan a 2-day trip to Pondicherry",
  "What makes Groq inference so fast?",
];

const STORAGE_KEY = "groq-chat-history";
const SETTINGS_KEY = "groq-chat-settings";
const MAX_IMAGES = 5; // Groq vision limit per request

const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

// Convert UI messages into the API format. Only the most recent images are sent
// (keeps requests small and within the vision model's image limit).
function toApiMessages(messages) {
  let lastImgIdx = -1;
  messages.forEach((m, i) => m.images?.length && (lastImgIdx = i));

  return messages.map((m, i) => {
    if (!m.images?.length) return { role: m.role, content: m.content };
    if (i !== lastImgIdx) {
      return { role: m.role, content: `${m.content}\n[${m.images.length} image(s) shared earlier]`.trim() };
    }
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content || "Describe this image." },
        ...m.images.slice(0, MAX_IMAGES).map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    };
  });
}

export default function App() {
  const [messages, setMessages] = useState(() => load(STORAGE_KEY, []));
  const [input, setInput] = useState("");
  const [images, setImages] = useState([]); // pending attachments (data URLs)
  const [models, setModels] = useState([]);
  const [visionModel, setVisionModel] = useState("");
  const [model, setModel] = useState("llama-3.3-70b-versatile");
  const [autoSpeak, setAutoSpeak] = useState(() => load(SETTINGS_KEY, {}).autoSpeak ?? false);
  const [loading, setLoading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);

  const abortRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const fileRef = useRef(null);

  const recorder = useRecorder();
  const speaker = useSpeaker();

  useEffect(() => {
    fetchModels()
      .then(({ models: list, visionModel: vm }) => {
        setVisionModel(vm || "");
        setModels(list || []);
        if (list?.length && !list.includes(model)) setModel(list[0]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // If storage is full (images are large), save history without the images
    if (!save(STORAGE_KEY, messages)) {
      save(STORAGE_KEY, messages.map(({ images: _i, ...m }) => m));
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    save(SETTINGS_KEY, { autoSpeak });
    if (!autoSpeak) speaker.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSpeak]);

  // ---------- Images ----------
  async function addImages(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return setError(`You can attach up to ${MAX_IMAGES} images.`);
    try {
      const urls = await Promise.all(files.slice(0, room).map((f) => imageToDataUrl(f)));
      setImages((prev) => [...prev, ...urls]);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      addImages(files);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    addImages(e.dataTransfer.files);
  }

  // ---------- Send ----------
  async function send(text) {
    const content = (text ?? input).trim();
    if ((!content && !images.length) || loading) return;

    setError("");
    setInput("");
    speaker.stop();
    const userMsg = { role: "user", content, ...(images.length ? { images } : {}) };
    setImages([]);

    const history = [...messages, userMsg];
    setMessages([...history, { role: "assistant", content: "" }]);
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let full = "";

    try {
      await streamChat({
        messages: [SYSTEM_PROMPT, ...toApiMessages(history)],
        model,
        signal: controller.signal,
        onToken: (token) => {
          full += token;
          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = { ...next[next.length - 1], content: full };
            return next;
          });
        },
      });
      if (autoSpeak && full) speaker.speak(full, history.length);
    } catch (e) {
      if (e.name !== "AbortError") {
        setError(e.message);
        setMessages((prev) => (prev[prev.length - 1]?.content ? prev : prev.slice(0, -1)));
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
      textareaRef.current?.focus();
    }
  }

  // ---------- Voice input ----------
  async function toggleMic() {
    setError("");
    if (recorder.recording) {
      const blob = await recorder.stop();
      if (!blob || blob.size < 1000) return setError("Didn't catch that — hold the mic a little longer.");
      setTranscribing(true);
      try {
        const text = await transcribe(blob);
        if (!text) return setError("No speech detected. Try again.");
        const combined = [input.trim(), text].filter(Boolean).join(" ");
        send(combined); // speak → send automatically
      } catch (e) {
        setError(e.message);
      } finally {
        setTranscribing(false);
      }
    } else {
      try {
        speaker.stop();
        await recorder.start();
      } catch {
        setError("Microphone access was blocked. Allow it in your browser settings.");
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function clearChat() {
    stop();
    speaker.stop();
    setMessages([]);
    setImages([]);
    setError("");
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const willUseVision = images.length > 0 || messages.some((m) => m.images?.length);
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div
      className={`app ${dragOver ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <span className="logo">⚡</span>
          <span>Hillboat Chat</span>
        </div>
        <div className="controls">
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={loading} aria-label="Model">
            {(models.length ? models : [model]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {speaker.supported && (
            <button
              className={`ghost icon ${autoSpeak ? "on" : ""}`}
              onClick={() => setAutoSpeak((v) => !v)}
              title={autoSpeak ? "Auto-read replies: ON" : "Auto-read replies: OFF"}
            >
              {autoSpeak ? "🔊" : "🔇"}
            </button>
          )}
          <button className="ghost" onClick={clearChat} disabled={!messages.length}>
            New chat
          </button>
        </div>
      </header>

      <main className="chat">
        {messages.length === 0 ? (
          <div className="empty">
            <h1>How can I help you today?</h1>
            <p>Type, talk 🎤 or drop an image 🖼️ — powered by open-source models on Groq.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`row ${m.role}`}>
              <div className="avatar">{m.role === "user" ? "You" : "AI"}</div>
              <div className="bubble">
                {m.images?.length > 0 && (
                  <div className="msg-images">
                    {m.images.map((src, j) => (
                      <img key={j} src={src} alt="" onClick={() => setPreview(src)} />
                    ))}
                  </div>
                )}
                {m.role === "assistant" ? (
                  m.content ? (
                    <>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      {speaker.supported && !(loading && i === messages.length - 1) && (
                        <button
                          className="speak"
                          onClick={() => (speaker.speakingId === i ? speaker.stop() : speaker.speak(m.content, i))}
                        >
                          {speaker.speakingId === i ? "⏹ Stop" : "🔊 Listen"}
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )
                ) : (
                  m.content && <div className="user-text">{m.content}</div>
                )}
              </div>
            </div>
          ))
        )}
        {error && <div className="error">⚠ {error}</div>}
        <div ref={bottomRef} />
      </main>

      <footer className="composer">
        {images.length > 0 && (
          <div className="attachments">
            {images.map((src, i) => (
              <div key={i} className="thumb">
                <img src={src} alt="" onClick={() => setPreview(src)} />
                <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} title="Remove">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="inputbox">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addImages(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="tool"
            onClick={() => fileRef.current?.click()}
            disabled={loading || recorder.recording}
            title="Attach image"
          >
            🖼️
          </button>

          {recorder.recording ? (
            <div className="recording">
              <span className="dot" /> Listening… {fmt(recorder.seconds)}
              <button className="link" onClick={recorder.cancel}>
                Cancel
              </button>
            </div>
          ) : transcribing ? (
            <div className="recording">Transcribing…</div>
          ) : (
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              placeholder={images.length ? "Ask about the image…" : "Message Groq Chat…  (Shift+Enter for new line)"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              autoFocus
            />
          )}

          {recorder.supported && !loading && (
            <button
              className={`tool mic ${recorder.recording ? "live" : ""}`}
              onClick={toggleMic}
              disabled={transcribing}
              title={recorder.recording ? "Stop & send" : "Speak"}
            >
              {recorder.recording ? "⏹" : "🎤"}
            </button>
          )}

          {loading ? (
            <button className="send stop" onClick={stop} title="Stop">
              ■
            </button>
          ) : (
            <button
              className="send"
              onClick={() => send()}
              disabled={(!input.trim() && !images.length) || recorder.recording || transcribing}
              title="Send"
            >
              ➤
            </button>
          )}
        </div>
        <small>
          {willUseVision && visionModel ? `Images are answered by ${visionModel.split("/").pop()} · ` : ""}
          AI can make mistakes. Check important info.
        </small>
      </footer>

      {dragOver && <div className="dropzone">Drop image to attach</div>}
      {preview && (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <img src={preview} alt="" />
        </div>
      )}
    </div>
  );
}
