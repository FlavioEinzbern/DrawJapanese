/* ==========================================================================
   Visible Viewport Height Sync (Keeps UI Above Mobile Browser Toolbars)
   ========================================================================== */
function syncViewportHeight() {
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(vh)}px`);
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
    currentLang === 'ja' ? furiganaBackdrop.scrollHeight : 0
  );

  const box2ContentHeight = Math.max(
    minHeightPx,
    romanizedOutputBox.scrollHeight
  );

  const syncedHeight = Math.max(box1ContentHeight, box2ContentHeight);

  box1Wrapper.style.height = `${syncedHeight}px`;
  textOutputBox.style.height = `${syncedHeight}px`;
  furiganaBackdrop.style.height = `${syncedHeight}px`;
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

function initCanvasFullscreenToggle() {
  const viewport = canvas.parentElement;
  if (!viewport || document.getElementById('btn-toggle-fullscreen')) return;

  const btn = document.createElement('button');
  btn.id = 'btn-toggle-fullscreen';
  btn.type = 'button';
  btn.title = 'Expand canvas';
  btn.setAttribute('aria-label', 'Toggle expanded canvas');
  btn.className = 'absolute bottom-2.5 right-2.5 z-30 p-2 rounded-xl bg-white/90 hover:bg-white active:bg-indigo-50 text-slate-600 hover:text-indigo-600 border border-slate-200/90 shadow-sm transition-all flex items-center justify-center';
  btn.innerHTML = EXPAND_ICON_SVG;

  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    syncViewportHeight();
    const isExpanded = document.body.classList.toggle('canvas-expanded');
    btn.innerHTML = isExpanded ? COLLAPSE_ICON_SVG : EXPAND_ICON_SVG;
    btn.title = isExpanded ? 'Back to default view' : 'Expand canvas';

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
   Canvas & Input Event Listeners
   ========================================================================== */
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
window.addEventListener('mouseup', stopDrawing);

canvas.addEventListener('touchstart', startDrawing, { passive: false });
canvas.addEventListener('touchmove', draw, { passive: false });
window.addEventListener('touchend', stopDrawing, { passive: false });

textOutputBox.addEventListener('input', () => {
  updateRomanization();
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
    const langConfig = LANGUAGES[currentLang];

    drawingInstructions.textContent = langConfig.instruction;
    romanizationLabel.textContent = langConfig.romajiName;
    translitDesc.textContent = langConfig.desc;

    textOutputBox.setAttribute('lang', currentLang);
    if (currentLang === 'ja') {
      textOutputBox.classList.add('overlay-ja-active');
      furiganaBackdrop.classList.remove('hidden');
    } else {
      textOutputBox.classList.remove('overlay-ja-active');
      furiganaBackdrop.classList.add('hidden');
    }

    if (langConfig.guideType === 'cyrillic') {
      gridGuide.className = 'absolute inset-0 cyrillic-grid pointer-events-none';
    } else {
      gridGuide.className = 'absolute inset-0 cjk-grid pointer-events-none';
    }

    clearCanvas();
    updateRomanization();
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
    updateRomanization();
  }
});

document.getElementById('btn-clear-text').addEventListener('click', () => {
  textOutputBox.value = '';
  furiganaBackdrop.innerHTML = '';
  romanizedOutputBox.value = '';
  textOutputBox.blur();
  charCount.textContent = '0 chars';
  autoResizeBoxes();
});

/* ==========================================================================
   Clipboard Copy Feedback
   ========================================================================== */
function showToast(msg) {
  toastMessage.textContent = msg;
  toast.classList.remove('translate-y-12', 'opacity-0');
  setTimeout(() => {
    toast.classList.add('translate-y-12', 'opacity-0');
  }, 2000);
}

async function copyToClipboard(text, label) {
  if (!text) {
    showToast('Nothing to copy!');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${label} to clipboard!`);
  } catch (err) {
    const temp = document.createElement('textarea');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    document.body.removeChild(temp);
    showToast(`Copied ${label} to clipboard!`);
  }
}

document.getElementById('btn-copy-box1').addEventListener('click', () => {
  copyToClipboard(textOutputBox.value, 'Character text');
});

document.getElementById('btn-copy-box2').addEventListener('click', () => {
  copyToClipboard(romanizedOutputBox.value, 'Romanization');
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
  syncViewportHeight();
  initCanvasFullscreenToggle();
  resizeCanvas();
  initKuroshiro();
});

window.addEventListener('load', () => {
  syncViewportHeight();
  initOfflineRecognizers();
});
