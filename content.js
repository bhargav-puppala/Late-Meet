(() => {
  const COPILOT_PREFIX = '[LateMeet]';

  const SELECTORS = {
    chatToggleButtons: [
      'button[aria-label*="Chat"]',
      'button[data-panel-id="chat-pane"]',
      'button[jsname][aria-label*="chat"]'
    ],
    chatInput: [
      'textarea[aria-label="Chat text input"]',
      'textarea[name="chatTextInput"]',
      'div[contenteditable="true"][aria-label*="message"]'
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[data-tooltip="Send message"]',
      'button[jsname][aria-label*="Send"]'
    ],
    participantNodes: [
      '[data-participant-id] [data-self-name]',
      '[data-participant-id] [role="heading"]',
      '[data-participant-id] [aria-label]'
    ]
  };

  function queryFirst(selectors, root = document) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function getTextValue(el) {
    if (!el) return '';
    if ('value' in el) return String(el.value || '').trim();
    return String(el.textContent || '').trim();
  }

  function setInputValue(el, value) {
    if ('value' in el) {
      el.value = value;
    } else {
      el.textContent = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  async function wait(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  async function findChatInputWithRetry(attempts = 6) {
    for (let i = 0; i < attempts; i += 1) {
      const input = queryFirst(SELECTORS.chatInput);
      if (input) return input;
      await wait(300);
    }
    return null;
  }

  async function ensureChatPanelOpen() {
    const existingInput = queryFirst(SELECTORS.chatInput);
    if (existingInput) return existingInput;

    const chatToggle = queryFirst(SELECTORS.chatToggleButtons);
    if (chatToggle) {
      chatToggle.click();
      return findChatInputWithRetry(8);
    }

    return null;
  }

  async function sendChatMessage(message) {
    console.log(`${COPILOT_PREFIX} Attempting to send chat message.`);

    try {
      const chatInput = await ensureChatPanelOpen();
      if (!chatInput) {
        console.error(`${COPILOT_PREFIX} Could not find chat input box.`);
        return false;
      }

      setInputValue(chatInput, message);
      await wait(150);

      const sendButton = queryFirst(SELECTORS.sendButton);
      if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
        sendButton.click();
      } else {
        chatInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        }));
      }

      if (getTextValue(chatInput) === message) {
        chatInput.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        }));
      }

      console.log(`${COPILOT_PREFIX} Chat message send attempted.`);
      return true;
    } catch (err) {
      console.error(`${COPILOT_PREFIX} Error sending chat message:`, err);
      return false;
    }
  }

  function upsertBriefOverlay(briefContent, targetName) {
    const overlayId = 'late-meet-brief-overlay';
    let overlay = document.getElementById(overlayId);

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.style.position = 'fixed';
      overlay.style.right = '16px';
      overlay.style.bottom = '16px';
      overlay.style.maxWidth = '360px';
      overlay.style.zIndex = '2147483647';
      overlay.style.background = 'rgba(0,0,0,0.9)';
      overlay.style.color = '#fff';
      overlay.style.border = '1px solid rgba(255,255,255,0.2)';
      overlay.style.borderRadius = '12px';
      overlay.style.padding = '12px';
      overlay.style.fontFamily = 'Inter, Arial, sans-serif';
      overlay.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
      document.body.appendChild(overlay);
    }

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = targetName ? `Brief for ${targetName}` : 'Meeting brief';

    const body = document.createElement('div');
    body.style.fontSize = '13px';
    body.style.lineHeight = '1.4';
    body.textContent = String(briefContent || 'No brief content available.');

    overlay.replaceChildren(title, body);

    setTimeout(() => {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }, 8000);
  }

  function collectParticipants() {
    const names = new Set();

    for (const selector of SELECTORS.participantNodes) {
      document.querySelectorAll(selector).forEach(node => {
        const label = node.getAttribute('aria-label');
        const text = (label || node.textContent || '').trim();
        if (text && text.length < 120) names.add(text);
      });

      if (names.size > 0) break;
    }

    return [...names];
  }

  let participantPollTimer = null;

  function startParticipantPolling() {
    if (participantPollTimer) return;

    participantPollTimer = setInterval(async () => {
      const participants = collectParticipants();
      if (participants.length === 0) return;

      try {
        await chrome.runtime.sendMessage({
          type: 'PARTICIPANTS_UPDATED',
          participants
        });
      } catch {
        // Ignore while service worker is inactive/unavailable.
      }
    }, 5000);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SHOW_BRIEF') {
      upsertBriefOverlay(message.briefContent, message.targetName);
      sendResponse({ success: true });
      return false;
    }

    if (message?.type === 'SEND_CHAT_MESSAGE') {
      sendChatMessage(message.text).then(success => sendResponse({ success }));
      return true;
    }

    sendResponse({ success: false, error: 'Unknown message type' });
    return false;
  });

  startParticipantPolling();
})();
