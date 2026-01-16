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

    // Check if clicked on a model category header (li.list-label) - e.g., "Grant Request"
    // Apply same logic as model theme clicks below
    const categoryLabel = e.target.closest('li.list-label');
    if (categoryLabel) {
      // Clear export immediately since we're switching
      currentExport = null;
      notifyExtension();

      // Wait for Fluxx to expand the category and select a theme, then detect
      setTimeout(() => {
        // Find the globally selected stencil entry (Fluxx will have updated this)
        const selectedEntry = document.querySelector('li.icon.selected li.active.entry.selected') ||
                             document.querySelector('li.icon.selected li.active.entry');
        if (selectedEntry && selectedEntry.dataset.modelId) {
          const newStencilId = selectedEntry.dataset.modelId;
          if (newStencilId !== currentStencilId) {
            currentStencilId = newStencilId;
            currentExport = null;
          }
        }
        detectFormEditor();
        notifyExtension();
      }, 1000);
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

// Get theme name from the sidebar (e.g., "R3.1: Impactful AI")
// This is the Model Theme name (same as getModelNameFromUI)
function getThemeNameFromUI(stencilId) {
  // Method 1: Find stencil entry by ID and get its parent model theme's label
  if (stencilId) {
    const selectors = [
      `li.active.entry[data-model-id="${stencilId}"]`,
      `li.entry[data-model-id="${stencilId}"]`,
      `li[data-model-id="${stencilId}"]`
    ];

    for (const selector of selectors) {
      const stencilEntry = document.querySelector(selector);
      if (stencilEntry) {
        // EXCEPTION: Generic Template has no model themes, just "All Templates"
        // For Generic Template, the theme IS the stencil entry label
        const parentCategory = stencilEntry.closest('ul#generic_template');
        if (parentCategory) {
          const entryLabel = stencilEntry.querySelector('div.label, .label');
          if (entryLabel) {
            const themeName = entryLabel.textContent?.trim();
            console.log('[Fluxx AI] Theme name from Generic Template entry:', themeName);
            return themeName;
          }
        }

        const parentModel = stencilEntry.closest('li.icon');
        if (parentModel) {
          const modelLabel = parentModel.querySelector('a.link span.label');
          if (modelLabel) {
            const themeName = modelLabel.textContent?.trim();
            console.log('[Fluxx AI] Theme name from parent li.icon:', themeName);
            return themeName;
          }
        }
      }
    }
  }

  // Method 2: Find the selected model theme that contains a selected entry
  const allSelectedModels = document.querySelectorAll('li.icon.selected');
  for (const model of allSelectedModels) {
    const selectedEntry = model.querySelector('li.active.entry.selected, li.entry.selected');
    if (selectedEntry) {
      // EXCEPTION: Generic Template - use entry label, not model label
      const parentCategory = model.closest('ul#generic_template');
      if (parentCategory) {
        const entryLabel = selectedEntry.querySelector('div.label, .label');
        if (entryLabel) {
          const themeName = entryLabel.textContent?.trim();
          console.log('[Fluxx AI] Theme name from Generic Template selected entry:', themeName);
          return themeName;
        }
      }

      const modelLabel = model.querySelector('a.link span.label');
      if (modelLabel) {
        const themeName = modelLabel.textContent?.trim();
        console.log('[Fluxx AI] Theme name from selected li.icon with entry:', themeName);
        return themeName;
      }
    }
  }

  // Method 3: Fallback - just get first selected model's label (skip for Generic Template)
  const selectedModel = document.querySelector('li.icon.selected:not(ul#generic_template li.icon) a.link span.label');
  if (selectedModel) {
    const themeName = selectedModel.textContent?.trim();
    console.log('[Fluxx AI] Theme name from first selected li.icon (fallback):', themeName);
    return themeName;
  }

  console.log('[Fluxx AI] Could not find theme name for stencil', stencilId);
  return null;
}

// Get model category name from the sidebar (e.g., "Grant Request", "Funding Source")
// This is the top-level category that contains model themes
function getModelNameFromUI(stencilId) {
  // Method 1: Find stencil entry by ID and traverse up to the category header
  if (stencilId) {
    const selectors = [
      `li.active.entry[data-model-id="${stencilId}"]`,
      `li.entry[data-model-id="${stencilId}"]`,
      `li[data-model-id="${stencilId}"]`
    ];

    for (const selector of selectors) {
      const stencilEntry = document.querySelector(selector);
      if (stencilEntry) {
        // Go up to the parent ul (model category container)
        const categoryList = stencilEntry.closest('ul.toggle-class, ul[id]');
        if (categoryList) {
          // Find the list-label with the category name
          const listLabel = categoryList.querySelector('li.list-label div.link');
          if (listLabel) {
            const modelName = listLabel.textContent?.trim();
            console.log('[Fluxx AI] Model name from category header:', modelName);
            return modelName;
          }
        }
      }
    }
  }

  // Method 2: Find selected model theme and get its category
  const selectedIcon = document.querySelector('li.icon.selected');
  if (selectedIcon) {
    const categoryList = selectedIcon.closest('ul.toggle-class, ul[id]');
    if (categoryList) {
      const listLabel = categoryList.querySelector('li.list-label div.link');
      if (listLabel) {
        const modelName = listLabel.textContent?.trim();
        console.log('[Fluxx AI] Model name from selected icon category:', modelName);
        return modelName;
      }
    }
  }

  // Method 3: Fallback - find any open category with a selected entry
  const openCategory = document.querySelector('ul.toggle-class.open');
  if (openCategory) {
    const listLabel = openCategory.querySelector('li.list-label div.link');
    if (listLabel) {
      const modelName = listLabel.textContent?.trim();
      console.log('[Fluxx AI] Model name from open category (fallback):', modelName);
      return modelName;
    }
  }

  console.log('[Fluxx AI] Could not find model name for stencil', stencilId);
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

  // Get the extension's logo URL
  const logoUrl = chrome.runtime.getURL('icons/fluxx_logo.jfif');

  const overlay = document.createElement('div');
  overlay.id = 'fluxx-ai-loading-overlay';
  overlay.innerHTML = `
    <div class="fluxx-ai-loading-content">
      <div class="fluxx-ai-animation">
        <img src="${logoUrl}" class="fluxx-ai-logo" alt="Fluxx AI">
        <div class="fluxx-ai-sparkles">
          <span class="sparkle s1">✦</span>
          <span class="sparkle s2">✧</span>
          <span class="sparkle s3">✦</span>
          <span class="sparkle s4">✧</span>
          <span class="sparkle s5">✦</span>
          <span class="sparkle s6">✧</span>
        </div>
      </div>
      <div class="fluxx-ai-loading-text">${message}</div>
      <div class="fluxx-ai-warning">⚠️ DO NOT LEAVE THIS PAGE</div>
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
      background: rgba(0, 0, 0, 0.75);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
    }
    .fluxx-ai-warning {
      margin-top: 16px;
      font-size: 12px;
      color: #dc2626;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .fluxx-ai-loading-content {
      background: white;
      padding: 40px 60px;
      border-radius: 16px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .fluxx-ai-animation {
      position: relative;
      width: 100px;
      height: 100px;
      margin: 0 auto 24px;
    }
    .fluxx-ai-logo {
      width: 80px;
      height: 80px;
      object-fit: contain;
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      border-radius: 12px;
    }
    .fluxx-ai-sparkles {
      position: absolute;
      width: 100%;
      height: 100%;
      top: 0;
      left: 0;
      pointer-events: none;
    }
    .sparkle {
      position: absolute;
      font-size: 16px;
      color: #FFD700;
      animation: fluxx-ai-sparkle 2s ease-in-out infinite;
      opacity: 0;
      text-shadow: 0 0 6px #FFD700;
    }
    .sparkle.s1 { top: 0; left: 50%; transform: translateX(-50%); animation-delay: 0s; }
    .sparkle.s2 { top: 50%; right: 0; transform: translateY(-50%); animation-delay: 0.33s; }
    .sparkle.s3 { bottom: 0; left: 50%; transform: translateX(-50%); animation-delay: 0.66s; }
    .sparkle.s4 { top: 50%; left: 0; transform: translateY(-50%); animation-delay: 1s; }
    .sparkle.s5 { top: 10px; right: 10px; animation-delay: 1.33s; }
    .sparkle.s6 { bottom: 10px; left: 10px; animation-delay: 1.66s; }
    .fluxx-ai-loading-text {
      font-size: 18px;
      color: #333;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-weight: 500;
    }
    @keyframes fluxx-ai-sparkle {
      0%, 100% { opacity: 0; transform: scale(0.5); }
      50% { opacity: 1; transform: scale(1.2); }
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

    // Step 2: Find the "Select file to import" link (must have correct title)
    const uploadLink = await waitForElement('a.upload-file[title="Import Stencil"]', 5000);
    if (!uploadLink) {
      throw new Error('Upload link not found in import panel');
    }

    console.log('[Fluxx AI] Found upload link:', uploadLink.id);
    updateLoadingText('Uploading changes...');

    // Step 4: Create a File from our modified JSON
    const jsonString = JSON.stringify(modified, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const file = new File([blob], 'fluxx_import.json', { type: 'application/json' });

    // Step 5: Find the file input that handles JSON/text imports
    // On fluxx.io, Plupload uses shared file inputs - we need the one that accepts text/plain
    const allInputs = document.querySelectorAll('input[type="file"]');
    const textInputs = Array.from(allInputs).filter(inp => {
      const accept = inp.getAttribute('accept') || inp.getAttribute('accept_donotuse') || '';
      return accept.includes('text/plain') || accept.includes('application/json');
    });

    // Use the last text input (most recently created, for the import modal)
    let fileInput = textInputs[textInputs.length - 1];

    // Fallback: if no text inputs, try to find by Plupload instance on upload link (fluxxlabs.com style)
    if (!fileInput) {
      const pluploadKey = Object.keys(uploadLink).find(k => k.startsWith('Plupload_'));
      if (pluploadKey) {
        const uploader = uploadLink[pluploadKey];
        console.log('[Fluxx AI] Found Plupload instance:', pluploadKey);

        // Use Plupload's addFile API directly
        await new Promise((resolve, reject) => {
          const onComplete = () => {
            console.log('[Fluxx AI] Upload complete via Plupload API');
            uploader.unbind('UploadComplete', onComplete);
            uploader.unbind('Error', onError);
            resolve();
          };
          const onError = (up, err) => {
            console.error('[Fluxx AI] Plupload error:', err);
            uploader.unbind('UploadComplete', onComplete);
            uploader.unbind('Error', onError);
            reject(new Error(err.message || 'Upload failed'));
          };
          uploader.bind('UploadComplete', onComplete);
          uploader.bind('Error', onError);
          uploader.addFile(file);
          uploader.start();
        });

        // Skip the file input approach since we used Plupload API
        fileInput = null;
      }
    }

    if (!fileInput && textInputs.length === 0) {
      throw new Error('Could not find import file input. Try refreshing the page.');
    }

    if (fileInput) {
      console.log('[Fluxx AI] Using file input:', fileInput.id);

      // Set the file on the input
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // Dispatch change event to trigger Plupload
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    updateLoadingText('Processing import...');

    // Step 6: Wait for the upload to process and look for success indicator
    let refreshLink = null;
    let uploadComplete = false;
    const startTime = Date.now();
    const timeout = 30000; // Increased timeout

    while (Date.now() - startTime < timeout) {
      // Check for refresh-dashboard link (primary success indicator)
      refreshLink = document.querySelector('a.refresh-dashboard');
      if (refreshLink) {
        console.log('[Fluxx AI] Found a.refresh-dashboard link');
        break;
      }

      // Check for any link containing "Refresh" text
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const text = link.textContent?.toLowerCase() || '';
        if (text.includes('refresh') && (text.includes('dashboard') || text.includes('your'))) {
          console.log('[Fluxx AI] Found refresh link by text:', link.textContent);
          refreshLink = link;
          break;
        }
      }
      if (refreshLink) break;

      // Check for success text anywhere on the page
      const bodyText = document.body.innerText || '';
      if (bodyText.includes('Refresh Your Dashboard') ||
          bodyText.includes('Import successful') ||
          bodyText.includes('import complete') ||
          bodyText.includes('Successfully imported')) {
        console.log('[Fluxx AI] Found success text in page');
        uploadComplete = true;
        break;
      }

      // Check if upload progress finished (look for 100% or completed state)
      const progressBar = document.querySelector('.plupload_progress, .upload-progress, .progress-bar');
      if (progressBar) {
        const width = progressBar.style.width;
        if (width === '100%') {
          console.log('[Fluxx AI] Progress bar at 100%');
          // Wait a bit more for server processing after upload completes
          await sleep(2000);
          uploadComplete = true;
          break;
        }
      }

      // Check for file uploaded indicator
      const uploadedFile = document.querySelector('.plupload_file_status_done, .upload-complete, .file-uploaded');
      if (uploadedFile) {
        console.log('[Fluxx AI] Found upload complete indicator');
        await sleep(2000);
        uploadComplete = true;
        break;
      }

      await sleep(300);
    }

    console.log('[Fluxx AI] Detection loop finished. refreshLink:', !!refreshLink, 'uploadComplete:', uploadComplete, 'elapsed:', Date.now() - startTime, 'ms');

    if (refreshLink || uploadComplete) {
      updateLoadingText('Refreshing page...');
      chrome.runtime.sendMessage({ type: 'IMPORT_COMPLETE' });
      currentExport = null;
      await sleep(500);
      window.location.reload();
    } else {
      // Check for error messages
      const errorMsg = document.querySelector('.import-error, .error-message, .alert-danger, .error, .plupload_error');
      if (errorMsg && errorMsg.textContent.trim()) {
        throw new Error(errorMsg.textContent.trim());
      }

      // No success or error detected - don't auto-refresh, ask user
      throw new Error('Import status unclear. Please check if changes applied and refresh manually if needed.');
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

// Helper: Get regex patterns that match any shade of a color
function getColorPatterns(colorName) {
  const patterns = [];
  const color = colorName.toLowerCase();

  // CSS color keywords for each color family
  const keywords = {
    red: ['red', 'crimson', 'darkred', 'firebrick', 'indianred', 'maroon', 'brown'],
    blue: ['blue', 'navy', 'darkblue', 'royalblue', 'steelblue', 'dodgerblue', 'cornflowerblue', 'deepskyblue', 'midnightblue'],
    green: ['green', 'darkgreen', 'forestgreen', 'limegreen', 'seagreen', 'olive', 'teal'],
    orange: ['orange', 'darkorange', 'coral', 'tomato', 'orangered'],
    yellow: ['yellow', 'gold', 'khaki', 'goldenrod'],
    purple: ['purple', 'violet', 'magenta', 'fuchsia', 'orchid', 'plum', 'indigo'],
    gray: ['gray', 'grey', 'darkgray', 'darkgrey', 'lightgray', 'lightgrey', 'silver', 'dimgray', 'dimgrey'],
    black: ['black'],
    white: ['white', 'snow', 'ivory']
  };

  // Add keyword patterns
  if (keywords[color]) {
    for (const kw of keywords[color]) {
      // Match color keyword in CSS (e.g., "color: red" or "color:red")
      patterns.push(new RegExp(`(color\\s*:\\s*)${kw}\\b`, 'gi'));
    }
  }

  // Add hex pattern that matches color range
  // This regex will be replaced with a function-based approach
  patterns.push({
    type: 'hex',
    color: color,
    test: (hex) => isColorInFamily(hex, color)
  });

  // Add rgb pattern
  patterns.push({
    type: 'rgb',
    color: color,
    test: (r, g, b) => isRgbInFamily(r, g, b, color)
  });

  return patterns;
}

// Helper: Check if a hex color belongs to a color family
function isColorInFamily(hex, family) {
  // Parse hex to RGB
  let r, g, b;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else {
    return false;
  }
  return isRgbInFamily(r, g, b, family);
}

// Helper: Check if RGB values belong to a color family
function isRgbInFamily(r, g, b, family) {
  const brightness = (r + g + b) / 3;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;

  switch (family) {
    case 'red':
      // Red: high red, low green, variable blue
      return r > 150 && r > g * 1.5 && r > b * 1.2 && g < 150;
    case 'blue':
      // Blue: high blue, low red and green
      return b > 150 && b > r * 1.3 && b > g * 1.1;
    case 'green':
      // Green: high green, low red and blue
      return g > 150 && g > r * 1.2 && g > b * 1.2;
    case 'orange':
      // Orange: high red, medium green, low blue
      return r > 180 && g > 80 && g < 180 && b < 100;
    case 'yellow':
      // Yellow: high red and green, low blue
      return r > 180 && g > 180 && b < 120;
    case 'purple':
      // Purple: high red and blue, low green
      return r > 100 && b > 100 && g < Math.min(r, b) * 0.8;
    case 'gray':
      // Gray: low saturation, medium brightness
      return saturation < 0.2 && brightness > 50 && brightness < 220;
    case 'black':
      return brightness < 50;
    case 'white':
      return brightness > 220 && saturation < 0.1;
    default:
      return false;
  }
}

// Helper: Get target color value
function getTargetColor(colorName) {
  const colors = {
    red: '#cc0000',
    blue: '#0066cc',
    green: '#008800',
    orange: '#ff6600',
    yellow: '#ffcc00',
    purple: '#9900cc',
    gray: '#666666',
    black: '#000000',
    white: '#ffffff'
  };
  // If it's already a hex code, use it directly
  if (colorName.startsWith('#')) {
    return colorName;
  }
  return colors[colorName.toLowerCase()] || colorName;
}

// Helper: Replace colors in HTML string
function replaceColorsInHtml(html, findColor, replaceColor) {
  const targetColor = getTargetColor(replaceColor);
  let result = html;

  // Replace hex colors
  result = result.replace(/#([0-9a-fA-F]{3}){1,2}\b/g, (match) => {
    if (isColorInFamily(match, findColor)) {
      return targetColor;
    }
    return match;
  });

  // Replace rgb/rgba colors
  result = result.replace(/rgb(a?)\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)([^)]*)\)/gi, (match, a, r, g, b, rest) => {
    if (isRgbInFamily(parseInt(r), parseInt(g), parseInt(b), findColor)) {
      // Convert target to rgb format if needed
      if (targetColor.startsWith('#')) {
        const tr = parseInt(targetColor.slice(1, 3), 16);
        const tg = parseInt(targetColor.slice(3, 5), 16);
        const tb = parseInt(targetColor.slice(5, 7), 16);
        return a ? `rgba(${tr}, ${tg}, ${tb}${rest})` : `rgb(${tr}, ${tg}, ${tb})`;
      }
      return targetColor;
    }
    return match;
  });

  // Replace color keywords
  const keywords = {
    red: ['red', 'crimson', 'darkred', 'firebrick', 'indianred', 'maroon'],
    blue: ['blue', 'navy', 'darkblue', 'royalblue', 'steelblue', 'dodgerblue'],
    green: ['green', 'darkgreen', 'forestgreen', 'limegreen', 'seagreen'],
    orange: ['orange', 'darkorange', 'coral', 'tomato'],
    yellow: ['yellow', 'gold', 'khaki'],
    purple: ['purple', 'violet', 'magenta', 'fuchsia'],
    gray: ['gray', 'grey', 'darkgray', 'lightgray', 'silver'],
  };

  if (keywords[findColor]) {
    for (const kw of keywords[findColor]) {
      // Match in CSS context (after color: or background-color: etc.)
      const regex = new RegExp(`((?:color|background-color|border-color)\\s*:\\s*)${kw}\\b`, 'gi');
      result = result.replace(regex, `$1${targetColor}`);
    }
  }

  return result;
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
        } else if (op.position === 'inside' || op.position === 'inside_end') {
          // Add to END of group's children
          const target = findElementByUid(elements, targetUid);
          if (target) {
            target.elements = target.elements || [];
            target.elements.push(newElement);
          }
        } else if (op.position === 'inside_start' || op.position === 'inside_top') {
          // Add to START of group's children (top of group)
          const target = findElementByUid(elements, targetUid);
          if (target) {
            target.elements = target.elements || [];
            target.elements.unshift(newElement);
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

        // Required change (for fields)
        if (op.required !== undefined) {
          el.config.required = op.required;
        }

        // Read-only change (for fields)
        if (op.read_only !== undefined) {
          el.config.read_only = op.read_only;
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

        if (op.position === 'inside' || op.position === 'inside_end') {
          // Move to END of destination group's children
          const dest = findElementByUid(elements, destUid);
          if (dest) {
            dest.elements = dest.elements || [];
            dest.elements.push(removed);
          }
        } else if (op.position === 'inside_start' || op.position === 'inside_top') {
          // Move to START of destination group's children
          const dest = findElementByUid(elements, destUid);
          if (dest) {
            dest.elements = dest.elements || [];
            dest.elements.unshift(removed);
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

    } else if (op.type === 'bulk_replace') {
      // Bulk operations for multiple elements
      const uids = op.uids || [];
      const findColor = op.find_color;  // e.g., "red" - will match any red-ish color
      const replaceColor = op.replace_color;  // e.g., "blue" or "#0066CC"
      const findStr = op.find;
      const replaceStr = op.replace;
      const setRequired = op.set_required;  // true or false
      const setReadOnly = op.set_read_only;  // true or false
      const setHidden = op.set_hidden;  // true or false
      const setCollapsible = op.set_collapsible;  // true or false
      const setShowInToc = op.set_show_in_toc;  // true or false
      const setDefaultOpen = op.set_default_open;  // true or false
      const setHideLabel = op.set_hide_label;  // true or false

      for (const uid of uids) {
        const el = findElementByUid(elements, uid);
        if (!el) continue;

        el.config = el.config || {};

        // Set required on multiple fields
        if (setRequired !== undefined) {
          el.config.required = setRequired;
        }

        // Set read-only on multiple fields
        if (setReadOnly !== undefined) {
          el.config.read_only = setReadOnly;
        }

        // Set hidden on multiple elements (affects both edit and view visibility)
        if (setHidden !== undefined) {
          el.visibility = el.visibility || {};
          el.visibility.visible_form = !setHidden;
          el.visibility.visible_show = !setHidden;
        }

        // Set collapsible on groups
        if (setCollapsible !== undefined && el.element_type === 'group') {
          el.config.collapsible = setCollapsible;
        }

        // Set show_in_toc on groups
        if (setShowInToc !== undefined && el.element_type === 'group') {
          el.config.show_in_toc = setShowInToc;
        }

        // Set default_open on groups
        if (setDefaultOpen !== undefined && el.element_type === 'group') {
          el.config.default_open = setDefaultOpen;
        }

        // Set hide_label on elements
        if (setHideLabel !== undefined) {
          el.config.hide_label = setHideLabel;
        }

        // Color-aware replacement (matches hex, rgb, and keywords)
        if (el.config.text && findColor && replaceColor) {
          el.config.text = replaceColorsInHtml(el.config.text, findColor, replaceColor);
        }
        // Literal string replacement
        else if (el.config.text && findStr && replaceStr) {
          const regex = new RegExp(findStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          el.config.text = el.config.text.replace(regex, replaceStr);
        }
      }

    } else if (op.type === 'replace_subtree') {
      // Complex structural operation - insert or replace entire subtree
      const targetUid = op.target_uid;
      const position = op.position || 'after';
      let newStructure = op.structure;

      if (!newStructure) {
        console.warn('replace_subtree: no structure provided');
        continue;
      }

      // Deep clone and regenerate all UIDs to ensure uniqueness
      function regenerateUids(el) {
        el.uid = generateUid();
        if (el.elements && Array.isArray(el.elements)) {
          el.elements.forEach(regenerateUids);
        }
        return el;
      }

      newStructure = regenerateUids(JSON.parse(JSON.stringify(newStructure)));

      if (position === 'replace') {
        // Replace the target element with new structure
        const result = findParentOf(elements, targetUid);
        if (result && result.array) {
          const idx = result.array.findIndex(e => e.uid === targetUid);
          if (idx !== -1) {
            result.array.splice(idx, 1, newStructure);
          }
        }
      } else {
        // Insert before or after the target
        const result = findParentOf(elements, targetUid);
        if (result && result.array) {
          const idx = result.array.findIndex(e => e.uid === targetUid);
          if (idx !== -1) {
            const insertIdx = position === 'before' ? idx : idx + 1;
            result.array.splice(insertIdx, 0, newStructure);
          }
        }
      }

    } else if (op.type === 'clone_subtree') {
      // Clone a subtree with transformations - backend does the heavy lifting
      const sourceUid = op.source_uid;
      const position = op.position || 'after';
      const labelFind = op.label_find;
      const labelReplace = op.label_replace;
      const fieldSuffix = op.field_suffix || '';

      // Find the source element
      const sourceEl = findElementByUid(elements, sourceUid);
      if (!sourceEl) {
        console.warn('clone_subtree: source element not found');
        continue;
      }

      // Deep clone
      let cloned = JSON.parse(JSON.stringify(sourceEl));

      // Apply transformations recursively
      function transformElement(el) {
        // Regenerate UID
        el.uid = generateUid();

        // Transform labels
        if (labelFind && labelReplace) {
          if (el.config?.label) {
            el.config.label = el.config.label.replace(new RegExp(labelFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), labelReplace);
          }
          if (el.label) {
            el.label = el.label.replace(new RegExp(labelFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), labelReplace);
          }
        }

        // Add suffix to field names (attribute elements)
        if (fieldSuffix && el.element_type === 'attribute' && el.name) {
          el.name = el.name + fieldSuffix;
        }

        // Recurse into children
        if (el.elements && Array.isArray(el.elements)) {
          el.elements.forEach(transformElement);
        }
      }

      transformElement(cloned);

      // Create ModelAttribute entries for any new field names (when suffix applied)
      if (fieldSuffix) {
        function collectFieldNames(el) {
          const names = [];
          if (el.element_type === 'attribute' && el.name) {
            names.push(el.name);
          }
          if (el.elements) {
            for (const child of el.elements) {
              names.push(...collectFieldNames(child));
            }
          }
          return names;
        }

        const newFieldNames = collectFieldNames(cloned);
        for (const fieldName of newFieldNames) {
          const exists = modelAttrs.find(a => a.name === fieldName);
          if (!exists) {
            modelAttrs.push(createModelAttribute(fieldName, fieldName, 'string'));
          }
        }
      }

      // Insert the cloned element
      const result = findParentOf(elements, sourceUid);
      if (result && result.array) {
        const idx = result.array.findIndex(e => e.uid === sourceUid);
        if (idx !== -1) {
          const insertIdx = position === 'before' ? idx : idx + 1;
          result.array.splice(insertIdx, 0, cloned);
        }
      }
    }
  }

  return data;
}

// Start
init();
