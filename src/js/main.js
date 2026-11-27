/* ==========================================================================
   Force-Unlock Box 2 & Remove Placeholders Even If HTML Is Cached
   ========================================================================== */
function unlockBox2AndStripPlaceholders() {
  textOutputBox.removeAttribute('placeholder');
  romanizedOutputBox.removeAttribute('placeholder');
  romanizedOutputBox.readOnly = false;
  romanizedOutputBox.disabled = false;
  romanizedOutputBox.removeAttribute('readonly');
  romanizedOutputBox.removeAttribute('disabled');
}

unlockBox2AndStripPlaceholders();

function syncBoxFocusState() {
  const isBox1 = document.activeElement === textOutputBox;
  const isBox2 = document.activeElement === romanizedOutputBox;
  document.body.classList.toggle('box-focused', isBox1 || isBox2);
  document.body.classList.toggle('box2-focused', isBox2);
}

/* Deselect (blur) Box 1 & Box 2 when tapping/clicking the canvas or anywhere outside the boxes */
function blurBoxesOnOutsideInteraction(e) {
  const activeEl = document.activeElement;
  if (activeEl !== textOutputBox && activeEl !== romanizedOutputBox) return;

  const target = e.target;
  if (!target) return;

  const activeBox2Wrapper = document.getElementById('box2-wrapper');
  if (
    textOutputBox.contains(target) ||
    romanizedOutputBox.contains(target) ||
    (box1Wrapper && box1Wrapper.contains(target)) ||
    (activeBox2Wrapper && activeBox2Wrapper.contains(target)) ||
    (candidatesContainer && candidatesContainer.contains(target))
  ) {
    return;
  }

  textOutputBox.blur();
  romanizedOutputBox.blur();
  syncBoxFocusState();
}

document.addEventListener('mousedown', blurBoxesOnOutsideInteraction, true);
document.addEventListener('touchstart', blurBoxesOnOutsideInteraction, { capture: true, passive: true });

/* ==========================================================================
   Visible Viewport Height Sync (Keeps UI Above Mobile Browser Toolbars)
   ========================================================================== */
function syncViewportHeight() {
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(vh)}px`);
}

/* ==========================================================================
   Dark Mode Toggle (Top-Right of Header, Default: Dark Mode)
   ========================================================================== */
const SUN_ICON_SVG = `
  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="4"></circle>
    <path stroke-linecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"></path>
  </svg>
`;

const MOON_ICON_SVG = `
  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"></path>
  </svg>
`;

function initThemeToggle() {
  const themeBtn = document.getElementById('btn-theme-toggle');
  if (!themeBtn) return;

  const updateThemeButtonUI = () => {
    const isDark = document.body.classList.contains('dark-mode');
    const themeStrings = (typeof getAppStrings === 'function')
      ? getAppStrings().theme
      : { toLight: 'Switch to Light Mode', toDark: 'Switch to Dark Mode' };
    themeBtn.innerHTML = isDark ? SUN_ICON_SVG : MOON_ICON_SVG;
    themeBtn.title = isDark ? themeStrings.toLight : themeStrings.toDark;
  };

  updateThemeButtonUI();

  themeBtn.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    updateThemeButtonUI();
    redrawStrokes();
  });
}

/* ==========================================================================
   Box Height Synchronization (Portrait 64px vs. Landscape 86px Base)
   ========================================================================== */
function getMinBoxHeightPx() {
  return window.matchMedia('(orientation: portrait)').matches ? 64 : 86;
}

function autoResizeBoxes() {
  if (document.body.classList.contains('canvas-expanded')) return;

  const minHeightPx = getMinBoxHeightPx();
  textOutputBox.style.height = `${minHeightPx}px`;
  furiganaBackdrop.style.height = 'auto';
  romanizedOutputBox.style.height = `${minHeightPx}px`;

  const box1ContentHeight = Math.max(
    minHeightPx,
    textOutputBox.scrollHeight,
    furiganaBackdrop.scrollHeight
  );

  const box2ContentHeight = Math.max(
    minHeightPx,
    romanizedOutputBox.scrollHeight
  );

  const syncedHeight = Math.max(box1ContentHeight, box2ContentHeight);

  box1Wrapper.style.height = `${syncedHeight}px`;
  textOutputBox.style.height = `${syncedHeight}px`;
  furiganaBackdrop.style.height = `${syncedHeight}px`;

  const activeBox2Wrapper = document.getElementById('box2-wrapper');
  const activeRomanizedBackdrop = document.getElementById('romanized-backdrop');
  if (activeBox2Wrapper) {
    activeBox2Wrapper.style.height = `${syncedHeight}px`;
  }
  if (activeRomanizedBackdrop) {
    activeRomanizedBackdrop.style.height = `${syncedHeight}px`;
  }
  romanizedOutputBox.style.height = `${syncedHeight}px`;
}

/* ==========================================================================
   Canvas Full-Viewport Toggle Button (Bottom-Right of Canvas)
   ========================================================================== */
const EXPAND_ICON_SVG = `
  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4h4M4 4l5 5M20 8V4h-4m4 0l-5 5M4 16v4h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
  </svg>
`;

const COLLAPSE_ICON_SVG = `
  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" d="M9 9V4m0 5H4m5 0L4 4m11 5h5m-5 0V4m0 5l5-5M9 15v5m0-5H4m5 0l-5 5m11-5h5m-5 0v5m0-5l5 5"/>
  </svg>
`;

function syncExpandedBoxWrapping() {
  const isExpanded = document.body.classList.contains('canvas-expanded');
  const wrapMode = isExpanded ? 'off' : 'soft';
  textOutputBox.setAttribute('wrap', wrapMode);
  romanizedOutputBox.setAttribute('wrap', wrapMode);

  if (!isExpanded) {
    textOutputBox.scrollLeft = 0;
    furiganaBackdrop.scrollLeft = 0;
    romanizedOutputBox.scrollLeft = 0;
    const activeRomanizedBackdrop = document.getElementById('romanized-backdrop');
    if (activeRomanizedBackdrop) {
      activeRomanizedBackdrop.scrollLeft = 0;
    }
  }
}

function initCanvasFullscreenToggle() {
  const viewport = canvas.parentElement;
  if (!viewport || document.getElementById('btn-toggle-fullscreen')) return;

  if (window.matchMedia('(orientation: portrait)').matches) {
    document.body.classList.add('canvas-expanded');
  }
  syncExpandedBoxWrapping();

  const isInitiallyExpanded = document.body.classList.contains('canvas-expanded');
  const canvasStrings = (typeof getAppStrings === 'function')
    ? getAppStrings().canvas
    : { expandCanvas: 'Expand canvas', collapseCanvas: 'Back to default view' };

  const btn = document.createElement('button');
  btn.id = 'btn-toggle-fullscreen';
  btn.type = 'button';
  btn.title = isInitiallyExpanded ? canvasStrings.collapseCanvas : canvasStrings.expandCanvas;
  btn.setAttribute('aria-label', 'Toggle expanded canvas');
  btn.className = 'absolute bottom-2.5 right-2.5 z-30 p-2 rounded-xl bg-white/90 hover:bg-white active:bg-indigo-50 text-slate-600 hover:text-indigo-600 border border-slate-200/90 shadow-sm transition-all flex items-center justify-center';
  btn.innerHTML = isInitiallyExpanded ? COLLAPSE_ICON_SVG : EXPAND_ICON_SVG;

  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    syncViewportHeight();
    const isExpanded = document.body.classList.toggle('canvas-expanded');
    syncExpandedBoxWrapping();
    const cStrings = (typeof getAppStrings === 'function')
      ? getAppStrings().canvas
      : { expandCanvas: 'Expand canvas', collapseCanvas: 'Back to default view' };

    btn.innerHTML = isExpanded ? COLLAPSE_ICON_SVG : EXPAND_ICON_SVG;
    btn.title = isExpanded ? cStrings.collapseCanvas : cStrings.expandCanvas;

    if (isExpanded) {
      window.scrollTo(0, 0);
    }

    requestAnimationFrame(() => {
      syncViewportHeight();
      resizeCanvas();
      autoResizeBoxes();
    });
  });

  viewport.appendChild(btn);
}

/* ==========================================================================
   Canvas & Bidirectional Box Input Event Listeners
   ========================================================================== */
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
window.addEventListener('mouseup', stopDrawing);

canvas.addEventListener('touchstart', startDrawing, { passive: false });
canvas.addEventListener('touchmove', draw, { passive: false });
window.addEventListener('touchend', stopDrawing, { passive: false });
window.addEventListener('touchcancel', stopDrawing, { passive: false });

/* Sync scroll offsets between transparent textareas and their backdrops (especially in canvas-expanded mode) */
textOutputBox.addEventListener('scroll', () => {
  if (furiganaBackdrop.scrollLeft !== textOutputBox.scrollLeft) {
    furiganaBackdrop.scrollLeft = textOutputBox.scrollLeft;
  }
  if (furiganaBackdrop.scrollTop !== textOutputBox.scrollTop) {
    furiganaBackdrop.scrollTop = textOutputBox.scrollTop;
  }
});

furiganaBackdrop.addEventListener('scroll', () => {
  if (textOutputBox.scrollLeft !== furiganaBackdrop.scrollLeft) {
    textOutputBox.scrollLeft = furiganaBackdrop.scrollLeft;
  }
  if (textOutputBox.scrollTop !== furiganaBackdrop.scrollTop) {
    textOutputBox.scrollTop = furiganaBackdrop.scrollTop;
  }
});

romanizedOutputBox.addEventListener('scroll', () => {
  const activeRomanizedBackdrop = document.getElementById('romanized-backdrop');
  if (!activeRomanizedBackdrop) return;
  if (activeRomanizedBackdrop.scrollLeft !== romanizedOutputBox.scrollLeft) {
    activeRomanizedBackdrop.scrollLeft = romanizedOutputBox.scrollLeft;
  }
  if (activeRomanizedBackdrop.scrollTop !== romanizedOutputBox.scrollTop) {
    activeRomanizedBackdrop.scrollTop = romanizedOutputBox.scrollTop;
  }
});

if (romanizedBackdrop) {
  romanizedBackdrop.addEventListener('scroll', () => {
    if (document.activeElement === romanizedOutputBox) return;
    if (romanizedOutputBox.scrollLeft !== romanizedBackdrop.scrollLeft) {
      romanizedOutputBox.scrollLeft = romanizedBackdrop.scrollLeft;
    }
    if (romanizedOutputBox.scrollTop !== romanizedBackdrop.scrollTop) {
      romanizedOutputBox.scrollTop = romanizedBackdrop.scrollTop;
    }
  });
}

textOutputBox.addEventListener('focus', () => {
  syncBoxFocusState();
  if ((currentLang === 'ja' || currentLang === 'zh') && typeof updateTypingSuggestions === 'function') {
    updateTypingSuggestions(textOutputBox.value);
  }
});
textOutputBox.addEventListener('blur', syncBoxFocusState);
textOutputBox.addEventListener('input', () => {
  updateRomanization(true, true);
});

romanizedOutputBox.addEventListener('focus', () => {
  unlockBox2AndStripPlaceholders();
  syncBoxFocusState();
});
romanizedOutputBox.addEventListener('blur', () => {
  syncBoxFocusState();
  updateRomanization(false, true);
});
romanizedOutputBox.addEventListener('input', () => {
  if (typeof handleBox2Input === 'function') {
    handleBox2Input();
  }
});

/* ==========================================================================
   Language Tab Switching
   ========================================================================== */
const tabs = document.querySelectorAll('.lang-tab');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => {
      t.classList.remove('active-tab', 'border-indigo-600', 'text-indigo-600');
      t.classList.add('border-transparent', 'text-slate-600');
    });
    
    tab.classList.add('active-tab', 'border-indigo-600', 'text-indigo-600');
    tab.classList.remove('border-transparent', 'text-slate-600');

    currentLang = tab.getAttribute('data-lang');
    if (typeof applyAppLanguageUI === 'function') {
      applyAppLanguageUI();
    }

    const langConfig = LANGUAGES[currentLang];
    drawingInstructions.textContent = langConfig.instruction;
    romanizationLabel.textContent = langConfig.romajiName;
    translitDesc.textContent = langConfig.desc;

    textOutputBox.setAttribute('lang', currentLang);
    furiganaBackdrop.setAttribute('lang', currentLang);
    textOutputBox.classList.add('overlay-ja-active');
    furiganaBackdrop.classList.remove('hidden');

    if (langConfig.guideType === 'cyrillic') {
      gridGuide.className = 'absolute inset-0 cyrillic-grid pointer-events-none';
    } else {
      gridGuide.className = 'absolute inset-0 cjk-grid pointer-events-none';
    }

    if (typeof hideDictionaryPopover === 'function') {
      hideDictionaryPopover();
    }
    clearCanvas();
    updateRomanization(false, true);
  });
});

/* ==========================================================================
   Toolbar & Quick Action Buttons
   ========================================================================== */
document.getElementById('btn-clear-canvas').addEventListener('click', clearCanvas);
document.getElementById('btn-undo').addEventListener('click', undoLastStroke);

document.getElementById('btn-add-space').addEventListener('click', () => {
  insertCharacter(' ');
});

document.getElementById('btn-backspace').addEventListener('click', () => {
  const originalText = textOutputBox.value;
  if (originalText.length > 0) {
    textOutputBox.value = originalText.slice(0, -1);
    textOutputBox.blur();
    updateRomanization(true, true);
  }
});

document.getElementById('btn-clear-text').addEventListener('click', () => {
  textOutputBox.value = '';
  textOutputBox.scrollLeft = 0;
  furiganaBackdrop.innerHTML = '';
  furiganaBackdrop.scrollLeft = 0;
  romanizedOutputBox.value = '';
  romanizedOutputBox.scrollLeft = 0;
  const activeRomanizedBackdrop = document.getElementById('romanized-backdrop');
  if (activeRomanizedBackdrop) {
    activeRomanizedBackdrop.innerHTML = '';
    activeRomanizedBackdrop.scrollLeft = 0;
  }
  if (typeof clearAlignedSegmentsAndSuggestions === 'function') {
    clearAlignedSegmentsAndSuggestions();
  }
  textOutputBox.blur();
  romanizedOutputBox.blur();
  charCount.textContent = typeof formatCharCountText === 'function' ? formatCharCountText(0) : '0 chars';
  autoResizeBoxes();
});

/* ==========================================================================
   Clipboard Copy Feedback
   ========================================================================== */
let toastHideTimer = null;

function showToast(msg) {
  clearTimeout(toastHideTimer);
  toastMessage.textContent = msg;
  toast.classList.remove('translate-y-12', 'opacity-0');
  toastHideTimer = setTimeout(() => {
    toast.classList.add('translate-y-12', 'opacity-0');
    toastHideTimer = null;
  }, 2000);
}

async function copyToClipboard(text, boxKey) {
  const toastStrings = (typeof getAppStrings === 'function')
    ? getAppStrings().toasts
    : {
        nothingToCopy: 'Nothing to copy!',
        copiedBox1: 'Copied Character text to clipboard!',
        copiedBox2: 'Copied Romanization to clipboard!'
      };

  if (!text) {
    showToast(toastStrings.nothingToCopy);
    return;
  }
  const copiedMsg = boxKey === 'box2' ? toastStrings.copiedBox2 : toastStrings.copiedBox1;
  try {
    await navigator.clipboard.writeText(text);
    showToast(copiedMsg);
  } catch (err) {
    const temp = document.createElement('textarea');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    document.body.removeChild(temp);
    showToast(copiedMsg);
  }
}

document.getElementById('btn-copy-box1').addEventListener('click', () => {
  copyToClipboard(textOutputBox.value, 'box1');
});

document.getElementById('btn-copy-box2').addEventListener('click', () => {
  copyToClipboard(romanizedOutputBox.value, 'box2');
});

/* ==========================================================================
   Lifecycle Initialization
   ========================================================================== */
function handleViewportResize() {
  syncViewportHeight();
  resizeCanvas();
}

window.addEventListener('resize', handleViewportResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleViewportResize);
}

window.addEventListener('DOMContentLoaded', () => {
  unlockBox2AndStripPlaceholders();
  syncViewportHeight();
  initThemeToggle();
  initCanvasFullscreenToggle();
  if (typeof applyAppLanguageUI === 'function') {
    applyAppLanguageUI();
  }
  resizeCanvas();
  initKuroshiro();
});

window.addEventListener('load', () => {
  unlockBox2AndStripPlaceholders();
  syncViewportHeight();
  initOfflineRecognizers();
});
