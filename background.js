// MV3 service worker for Late Meet

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

const state = {
  isActive: false,
  meetingId: null,
  meetingUrl: null,
  startTime: null,
  summary: '',
  topics: [],
  decisions: [],
  actionItems: [],
  currentTopic: '',
  sentiment: 'neutral',
  keyInsights: [],
  questionsRaised: [],
  participants: [],
  initialParticipants: [],
  lateJoiners: [],
  timeline: [],
  transcript: [],
  audioActive: false,
  targetTabId: null,
  lastSummarizedAt: 0,
  pendingJoiners: new Set()
};

function resetState() {
  state.isActive = false;
  state.meetingId = null;
  state.meetingUrl = null;
  state.startTime = null;
  state.summary = '';
  state.topics = [];
  state.decisions = [];
  state.actionItems = [];
  state.currentTopic = '';
  state.sentiment = 'neutral';
  state.keyInsights = [];
  state.questionsRaised = [];
  state.participants = [];
  state.initialParticipants = [];
  state.lateJoiners = [];
  state.timeline = [];
  state.transcript = [];
  state.audioActive = false;
  state.targetTabId = null;
  state.lastSummarizedAt = 0;
  state.pendingJoiners.clear();
}

function addTimeline(event) {
  state.timeline.push({
    event,
    timestamp: Date.now(),
    elapsed: state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0
  });
}

function getDuration() {
  if (!state.startTime) return 0;
  return Math.round((Date.now() - state.startTime) / 1000);
}

function snapshot() {
  return {
    isActive: state.isActive,
    meetingId: state.meetingId,
    meetingUrl: state.meetingUrl,
    startTime: state.startTime,
    duration: getDuration(),
    summary: state.summary,
    topics: state.topics,
    decisions: state.decisions,
    actionItems: state.actionItems,
    currentTopic: state.currentTopic,
    sentiment: state.sentiment,
    keyInsights: state.keyInsights,
    questionsRaised: state.questionsRaised,
    participants: state.participants,
    lateJoiners: state.lateJoiners,
    timeline: state.timeline,
    transcript: state.transcript,
    audioActive: state.audioActive
  };
}

async function broadcastStateUpdate() {
  try {
    await chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: snapshot() });
  } catch {
    // No active listeners (popup/dashboard closed)
  }
}

async function getApiKey() {
  const result = await chrome.storage.local.get('openai_api_key');
  return result.openai_api_key || null;
}

async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return result.settings || {};
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_DOCUMENT_URL]
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture Google Meet tab audio for local transcription'
  });
}

async function closeOffscreenDocumentIfPresent() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_DOCUMENT_URL]
  });

  if (contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

async function transcribeChunk(base64Audio) {
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  const bytes = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/webm' });

  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');

  const response = await fetch(OPENAI_WHISPER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}

async function summarizeTranscriptIfNeeded() {
  if (!state.isActive || state.transcript.length === 0) return;

  const settings = await getSettings();
  const intervalSeconds = Number(settings.summarizationInterval || 30);
  const elapsed = Math.floor((Date.now() - state.lastSummarizedAt) / 1000);
  if (state.lastSummarizedAt && elapsed < intervalSeconds) return;

  const apiKey = await getApiKey();
  if (!apiKey) return;

  const transcriptWindow = state.transcript.slice(-25).map(e => `${e.speaker}: ${e.text}`).join('\n');
  if (!transcriptWindow.trim()) return;

  const userPrompt = `Analyze this transcript and return strict JSON with fields summary, topics, decisions, actionItems, currentTopic, sentiment, keyInsights, questionsRaised.\n\nPrevious summary: ${state.summary || 'None'}\n\nTranscript:\n${transcriptWindow}`;

  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: settings.aiModel || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are an AI assistant that outputs only valid JSON.' },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
      max_tokens: 1200
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chat API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return;

  const parsed = JSON.parse(content);
  state.summary = parsed.summary || state.summary;
  state.topics = Array.isArray(parsed.topics) ? parsed.topics : state.topics;
  state.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : state.decisions;
  state.actionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : state.actionItems;
  state.currentTopic = parsed.currentTopic || state.currentTopic;
  state.sentiment = parsed.sentiment || state.sentiment;
  state.keyInsights = Array.isArray(parsed.keyInsights) ? parsed.keyInsights : state.keyInsights;
  state.questionsRaised = Array.isArray(parsed.questionsRaised) ? parsed.questionsRaised : state.questionsRaised;
  state.lastSummarizedAt = Date.now();
}

function detectNewJoiners(currentList) {
  if (state.participants.length === 0 && state.initialParticipants.length === 0) {
    state.initialParticipants = [...currentList];
    state.participants = [...currentList];
    return [];
  }

  const next = Array.isArray(currentList) ? currentList : [];
  const newJoiners = next.filter(
    p => !state.participants.includes(p) && !state.initialParticipants.includes(p)
  );

  if (newJoiners.length > 0) {
    state.lateJoiners.push(...newJoiners);
  }

  state.participants = [...next];
  return newJoiners;
}

async function generateLateJoinerMessage(joinerName) {
  const context = {
    duration: getDuration(),
    currentTopic: state.currentTopic,
    topics: state.topics,
    decisions: state.decisions
  };

  const fallback = `Hi ${joinerName}, welcome to the meeting! We are currently discussing ${context.currentTopic || 'project updates'}.`;

  try {
    const apiKey = await getApiKey();
    if (!apiKey) return fallback;

    const prompt = `A participant named ${joinerName} joined late. Meeting duration: ${Math.round(context.duration / 60)} minutes. Current topic: ${context.currentTopic || 'General discussion'}. Recent topics: ${JSON.stringify(context.topics || [])}. Decisions: ${JSON.stringify(context.decisions || [])}. Write a short welcome message under 3 sentences. Output plain text only.`;

    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 120
      })
    });

    if (!response.ok) return fallback;
    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function sendChatToTab(tabId, text) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SEND_CHAT_MESSAGE',
      text
    });
  } catch (err) {
    console.error('[LateMeet] Failed to send chat message to tab:', err);
  }
}

async function maybeWelcomeJoiners(tabId, joiners) {
  if (!joiners.length || getDuration() <= 60) return;

  for (const joiner of joiners) {
    const name = String(joiner || '').trim();
    if (!name || name.includes('You') || state.pendingJoiners.has(name)) continue;

    state.pendingJoiners.add(name);
    try {
      const text = await generateLateJoinerMessage(name);
      await sendChatToTab(tabId, text);
      addTimeline(`Late joiner brief sent to ${name}`);
    } finally {
      state.pendingJoiners.delete(name);
    }
  }
}

async function savePendingSession() {
  const session = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...snapshot(),
    savedAt: Date.now(),
    isActive: false
  };
  await chrome.storage.local.set({ pendingSession: session });
}

async function persistSession() {
  const { pendingSession, savedSessions } = await chrome.storage.local.get(['pendingSession', 'savedSessions']);
  if (!pendingSession) return;

  const sessions = Array.isArray(savedSessions) ? savedSessions : [];
  sessions.unshift(pendingSession);
  await chrome.storage.local.set({ savedSessions: sessions, pendingSession: null });
}

async function discardPendingSession() {
  await chrome.storage.local.set({ pendingSession: null });
}

async function startAudioCapture(tabId, meetingId, meetingUrl) {
  if (!tabId) throw new Error('Missing target tab id');

  await ensureOffscreenDocument();

  if (!state.isActive) {
    resetState();
    state.isActive = true;
    state.startTime = Date.now();
    state.meetingId = meetingId || 'unknown';
    state.meetingUrl = meetingUrl || null;
    state.targetTabId = tabId;
    addTimeline(`Meeting started (${state.meetingId})`);
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START_CAPTURE',
      tabId
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Failed to start offscreen capture');
    }

    state.audioActive = true;
    addTimeline('Audio capture started');
    await broadcastStateUpdate();
  } catch (err) {
    state.audioActive = false;
    throw err;
  }
}

async function stopAudioCapture(reason = 'Stopped') {
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_CAPTURE' });
  } catch {
    // Ignore if offscreen not running
  }

  if (state.isActive) {
    addTimeline(`Meeting ended (${reason})`);
    await savePendingSession();
  }

  state.audioActive = false;
  state.isActive = false;

  await broadcastStateUpdate();

  try {
    await chrome.runtime.sendMessage({ type: 'SESSION_ENDED' });
  } catch {
    // no listeners
  }

  await closeOffscreenDocumentIfPresent();
}

chrome.tabs.onRemoved.addListener(async tabId => {
  if (state.targetTabId && tabId === state.targetTabId) {
    await stopAudioCapture('Meeting tab closed');
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'GET_STATE': {
        sendResponse(snapshot());
        return;
      }

      case 'MANUAL_START_AUDIO': {
        const meetingId = message.meetingId || state.meetingId;
        const meetingUrl = sender?.tab?.url || state.meetingUrl;
        await startAudioCapture(message.tabId, meetingId, meetingUrl);
        sendResponse({ success: true });
        return;
      }

      case 'OFFSCREEN_CAPTURE_STOPPED': {
        state.audioActive = false;
        await broadcastStateUpdate();
        sendResponse({ success: true });
        return;
      }

      case 'OFFSCREEN_AUDIO_CHUNK': {
        if (!state.isActive) {
          sendResponse({ success: true, ignored: true });
          return;
        }

        try {
          const text = await transcribeChunk(message.audioBase64);
          if (text) {
            state.transcript.push({ speaker: 'Audio', text, timestamp: Date.now() });
            await summarizeTranscriptIfNeeded();
            await broadcastStateUpdate();
          }
          sendResponse({ success: true });
        } catch (err) {
          console.error('[LateMeet] Audio chunk processing failed:', err);
          sendResponse({ success: false, error: err.message });
        }
        return;
      }

      case 'PARTICIPANTS_UPDATED': {
        if (!Array.isArray(message.participants)) {
          sendResponse({ success: false, error: 'participants must be an array' });
          return;
        }

        const joiners = detectNewJoiners(message.participants);
        await maybeWelcomeJoiners(sender?.tab?.id || state.targetTabId, joiners);
        await broadcastStateUpdate();
        sendResponse({ success: true, joiners });
        return;
      }

      case 'SAVE_SESSION': {
        await persistSession();
        sendResponse({ success: true });
        return;
      }

      case 'DISCARD_SESSION': {
        await discardPendingSession();
        sendResponse({ success: true });
        return;
      }

      case 'GET_SAVED_SESSIONS': {
        const { savedSessions } = await chrome.storage.local.get('savedSessions');
        sendResponse(Array.isArray(savedSessions) ? savedSessions : []);
        return;
      }

      case 'DELETE_SAVED_SESSION': {
        const { savedSessions } = await chrome.storage.local.get('savedSessions');
        const sessions = Array.isArray(savedSessions) ? savedSessions : [];
        const next = sessions.filter(s => s.id !== message.sessionId);
        await chrome.storage.local.set({ savedSessions: next });
        sendResponse({ success: true });
        return;
      }

      default: {
        sendResponse({ success: false, error: 'Unknown message type' });
      }
    }
  })().catch(err => {
    console.error('[LateMeet] Message handler error:', err);
    sendResponse({ success: false, error: err.message || 'Unexpected error' });
  });

  return true;
});
