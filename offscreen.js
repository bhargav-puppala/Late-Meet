let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let analyserNode = null;
let chunkTimer = null;

let pendingChunks = [];
let isChunkRequested = false;

const CHUNK_MS = 8000;
const RMS_THRESHOLD = 0.012;
const SILENCE_LIMIT = 3;
let consecutiveSilent = 0;

function toBase64(arrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function pickSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus'
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getCurrentRms() {
  if (!analyserNode) return 0;

  const buffer = new Uint8Array(analyserNode.fftSize);
  analyserNode.getByteTimeDomainData(buffer);

  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const normalized = (buffer[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }

  return Math.sqrt(sumSquares / buffer.length);
}

async function flushAudioChunk() {
  if (isChunkRequested || !mediaRecorder || mediaRecorder.state !== 'recording') return;

  const rms = getCurrentRms();
  if (rms < RMS_THRESHOLD) {
    consecutiveSilent += 1;
    if (consecutiveSilent >= SILENCE_LIMIT) {
      return;
    }
  } else {
    consecutiveSilent = 0;
  }

  isChunkRequested = true;
  mediaRecorder.requestData();
}

async function postChunk(blob) {
  if (!blob || blob.size === 0) return;

  const buffer = await blob.arrayBuffer();
  const audioBase64 = toBase64(buffer);

  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_AUDIO_CHUNK',
    audioBase64
  });
}

async function startCapture(tabId) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return;
  }

  mediaStream = await chrome.tabCapture.capture({
    audio: true,
    video: false,
    targetTabId: tabId
  });

  if (!mediaStream) {
    throw new Error('Failed to capture tab audio stream');
  }

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 1024;
  source.connect(analyserNode);

  const mimeType = pickSupportedMimeType();
  mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);

  mediaRecorder.addEventListener('dataavailable', event => {
    if (event.data && event.data.size > 0) {
      pendingChunks.push(event.data);
    }
    isChunkRequested = false;
  });

  mediaRecorder.addEventListener('stop', async () => {
    try {
      for (const blob of pendingChunks) {
        await postChunk(blob);
      }
    } catch (err) {
      console.error('[LateMeet][offscreen] Failed to flush pending chunks:', err);
    } finally {
      pendingChunks = [];
    }
  });

  mediaRecorder.start();

  chunkTimer = setInterval(async () => {
    try {
      await flushAudioChunk();
      while (pendingChunks.length > 0) {
        const blob = pendingChunks.shift();
        await postChunk(blob);
      }
    } catch (err) {
      console.error('[LateMeet][offscreen] Chunk pipeline error:', err);
    }
  }, CHUNK_MS);
}

async function stopCapture() {
  if (chunkTimer) {
    clearInterval(chunkTimer);
    chunkTimer = null;
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  mediaRecorder = null;
  analyserNode = null;
  pendingChunks = [];
  isChunkRequested = false;
  consecutiveSilent = 0;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === 'OFFSCREEN_START_CAPTURE') {
      try {
        await startCapture(message.tabId);
        sendResponse({ success: true });
      } catch (err) {
        console.error('[LateMeet][offscreen] Failed to start capture:', err);
        sendResponse({ success: false, error: err.message || 'Start capture failed' });
      }
      return;
    }

    if (message?.type === 'OFFSCREEN_STOP_CAPTURE') {
      try {
        await stopCapture();
      } finally {
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CAPTURE_STOPPED' });
      }
      sendResponse({ success: true });
      return;
    }

    sendResponse({ success: false, error: 'Unknown message type' });
  })();

  return true;
});
