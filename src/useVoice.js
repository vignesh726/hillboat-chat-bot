import { useEffect, useRef, useState } from "react";

// ---------- Microphone recording (speech → audio blob) ----------
function pickMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
}

export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const resolveRef = useRef(null);

  const supported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder;

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(timerRef.current);
      setRecording(false);
      resolveRef.current?.(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    };
    recorderRef.current = rec;
    rec.start();
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    setRecording(true);
  }

  // Stops recording and resolves with the audio Blob
  function stop() {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      else resolve(null);
    });
  }

  function cancel() {
    resolveRef.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  useEffect(() => () => cancel(), []);

  return { supported, recording, seconds, start, stop, cancel };
}

// ---------- Read replies aloud (browser text-to-speech) ----------
function toSpeakable(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function useSpeaker() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speakingId, setSpeakingId] = useState(null);

  function speak(text, id) {
    if (!supported) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(toSpeakable(text));
    utter.rate = 1;
    utter.onend = utter.onerror = () => setSpeakingId((cur) => (cur === id ? null : cur));
    setSpeakingId(id);
    window.speechSynthesis.speak(utter);
  }

  function stop() {
    if (supported) window.speechSynthesis.cancel();
    setSpeakingId(null);
  }

  useEffect(() => () => supported && window.speechSynthesis.cancel(), [supported]);

  return { supported, speakingId, speak, stop };
}
