/**
 * Fluxx AI Side Panel
 *
 * Main chat interface for the extension.
 * Communicates with content script and backend API.
 */

// Configuration
const CONFIG = {
  apiEndpoint: 'https://fluxxai-web-service.onrender.com/api/chat',
  generateFormEndpoint: 'https://fluxxai-web-service.onrender.com/api/generate-form',
  maxRetries: 3
};

// State
let state = {
  connected: false,
  fluxxTabId: null,
  currentExport: null,
  themeNameFromUI: null,
  modelNameFromUI: null,
  pendingOperations: null,
  isLoading: false,
  conversationHistory: [] // Track conversation for context
};

// DOM Elements
const elements = {
  status: document.getElementById('status'),
  connectionPanel: document.getElementById('connectionPanel'),
  formInfo: document.getElementById('formInfo'),
  modelName: document.getElementById('modelName'),
  themeName: document.getElementById('themeName'),
  elementCount: document.getElementById('elementCount'),
  refreshBtn: document.getElementById('refreshBtn'),
  messages: document.getElementById('messages'),
  operationsPreview: document.getElementById('operationsPreview'),
  previewContent: document.getElementById('previewContent'),
  cancelOps: document.getElementById('cancelOps'),
  rejectOps: document.getElementById('rejectOps'),
  applyOps: document.getElementById('applyOps'),
  userInput: document.getElementById('userInput'),
  sendBtn: document.getElementById('sendBtn'),
  docUpload: document.getElementById('docUpload'),
  uploadLabel: document.getElementById('uploadLabel')
};

// Initialize
async function init() {
  setupEventListeners();

  chrome.runtime.onMessage.addListener(handleMessage);

  // Load persisted conversation history
  await loadConversationHistory();

  // Recheck connection when switching tabs
  chrome.tabs.onActivated.addListener(async () => {
    await new Promise(r => setTimeout(r, 100));
    checkFluxxConnection();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete' && tabId === state.fluxxTabId) {
      setTimeout(checkFluxxConnection, 500);
    }
  });

  await checkFluxxConnectionWithRetry();
}

// Get a unique identifier for the current form
function getFormId() {
  // Try stencil ID from export
  const stencilId = state.currentExport?.records?.Stencil?.[0]?.id;
  if (stencilId) return String(stencilId);

  // Fallback: use theme name
  if (state.themeNameFromUI) return state.themeNameFromUI.replace(/[^a-zA-Z0-9]/g, '_');

  return null;
}

// Persist conversation history to survive page refreshes
async function saveConversationHistory() {
  try {
    const formId = getFormId();
    if (formId) {
      await chrome.storage.session.set({
        [`chat_${formId}`]: state.conversationHistory,
        'currentFormId': formId
      });
    }
  } catch (e) {
    // Ignore storage errors
  }
}

async function loadConversationHistory() {
  try {
    const result = await chrome.storage.session.get(['currentFormId']);
    if (result.currentFormId) {
      const chatResult = await chrome.storage.session.get([`chat_${result.currentFormId}`]);
      const history = chatResult[`chat_${result.currentFormId}`];
      if (history && Array.isArray(history)) {
        state.conversationHistory = history;
        // Restore chat UI
        for (const msg of history) {
          addMessage(msg.role === 'user' ? 'user' : 'assistant', msg.content, true);
        }
      }
    }
  } catch (e) {
    // Ignore storage errors
  }
}

async function clearConversationHistory() {
  state.conversationHistory = [];
  elements.messages.innerHTML = '';
  try {
    const formId = getFormId();
    if (formId) {
      await chrome.storage.session.remove([`chat_${formId}`, 'currentFormId']);
    }
  } catch (e) {
    // Ignore storage errors
  }
}

function setupEventListeners() {
  // Send message
  elements.sendBtn.addEventListener('click', sendMessage);
  elements.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Refresh export
  elements.refreshBtn.addEventListener('click', refreshExport);

  // Operations preview
  elements.cancelOps.addEventListener('click', hideOperationsPreview);
  elements.rejectOps.addEventListener('click', hideOperationsPreview);
  elements.applyOps.addEventListener('click', applyOperations);

  // Document upload for form generation
  elements.docUpload.addEventListener('change', handleDocumentUpload);
}

// Connection Management with retry
async function checkFluxxConnectionWithRetry(retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    const connected = await checkFluxxConnection();
    if (connected) return true;

    if (i < retries - 1) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

// Check if URL is a Fluxx site
function isFluxxSite(url) {
  return url?.includes('fluxxlabs.com') || url?.includes('fluxx.io');
}

async function checkFluxxConnection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !isFluxxSite(tab.url)) {
      setDisconnected('Not on Fluxx');
      return false;
    }

    state.fluxxTabId = tab.id;

    elements.status.querySelector('.status-dot').className = 'status-dot loading';
    elements.status.querySelector('.status-text').textContent = 'Loading...';

    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'GET_EXPORT' }, (response) => {
        if (chrome.runtime.lastError) {
          setDisconnected('Loading...');
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/fluxx-bridge.js']
          }).catch(() => {});
          resolve(false);
          return;
        }

        if (response && response.success) {
          setConnected(response.data, response.themeNameFromUI, response.modelNameFromUI);
          resolve(true);
        } else {
          setDisconnected(response?.error || 'Open a form theme');
          resolve(false);
        }
      });
    });
  } catch (err) {
    setDisconnected(err.message);
    return false;
  }
}

function setConnected(exportData, themeNameFromUI = null, modelNameFromUI = null) {
  // Get current form ID before updating state
  const oldFormId = getFormId();

  state.connected = true;
  state.currentExport = exportData;
  state.themeNameFromUI = themeNameFromUI;
  state.modelNameFromUI = modelNameFromUI;

  // Check if we switched to a different form - clear conversation if so
  const newFormId = getFormId();
  if (oldFormId && newFormId && oldFormId !== newFormId) {
    clearConversationHistory();
  }

  // Update UI
  elements.status.querySelector('.status-dot').className = 'status-dot connected';
  elements.status.querySelector('.status-text').textContent = 'Connected';

  elements.connectionPanel.style.display = 'none';
  elements.formInfo.style.display = 'flex';

  // Parse export info
  if (exportData && exportData.records && exportData.records.Stencil) {
    const stencil = exportData.records.Stencil[0];

    // Prefer UI model name over raw model_type (more user-friendly)
    const modelName = modelNameFromUI || stencil.model_type || '-';
    elements.modelName.textContent = modelName;

    // Prefer UI theme name over export JSON data (more accurate)
    const themeName = themeNameFromUI || exportData.name || stencil.name || '-';
    elements.themeName.textContent = themeName;

    // Count elements
    const count = countElements(stencil.json?.elements || []);
    elements.elementCount.textContent = count;
  }

  // Enable input
  elements.userInput.disabled = false;
  elements.sendBtn.disabled = false;
  elements.docUpload.disabled = false;
  elements.userInput.placeholder = 'Describe the changes you want to make...';
}

function setDisconnected(reason) {
  state.connected = false;
  state.currentExport = null;
  state.themeNameFromUI = null;
  state.modelNameFromUI = null;
  state.fluxxTabId = null;
  // Note: Don't clear conversation history on disconnect - page might just be refreshing

  elements.status.querySelector('.status-dot').className = 'status-dot disconnected';
  elements.status.querySelector('.status-text').textContent = reason || 'Not connected';

  elements.connectionPanel.style.display = 'block';
  elements.formInfo.style.display = 'none';

  // Clear display values
  elements.modelName.textContent = '-';
  elements.themeName.textContent = '-';
  elements.elementCount.textContent = '-';

  elements.userInput.disabled = true;
  elements.sendBtn.disabled = true;
  elements.docUpload.disabled = true;
  elements.userInput.placeholder = 'Connect to Fluxx to get started...';
}

function countElements(elements, count = 0) {
  for (const el of elements) {
    count++;
    if (el.elements) {
      count = countElements(el.elements, count);
    }
  }
  return count;
}

// Message Handling
function handleMessage(message) {
  switch (message.type) {
    case 'FLUXX_PAGE_LOADED':
    case 'FLUXX_STATE_CHANGED':
      if (message.isOnFormEditor) {
        state.currentExport = null;
        checkFluxxConnection();
      } else {
        setDisconnected('Open a form theme');
      }
      break;
    case 'EXPORT_UPDATED':
      if (message.data) {
        setConnected(message.data, message.themeNameFromUI, message.modelNameFromUI);
      }
      break;
    case 'IMPORT_COMPLETE':
      addMessage('assistant', 'Changes applied successfully! The form has been updated.');
      setLoading(false);
      break;
    case 'IMPORT_ERROR':
      addMessage('error', `Failed to apply changes: ${message.error}`);
      setLoading(false);
      break;
  }
}

// Chat Functions
async function sendMessage() {
  const text = elements.userInput.value.trim();
  if (!text || state.isLoading || !state.connected) return;

  // Add user message to history first, then UI (which triggers save)
  state.conversationHistory.push({ role: 'user', content: text });
  addMessage('user', text);
  elements.userInput.value = '';

  setLoading(true);

  try {
    const response = await fetch(CONFIG.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        export: state.currentExport,
        conversationHistory: state.conversationHistory.slice(-10) // Last 10 messages for context
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      addMessage('error', data.error);
    } else if (data.operations && Array.isArray(data.operations) && data.operations.length > 0) {
      const explanation = data.explanation || 'Here are the proposed changes:';
      // Add to history before UI (which triggers save)
      state.conversationHistory.push({ role: 'assistant', content: explanation });
      addMessage('assistant', explanation);
      showOperationsPreview(data.operations);
      state.pendingOperations = data.operations;
    } else if (data.operations && !Array.isArray(data.operations)) {
      addMessage('error', 'Invalid response format from AI. Please try again.');
    } else {
      const explanation = data.explanation || data.response || 'I couldn\'t determine what changes to make. Could you clarify?';
      // Add to history before UI (which triggers save)
      state.conversationHistory.push({ role: 'assistant', content: explanation });
      addMessage('assistant', explanation);
    }
  } catch (err) {
    addMessage('error', `Failed to connect to AI service: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

// Handle document upload for form generation
async function handleDocumentUpload(e) {
  const file = e.target.files[0];
  if (!file || state.isLoading || !state.connected) {
    e.target.value = ''; // Reset input
    return;
  }

  // Validate file type
  const validTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
  if (!validTypes.includes(file.type)) {
    addMessage('error', 'Please upload a PDF or Word document (.pdf, .doc, .docx)');
    e.target.value = '';
    return;
  }

  addMessage('user', `📄 Uploaded: ${file.name}`);
  addMessage('assistant', 'Analyzing document and generating form structure... This may take a moment.');

  setLoading(true);

  try {
    const formData = new FormData();
    formData.append('document', file);

    // Include current export for style reference (if available)
    if (state.currentExport) {
      formData.append('export', JSON.stringify(state.currentExport));
    }

    const response = await fetch(CONFIG.generateFormEndpoint, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      addMessage('error', data.error);
    } else if (data.operations && Array.isArray(data.operations) && data.operations.length > 0) {
      const explanation = data.explanation || `Generated ${data.operations.length} operations to create the form.`;
      addMessage('assistant', explanation);
      showOperationsPreview(data.operations);
      state.pendingOperations = data.operations;
    } else {
      addMessage('error', 'Could not generate form structure from the document. Try a different document or describe what you need.');
    }
  } catch (err) {
    addMessage('error', `Failed to process document: ${err.message}`);
  } finally {
    setLoading(false);
    e.target.value = ''; // Reset file input
  }
}

function addMessage(type, content, isRestoring = false) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  // Support HTML content
  if (content.includes('<')) {
    contentDiv.innerHTML = content;
  } else {
    contentDiv.innerHTML = `<p>${escapeHtml(content)}</p>`;
  }

  messageDiv.appendChild(contentDiv);
  elements.messages.appendChild(messageDiv);

  // Scroll to bottom
  elements.messages.scrollTop = elements.messages.scrollHeight;

  // Save to storage (unless we're restoring from storage)
  if (!isRestoring && type !== 'error') {
    saveConversationHistory();
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Operations Preview
function showOperationsPreview(operations) {
  const html = operations.map(op => {
    const details = formatOperationDetails(op);
    return `
      <div class="op-item">
        <span class="op-type ${op.type}">${op.type}</span>
        <div class="op-details">
          <div class="op-summary">${escapeHtml(details.summary)}</div>
          ${details.changes.length > 0 ? `
            <ul class="op-changes">
              ${details.changes.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
            </ul>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  elements.previewContent.innerHTML = html;
  elements.operationsPreview.style.display = 'block';
}

function formatOperationDetails(op) {
  const details = { summary: '', changes: [] };

  if (op.type === 'add') {
    // ADD operation
    const name = op.label || op.field_name || (op.content ? op.content.substring(0, 40) + '...' : 'element');
    details.summary = `Add ${op.element_type || 'element'}: "${name}"`;

    if (op.position) details.changes.push(`Position: ${op.position}`);
    if (op.config) {
      if (op.config.hide_label) details.changes.push('Hidden label');
      if (op.config.collapsible) details.changes.push('Collapsible');
      if (op.config.show_in_toc) details.changes.push('Show in TOC');
    }
    if (op.conditional) {
      details.changes.push(`Conditional: show when ${op.conditional.field} = "${op.conditional.values?.join('" or "')}"`);
    }
    if (op.styling?.background_color) details.changes.push(`Background: ${op.styling.background_color}`);
    if (op.visibility?.show_states) details.changes.push(`States: ${op.visibility.show_states.join(', ')}`);
    if (op.visibility?.user_profile) details.changes.push(`Profiles: ${op.visibility.user_profile.join(', ')}`);

  } else if (op.type === 'edit') {
    // EDIT operation
    details.summary = `Edit element (${op.uid?.substring(0, 8)}...)`;

    // Label/content changes
    if (op.label !== undefined) details.changes.push(`Label → "${op.label}"`);
    if (op.content !== undefined) details.changes.push(`Content → "${op.content.substring(0, 50)}${op.content.length > 50 ? '...' : ''}"`);

    // Config changes
    if (op.config) {
      if (op.config.label !== undefined) details.changes.push(`Label → "${op.config.label}"`);
      if (op.config.hide_label !== undefined) details.changes.push(op.config.hide_label ? 'Hide label' : 'Show label');
      if (op.config.collapsible !== undefined) details.changes.push(op.config.collapsible ? 'Make collapsible' : 'Remove collapsible');
      if (op.config.default_open !== undefined) details.changes.push(op.config.default_open ? 'Default open' : 'Default closed');
      if (op.config.show_in_toc !== undefined) details.changes.push(op.config.show_in_toc ? 'Add to TOC' : 'Remove from TOC');
      if (op.config.open_states) details.changes.push(`Open in states: ${op.config.open_states.join(', ')}`);
    }

    // Conditional visibility
    if (op.conditional) {
      if (op.conditional.field) {
        details.changes.push(`Conditional: ${op.conditional.type || 'show'} when ${op.conditional.field} = "${op.conditional.values?.join('" or "')}"`);
      } else {
        details.changes.push('Remove conditional visibility');
      }
    }

    // Styling changes
    if (op.styling) {
      const styleChanges = [];
      if (op.styling.background_color) styleChanges.push(`bg: ${op.styling.background_color}`);
      if (op.styling.color) styleChanges.push(`text: ${op.styling.color}`);
      if (op.styling.alignment) styleChanges.push(`align: ${op.styling.alignment}`);
      if (op.styling.border_top_enabled || op.styling.border_bottom_enabled ||
          op.styling.border_left_enabled || op.styling.border_right_enabled) {
        styleChanges.push('borders');
      }
      if (op.styling.padding_top || op.styling.padding_bottom) styleChanges.push('padding');
      if (op.styling.margin_top || op.styling.margin_bottom) styleChanges.push('margins');
      if (styleChanges.length > 0) details.changes.push(`Styling: ${styleChanges.join(', ')}`);
    }

    // Visibility changes
    if (op.visibility) {
      if (op.visibility.show_states) details.changes.push(`Show in states: ${op.visibility.show_states.join(', ')}`);
      if (op.visibility.read_only_states) details.changes.push(`Read-only in: ${op.visibility.read_only_states.join(', ')}`);
      if (op.visibility.user_profile) details.changes.push(`Profiles: ${op.visibility.user_profile.join(', ')}`);
      if (op.visibility.visible_form !== undefined) details.changes.push(op.visibility.visible_form ? 'Show in form' : 'Hide in form');
      if (op.visibility.visible_show !== undefined) details.changes.push(op.visibility.visible_show ? 'Show in view' : 'Hide in view');
    }

    // If no specific changes detected, show generic message
    if (details.changes.length === 0) {
      details.changes.push('Update properties');
    }

  } else if (op.type === 'move') {
    // MOVE operation
    details.summary = `Move element (${op.uid?.substring(0, 8)}...)`;
    details.changes.push(`Position: ${op.position} ${op.target?.startsWith('$') ? op.target : `(${op.target?.substring(0, 8)}...)`}`);

  } else if (op.type === 'delete') {
    // DELETE operation
    details.summary = `Delete element (${op.uid?.substring(0, 8)}...)`;
    details.changes.push('⚠️ This will also delete all children');

  } else {
    // Unknown operation type
    details.summary = `${op.type || 'Unknown'} operation`;
  }

  return details;
}

function hideOperationsPreview() {
  elements.operationsPreview.style.display = 'none';
  state.pendingOperations = null;
}

async function applyOperations() {
  if (!state.pendingOperations || !Array.isArray(state.pendingOperations) || !state.fluxxTabId) {
    addMessage('error', 'Make sure you\'re in form preview mode.');
    return;
  }

  const ops = [...state.pendingOperations];
  state.pendingOperations = null;

  setLoading(true);
  hideOperationsPreview();
  addMessage('assistant', 'Applying changes...');

  chrome.tabs.sendMessage(state.fluxxTabId, {
    type: 'APPLY_OPERATIONS',
    operations: ops,
    export: state.currentExport
  });
}

// Refresh Export
async function refreshExport() {
  if (!state.fluxxTabId) return;

  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = 'Refreshing...';

  chrome.tabs.sendMessage(state.fluxxTabId, { type: 'REFRESH_EXPORT' }, (response) => {
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = 'Refresh Export';

    if (response && response.success) {
      setConnected(response.data, response.themeNameFromUI, response.modelNameFromUI);
      addMessage('assistant', 'Export refreshed successfully.');
    } else {
      addMessage('error', 'Failed to refresh export.');
    }
  });
}

// Loading State
function setLoading(loading) {
  state.isLoading = loading;

  elements.sendBtn.disabled = loading;
  elements.userInput.disabled = loading;

  elements.sendBtn.querySelector('.btn-text').style.display = loading ? 'none' : 'inline';
  elements.sendBtn.querySelector('.btn-loading').style.display = loading ? 'inline-flex' : 'none';
}

// Start
init();
