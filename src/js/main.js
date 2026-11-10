/* ==========================================================================
   Box Height Synchronization (Portrait 64px vs. Landscape 86px Base)
   ========================================================================== */
function getMinBoxHeightPx() {
  return window.matchMedia('(orientation: portrait)').matches ? 64 : 86;
}

function autoResizeBoxes() {
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
window.addEventListener('resize', resizeCanvas);
window.addEventListener('DOMContentLoaded', () => {
  resizeCanvas();
  initKuroshiro();
});
window.addEventListener('load', () => {
  initOfflineRecognizers();
});