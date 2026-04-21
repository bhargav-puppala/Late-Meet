// Popup Script — AI Meeting Copilot

document.addEventListener('DOMContentLoaded', async () => {
  const setupView = document.getElementById('setup-view');
  const mainView = document.getElementById('main-view');
  const meetingSection = document.getElementById('meeting-section');
  const noMeetingSection = document.getElementById('no-meeting-section');
  const sessionModal = document.getElementById('session-modal');

  // ——— Check if API key is configured ———
  const config = await chrome.storage.local.get(['openai_api_key']);
  
  if (!config.openai_api_key) {
    setupView.style.display = 'block';
    mainView.style.display = 'none';
  } else {
    setupView.style.display = 'none';
    mainView.style.display = 'block';
  }

  // ——— Setup: Save Key ———
  document.getElementById('save-keys').addEventListener('click', async () => {
    const apiKey = document.getElementById('api-key-input').value.trim();

    if (!apiKey) {
      shakeElement(document.getElementById('api-key-input'));
      return;
    }

    await chrome.storage.local.set({ openai_api_key: apiKey });

    setupView.style.display = 'none';
    mainView.style.display = 'block';
  });

  // ——— Toggle API Key Visibility ———
  document.getElementById('toggle-key').addEventListener('click', () => {
    const input = document.getElementById('api-key-input');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // ——— Settings ———
  document.getElementById('settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ——— Open Dashboard ———
  document.getElementById('open-dashboard')?.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.sidePanel.open({ tabId: tabs[0].id });
      }
    });
  });

  // ——— Start Copilot (Audio Capture with User Gesture) ———
  const copilotBtn = document.getElementById('start-copilot-btn');

  async function handleStartAudio(btn) {
    const textEl = btn.querySelector('.copilot-btn-text');
    const originalText = textEl?.textContent || 'Start';

    try {
      // Show loading state
      btn.disabled = true;
      if (textEl) textEl.textContent = 'Starting...';
      btn.classList.add('loading');

      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
      if (tabs.length === 0) {
        throw new Error('No Google Meet tab found. Join a meeting first.');
      }
      const meetTab = tabs[0];

      // Extract meeting ID from tab URL
      const urlMatch = meetTab.url?.match(/meet\.google\.com\/([a-z\-]+)/);
      const meetingId = urlMatch ? urlMatch[1] : null;

      // --- Get Media Stream ID in foreground (popup) to ensure user gesture propagation ---
      const streamId = await new Promise((resolve) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: meetTab.id }, (id) => {
          if (chrome.runtime.lastError) {
            console.error('[LateMeet] Popup getMediaStreamId error:', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(id);
          }
        });
      });

      if (!streamId) {
        throw new Error('Capture permission denied. Try clicking the extension icon again on the Meet tab.');
      }

      const response = await chrome.runtime.sendMessage({
        type: 'MANUAL_START_AUDIO',
        tabId: meetTab.id,
        meetingId: meetingId,
        streamId: streamId
      });

      if (response && response.success) {
        setCopilotActive(true);
        // Immediately show meeting section and start timer
        meetingSection.style.display = 'block';
        noMeetingSection.style.display = 'none';
        if (meetingId) {
          document.getElementById('meeting-id').textContent = meetingId;
        }
        const badge = document.getElementById('status-badge');
        badge.className = 'status-badge active';
        badge.querySelector('.status-text').textContent = 'Recording...';
        startDurationTimer(Date.now());
      } else {
        throw new Error(response?.error || 'Failed to start audio capture');
      }
    } catch (err) {
      console.error('Failed to start audio capture:', err);
      btn.disabled = false;
      btn.classList.remove('loading');
      if (textEl) {
        textEl.textContent = err.message.length > 40
          ? 'Error — Check Console'
          : err.message;
        setTimeout(() => {
          if (textEl) textEl.textContent = originalText;
        }, 3000);
      }
    }
  }

  copilotBtn?.addEventListener('click', () => handleStartAudio(copilotBtn));
  document.getElementById('meeting-start-audio-btn')?.addEventListener('click', (e) => handleStartAudio(e.currentTarget));

  function setCopilotActive(active) {
    if (!copilotBtn) return;
    const miniBtn = document.getElementById('meeting-start-audio-btn');
    const iconEl = copilotBtn.querySelector('.copilot-btn-icon');
    
    if (active) {
      copilotBtn.classList.add('active');
      copilotBtn.querySelector('.copilot-btn-text').textContent = 'Copilot Active';
      iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
      copilotBtn.disabled = true;
      if (miniBtn) miniBtn.style.display = 'none';
    } else {
      copilotBtn.classList.remove('active');
      copilotBtn.querySelector('.copilot-btn-text').textContent = 'Start Copilot';
      iconEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
      copilotBtn.disabled = false;
      if (miniBtn) miniBtn.style.display = 'flex';
    }
  }

  // ——— Session Save/Discard Modal ———
  function showSessionModal() {
    sessionModal.style.display = 'flex';
    requestAnimationFrame(() => sessionModal.classList.add('visible'));
  }

  function hideSessionModal() {
    sessionModal.classList.remove('visible');
    setTimeout(() => { sessionModal.style.display = 'none'; }, 300);
  }

  document.getElementById('save-session-btn')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'SAVE_SESSION' });
    hideSessionModal();
  });

  document.getElementById('discard-session-btn')?.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DISCARD_SESSION' });
    hideSessionModal();
  });

  // ——— Check for pending session on load ———
  const { pendingSession } = await chrome.storage.local.get('pendingSession');
  if (pendingSession && !pendingSession.isActive) {
    showSessionModal();
  }

  // ——— Get Current State ———
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (state) {
      updateUI(state);
    }
  } catch {
    // No active meeting
  }

  // ——— Listen for State Updates ———
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      updateUI(message.state);
    }
    if (message.type === 'SESSION_ENDED') {
      showSessionModal();
    }
  });

  // ——— Duration Timer ———
  let durationInterval = null;

  function startDurationTimer(startTime) {
    if (durationInterval) clearInterval(durationInterval);
    
    durationInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      document.getElementById('meeting-duration').textContent = formatDuration(elapsed);
    }, 1000);
  }

  // ——— Update UI ———
  function updateUI(state) {
    if (state.isActive) {
      meetingSection.style.display = 'block';
      noMeetingSection.style.display = 'none';
      
      const badge = document.getElementById('status-badge');
      badge.className = 'status-badge active';
      badge.querySelector('.status-text').textContent = state.audioActive ? 'Recording...' : 'Meeting active';
      
      document.getElementById('meeting-id').textContent = state.meetingId || '—';
      
      if (state.startTime) startDurationTimer(state.startTime);
      
      document.getElementById('summary-text').textContent = state.summary || 'Waiting for conversation...';
      document.getElementById('current-topic').textContent = state.currentTopic || 'Detecting...';
      
      document.getElementById('participant-count').textContent = state.participants?.length || 0;
      document.getElementById('decision-count').textContent = state.decisions?.length || 0;
      document.getElementById('action-count').textContent = state.actionItems?.length || 0;
      document.getElementById('sentiment-icon').textContent = getSentimentEmoji(state.sentiment);

      setCopilotActive(state.audioActive || false);
      
      const topicsList = document.getElementById('topics-list');
      if (state.topics && state.topics.length > 0) {
        topicsList.innerHTML = state.topics.map(t => `
          <div class="topic-item">
            <div class="topic-dot ${sanitizeTopicStatus(t.status)}"></div>
            <span class="topic-name">${escapeHtml(t.name || '')}</span>
            <span class="topic-status ${sanitizeTopicStatus(t.status)}">${escapeHtml(t.status || 'active')}</span>
          </div>
        `).join('');
      } else {
        topicsList.innerHTML = '<div class="empty-state">No topics detected yet</div>';
      }
      
      const lateSection = document.getElementById('late-joiners-section');
      const lateList = document.getElementById('late-joiners-list');
      if (state.lateJoiners && state.lateJoiners.length > 0) {
        lateSection.style.display = 'block';
        lateList.innerHTML = state.lateJoiners.map(name => `
          <div class="late-joiner-item">
            <span class="joiner-icon">🚪</span>
            <span class="joiner-name">${escapeHtml(name || '')}</span>
            <span style="color: #64748B; font-size: 10px;">briefed ✓</span>
          </div>
        `).join('');
      } else {
        lateSection.style.display = 'none';
        lateList.innerHTML = '';
      }
    } else {
      meetingSection.style.display = 'none';
      noMeetingSection.style.display = 'block';
      
      const badge = document.getElementById('status-badge');
      badge.className = 'status-badge inactive';
      badge.querySelector('.status-text').textContent = 'No active meeting';
      
      if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
      }
    }
  }

  // ——— Helpers ———
  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getSentimentEmoji(sentiment) {
    const map = { positive: '😊', negative: '😟', neutral: '😐', mixed: '🤔' };
    return map[sentiment] || '—';
  }

  function sanitizeTopicStatus(status) {
    // UI supports only active/completed badges; unknown values render as active.
    return status === 'completed' ? 'completed' : 'active';
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value || '');
    return div.innerHTML;
  }

  function shakeElement(el) {
    el.style.borderColor = '#EF4444';
    el.style.animation = 'shake 0.4s ease';
    setTimeout(() => {
      el.style.borderColor = '';
      el.style.animation = '';
    }, 400);
  }
});
