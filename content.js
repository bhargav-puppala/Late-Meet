// Content Script — Google Meet Integration
// Injected into Google Meet pages to detect meetings, monitor participants,
// and display private late-joiner briefs via Supabase Realtime

(function() {
  'use strict';

  const COPILOT_PREFIX = '[MeetingCopilot]';
  let meetingDetected = false;
  let participantPollInterval = null;
  let previousParticipants = [];
  let meetingId = null;
  let supabaseRealtimeSetup = false;
  let briefOverlayVisible = false;

  // ——— Meeting Detection ———
  function extractMeetingId() {
    const url = window.location.href;
    const match = url.match(/meet\.google\.com\/([a-z\-]+)/);
    return match ? match[1] : null;
  }

  function detectMeeting() {
    // Check if we're in an active Google Meet call
    // Primary indicator: the "Leave call" button only exists when connected to a call
    const leaveCallBtn = document.querySelector('button[aria-label="Leave call"]');
    // Fallback: check for other in-call indicators
    const inCallIndicator = leaveCallBtn ||
                             document.querySelector('[data-meeting-code]') ||
                             document.querySelector('[data-unresolved-meeting-id]');

    // Also verify we're on a valid meeting URL (xxx-xxxx-xxx pattern)
    const url = window.location.href;
    const isMeetUrl = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(url);

    if (inCallIndicator && isMeetUrl && !meetingDetected) {
      meetingDetected = true;
      meetingId = extractMeetingId();
      
      console.log(`${COPILOT_PREFIX} Meeting detected: ${meetingId}`);
      
      // Notify background
      chrome.runtime.sendMessage({
        type: 'MEETING_STARTED',
        meetingId: meetingId,
        url: window.location.href
      });

      // Inject floating dashboard button
      injectFloatingButton();
      
      // Start participant monitoring
      startParticipantMonitoring();
      
      // Subscribe to Supabase for incoming briefs (for late joiner scenario)
      subscribeToSupabaseBriefs();
    }
  }

  // ——— Participant Monitoring ———
  function getParticipantNames() {
    const names = new Set();
    
    // Method 1: Participant panel (when open)
    const participantItems = document.querySelectorAll(
      '[data-participant-id] [data-self-name],' +
      '.zWGUib,' +  // Participant name in the list
      '.cS7aqe.NkoGfe' // Participant tile names
    );
    
    participantItems.forEach(el => {
      const name = el.textContent?.trim() || el.getAttribute('data-self-name');
      if (name && name.length > 0 && name !== 'You') {
        names.add(name);
      }
    });
    
    // Method 2: Video tiles with names
    const videoTiles = document.querySelectorAll('.KV1GEc, .dwSJ2e');
    videoTiles.forEach(tile => {
      const nameEl = tile.querySelector('.XEazBc, .zs7s8d, .ZjFb7c');
      if (nameEl) {
        const name = nameEl.textContent?.trim();
        if (name && name !== 'You') names.add(name);
      }
    });
    
    // Method 3: Captions speaker names
    const captionNames = document.querySelectorAll('.zs7s8d.jxFHg');
    captionNames.forEach(el => {
      const name = el.textContent?.trim();
      if (name) names.add(name);
    });
    
    return Array.from(names);
  }

  function startParticipantMonitoring() {
    participantPollInterval = setInterval(() => {
      const currentParticipants = getParticipantNames();
      
      if (currentParticipants.length > 0) {
        // Check for changes
        const hasChanged = currentParticipants.length !== previousParticipants.length ||
          currentParticipants.some(p => !previousParticipants.includes(p));
        
        if (hasChanged) {
          chrome.runtime.sendMessage({
            type: 'PARTICIPANTS_UPDATED',
            participants: currentParticipants
          });
          
          previousParticipants = [...currentParticipants];
        }
      }
    }, 5000); // Check every 5 seconds
  }

  // ——— Supabase Realtime Subscription (for receiving briefs as late joiner) ———
  async function subscribeToSupabaseBriefs() {
    if (supabaseRealtimeSetup || !meetingId) return;
    
    const config = await chrome.storage.local.get(['supabase_url', 'supabase_anon_key']);
    if (!config.supabase_url || !config.supabase_anon_key) {
      console.log(`${COPILOT_PREFIX} Supabase not configured — brief relay disabled`);
      return;
    }
    
    supabaseRealtimeSetup = true;
    
    // Poll for briefs (simpler than Realtime in content script context)
    setInterval(async () => {
      try {
        const response = await fetch(
          `${config.supabase_url}/rest/v1/meeting_briefs?meeting_id=eq.${meetingId}&order=created_at.desc&limit=1`,
          {
            headers: {
              'apikey': config.supabase_anon_key,
              'Authorization': `Bearer ${config.supabase_anon_key}`
            }
          }
        );
        
        if (response.ok) {
          const briefs = await response.json();
          if (briefs.length > 0) {
            const latestBrief = briefs[0];
            const briefAge = Date.now() - new Date(latestBrief.created_at).getTime();
            
            // Only show if brief is less than 30 seconds old (fresh)
            if (briefAge < 30000 && !briefOverlayVisible) {
              showBriefOverlay(latestBrief.brief_content, latestBrief.target_participant);
            }
          }
        }
      } catch (err) {
        // Silent fail — network might be intermittent
      }
    }, 10000); // Poll every 10 seconds
  }

  // ——— Private Brief Overlay ———
  function showBriefOverlay(briefContent, targetName) {
    if (briefOverlayVisible) return;
    briefOverlayVisible = true;
    
    const overlay = document.createElement('div');
    overlay.id = 'mc-brief-overlay';
    overlay.innerHTML = `
      <div class="mc-brief-card">
        <div class="mc-brief-header">
          <div class="mc-brief-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>
          </div>
          <div class="mc-brief-title">AI Meeting Copilot</div>
          <button class="mc-brief-close" id="mc-close-brief">✕</button>
        </div>
        <div class="mc-brief-greeting">${briefContent.greeting || `Hey ${targetName} 👋`}</div>
        <div class="mc-brief-text">${briefContent.briefing || "Here's what you missed:"}</div>
        <div class="mc-brief-section">
          <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Topics Discussed</div>
          <ul class="mc-brief-list">
            ${(briefContent.topicsSummary || []).map(t => `<li>${t}</li>`).join('')}
          </ul>
        </div>
        ${(briefContent.keyDecisions || []).length > 0 ? `
          <div class="mc-brief-section">
            <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Key Decisions</div>
            <ul class="mc-brief-list">
              ${briefContent.keyDecisions.map(d => `<li>${d}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        <div class="mc-brief-section">
          <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg> Current Discussion</div>
          <div class="mc-brief-current">${briefContent.currentDiscussion || 'N/A'}</div>
        </div>
        ${(briefContent.actionItemsForThem || []).length > 0 ? `
          <div class="mc-brief-section">
            <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><path d="M12 11h4"></path><path d="M12 16h4"></path><path d="M8 11h.01"></path><path d="M8 16h.01"></path></svg> Action Items</div>
            <ul class="mc-brief-list">
              ${briefContent.actionItemsForThem.map(a => `<li>${a}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        <div class="mc-brief-footer">Only you can see this notification</div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add('mc-visible');
    });
    
    // Close button
    document.getElementById('mc-close-brief').addEventListener('click', () => {
      overlay.classList.remove('mc-visible');
      setTimeout(() => overlay.remove(), 300);
      briefOverlayVisible = false;
    });
    
    // Auto-dismiss after 30 seconds
    setTimeout(() => {
      if (overlay.parentNode) {
        overlay.classList.remove('mc-visible');
        setTimeout(() => overlay.remove(), 300);
        briefOverlayVisible = false;
      }
    }, 30000);
  }

  // ——— Floating Dashboard Button ———
  function injectFloatingButton() {
    if (document.getElementById('mc-float-btn')) return;
    
    const btn = document.createElement('div');
    btn.id = 'mc-float-btn';
    btn.innerHTML = `
      <div class="mc-float-btn-inner">
        <div class="mc-float-pulse"></div>
        <div class="mc-float-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>
        </div>
      </div>
      <div class="mc-float-label">AI Copilot</div>
    `;
    
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    });
    
    document.body.appendChild(btn);
    
    // Animate in
    requestAnimationFrame(() => {
      btn.classList.add('mc-visible');
    });
  }

  // ——— Meeting End Detection ———
  function detectMeetingEnd() {
    if (!meetingDetected) return;

    // Primary check: "Leave call" button disappears when you leave
    const leaveCallBtn = document.querySelector('button[aria-label="Leave call"]');

    // Secondary checks: explicit "you left" indicators
    const youLeftText = document.body.innerText.includes('You left the meeting');
    const rejoinBtn = document.querySelector('[jsname="oI7Fj"]');
    const returnHomeBtn = document.querySelector('.CRFCdf');
    const callEndedIndicator = document.querySelector('[data-call-ended]');

    const meetingEnded = !leaveCallBtn &&
      (youLeftText || rejoinBtn || returnHomeBtn || callEndedIndicator);

    if (meetingEnded) {
      meetingDetected = false;
      console.log(`${COPILOT_PREFIX} Meeting ended`);
      
      chrome.runtime.sendMessage({ type: 'MEETING_ENDED' });
      
      if (participantPollInterval) {
        clearInterval(participantPollInterval);
        participantPollInterval = null;
      }
      
      // Remove floating button
      const btn = document.getElementById('mc-float-btn');
      if (btn) btn.remove();
    }
  }

  // ——— Listen for state updates from background ———
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SHOW_BRIEF') {
      showBriefOverlay(message.briefContent, message.targetName);
      sendResponse({ success: true });
    }
    return true;
  });

  // ——— Initialize ———
  function init() {
    console.log(`${COPILOT_PREFIX} Content script loaded on Google Meet`);
    
    // Try to detect meeting immediately
    detectMeeting();
    
    // Keep checking for meeting start (user might not be in call yet)
    const meetingCheckInterval = setInterval(() => {
      if (!meetingDetected) {
        detectMeeting();
      } else {
        detectMeetingEnd();
      }
    }, 3000);
    
    // Also observe DOM for dynamic changes
    const observer = new MutationObserver(() => {
      if (!meetingDetected) {
        detectMeeting();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
