// MV3 service worker for Late Meet

import { State } from "./types";
import { audioFileExtensionForMimeType, isChunkViable } from "./audioProcessing";
import { initTheme } from "./theme.js";

initTheme();

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const OFFSCREEN_DOCUMENT_PATH = "src/offscreen.html";
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const MAX_PROMPT_LENGTH = 2000;
const TRANSCRIPT_WINDOW_SIZE = 25;
const SUMMARIZATION_MAX_TOKENS = 1200;
const JOINER_MESSAGE_MAX_TOKENS = 120;
const ELEVENLABS_STT_MODEL = "scribe_v2";
// Delay late-joiner auto messages until 10s to avoid lobby/join churn spam.
const MIN_MEETING_DURATION_FOR_WELCOME = 10;

// ---------------------------------------------------------------------------
// API Transaction Manager
// ---------------------------------------------------------------------------
// Provides a serialized, resilient request queue with:
//   • Exponential backoff:  delay = BASE_DELAY_MS * 2^attempt
//   • Randomized jitter:    ±JITTER_FRACTION of the computed delay
//   • Offline pause/resume: queue halts when navigator.onLine is false and
//     flushes automatically when the browser comes back online.
//   • MV3-safe retries:     retrying tasks are held in a separate Map so they
//     survive the shift() that removes them from the FIFO queue, and alarm-
//     based scheduling avoids lost timers on service-worker suspension.
// ---------------------------------------------------------------------------

type ApiTask<T> = () => Promise<T>;

interface QueueEntry<T> {
  /** Unique id used as the chrome.alarms alarm name for retry scheduling. */
  id: string;
  task: ApiTask<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  attempt: number;
  label: string; // for debug logging
}

class ApiTransactionManager {
  private static readonly MAX_RETRIES = 5;
  private static readonly BASE_DELAY_MS = 1_000;
  private static readonly JITTER_FRACTION = 0.3; // ±30 % of computed delay
  private static readonly RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

  private queue: QueueEntry<any>[] = [];

  /**
   * Tasks that have been dequeued but are waiting for their retry alarm to
   * fire live here so findRetryEntry() can locate them later.
   */

  private retryingTasks = new Map<string, QueueEntry<any>>();

  private processing = false;
  private paused = false;

  constructor() {
    // Pause the queue while the extension context is offline.
    self.addEventListener("offline", () => {
      if (!this.paused) {
        console.warn("[LateMeet][Queue] Network offline — queue paused");
        this.paused = true;
      }
    });

    // Resume (and immediately flush) when connectivity returns.
    self.addEventListener("online", () => {
      if (this.paused) {
        console.info("[LateMeet][Queue] Network back online — resuming queue");
        this.paused = false;
        this.drain();
      }
    });

    // Re-enqueue any task whose alarm has fired (MV3-safe retry scheduling).
    chrome.alarms.onAlarm.addListener((alarm) => {
      const entry = this.retryingTasks.get(alarm.name);
      if (!entry) {
        // Not our alarm — ignore.
        return;
      }
      this.retryingTasks.delete(alarm.name);
      // Place the entry back at the front of the queue so it executes next.
      this.queue.unshift(entry);
      this.drain();
    });
  }

  /** Enqueue a fetch task and return a Promise that resolves with its result. */
  enqueue<T>(label: string, task: ApiTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `atm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.queue.push({ id, task, resolve, reject, attempt: 0, label });
      this.drain();
    });
  }

  private drain() {
    if (this.processing || this.paused || this.queue.length === 0) return;
    this.processing = true;
    this.processNext();
  }

  private async processNext() {
    if (this.paused || this.queue.length === 0) {
      this.processing = false;
      return;
    }

    // Peek — do not dequeue until the task succeeds or exhausts retries.
    const entry = this.queue[0];

    try {
      const result = await entry.task();
      this.queue.shift(); // success — remove from queue
      entry.resolve(result);
    } catch (err) {
      const isRetryable = this.shouldRetry(err, entry.attempt);

      if (isRetryable && entry.attempt < ApiTransactionManager.MAX_RETRIES) {
        const delay = this.backoffDelay(entry.attempt);
        entry.attempt += 1;
        console.warn(
          `[LateMeet][Queue] "${entry.label}" failed (attempt ${entry.attempt}), ` +
            `retrying in ${delay}ms…`,
          err,
        );

        // Remove from the head of the FIFO queue so other tasks can proceed
        // while we wait for the retry alarm, but keep the entry alive in the
        // retryingTasks map so the alarm handler can find and re-enqueue it.
        this.queue.shift();
        this.retryingTasks.set(entry.id, entry);

        // chrome.alarms is the MV3-safe alternative to setTimeout: it fires
        // even if the service worker is suspended and woken up between now and
        // the scheduled time.
        chrome.alarms.create(entry.id, { when: Date.now() + delay });

        // Let the drain loop continue with the next queued task rather than
        // blocking the whole queue on this retry delay.
        this.processNext();
        return;
      } else {
        this.queue.shift(); // non-retryable or exhausted — discard
        console.error(
          `[LateMeet][Queue] "${entry.label}" permanently failed after ` +
            `${entry.attempt + 1} attempt(s).`,
          err,
        );
        entry.reject(err);
      }
    }

    // Continue with the next item.
    this.processNext();
  }

  private shouldRetry(err: unknown, attempt: number): boolean {
    if (attempt >= ApiTransactionManager.MAX_RETRIES) return false;
    // Treat network errors (TypeError: failed to fetch) as retryable.
    if (err instanceof TypeError) return true;
    // Honour HTTP status codes embedded in thrown Error messages.
    if (err instanceof Error) {
      for (const status of ApiTransactionManager.RETRYABLE_STATUSES) {
        if (err.message.includes(String(status))) return true;
      }
    }
    return false;
  }

  private backoffDelay(attempt: number): number {
    const base = ApiTransactionManager.BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = base * ApiTransactionManager.JITTER_FRACTION * (Math.random() * 2 - 1);
    return Math.max(100, Math.round(base + jitter));
  }
}

/** Singleton queue shared by all fetch helpers in this service worker. */
const apiQueue = new ApiTransactionManager();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
import { ActionItem, Decision, State } from "./types";
import { audioFileExtensionForMimeType, isChunkViable } from "./audioProcessing";
import { getElevenLabsApiKey, getOpenAiApiKey } from "./utils/credentials";
import { resolveDetectedMeetTab } from "./meetingTabs";

const state: State = {
  isActive: false,
  meetingId: null,
  meetingUrl: null,
  startTime: null,
  summary: "",
  topics: [],
  decisions: [],
  actionItems: [],
  currentTopic: "",
  sentiment: "neutral",
  keyInsights: [],
  questionsRaised: [],
  participants: [],
  initialParticipants: [],
  lateJoiners: [],
  timeline: [],
  transcript: [],
  audioActive: false,
  currentSpeaker: null,
  targetTabId: null,
  lastSummarizedAt: 0,
  pendingJoiners: new Set(),
  participantCount: 0,
};

let selfParticipantName: string | null = null;
const notifiedActionItems = new Set<string>();
let activeSpeakerName: string | null = null;
let activeSpeakerUpdatedAt = 0;
const ACTIVE_SPEAKER_TTL_MS = 15000;

function normalizeParticipantName(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function resetState() {
  state.isActive = false;
  state.meetingId = null;
  state.meetingUrl = null;
  state.startTime = null;
  state.summary = "";
  state.topics = [];
  state.decisions = [];
  state.actionItems = [];
  state.currentTopic = "";
  state.sentiment = "neutral";
  state.keyInsights = [];
  state.questionsRaised = [];
  state.participants = [];
  state.initialParticipants = [];
  state.lateJoiners = [];
  state.timeline = [];
  state.transcript = [];
  state.audioActive = false;
  state.currentSpeaker = null;
  state.targetTabId = null;
  state.lastSummarizedAt = 0;
  state.pendingJoiners.clear();
  state.participantCount = 0;
  selfParticipantName = null;
  notifiedActionItems.clear();
  activeSpeakerName = null;
  activeSpeakerUpdatedAt = 0;
}

function addTimeline(event: string) {
  state.timeline.push({
    event,
    timestamp: Date.now(),
    elapsed: state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0,
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
    audioActive: state.audioActive,
    currentSpeaker: state.currentSpeaker,
    participantCount: state.participantCount,
  };
}

function getSpeakerForCurrentChunk(): string {
  if (activeSpeakerName && Date.now() - activeSpeakerUpdatedAt <= ACTIVE_SPEAKER_TTL_MS) {
    return activeSpeakerName;
  }

  return "Audio";
}

async function broadcastStateUpdate() {
  const snapshotData = snapshot();
  try {
    // To popup/dashboard
    await chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: snapshotData });
  } catch {
    /* ignore */
  }

  try {
    // To content scripts (floating button)
    const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        chrome.tabs
          .sendMessage(tab.id, { type: "STATE_UPDATE", state: snapshotData })
          .catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
}

interface Settings {
  summarizationInterval?: number;
  aiModel?: string;
  vadThreshold?: number;
  lateJoinerBriefing?: boolean;
  topicDetection?: boolean;
  decisionDetection?: boolean;
  actionExtraction?: boolean;
  sentimentAnalysis?: boolean;
}

async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get("settings");
  return result.settings || {};
}

function isFeatureEnabled(settings: Settings, key: keyof Settings): boolean {
  return settings[key] !== false;
}

function sanitizePromptText(value: string | null) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/```/g, "")
    .replace(/[<>{}]/g, " ")
    .slice(0, MAX_PROMPT_LENGTH);
}

function sanitizeOptionalField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizePromptText(value).trim();
  return sanitized || undefined;
}

function normalizeDecisions(value: unknown, fallback: Decision[]): Decision[] {
  if (!Array.isArray(value)) return fallback;

  return value
    .map((item) => {
      if (typeof item === "string") {
        const text = sanitizeOptionalField(item);
        return text ? { text } : null;
      }

      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const text = sanitizeOptionalField(record.text);
        if (!text) return null;

        return {
          text,
          by: sanitizeOptionalField(record.by),
          timestamp: sanitizeOptionalField(record.timestamp),
        };
      }

      return null;
    })
    .filter((item): item is Decision => Boolean(item));
}

function normalizeActionItems(value: unknown, fallback: ActionItem[]): ActionItem[] {
  if (!Array.isArray(value)) return fallback;

  return value
    .map((item) => {
      if (typeof item === "string") {
        const task = sanitizeOptionalField(item);
        return task ? { task } : null;
      }

      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const task = sanitizeOptionalField(record.task);
        if (!task) return null;

        return {
          task,
          owner: sanitizeOptionalField(record.owner),
          deadline: sanitizeOptionalField(record.deadline),
        };
      }

      return null;
    })
    .filter((item): item is ActionItem => Boolean(item));
}

async function ensureOffscreenDocument() {
  const contexts = await (chrome.runtime as any).getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_DOCUMENT_URL],
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA" as any],
    justification: "Capture Google Meet tab audio for local transcription",
  });

  // createDocument resolves when the document is created, but the offscreen JS
  // still needs a moment to execute and register its chrome.runtime.onMessage
  // listener. Without this delay the first OFFSCREEN_START_CAPTURE is lost.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function closeOffscreenDocumentIfPresent() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as any],
    documentUrls: [OFFSCREEN_DOCUMENT_URL],
  });

  if (contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

function getTranscriptionPrompt() {
  const recentTexts = state.transcript
    .slice(-3)
    .map((e) => e.text)
    .join(" ");
  if (!recentTexts) return "";
  // Provide last ~200 characters to Whisper to help with context/names
  return recentTexts.slice(-200);
}

async function transcribeChunk(base64Audio: string, mimeType = "audio/webm", prompt = "") {
  // Single declaration — retrieved from session storage where ElevenLabs keys are stored.
  // Use ElevenLabs API key if available, fallback to OpenAI if not?
  // No, the requirement is to use ElevenLabs.
  const elevenlabsKey = await getElevenLabsApiKey();

  const bytes = Uint8Array.from(atob(base64Audio), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });

  if (!isChunkViable(blob)) {
    console.warn("[LateMeet] Audio chunk too small to transcribe, skipping:", blob.size, "bytes");
    return null;
  }

  if (elevenlabsKey) {
    try {
      const normalizedMime = mimeType.split(";")[0].trim();
      const extension = audioFileExtensionForMimeType(normalizedMime);

      const formData = new FormData();
      formData.append("file", blob, `audio.${extension}`);
      formData.append("model_id", ELEVENLABS_STT_MODEL);

      const transcript = await apiQueue.enqueue("elevenlabs-stt", async () => {
        const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": elevenlabsKey },
          body: formData,
        });

        if (!response.ok) {
          const text = await response.text();
          console.error("[LateMeet] ElevenLabs API rejected chunk", {
            status: response.status,
            statusText: response.statusText,
            response: text,
            mimeType,
            size: blob.size,
          });
          throw new Error(`ElevenLabs STT error ${response.status}: ${text}`);
        }

        const data = await response.json();
        const result = (data.text || "").trim();
        if (!result) throw new Error("Empty ElevenLabs transcript");
        return result;
      });

      return transcript;
    } catch (err) {
      console.warn("[LateMeet] ElevenLabs transcription failed, falling back to Whisper:", err);
      // Fall through to Whisper below.
    }
  }

  // Fallback to Whisper.
  const apiKey = await getApiKey();
  // Fallback to Whisper
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) return null;

  const normalizedMime = mimeType.split(";")[0].trim();
  const extension = audioFileExtensionForMimeType(normalizedMime);

  const formData = new FormData();
  formData.append("file", blob, `audio.${extension}`);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");
  if (prompt) {
    formData.append("prompt", prompt);
  }

  return apiQueue.enqueue("whisper-stt", async () => {
    const response = await fetch(OPENAI_WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Whisper API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    return (data.text || "").trim();
  });
}

async function refineTranscription(rawText: string) {
  if (!rawText || rawText.length < 5) return rawText;

  // Skip refinement for very short or likely-noise transcriptions
  const words = rawText.trim().split(/\s+/);
  if (words.length < 3) return rawText;

  const apiKey = await getOpenAiApiKey();
  if (!apiKey) return rawText;

  const systemPrompt = `You are an expert AI transcription editor. 
Your task is to correct errors, remove filler words (um, uh, like), and improve the clarity of the provided meeting transcript segment while strictly preserving the speaker's original meaning and intent. 
Return ONLY the corrected transcript text. If the input is unclear, inaudible, or empty, return the exact input unchanged. Never add commentary, apologies, or meta-responses.`;

  try {
    return await apiQueue.enqueue("refine-transcription", async () => {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: rawText },
          ],
          temperature: 0.1,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Refinement API error ${response.status}: ${text}`);
      }

      const data = await response.json();
      const refined = data?.choices?.[0]?.message?.content?.trim() || rawText;

      // Guard against AI hallucination / apology responses
      const lowerRefined = refined.toLowerCase();
      if (
        lowerRefined.startsWith("i'm sorry") ||
        lowerRefined.startsWith("i apologize") ||
        lowerRefined.startsWith("sorry,") ||
        lowerRefined.includes("no text provided") ||
        lowerRefined.includes("please provide") ||
        lowerRefined.includes("i cannot") ||
        lowerRefined.includes("there is no")
      ) {
        return rawText;
      }

      return refined;
    });
  } catch (err) {
    console.error("[LateMeet] Refinement failed:", err);
    return rawText;
  }
}

// ---------------------------------------------------------------------------
// Single-flight guard for summarization
// ---------------------------------------------------------------------------
// Without this guard, concurrent OFFSCREEN_AUDIO_CHUNK handlers can all pass
// the lastSummarizedAt interval check before any of them updates the value,
// causing duplicate summarization requests and concurrent mutation of shared
// state (summary, topics, decisions, …).  The flag is reset in `finally` so
// a permanent API failure does not permanently block future summarizations.
// ---------------------------------------------------------------------------
let summaryInFlight = false;

async function summarizeTranscriptIfNeeded() {
  if (!state.isActive || state.transcript.length === 0) return;

  // Bail out immediately if another summarization is already running.
  if (summaryInFlight) return;

  const settings = await getSettings();
  const requestedInterval = Number(settings.summarizationInterval);
  const intervalSeconds =
    Number.isFinite(requestedInterval) && requestedInterval > 0 ? requestedInterval : 30;
  const lastSum = state.lastSummarizedAt || 0;
  const elapsed = Math.floor((Date.now() - lastSum) / 1000);
  if (lastSum > 0 && elapsed < intervalSeconds) return;

  const apiKey = await getOpenAiApiKey();
  if (!apiKey) return;

  const transcriptWindow = state.transcript
    .slice(-TRANSCRIPT_WINDOW_SIZE)
    .map((e) => `${sanitizePromptText(e.speaker)}: ${sanitizePromptText(e.text)}`)
    .join("\n");
  if (!transcriptWindow.trim()) return;

  // Claim the in-flight slot *after* all cheap pre-checks pass.
  summaryInFlight = true;

  try {
    const topicDetectionEnabled = isFeatureEnabled(settings, "topicDetection");
    const decisionDetectionEnabled = isFeatureEnabled(settings, "decisionDetection");
    const actionExtractionEnabled = isFeatureEnabled(settings, "actionExtraction");
    const sentimentAnalysisEnabled = isFeatureEnabled(settings, "sentimentAnalysis");

    const outputFields = [
      '"summary": "Updated meeting summary..."',
      ...(topicDetectionEnabled
        ? [
            '"topics": [{"name": "Topic", "status": "active|completed"}]',
            '"currentTopic": "Identifying the current main topic"',
          ]
        : []),
      ...(decisionDetectionEnabled ? ['"decisions": ["Decision 1", ...]'] : []),
      ...(actionExtractionEnabled ? ['"actionItems": ["Action 1", ...]'] : []),
      ...(sentimentAnalysisEnabled ? ['"sentiment": "positive|neutral|negative|mixed"'] : []),
      '"keyInsights": ["Insight 1", ...]',
      '"questionsRaised": ["Question 1", ...]',
    ];

    const systemPrompt = `You are a World-Class Meeting Intelligence Engine. 
  const topicDetectionEnabled = isFeatureEnabled(settings, "topicDetection");
  const decisionDetectionEnabled = isFeatureEnabled(settings, "decisionDetection");
  const actionExtractionEnabled = isFeatureEnabled(settings, "actionExtraction");
  const sentimentAnalysisEnabled = isFeatureEnabled(settings, "sentimentAnalysis");
  const outputFields = [
    '"summary": "Updated meeting summary..."',
    ...(topicDetectionEnabled
      ? [
          '"topics": [{"name": "Topic", "status": "active|completed"}]',
          '"currentTopic": "Identifying the current main topic"',
        ]
      : []),
    ...(decisionDetectionEnabled
      ? ['"decisions": [{"text": "Decision", "by": "optional speaker", "timestamp": "optional"}]']
      : []),
    ...(actionExtractionEnabled
      ? ['"actionItems": [{"task": "Action", "owner": "optional owner", "deadline": "optional"}]']
      : []),
    ...(sentimentAnalysisEnabled ? ['"sentiment": "positive|neutral|negative|mixed"'] : []),
    '"keyInsights": ["Insight 1", ...]',
    '"questionsRaised": ["Question 1", ...]',
  ];

  const systemPrompt = `You are a World-Class Meeting Intelligence Engine. 
Your goal is to extract high-fidelity insights from meeting transcripts.

OUTPUT GUIDELINES:
- Provide a concise yet professional summary (business grade).
- Extract only the fields requested by the user prompt.
${topicDetectionEnabled ? "- Identify distinct topics and their statuses (active/completed)." : ""}
${decisionDetectionEnabled ? '- Precisely capture decisions as objects with a required "text" field and optional "by" and "timestamp" fields.' : ""}
${actionExtractionEnabled ? '- Precisely capture action items as objects with a required "task" field and optional "owner" and "deadline" fields.' : ""}
${sentimentAnalysisEnabled ? "- Detect the prevailing sentiment and emotional dynamics." : ""}
- Extract "Key Insights" that go beyond a simple summary (strategic value).
- Track specific questions raised that remain unanswered.

You must return ONLY a JSON object.`;

    const userPrompt = `Analyze the following meeting transcript segment.
Integrate this new data with the previous context.

PREVIOUS CONTEXT (Summary): 
${state.summary || "Initial session"}

RECENT TRANSCRIPT:
${transcriptWindow}

Return a JSON object with these exact keys:
{
  ${outputFields.join(",\n  ")}
}`;

    const content = await apiQueue.enqueue("summarize-transcript", async () => {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: settings.aiModel || "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
          max_tokens: SUMMARIZATION_MAX_TOKENS,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Chat API error ${response.status}: ${text}`);
      }

      const data = await response.json();
      const result = data?.choices?.[0]?.message?.content;
      if (!result) throw new Error("Empty summarization response");
      return result;
    });

    if (!content) return;

    // JSON.parse failures are caught by the outer try/catch so a malformed AI
    // response does not crash the chunk handler or corrupt state.
    const parsed = JSON.parse(content);

    state.summary = parsed.summary || state.summary;

    if (topicDetectionEnabled) {
      state.topics = Array.isArray(parsed.topics) ? parsed.topics : state.topics;
      state.currentTopic = parsed.currentTopic || state.currentTopic;
    } else {
      state.topics = [];
      state.currentTopic = "";
    }

    if (decisionDetectionEnabled) {
      state.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : state.decisions;
    } else {
      state.decisions = [];
    }

    if (actionExtractionEnabled) {
      state.actionItems = Array.isArray(parsed.actionItems)
        ? parsed.actionItems
        : state.actionItems;
    } else {
      state.actionItems = [];
    }

    if (sentimentAnalysisEnabled) {
      state.sentiment = parsed.sentiment || state.sentiment;
    } else {
      state.sentiment = "neutral";
    }

    state.keyInsights = Array.isArray(parsed.keyInsights) ? parsed.keyInsights : state.keyInsights;
    state.questionsRaised = Array.isArray(parsed.questionsRaised)
      ? parsed.questionsRaised
      : state.questionsRaised;

    // Update the timestamp only on success so a failed run doesn't suppress
    // the next attempt prematurely.
    state.lastSummarizedAt = Date.now();
  } catch (err) {
    // Summarization is best-effort: log and move on.  The transcript itself
    // has already been stored so the chunk handler should still report success.
    console.warn("[LateMeet] Summarization failed (non-fatal):", err);
  } finally {
    // Always release the in-flight slot so future calls are not blocked.
    summaryInFlight = false;
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return;

  const parsed = JSON.parse(content);
  state.summary = parsed.summary || state.summary;
  if (topicDetectionEnabled) {
    state.topics = Array.isArray(parsed.topics) ? parsed.topics : state.topics;
    state.currentTopic = parsed.currentTopic || state.currentTopic;
  } else {
    state.topics = [];
    state.currentTopic = "";
  }
  if (decisionDetectionEnabled) {
    state.decisions = normalizeDecisions(parsed.decisions, state.decisions);
  } else {
    state.decisions = [];
  }
  if (actionExtractionEnabled) {
    if (Array.isArray(parsed.actionItems)) {
      state.actionItems = parsed.actionItems;
      notifyNewActionItems(state.actionItems);
    }
    state.actionItems = normalizeActionItems(parsed.actionItems, state.actionItems);
  } else {
    state.actionItems = [];
  }
  if (sentimentAnalysisEnabled) {
    state.sentiment = parsed.sentiment || state.sentiment;
  } else {
    state.sentiment = "neutral";
  }
  state.keyInsights = Array.isArray(parsed.keyInsights) ? parsed.keyInsights : state.keyInsights;
  state.questionsRaised = Array.isArray(parsed.questionsRaised)
    ? parsed.questionsRaised
    : state.questionsRaised;
  state.lastSummarizedAt = Date.now();
}

function actionItemKey(item: ActionItem | unknown): string {
  if (item && typeof item === "object" && "task" in (item as object)) {
    const task = (item as { task?: unknown }).task;
    return String(task ?? "").trim();
  }
  return String(item ?? "").trim();
}

function notifyNewActionItems(items: ActionItem[]) {
  if (!chrome.notifications) return;
  for (const item of items) {
    const key = actionItemKey(item);
    if (!key || notifiedActionItems.has(key)) continue;
    const message = key.length > 100 ? key.slice(0, 97) + "..." : key;
    const notifId = `lm-action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    chrome.notifications.create(
      notifId,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("src/icons/icon128.png"),
        title: "New Action Item",
        message,
        priority: 1,
      },
      () => {
        if (!chrome.runtime.lastError) {
          notifiedActionItems.add(key);
        }
      },
    );
  }
}

function detectNewJoiners(currentList: string[]) {
  if (state.participants.length === 0 && state.initialParticipants.length === 0) {
    state.initialParticipants = [...currentList];
    state.participants = [...currentList];
    state.participantCount = currentList.length > 0 ? currentList.length : 1;
    return [];
  }

  const hasPlaceholderOnly =
    (state.initialParticipants.length === 0 ||
      (state.initialParticipants.length === 1 && state.initialParticipants[0] === "You")) &&
    state.participants.length === 1 &&
    state.participants[0] === "You";

  if (hasPlaceholderOnly) {
    const next = Array.isArray(currentList) ? currentList : [];
    if (next.length > 0 && !(next.length === 1 && next[0] === "You")) {
      state.initialParticipants = [...next];
      state.participants = [...next];
      state.participantCount = next.length;
      return [];
    }
  }

  const normalizedSelf = normalizeParticipantName(selfParticipantName);
  const next = Array.isArray(currentList) ? currentList : [];
  const newJoiners = next.filter(
    (p) =>
      !state.participants.includes(p) &&
      !state.initialParticipants.includes(p) &&
      (!normalizedSelf || normalizeParticipantName(p) !== normalizedSelf),
  );

  if (newJoiners.length > 0) {
    state.lateJoiners.push(...newJoiners);
    if (state.participantCount !== undefined) {
      state.participantCount += newJoiners.length;
    }
  }

  state.participants = [...next];
  return newJoiners;
}

async function generateLateJoinerMessage(joinerName: string) {
  const safeJoinerName = sanitizePromptText(joinerName);
  const context = {
    duration: getDuration(),
    currentTopic: state.currentTopic,
    topics: state.topics,
    decisions: state.decisions,
  };

  const fallback = `Hi ${joinerName}, welcome to the meeting! We are currently discussing ${context.currentTopic || "project updates"}.`;

  try {
    const apiKey = await getOpenAiApiKey();
    if (!apiKey) return fallback;

    const prompt = `A participant named ${safeJoinerName} joined late. Meeting duration: ${Math.round(context.duration / 60)} minutes. Current topic: ${sanitizePromptText(context.currentTopic || "General discussion")}. Recent topics: ${sanitizePromptText(JSON.stringify(context.topics || []))}. Decisions: ${sanitizePromptText(JSON.stringify(context.decisions || []))}. Write a short welcome message under 3 sentences. Output plain text only.`;

    return await apiQueue.enqueue("late-joiner-message", async () => {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5,
          max_tokens: JOINER_MESSAGE_MAX_TOKENS,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Late joiner API error ${response.status}: ${text}`);
      }

      const data = await response.json();
      return data?.choices?.[0]?.message?.content?.trim() || fallback;
    });
  } catch {
    return fallback;
  }
}

async function sendChatToTab(tabId: number, text: string) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SEND_CHAT_MESSAGE",
      text,
    });
  } catch (err) {
    console.error("[LateMeet] Failed to send chat message to tab:", err);
  }
}

async function maybeWelcomeJoiners(tabId: number | undefined, joiners: string[]) {
  if (!joiners.length || getDuration() <= MIN_MEETING_DURATION_FOR_WELCOME || !tabId) return;

  const settings = await getSettings();
  if (!isFeatureEnabled(settings, "lateJoinerBriefing")) return;

  const normalizedSelf = normalizeParticipantName(selfParticipantName);

  for (const joiner of joiners) {
    const name = String(joiner || "").trim();
    const normalizedName = normalizeParticipantName(name);
    if (
      !name ||
      normalizedName === normalizeParticipantName("You") ||
      (normalizedSelf && normalizedName === normalizedSelf) ||
      state.pendingJoiners.has(name)
    ) {
      continue;
    }

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
    id: crypto.randomUUID(),
    ...snapshot(),
    savedAt: Date.now(),
    isActive: false,
  };
  await chrome.storage.local.set({ pendingSession: session });
}

async function persistSession() {
  const { pendingSession, savedSessions } = await chrome.storage.local.get([
    "pendingSession",
    "savedSessions",
  ]);
  if (!pendingSession) return;

  const sessions = Array.isArray(savedSessions) ? savedSessions : [];
  sessions.unshift(pendingSession);
  await chrome.storage.local.set({ savedSessions: sessions, pendingSession: null });
}

async function discardPendingSession() {
  await chrome.storage.local.set({ pendingSession: null });
}

async function startAudioCapture(
  tabId: number,
  meetingId: string | null,
  meetingUrl: string | null,
  providedStreamId: string | null = null,
  includeMicrophone = true,
) {
  if (!tabId) throw new Error("Missing target tab id");

  await ensureOffscreenDocument();

  const createdSession = !state.isActive;

  if (createdSession) {
    resetState();
    state.isActive = true;
    state.startTime = Date.now();
    state.meetingId = meetingId || "unknown";
    state.meetingUrl = meetingUrl || null;
    state.targetTabId = tabId;
    addTimeline(`Meeting started (${state.meetingId})`);
  }

  try {
    let streamId = providedStreamId;

    if (!streamId) {
      streamId = await new Promise<string | null>((resolve) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) {
            console.error(
              "[LateMeet] getMediaStreamId error (background):",
              chrome.runtime.lastError.message || chrome.runtime.lastError,
            );
            resolve(null);
          } else {
            resolve(id);
          }
        });
      });
    }

    if (!streamId) {
      throw new Error(
        "Failed to get media stream ID for tab capture. Ensure you have given permission.",
      );
    }

    const settings = await getSettings();
    const raw = settings.vadThreshold;
    const vadThreshold =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.012;
    const response = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_CAPTURE",
      streamId,
      tabId,
      includeMicrophone,
      vadThreshold,
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to start offscreen capture");
    }

    state.audioActive = true;
    addTimeline("Audio capture started");
    if (response.microphoneActive === false) {
      addTimeline("Microphone capture unavailable; recording tab audio only");
    }
    await broadcastStateUpdate();
  } catch (err) {
    state.audioActive = false;
    if (createdSession) {
      resetState();
      await broadcastStateUpdate();
    }
    throw err;
  }
}

async function scanForMeetTabs() {
  try {
    const meetTab = await resolveDetectedMeetTab();
    if (meetTab && !state.isActive) {
      resetState();
      state.isActive = true;
      state.meetingId = meetTab.meetingId;
      state.meetingUrl = meetTab.meetingUrl;
      state.targetTabId = meetTab.tab.id || null;
      state.startTime = Date.now();
      state.participants = ["You"];
      console.log("[LateMeet] Proactively detected meeting:", meetTab.meetingId);
      await broadcastStateUpdate();
    }
  } catch (err) {
    console.error("[LateMeet] Scan for meet tabs failed:", err);
  }
}

async function stopAudioCapture(reason = "Stopped") {
  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_CAPTURE" });
  } catch {
    // Ignore if offscreen not running
  }

  if (state.isActive) {
    addTimeline(`Meeting ended (${reason})`);
    await savePendingSession();
  }

  state.audioActive = false;
  state.isActive = false;
  state.meetingId = null;
  state.meetingUrl = null;
  state.targetTabId = null;

  await broadcastStateUpdate();

  try {
    await chrome.runtime.sendMessage({ type: "SESSION_ENDED" });
  } catch {
    // no listeners
  }

  await closeOffscreenDocumentIfPresent();
}

function parseMeetUrl(value: string | undefined | null): URL | null {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.hostname !== "meet.google.com") return null;
    return parsed;
  } catch {
    return null;
  }
}

function extractMeetCode(url: string | undefined | null): string | null {
  const parsed = parseMeetUrl(url);
  if (!parsed) return null;
  const match = parsed.pathname.match(/^\/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})(?:\/|$)/i);
  return match ? match[1] : null;
}

function isMeetCode(value: string | null | undefined): boolean {
  return /^[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}$/i.test(String(value || ""));
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url || tab.url;

  // If we are actively capturing from this tab, stop capture as soon as the tab
  // navigates away from a Meet meeting scope (privacy safety default).
  if (state.audioActive && state.targetTabId && tabId === state.targetTabId) {
    const isMeetUrl = Boolean(parseMeetUrl(nextUrl));
    const meetCode = extractMeetCode(nextUrl);
    if (!isMeetUrl) {
      await stopAudioCapture("Navigated away from Meet");
      return;
    }
    if (!meetCode) {
      await stopAudioCapture("Left meeting");
      return;
    }
    if (isMeetCode(state.meetingId) && meetCode !== state.meetingId) {
      await stopAudioCapture("Switched meeting");
      return;
    }
  }

  if (changeInfo.status === "complete") {
    const meetingId = extractMeetCode(nextUrl);
    if (meetingId) {
      if (!state.isActive) {
        resetState();
        state.isActive = true;
        state.meetingId = meetingId;
        state.meetingUrl = nextUrl || null;
        state.targetTabId = tabId || null;
        state.startTime = Date.now();
        state.participants = ["You"];
        await broadcastStateUpdate();
      }
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const meetingId = extractMeetCode(tab.url);
    if (meetingId && !state.isActive) {
      state.meetingId = meetingId;
      state.meetingUrl = tab.url || null;
      state.targetTabId = activeInfo.tabId;
      await broadcastStateUpdate();
    }
  } catch (err) {
    // Tab might be closed by now
    console.log(err);
    console.log(err); // since lint is giving error
    console.debug("[LateMeet] tab activation handler failed:", err);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.targetTabId && tabId === state.targetTabId) {
    if (state.isActive) {
      await stopAudioCapture("Meeting tab closed");
    } else {
      state.meetingId = null;
      state.targetTabId = null;
      await broadcastStateUpdate();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_STATE": {
        if (!state.isActive) {
          await scanForMeetTabs();
        }
        sendResponse(snapshot());
        return;
      }

      case "OPEN_SIDE_PANEL": {
        const callerTabId = sender?.tab?.id;
        if (callerTabId) {
          await chrome.sidePanel.open({ tabId: callerTabId });
        }
        sendResponse({ success: true });
        return;
      }

      case "MANUAL_START_AUDIO": {
        let tabId = message.tabId;
        if (tabId === "current") {
          tabId = sender?.tab?.id;
        }

        if (!tabId) {
          sendResponse({ success: false, error: "Target tab not found" });
          return;
        }

        const meetingId = message.meetingId || state.meetingId;
        const meetingUrl = message.meetingUrl || sender?.tab?.url || state.meetingUrl;
        await startAudioCapture(
          tabId,
          meetingId,
          meetingUrl,
          message.streamId,
          message.includeMicrophone !== false,
        );
        sendResponse({ success: true });
        return;
      }

      case "OFFSCREEN_LOG": {
      case "MANUAL_STOP_AUDIO": {
        if (state.audioActive || state.isActive) {
          await stopAudioCapture("Stopped by user");
        }
        sendResponse({ success: true });
        return;
      }

      case "MEETING_ENDED":
      case "CALL_ENDED": {
        if (state.audioActive || state.isActive) {
          await stopAudioCapture("Call ended");
        }
        sendResponse({ success: true });
        return;
      }

      case "WAVEFORM_DATA": {
        if (!message._relayed) {
          chrome.runtime
            .sendMessage({ type: "WAVEFORM_DATA", buckets: message.buckets, _relayed: true })
            .catch(() => {});
        }
        sendResponse({ success: true });
        return;
      }

      case "OFFSCREEN_LOG": {
        // Relay log lines from the offscreen document into the SW console so
        // they are visible without opening the offscreen DevTools separately.
        console.log("[LateMeet][offscreen]", message.message);
        sendResponse({ success: true });
        return;
      }

      case "OFFSCREEN_CAPTURE_STOPPED": {
        state.audioActive = false;
        await broadcastStateUpdate();
        sendResponse({ success: true });
        return;
      }

      case "OFFSCREEN_AUDIO_CHUNK": {
        if (!state.isActive) {
          console.warn("[LateMeet] chunk received but session not active — ignored");
          sendResponse({ success: true, ignored: true });
          return;
        }

        const chunkSpeaker = getSpeakerForCurrentChunk();
        const base64Len = message.audioBase64?.length ?? 0;
        const approxBytes = Math.round((base64Len * 3) / 4);
        console.log(
          `[LateMeet] chunk received — ~${approxBytes} bytes  mimeType=${message.mimeType}`,
        );

        try {
          const prompt = getTranscriptionPrompt();
          const rawText = await transcribeChunk(message.audioBase64, message.mimeType, prompt);
          if (rawText) {
            console.log(`[LateMeet] transcript received — ${rawText.length} chars`);
            const refinedText = await refineTranscription(rawText);
            console.log(`[LateMeet] transcript refined — ${refinedText.length} chars`);
            state.transcript.push({ speaker: "Audio", text: refinedText, timestamp: Date.now() });
            // summarizeTranscriptIfNeeded is best-effort — failures are caught
            // internally and must not propagate back to the chunk handler.
            state.transcript.push({
              speaker: chunkSpeaker,
              text: refinedText,
              timestamp: Date.now(),
            });
            await summarizeTranscriptIfNeeded();
            await broadcastStateUpdate();
          } else {
            console.warn("[LateMeet] STT returned empty — chunk may be silent or too short");
          }
          sendResponse({ success: true });
        } catch (err) {
          console.error("[LateMeet] chunk processing failed:", err);
          sendResponse({ success: false, error: (err as Error).message });
        }
        return;
      }

      case "ACTIVE_SPEAKER_CHANGED": {
        const speaker = typeof message.name === "string" ? message.name.trim() : "";

        if (!speaker) {
          sendResponse({ success: false, error: "speaker name is required" });
          return;
        }

        activeSpeakerName = speaker;
        activeSpeakerUpdatedAt = Date.now();
        state.currentSpeaker = speaker;
        sendResponse({ success: true });
        return;
      }

      case "PARTICIPANTS_UPDATED": {
        if (!Array.isArray(message.participants)) {
          sendResponse({ success: false, error: "participants must be an array" });
          return;
        }

        const incomingSelfName =
          typeof message.selfName === "string" ? message.selfName.trim() : "";
        if (incomingSelfName) selfParticipantName = incomingSelfName;

        const joiners = detectNewJoiners(message.participants);
        await maybeWelcomeJoiners(sender?.tab?.id || state.targetTabId || undefined, joiners);
        await broadcastStateUpdate();
        sendResponse({ success: true, joiners });
        return;
      }

      case "SAVE_SESSION": {
        await persistSession();
        await broadcastStateUpdate();
        sendResponse({ success: true });
        return;
      }

      case "DISCARD_SESSION": {
        await discardPendingSession();
        await broadcastStateUpdate();
        sendResponse({ success: true });
        return;
      }

      case "GET_SAVED_SESSIONS": {
        const { savedSessions } = await chrome.storage.local.get("savedSessions");
        sendResponse(Array.isArray(savedSessions) ? savedSessions : []);
        return;
      }

      case "DELETE_SAVED_SESSION": {
        const { savedSessions } = await chrome.storage.local.get("savedSessions");
        const sessions = Array.isArray(savedSessions) ? savedSessions : [];
        const next = sessions.filter((s) => s.id !== message.sessionId);
        await chrome.storage.local.set({ savedSessions: next });
        sendResponse({ success: true });
        return;
      }

      default: {
        sendResponse({ success: false, error: "Unknown message type" });
      }
    }
  })().catch((err) => {
    console.error("[LateMeet] Message handler error:", err);
    sendResponse({ success: false, error: err.message || "Unexpected error" });
  });

  return true;
});

// Proactive scan on startup/load
scanForMeetTabs();
