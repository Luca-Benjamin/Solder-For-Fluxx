/**
 * Fluxx AI Background Service Worker
 *
 * Handles:
 * 1. Extension icon click -> open side panel
 * 2. Relay messages between content script and side panel
 * 3. Inject content script when needed
 */

// Set side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Listen for messages and relay between content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from content script - forward to any listeners (side panel)
  if (sender.tab) {
    console.log('[Fluxx AI BG] Message from content script:', message.type);
  }

  // Return true to keep the message channel open
  return false;
});

// Check if URL is a Fluxx site
function isFluxxSite(url) {
  return url?.includes('fluxxlabs.com') || url?.includes('fluxx.io');
}

// When a tab finishes loading a Fluxx page, ensure content script is injected
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && isFluxxSite(tab.url)) {
    try {
      // Check if content script is already loaded
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    } catch (e) {
      // Content script not loaded, inject it
      console.log('[Fluxx AI BG] Injecting content script into tab', tabId);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/fluxx-bridge.js']
        });
        await chrome.scripting.insertCSS({
          target: { tabId },
          files: ['content/fluxx-bridge.css']
        });
      } catch (err) {
        console.error('[Fluxx AI BG] Failed to inject:', err);
      }
    }
  }
});

// Listen for tab activation to handle switching between tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (isFluxxSite(tab.url)) {
      console.log('[Fluxx AI BG] Activated Fluxx tab:', activeInfo.tabId);
    }
  } catch (e) {
    // Tab might not exist anymore
  }
});
