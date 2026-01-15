/**
 * Fluxx Bridge - Content Script
 *
 * Runs on Fluxx pages to:
 * 1. Detect form editor pages
 * 2. Download JSON exports
 * 3. Apply changes via import
 */

// State
let currentExport = null;
let currentExportUrl = null;
let isOnFormEditor = false;
let detectionInterval = null;
let debounceTimer = null;

// Initialize
function init() {
  // Initial detection
  detectFormEditor();

  // Re-check when page changes (Fluxx is SPA-like)
  const observer = new MutationObserver((mutations) => {
    // Check if any mutation affects the export link area
    let shouldCheck = false;
    for (const mutation of mutations) {
      // Check if export link was added/removed/changed
      if (mutation.type === 'childList') {
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (node.nodeType === 1) { // Element node
            if (node.matches?.('a.export-form') || node.querySelector?.('a.export-form')) {
              shouldCheck = true;
              break;
            }
          }
        }
      }
      if (shouldCheck) break;
    }

    // Debounce - use longer delay to let Fluxx finish updating
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(detectFormEditor, shouldCheck ? 500 : 300);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Also poll periodically as backup (Fluxx can be slow to render)
  detectionInterval = setInterval(detectFormEditor, 2000);

  // Listen for clicks on theme items in the dock
  document.addEventListener('click', (e) => {
    // Check if clicked on a theme entry (stencil/view) in the sidebar
    const themeEntry = e.target.closest('li.active.entry, li.entry');
    if (themeEntry && themeEntry.dataset.modelId) {
      const clickedStencilId = themeEntry.dataset.modelId;

      if (clickedStencilId && clickedStencilId !== currentStencilId) {
        currentStencilId = clickedStencilId;
        currentExport = null;
        notifyExtension();
        setTimeout(() => {
          detectFormEditor();
          notifyExtension();
        }, 1000);
      }
      return;
    }

    // Check if clicked on a model/theme header (li.icon)
    const modelItem = e.target.closest('li.icon:not(.new-theme):not(.retired-themes):not(.export-view):not(.filter-view):not(.viz-view)');
    if (modelItem && !themeEntry) {
      const selectedEntry = modelItem.querySelector('li.active.entry.selected') ||
                           modelItem.querySelector('li.active.entry');
      if (selectedEntry && selectedEntry.dataset.modelId) {
        const newStencilId = selectedEntry.dataset.modelId;
        if (newStencilId !== currentStencilId) {
          currentStencilId = newStencilId;
          currentExport = null;
          notifyExtension();
          setTimeout(() => {
            detectFormEditor();
            notifyExtension();
          }, 1000);
        }
      } else {
        // Wait for Fluxx to load the stencil list
        setTimeout(() => {
          const entry = modelItem.querySelector('li.active.entry.selected') ||
                       modelItem.querySelector('li.active.entry');
          if (entry && entry.dataset.modelId) {
            currentStencilId = entry.dataset.modelId;
            currentExport = null;
            detectFormEditor();
            notifyExtension();
          }
        }, 1500);
      }
    }
  }, true);

  // Notify extension that content script is ready
  notifyExtension();
}

// Track the current stencil ID we're working with
let currentStencilId = null;

// Find the export link for a specific stencil ID, or any export link as fallback
function findExportLink(targetStencilId = null) {
  const allExportLinks = document.querySelectorAll('a.export-form.air-download, a[href*="stencil_export"]');

  if (allExportLinks.length === 0) {
    return null;
  }

  // If we have a target stencil ID, find that specific export link
  if (targetStencilId) {
    for (const link of allExportLinks) {
      const href = link.getAttribute('href') || '';
      if (href.includes(`stencil_export/${targetStencilId}.json`)) {
        return link;
      }
    }
  }

  // Fallback: return first export link
  return allExportLinks[0];
}

// Get stencil ID from export link href
function getStencilIdFromLink(exportLink) {
  if (!exportLink) return null;
  const href = exportLink.getAttribute('href');
  // Format: /stencil_export/34984.json or full URL
  const match = href?.match(/stencil_export\/(\d+)\.json/);
  return match ? match[1] : null;
}

// Get theme name from the sidebar by finding the stencil entry and traversing up to its parent model
function getThemeNameFromUI(stencilId) {
  // Method 1 (PRIORITY): Find stencil entry by ID and get parent model's label
  if (stencilId) {
    const selectors = [
      `li.active.entry[data-model-id="${stencilId}"]`,
      `li.entry[data-model-id="${stencilId}"]`,
      `li[data-model-id="${stencilId}"]`
    ];

    let stencilEntry = null;
    for (const selector of selectors) {
      stencilEntry = document.querySelector(selector);
      if (stencilEntry) break;
    }

    if (stencilEntry) {
      const parentModel = stencilEntry.closest('li.icon');
      if (parentModel) {
        const modelLabel = parentModel.querySelector('a.link span.label');
        if (modelLabel) {
          return modelLabel.textContent?.trim();
        }
      }
    }
  }

  // Method 2: Find the selected model that contains a selected entry
  // (This avoids picking up selected models from other model types)
  const allSelectedModels = document.querySelectorAll('li.icon.selected');
  for (const model of allSelectedModels) {
    const hasSelectedEntry = model.querySelector('li.active.entry.selected');
    if (hasSelectedEntry) {
      const modelLabel = model.querySelector('a.link span.label');
      if (modelLabel) {
        const themeName = modelLabel.textContent?.trim();
        console.log('[Fluxx AI] Theme name from selected model with entry:', themeName);
        return themeName;
      }
    }
  }

  // Method 3: Fallback - just get first selected model's label
  const selectedModel = document.querySelector('li.icon.selected a.link span.label');
  if (selectedModel) {
    const themeName = selectedModel.textContent?.trim();
    console.log('[Fluxx AI] Theme name from first selected model (fallback):', themeName);
    return themeName;
  }

  console.log('[Fluxx AI] Could not find theme name for stencil', stencilId);
  return null;
}

// Get model name from the sidebar - look at the dock section header
function getModelNameFromUI(stencilId) {
  // Method 1: Find stencil entry and get its containing dock section
  if (stencilId) {
    const selectors = [
      `li.active.entry[data-model-id="${stencilId}"]`,
      `li.entry[data-model-id="${stencilId}"]`,
      `li[data-model-id="${stencilId}"]`
    ];

    let stencilEntry = null;
    for (const selector of selectors) {
      stencilEntry = document.querySelector(selector);
      if (stencilEntry) break;
    }

    if (stencilEntry) {
      // Find the dock section that contains this entry
      const dockSection = stencilEntry.closest('div.dock-section, section.dock-section, .dock-section');
      if (dockSection) {
        // Look for section header with the model name
        const sectionHeader = dockSection.querySelector('.dock-section-header h3, .dock-section-header span, h3, header span');
        if (sectionHeader) {
          const modelName = sectionHeader.textContent?.trim();
          if (modelName) {
            console.log('[Fluxx AI] Model name from dock section:', modelName);
            return modelName;
          }
        }
      }

      // Alternative: Find the closest dock panel/card and get its title
      const dockPanel = stencilEntry.closest('.dock-panel, .panel, .card');
      if (dockPanel) {
        const panelTitle = dockPanel.querySelector('.title, .panel-title, h2, h3');
        if (panelTitle) {
          const modelName = panelTitle.textContent?.trim();
          if (modelName) {
            console.log('[Fluxx AI] Model name from dock panel:', modelName);
            return modelName;
          }
        }
      }
    }
  }

  // Method 2: Look for selected dock section header
  const selectedSection = document.querySelector('.dock-section.selected, .dock-section.active');
  if (selectedSection) {
    const header = selectedSection.querySelector('h3, .dock-section-header');
    if (header) {
      const modelName = header.textContent?.trim();
      if (modelName) {
        console.log('[Fluxx AI] Model name from selected section:', modelName);
        return modelName;
      }
    }
  }

  // Method 3: Look for breadcrumb or page header with model info
  const breadcrumb = document.querySelector('.breadcrumb .current, .page-header h1, .admin-header h1');
  if (breadcrumb) {
    const text = breadcrumb.textContent?.trim();
    if (text && !text.includes('Form Builder')) {
      console.log('[Fluxx AI] Model name from breadcrumb:', text);
      return text;
    }
  }

  console.log('[Fluxx AI] Could not find model name from UI for stencil', stencilId);
  return null;
}

// Convert model_type to a user-friendly display name
function formatModelType(modelType) {
  if (!modelType) return null;

  // Common mappings
  const modelNames = {
    'GrantRequest': 'Grant Request',
    'GenericTemplate': 'Portal Page',
    'PortfolioOverview': 'Portfolio Overview',
    'RequestReport': 'Request Report',
    'RequestReview': 'Request Review',
    'Organization': 'Organization',
    'User': 'User',
    'Program': 'Program',
    'SubProgram': 'Sub Program',
    'Initiative': 'Initiative',
    'FundingSource': 'Funding Source'
  };

  if (modelNames[modelType]) {
    return modelNames[modelType];
  }

  // Fallback: convert PascalCase to Title Case with spaces
  return modelType.replace(/([A-Z])/g, ' $1').trim();
}

// Detect if we're on a form editor page
function detectFormEditor() {
  const exportLink = findExportLink(currentStencilId);
  const importBtn = document.querySelector('a.import-form') || document.querySelector('a[title="Import"]');
  const wasOnFormEditor = isOnFormEditor;
  const foundStencilId = getStencilIdFromLink(exportLink);

  isOnFormEditor = !!(exportLink && importBtn);

  if (isOnFormEditor && !wasOnFormEditor) {
    // Just entered form editor
    if (!currentStencilId && foundStencilId) {
      currentStencilId = foundStencilId;
    }
    currentExportUrl = exportLink?.getAttribute('href');
    showIndicator();
    notifyExtension();
  } else if (!isOnFormEditor && wasOnFormEditor) {
    // Left form editor
    hideIndicator();
    currentExport = null;
    currentStencilId = null;
    currentExportUrl = null;
    notifyExtension();
  } else if (isOnFormEditor && currentStencilId && foundStencilId !== currentStencilId) {
    // Stencil changed
    currentExportUrl = exportLink?.getAttribute('href');
    notifyExtension();
  }
}

// Notify the extension about current state
function notifyExtension() {
  chrome.runtime.sendMessage({
    type: 'FLUXX_STATE_CHANGED',
    isOnFormEditor: isOnFormEditor,
    themeUrl: currentExportUrl
  }).catch(() => {}); // Ignore errors if sidepanel isn't open
}

// Download export JSON
async function downloadExport() {
  const exportLink = findExportLink(currentStencilId);
  if (!exportLink) {
    throw new Error('Export link not found');
  }

  const href = exportLink.getAttribute('href');
  if (!href) {
    throw new Error('Export link has no href');
  }

  // Update current stencil ID from the actual link we're using
  const linkStencilId = getStencilIdFromLink(exportLink);
  if (!currentStencilId) {
    currentStencilId = linkStencilId;
  }

  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  currentExport = data;

  return data;
}

// Show loading overlay during import
function showLoadingOverlay(message = 'Applying changes...') {
  // Remove existing overlay if any
  hideLoadingOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'fluxx-ai-loading-overlay';
  overlay.innerHTML = `
    <div class="fluxx-ai-loading-content">
      <div class="fluxx-ai-spinner"></div>
      <div class="fluxx-ai-loading-text">${message}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Add styles
  const style = document.createElement('style');
  style.id = 'fluxx-ai-loading-styles';
  style.textContent = `
    #fluxx-ai-loading-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
    }
    .fluxx-ai-loading-content {
      background: white;
      padding: 40px 60px;
      border-radius: 12px;
      text-align: center;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }
    .fluxx-ai-spinner {
      width: 50px;
      height: 50px;
      border: 4px solid #e0e0e0;
      border-top-color: #c43331;
      border-radius: 50%;
      animation: fluxx-ai-spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    .fluxx-ai-loading-text {
      font-size: 18px;
      color: #333;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    @keyframes fluxx-ai-spin {
      to { transform: rotate(360deg); }
    }
    /* Hide Fluxx modals during AI import */
    body.fluxx-ai-importing .reveal-modal,
    body.fluxx-ai-importing .modal,
    body.fluxx-ai-importing .reveal-modal-bg,
    body.fluxx-ai-importing .modal-backdrop {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);

  // Add class to body to hide Fluxx modals
  document.body.classList.add('fluxx-ai-importing');
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('fluxx-ai-loading-overlay');
  const style = document.getElementById('fluxx-ai-loading-styles');
  if (overlay) overlay.remove();
  if (style) style.remove();
  document.body.classList.remove('fluxx-ai-importing');
}

function updateLoadingText(message) {
  const textEl = document.querySelector('.fluxx-ai-loading-text');
  if (textEl) textEl.textContent = message;
}

// Apply operations and upload via Fluxx's full import flow
async function applyAndUpload(operations, exportData) {
  try {
    showLoadingOverlay('Applying changes...');

    const modified = applyOperations(exportData, operations);

    // Step 1: Click the Import button to open import modal
    const importBtn = document.querySelector('a.import-form') || document.querySelector('a[title="Import"]');
    if (!importBtn) {
      throw new Error('Import button not found');
    }
    importBtn.click();
    await sleep(800);

    // Step 2: Find and click the "Select file to import" link
    const uploadLink = await waitForElement('a.upload-file[title="Import Stencil"], a.upload-file', 5000);
    if (!uploadLink) {
      throw new Error('Upload link not found in import modal');
    }

    // Step 3: Find the hidden file input created by Plupload
    let fileInput = document.querySelector('input[type="file"][id^="html5_"]') ||
                    document.querySelector('input[type="file"].plupload') ||
                    document.querySelector('input[type="file"]');

    // If no file input exists yet, trigger Plupload to create it
    if (!fileInput) {
      uploadLink.click();
      await sleep(500);
      fileInput = document.querySelector('input[type="file"]');
    }

    if (!fileInput) {
      // Fallback: Use the direct API endpoint from the upload link
      const importUrl = uploadLink.getAttribute('href');
      if (importUrl) {
        await uploadViaAPI(modified, importUrl);
        return;
      }
      throw new Error('Could not find file input or import URL');
    }

    updateLoadingText('Uploading changes...');

    // Step 4: Create a File from our modified JSON
    const jsonString = JSON.stringify(modified, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const file = new File([blob], 'fluxx_import.json', { type: 'application/json' });

    // Step 5: Set the file on the input
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;

    // Trigger change event to start upload
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    updateLoadingText('Processing import...');
    await sleep(2000);

    // Step 6: Wait for the upload to process and look for success indicator
    const refreshLink = await waitForElement('a.refresh-dashboard', 15000);

    if (refreshLink) {
      updateLoadingText('Refreshing page...');
      chrome.runtime.sendMessage({ type: 'IMPORT_COMPLETE' });
      currentExport = null;
      await sleep(500);
      window.location.reload();
    } else {
      const errorMsg = document.querySelector('.import-error, .error-message, .alert-danger, .error');
      if (errorMsg) {
        throw new Error(errorMsg.textContent.trim() || 'Import failed');
      }
      throw new Error('Import did not complete - no refresh link appeared');
    }

  } catch (err) {
    console.error('[Fluxx AI] Import failed:', err);

    hideLoadingOverlay();

    // Try to close any open modals
    const closeBtn = document.querySelector('.modal .close, .close-reveal-modal, [data-dismiss="modal"]');
    if (closeBtn) closeBtn.click();

    chrome.runtime.sendMessage({
      type: 'IMPORT_ERROR',
      error: err.message
    });
  }
}

// Fallback: Upload via direct POST to import endpoint
async function uploadViaAPI(exportData, importUrl) {
  updateLoadingText('Uploading via API...');

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrfToken) {
    throw new Error('Could not find CSRF token');
  }

  const jsonString = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });

  const formData = new FormData();
  formData.append('file', blob, 'fluxx_import.json');

  const response = await fetch(importUrl, {
    method: 'POST',
    headers: {
      'X-CSRF-Token': csrfToken,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Import API error: ${response.status}`);
  }

  updateLoadingText('Refreshing page...');
  chrome.runtime.sendMessage({ type: 'IMPORT_COMPLETE' });
  currentExport = null;
  await sleep(500);
  window.location.reload();
}

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'PING':
      // Used by background to check if content script is loaded
      sendResponse({ pong: true, isOnFormEditor });
      return false;

    case 'GET_EXPORT':
      handleGetExport(sendResponse);
      return true; // Keep channel open for async

    case 'REFRESH_EXPORT':
      handleRefreshExport(sendResponse);
      return true;

    case 'APPLY_OPERATIONS':
      handleApplyOperations(message, sendResponse);
      return true;
  }
});

async function handleGetExport(sendResponse) {
  if (!isOnFormEditor) {
    sendResponse({ success: false, error: 'Not on form editor page' });
    return;
  }

  try {
    if (!currentExport) {
      currentExport = await downloadExport();
    }

    const themeNameFromUI = getThemeNameFromUI(currentStencilId);
    const modelNameFromUI = getModelNameFromUI(currentStencilId);

    // Get model_type from export for fallback formatting
    const modelType = currentExport?.records?.Stencil?.[0]?.model_type;
    const formattedModelType = formatModelType(modelType);

    sendResponse({
      success: true,
      data: currentExport,
      themeNameFromUI: themeNameFromUI,
      modelNameFromUI: modelNameFromUI || formattedModelType
    });
  } catch (err) {
    console.error('[Fluxx AI] Export error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

async function handleRefreshExport(sendResponse) {
  try {
    currentExport = await downloadExport();
    const themeNameFromUI = getThemeNameFromUI(currentStencilId);
    const modelNameFromUI = getModelNameFromUI(currentStencilId);

    // Get model_type from export for fallback formatting
    const modelType = currentExport?.records?.Stencil?.[0]?.model_type;
    const formattedModelType = formatModelType(modelType);

    sendResponse({
      success: true,
      data: currentExport,
      themeNameFromUI: themeNameFromUI,
      modelNameFromUI: modelNameFromUI || formattedModelType
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

async function handleApplyOperations(message, sendResponse) {
  try {
    await applyAndUpload(message.operations, message.export);
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// Visual indicator
function showIndicator() {
  let indicator = document.getElementById('fluxx-ai-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'fluxx-ai-indicator';
    indicator.innerHTML = `
      <span class="fluxx-ai-dot"></span>
      <span>Fluxx AI Ready</span>
    `;
    document.body.appendChild(indicator);
  }
  indicator.classList.add('visible');
}

function hideIndicator() {
  const indicator = document.getElementById('fluxx-ai-indicator');
  if (indicator) {
    indicator.classList.remove('visible');
  }
}

// Utilities
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForElement(selector, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(100);
  }
  return null;
}

// ============================================================
// JSON Operations (inline from lib/json-ops.js for content script)
// ============================================================

function generateUid() {
  return crypto.randomUUID();
}

function findElementByUid(elements, uid) {
  for (const el of elements) {
    if (el.uid === uid) return el;
    if (el.elements) {
      const found = findElementByUid(el.elements, uid);
      if (found) return found;
    }
  }
  return null;
}

function findParentOf(elements, uid, parent = null) {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.uid === uid) return { parent, array: elements, index: i };
    if (el.elements) {
      const found = findParentOf(el.elements, uid, el);
      if (found) return found;
    }
  }
  return null;
}

function createGroupElement(label, options = {}) {
  const group = {
    element_type: 'group',
    name: 'group',
    config: {
      label: label,
      show_in_toc: '0',
      hide_label: '0',
      collapsible: '0',
      default_open: '0',
      disable_lazy_load: '0',
      reveal_if_type: 'show'
    },
    visibility: {
      visible_form: true,
      visible_show: true,
      advanced_filter: '1',
      advanced_query: '{"group_type":"and","conditions":[],"relationship_filter_model_type":"GrantRequest"}',
      advanced_sort: '[]'
    },
    styling: { alignment: 'left' },
    uid: generateUid(),
    label: label,
    elements: []
  };

  // Apply custom config
  if (options.config) {
    for (const [key, value] of Object.entries(options.config)) {
      group.config[key] = value;
    }
  }

  // Apply custom styling
  if (options.styling) {
    for (const [key, value] of Object.entries(options.styling)) {
      group.styling[key] = value;
    }
  }

  // Apply custom visibility
  if (options.visibility) {
    for (const [key, value] of Object.entries(options.visibility)) {
      group.visibility[key] = value;
    }
  }

  // Apply conditional visibility
  if (options.conditional) {
    if (options.conditional.field) {
      group.config.reveal_if_attribute = options.conditional.field;
    }
    if (options.conditional.values) {
      group.config.reveal_if_value = options.conditional.values;
    }
    if (options.conditional.type) {
      group.config.reveal_if_type = options.conditional.type;
    }
  }

  return group;
}

function createTextElement(html, options = {}) {
  const text = {
    element_type: 'text',
    name: 'text',
    config: {
      text: html,
      strip_html: '0',
      allow_script: '0'
    },
    visibility: {
      visible_form: true,
      visible_show: true,
      advanced_filter: '1',
      advanced_query: '{"group_type":"and","conditions":[],"relationship_filter_model_type":"GrantRequest"}',
      advanced_sort: '[]'
    },
    styling: { alignment: 'left' },
    uid: generateUid()
  };

  // Apply custom styling
  if (options.styling) {
    for (const [key, value] of Object.entries(options.styling)) {
      text.styling[key] = value;
    }
  }

  // Apply custom visibility
  if (options.visibility) {
    for (const [key, value] of Object.entries(options.visibility)) {
      text.visibility[key] = value;
    }
  }

  return text;
}

function createAttributeElement(fieldName, label, options = {}) {
  return {
    element_type: 'attribute',
    name: fieldName,
    config: {
      label: label,
      required: options.required || false,
      ...options.config
    },
    visibility: {
      visible_form: true,
      visible_show: true,
      advanced_filter: '1',
      advanced_query: '{"group_type":"and","conditions":[],"relationship_filter_model_type":"GrantRequest"}',
      advanced_sort: '[]',
      ...(options.visibility || {})
    },
    styling: { alignment: 'left' },
    uid: generateUid(),
    label: label
  };
}

function createModelAttribute(name, description, attributeType = 'string') {
  return {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    name: name,
    description: description || name,
    model_type: 'GrantRequest',
    attribute_type: attributeType,
    multi_allowed: false,
    deleted_at: null,
    value_model_type: null,
    include_in_export: true,
    include_in_fulltext_search: false,
    api_style: 'full',
    force_dropdown: false,
    translatable: false,
    model_type_enum: 98
  };
}

function applyOperations(exportData, operations) {
  if (!Array.isArray(operations)) {
    throw new Error('Operations must be an array');
  }

  const data = JSON.parse(JSON.stringify(exportData));
  const elements = data.records.Stencil[0].json.elements;
  const modelAttrs = data.records.ModelAttribute;
  const aliases = {};

  for (const op of operations) {

    // Resolve aliases (but handle $root specially)
    let targetUid = op.after_uid || op.uid || op.target;
    const isRoot = targetUid === '$root';
    if (targetUid && targetUid.startsWith('$') && !isRoot) {
      targetUid = aliases[targetUid.slice(1)];
    }

    if (op.type === 'add') {
      let newElement;

      if (op.element_type === 'group') {
        newElement = createGroupElement(op.label, {
          config: op.config,
          styling: op.styling,
          visibility: op.visibility,
          conditional: op.conditional
        });
      } else if (op.element_type === 'text') {
        newElement = createTextElement(op.content, {
          styling: op.styling,
          visibility: op.visibility
        });
      } else if (op.element_type === 'field') {
        const existingAttr = modelAttrs.find(a => a.name === op.field_name);
        if (!existingAttr) {
          modelAttrs.push(createModelAttribute(op.field_name, op.field_name, op.field_type || 'string'));
        }
        newElement = createAttributeElement(op.field_name, op.label);
      }

      if (newElement) {
        if (op.alias) {
          aliases[op.alias] = newElement.uid;
        }

        // Handle $root - add to top-level elements array
        if (isRoot) {
          if (op.position === 'inside') {
            elements.push(newElement);
          } else {
            // "after $root" means append to end, "before $root" means prepend
            if (op.position === 'before') {
              elements.unshift(newElement);
            } else {
              elements.push(newElement);
            }
          }
        } else if (op.position === 'inside') {
          const target = findElementByUid(elements, targetUid);
          if (target) {
            target.elements = target.elements || [];
            target.elements.push(newElement);
          }
        } else {
          const result = findParentOf(elements, targetUid);
          if (result && result.array) {
            const idx = result.array.findIndex(e => e.uid === targetUid);
            const insertIdx = op.position === 'before' ? idx : idx + 1;
            result.array.splice(insertIdx, 0, newElement);
          }
        }
      }

    } else if (op.type === 'edit') {
      const el = findElementByUid(elements, targetUid);
      if (el) {
        el.config = el.config || {};

        // Label change
        if (op.label) {
          el.config.label = op.label;
          if (el.label !== undefined) el.label = op.label;
        }

        // Text content change
        if (op.content && el.element_type === 'text') {
          el.config.text = op.content;
        }

        // Config options (show_in_toc, hide_label, collapsible, etc.)
        if (op.config) {
          if (op.config.show_in_toc !== undefined) {
            el.config.show_in_toc = op.config.show_in_toc;
          }
          if (op.config.hide_label !== undefined) {
            el.config.hide_label = op.config.hide_label;
          }
          if (op.config.collapsible !== undefined) {
            el.config.collapsible = op.config.collapsible;
          }
          if (op.config.default_open !== undefined) {
            el.config.default_open = op.config.default_open;
          }
          if (op.config.open_states !== undefined) {
            el.config.open_states = op.config.open_states;
          }
        }

        // Conditional visibility
        if (op.conditional) {
          if (op.conditional.field) {
            el.config.reveal_if_attribute = op.conditional.field;
          }
          if (op.conditional.values) {
            el.config.reveal_if_value = op.conditional.values;
          }
          if (op.conditional.type) {
            el.config.reveal_if_type = op.conditional.type;
          }
        }

        // Styling
        if (op.styling) {
          el.styling = el.styling || {};
          for (const [key, value] of Object.entries(op.styling)) {
            // For non-groups, only allow margin/padding properties
            if (el.element_type !== 'group') {
              const spacingProps = ['margin_top', 'margin_bottom', 'margin_left', 'margin_right',
                                    'padding_top', 'padding_bottom', 'padding_left', 'padding_right', 'alignment'];
              if (!spacingProps.includes(key)) continue;
            }
            el.styling[key] = value;
          }
        }

        // Visibility/workflow state control
        if (op.visibility) {
          el.visibility = el.visibility || {};
          if (op.visibility.visible_form !== undefined) {
            el.visibility.visible_form = op.visibility.visible_form;
          }
          if (op.visibility.visible_show !== undefined) {
            el.visibility.visible_show = op.visibility.visible_show;
          }
          if (op.visibility.visible_list !== undefined) {
            el.visibility.visible_list = op.visibility.visible_list;
          }
          if (op.visibility.show_states !== undefined) {
            el.visibility.show_states = op.visibility.show_states;
          }
          if (op.visibility.read_only_states !== undefined) {
            el.visibility.read_only_states = op.visibility.read_only_states;
          }
          if (op.visibility.user_profile !== undefined) {
            el.visibility.user_profile = op.visibility.user_profile;
          }
        }
      }

    } else if (op.type === 'move') {
      let destUid = op.target;
      if (destUid && destUid.startsWith('$')) {
        destUid = aliases[destUid.slice(1)];
      }

      const srcResult = findParentOf(elements, targetUid);
      if (srcResult && srcResult.array) {
        const idx = srcResult.array.findIndex(e => e.uid === targetUid);
        const [removed] = srcResult.array.splice(idx, 1);

        if (op.position === 'inside') {
          const dest = findElementByUid(elements, destUid);
          if (dest) {
            dest.elements = dest.elements || [];
            dest.elements.push(removed);
          }
        } else {
          const destResult = findParentOf(elements, destUid);
          if (destResult && destResult.array) {
            const destIdx = destResult.array.findIndex(e => e.uid === destUid);
            const insertIdx = op.position === 'before' ? destIdx : destIdx + 1;
            destResult.array.splice(insertIdx, 0, removed);
          }
        }
      }

    } else if (op.type === 'delete') {
      const result = findParentOf(elements, targetUid);
      if (result && result.array) {
        const idx = result.array.findIndex(e => e.uid === targetUid);
        if (idx !== -1) {
          result.array.splice(idx, 1);
        }
      }
    }
  }

  return data;
}

// Start
init();
