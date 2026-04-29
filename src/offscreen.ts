let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let chunkTimer: number | NodeJS.Timeout | null = null;

let pendingChunks: Blob[] = [];
let isChunkRequested = false;
let isStopping = false;
let isDrainingQueue = false;

const CHUNK_MS = 8000;
const RMS_THRESHOLD = 0.012;
const SILENCE_LIMIT = 3;
let consecutiveSilent = 0;
let isFlushInProgress = false;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64String = result.split(',')[1];
      resolve(base64String);
    };
    reader.readAsDataURL(blob);
  });
}

function pickSupportedMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus'
  ];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function getCurrentRms(): number {
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
  if (isFlushInProgress || isChunkRequested || !mediaRecorder || mediaRecorder.state !== 'recording') return;

  isFlushInProgress = true;
  try {
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
  } finally {
    isFlushInProgress = false;
  }
}

async function postChunk(blob: Blob) {
  if (!blob || blob.size < 1024) return; // Ignore tiny chunks (<1KB) to avoid API errors

  const audioBase64 = await blobToBase64(blob);
  const mimeType = mediaRecorder?.mimeType || 'audio/webm';

  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_AUDIO_CHUNK',
    audioBase64,
    mimeType
  });
}

async function drainPendingChunks() {
  if (isDrainingQueue) return;
  isDrainingQueue = true;
  try {
    while (pendingChunks.length > 0) {
      const blob = pendingChunks.shift();
      if (blob) {
        await postChunk(blob);
      }
    }
  } finally {
    isDrainingQueue = false;
  }
}

async function startCapture(streamId: string, _tabId: number) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    return;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-ignore - chromeMediaSource is non-standard
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } as any,
    video: false
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

  mediaRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data && event.data.size > 0) {
      pendingChunks.push(event.data);
    }
    isChunkRequested = false;
  });

  mediaRecorder.start();

  chunkTimer = setInterval(async () => {
    try {
      if (isStopping) return;
      await flushAudioChunk();
      await drainPendingChunks();
    } catch (err) {
      console.error('[LateMeet][offscreen] Chunk pipeline error:', err);
    }
  }, CHUNK_MS);
}

async function stopCapture() {
  if (chunkTimer) {
    clearInterval(chunkTimer as any);
    chunkTimer = null;
  }
  isStopping = true;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    const recorder = mediaRecorder;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 2000);
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.addEventListener('error', () => resolve(), { once: true });
      recorder.stop();
      recorder.addEventListener('stop', () => clearTimeout(timeout), { once: true });
    });
  }

  await drainPendingChunks();

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
  isStopping = false;
  consecutiveSilent = 0;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === 'OFFSCREEN_START_CAPTURE') {
      try {
        await startCapture(message.streamId, message.tabId);
        sendResponse({ success: true });
      } catch (err) {
        console.error('[LateMeet][offscreen] Failed to start capture:', (err as Error).message);
        sendResponse({ success: false, error: (err as Error).message || 'Start capture failed' });
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
