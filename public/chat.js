/**
 * chat.js — Voice + text logging for Elina Tracker
 *
 * - Press-and-hold mic button to record
 * - Web Speech API first, MediaRecorder + Whisper as fallback
 * - Text chat interface with chat history
 * - All entries POSTed to /api/chat (same NLP pipeline as Telegram bot)
 */

'use strict';

// ---------------------------------------------------------------------------
// Clock / date header
// ---------------------------------------------------------------------------

function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById('current-time');
  const dateEl = document.getElementById('current-date');
  if (timeEl) {
    timeEl.textContent = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }
}
setInterval(updateClock, 1000);
updateClock();

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------

const chatHistory = document.getElementById('chat-history');

function nowTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Append a message bubble to the chat history.
 * @param {'user'|'bot'} role
 * @param {string} text
 * @param {'normal'|'success'|'warn'|'error'} [style]
 */
function appendMessage(role, text, style = 'normal') {
  const row = document.createElement('div');
  row.className = `chat-bubble-row ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (role === 'bot' && style !== 'normal') {
    bubble.classList.add(style);
  }
  bubble.textContent = text;

  const ts = document.createElement('div');
  ts.className = 'chat-timestamp';
  ts.textContent = nowTime();

  row.appendChild(bubble);
  row.appendChild(ts);
  chatHistory.appendChild(row);

  // Scroll to bottom
  row.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// Show initial welcome message
appendMessage(
  'bot',
  'Hi! You can type or hold the mic 🎤 to log entries. Try: 120ml pediasure and 45ml water or pee 80ml',
  'normal'
);

// ---------------------------------------------------------------------------
// Send text to /api/chat
// ---------------------------------------------------------------------------

async function sendToChat(text) {
  if (!text || !text.trim()) return;

  appendMessage('user', text);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
    });
    const data = await res.json();

    if (data.ok) {
      appendMessage('bot', data.message, 'success');
    } else {
      appendMessage('bot', data.message || data.error || '❌ Something went wrong', 'warn');
    }
  } catch (err) {
    appendMessage('bot', '❌ Network error — are you connected?', 'error');
  }
}

// ---------------------------------------------------------------------------
// Text input bar
// ---------------------------------------------------------------------------

const chatTextInput = document.getElementById('chat-text-input');
const chatSendBtn = document.getElementById('chat-send-btn');

function submitText() {
  const text = chatTextInput.value.trim();
  if (!text) return;
  chatTextInput.value = '';
  sendToChat(text);
}

chatSendBtn.addEventListener('click', submitText);
chatTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitText();
  }
});

// ---------------------------------------------------------------------------
// Transcription area
// ---------------------------------------------------------------------------

const transcriptionArea = document.getElementById('transcription-area');
const transcriptionInput = document.getElementById('transcription-input');
const btnLogIt = document.getElementById('btn-log-it');
const btnCancelTranscription = document.getElementById('btn-cancel-transcription');
const transcribingSpinner = document.getElementById('transcribing-spinner');

function showTranscription(text) {
  transcriptionArea.style.display = 'flex';
  transcribingSpinner.style.display = 'none';
  transcriptionInput.value = text;
  transcriptionInput.focus();
  // Place cursor at end
  transcriptionInput.setSelectionRange(text.length, text.length);
}

function hideTranscription() {
  transcriptionArea.style.display = 'none';
  transcriptionInput.value = '';
}

function showTranscribing() {
  transcribingSpinner.style.display = 'flex';
  transcriptionArea.style.display = 'none';
}

function hideTranscribing() {
  transcribingSpinner.style.display = 'none';
}

btnLogIt.addEventListener('click', () => {
  const text = transcriptionInput.value.trim();
  if (!text) return;
  hideTranscription();
  sendToChat(text);
});

btnCancelTranscription.addEventListener('click', () => {
  hideTranscription();
  hideTranscribing();
});

// ---------------------------------------------------------------------------
// Voice: Web Speech API
// ---------------------------------------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * Use Web Speech API to get a transcript.
 * Returns a Promise that resolves to { text } or rejects on error.
 */
function recognizeWithWebSpeech() {
  return new Promise((resolve, reject) => {
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let resolved = false;

    recognition.onresult = (event) => {
      if (resolved) return;
      resolved = true;
      const transcript = event.results[0][0].transcript;
      resolve({ text: transcript });
    };

    recognition.onerror = (event) => {
      if (resolved) return;
      resolved = true;
      reject(new Error('Web Speech error: ' + event.error));
    };

    recognition.onend = () => {
      if (!resolved) {
        resolved = true;
        reject(new Error('No speech detected'));
      }
    };

    recognition.start();
  });
}

// ---------------------------------------------------------------------------
// Voice: MediaRecorder + Whisper fallback
// ---------------------------------------------------------------------------

let mediaRecorder = null;
let audioChunks = [];
let mediaStream = null;

async function startMediaRecorder() {
  // Request microphone (iOS Safari: this MUST happen in a user gesture handler — it does)
  if (!mediaStream) {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  audioChunks = [];

  // Pick the best MIME type Whisper supports
  let mimeType = 'audio/webm';
  if (!MediaRecorder.isTypeSupported('audio/webm')) {
    mimeType = MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : 'audio/mp4';
  }

  mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.start(100); // collect chunks every 100ms
}

function stopMediaRecorder() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve(null);
      return;
    }
    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mimeType });
      resolve(blob);
    };
    mediaRecorder.stop();
  });
}

async function transcribeWithWhisper(audioBlob) {
  const formData = new FormData();
  // Use .webm extension by default — Whisper accepts webm, ogg, mp4
  const ext = audioBlob.type.includes('ogg') ? 'ogg' : audioBlob.type.includes('mp4') ? 'mp4' : 'webm';
  formData.append('audio', audioBlob, `recording.${ext}`);

  const res = await fetch('/api/transcribe', {
    method: 'POST',
    body: formData,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Transcription failed');
  return data.text;
}

// ---------------------------------------------------------------------------
// Mic button — press and hold
// ---------------------------------------------------------------------------

const micBtn = document.getElementById('mic-btn');
const micLabel = document.getElementById('mic-label');
const micTimer = document.getElementById('mic-timer');

let isRecording = false;
let recordingStartTime = null;
let timerInterval = null;
let webSpeechRecognition = null;
let holdTimeout = null; // must hold at least 1 second

// Minimum hold duration (ms) before we process the recording
const MIN_HOLD_MS = 1000;

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  recordingStartTime = Date.now();

  micBtn.classList.add('recording');
  micBtn.setAttribute('aria-pressed', 'true');
  micLabel.textContent = 'Recording... release to send';
  micLabel.classList.add('recording');
  micTimer.style.display = 'block';
  micTimer.textContent = '0:00';

  // Update timer every second
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    micTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }, 500);

  if (SpeechRecognition) {
    // Web Speech API: start immediately
    webSpeechRecognition = new SpeechRecognition();
    webSpeechRecognition.lang = 'en-US';
    webSpeechRecognition.continuous = false;
    webSpeechRecognition.interimResults = false;
    webSpeechRecognition.maxAlternatives = 1;
    // Don't call .start() yet — we'll start it when released (or use interim results)
    // Actually start it now so it captures while user holds
    webSpeechRecognition.start();
  } else {
    // MediaRecorder fallback: start recording
    startMediaRecorder().catch((err) => {
      console.error('[chat] MediaRecorder error:', err);
      stopRecording(true); // abort
      appendMessage('bot', '❌ Could not access microphone: ' + err.message, 'error');
    });
  }
}

async function stopRecording(abort = false) {
  if (!isRecording) return;
  isRecording = false;

  clearInterval(timerInterval);
  micBtn.classList.remove('recording');
  micBtn.setAttribute('aria-pressed', 'false');
  micLabel.textContent = 'Hold to record';
  micLabel.classList.remove('recording');
  micTimer.style.display = 'none';

  const heldMs = Date.now() - recordingStartTime;

  if (abort || heldMs < MIN_HOLD_MS) {
    // Too short — ignore
    if (webSpeechRecognition) {
      try { webSpeechRecognition.abort(); } catch (_) {}
      webSpeechRecognition = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    return;
  }

  showTranscribing();

  if (SpeechRecognition && webSpeechRecognition) {
    // Stop Web Speech and wait for result
    let transcript = null;
    try {
      // Web Speech API fires result asynchronously after stop()
      transcript = await new Promise((resolve, reject) => {
        let settled = false;

        webSpeechRecognition.onresult = (event) => {
          if (settled) return;
          settled = true;
          resolve(event.results[0]?.[0]?.transcript || '');
        };
        webSpeechRecognition.onerror = (event) => {
          if (settled) return;
          settled = true;
          reject(new Error(event.error));
        };
        webSpeechRecognition.onend = () => {
          if (!settled) {
            settled = true;
            resolve('');
          }
        };

        webSpeechRecognition.stop();
      });
    } catch (err) {
      console.warn('[chat] Web Speech failed, trying Whisper:', err.message);
      transcript = null;
    }
    webSpeechRecognition = null;

    if (transcript && transcript.trim()) {
      hideTranscribing();
      showTranscription(transcript.trim());
    } else {
      // Web Speech gave nothing — fall through to MediaRecorder+Whisper
      hideTranscribing();
      appendMessage('bot', '🎤 Web Speech returned nothing. Try typing instead, or tap-hold the mic again.', 'warn');
    }
  } else {
    // MediaRecorder path
    try {
      const audioBlob = await stopMediaRecorder();
      if (!audioBlob || audioBlob.size < 1000) {
        hideTranscribing();
        appendMessage('bot', '🎤 Recording was too short or empty. Try again.', 'warn');
        return;
      }

      const text = await transcribeWithWhisper(audioBlob);
      hideTranscribing();
      showTranscription(text);
    } catch (err) {
      hideTranscribing();
      console.error('[chat] Whisper transcription error:', err);
      appendMessage('bot', '❌ Transcription failed: ' + err.message + '. You can type instead.', 'error');
    }
  }
}

// Event handlers for press-and-hold (touch + mouse)
micBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  startRecording();
});

micBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startRecording();
}, { passive: false });

micBtn.addEventListener('mouseup', () => stopRecording());
micBtn.addEventListener('mouseleave', () => { if (isRecording) stopRecording(); });
micBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopRecording();
});
micBtn.addEventListener('touchcancel', () => stopRecording(true));

// Prevent context menu on long-press (mobile)
micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
