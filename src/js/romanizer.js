/* ==========================================================================
   Shared Multi-Language Romanization, Writable Box 2 & Dictionary Coordinator
   Dispatches to: lang-ja.js, lang-zh.js, lang-ko.js, and lang-ru.js
   ========================================================================== */
let alignedSegments = [];
let imeSuggestRequestId = 0;

/* 3-Way Dictionary Inspect Mode: 'on-unlocked' | 'on-locked' | 'off' */
const DICT_INSPECT_MODES = ['on-unlocked', 'on-locked', 'off'];
function getInitialDictInspectMode() {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(orientation: portrait)').matches ? 'on-locked' : 'on-unlocked';
  }
  return 'on-unlocked';
}

let dictInspectMode = getInitialDictInspectMode();
let isInspectModeActive = dictInspectMode !== 'off';
let activeHoveredSegIdx = null;
let lastInspectedTokenEl = null;
let lastKnownBox1Text = '';
let dictHoverHideTimer = null;
let dictLookupRequestId = 0;
let isDictAndHighlightInitialized = false;
let currentConversionId = 0;
let lastEngineStatusType = 'loading';

/* 3-Way Hover/Tap Translation Mode: 'on-unlocked' | 'on-locked' | 'off' (Starts OFF) */
const TRANSLATE_HOVER_MODES = ['on-unlocked', 'on-locked', 'off'];
let translateHoverMode = 'off';
let isTranslateModeActive = false;
let activeTranslatedSegIndices = new Set();
let activeTranslatedSpanKey = null;
let lastTranslatedContext = null;
let translateHoverDebounceTimer = null;
let translateSelectionDebounceTimer = null;
let translateLookupRequestId = 0;
const HOVER_TRANSLATION_CACHE = new Map();

/* ==========================================================================
   Full-App & Dictionary Localization ('en' | 'es' | 'pt') + Browser Detection
   ========================================================================== */
const DICT_TARGET_LANGS = ['en', 'es', 'pt'];

const DICT_TARGET_META = {
  en: {
    code: 'EN',
    flag: '🇺🇸',
    name: 'English',
    searching: 'Searching dictionary...',
    notFound: 'No exact entry found for',
    closeLabel: 'Close dictionary',
    breakdownLabel: 'Word Breakdown',
    translating: 'Translating...',
    translateTitle: 'Translation',
    translateSelectionBadge: 'Selection',
    translateSentenceBadge: 'Sentence',
    translateFailed: 'Unable to translate this text right now.'
  },
  es: {
    code: 'ES',
    flag: '🇪🇸',
    name: 'Español',
    searching: 'Buscando en el diccionario...',
    notFound: 'No se encontró entrada exacta para',
    closeLabel: 'Cerrar diccionario',
    breakdownLabel: 'Desglose gramatical',
    translating: 'Traduciendo...',
    translateTitle: 'Traducción',
    translateSelectionBadge: 'Selección',
    translateSentenceBadge: 'Oración',
    translateFailed: 'No se pudo traducir este texto en este momento.'
  },
  pt: {
    code: 'PT',
    flag: '🇧🇷',
    name: 'Português',
    searching: 'Pesquisando no dicionário...',
    notFound: 'Nenhuma entrada exata encontrada para',
    closeLabel: 'Fechar dicionário',
    breakdownLabel: 'Análise gramatical',
    translating: 'Traduzindo...',
    translateTitle: 'Tradução',
    translateSelectionBadge: 'Seleção',
    translateSentenceBadge: 'Frase',
    translateFailed: 'Não foi possível traduzir este texto no momento.'
  }
};

const APP_UI_STRINGS = {
  en: {
    pageTitle: 'Multilingual Handwriting & Romanizer',
    tabs: { ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ru: 'Russian' },
    status: {
      loading: 'Loading dictionary...',
      ready: 'Kuroshiro + Kuromoji Ready',
      'ready-fallback': 'Ready (kanjiapi.dev Mode)'
    },
    theme: {
      toLight: 'Switch to Light Mode',
      toDark: 'Switch to Dark Mode'
    },
    langConfig: {
      ja: {
        instruction: 'Draw Japanese (Kanji, Hiragana, Katakana)',
        romajiName: 'Romaji (Hepburn)',
        desc: 'Editable — lowercase → Hiragana, UPPERCASE → Katakana'
      },
      zh: {
        instruction: 'Draw Chinese (Simplified / Traditional Hanzi)',
        romajiName: 'Pinyin (Toned)',
        desc: 'Editable — type Pinyin to convert to Hanzi'
      },
      ko: {
        instruction: 'Draw Korean (Hangul Syllables / Jamo)',
        romajiName: 'Revised Romanization (RR)',
        desc: 'Editable — type Romanization to convert to Hangul'
      },
      ru: {
        instruction: 'Draw Russian (Cyrillic Script)',
        romajiName: 'Latin Transliteration',
        desc: 'Editable — type Latin letters to convert to Cyrillic'
      }
    },
    canvas: {
      recognizing: 'Recognizing...',
      undo: 'Undo',
      clearCanvas: 'Clear Canvas',
      candidateHeader: 'Recognition Candidates',
      candidateHint: 'Draw a character on the canvas above...',
      expandCanvas: 'Expand canvas',
      collapseCanvas: 'Back to default view'
    },
    boxes: {
      recognizedText: 'Recognized Text',
      charSingular: 'char',
      charPlural: 'chars',
      dictUnlockedTitle: 'Dictionary: ON — Box Unlocked (Hover/Tap & Edit)',
      dictLockedTitle: 'Dictionary: ON — Box Locked (Tap/Hover to Inspect)',
      dictOffTitle: 'Dictionary: OFF — Box Unlocked',
      translateUnlockedTitle: 'Translate: ON — Box Unlocked (Select or Hover/Tap Sentence)',
      translateLockedTitle: 'Translate: ON — Box Locked (Hover/Tap Sentence)',
      translateOffTitle: 'Translate: OFF',
      space: 'Space',
      spaceTitle: 'Insert Space',
      backspaceTitle: 'Backspace',
      clear: 'Clear',
      clearTitle: 'Clear All Text',
      copy: 'Copy',
      copyBox1Title: 'Copy Text',
      copyBox2Title: 'Copy Romanization',
      box1Footer: 'Editable — draw or type directly'
    },
    toasts: {
      nothingToCopy: 'Nothing to copy!',
      copiedBox1: 'Copied Character text to clipboard!',
      copiedBox2: 'Copied Romanization to clipboard!',
      langChanged: 'Language set to English (EN)'
    }
  },
  es: {
    pageTitle: 'Escritura a Mano y Romanizador Multilingüe',
    tabs: { ja: 'Japonés', zh: 'Chino', ko: 'Coreano', ru: 'Ruso' },
    status: {
      loading: 'Cargando diccionario...',
      ready: 'Kuroshiro + Kuromoji Listo',
      'ready-fallback': 'Listo (Modo kanjiapi.dev)'
    },
    theme: {
      toLight: 'Cambiar a modo claro',
      toDark: 'Cambiar a modo oscuro'
    },
    langConfig: {
      ja: {
        instruction: 'Dibuja en japonés (Kanji, Hiragana, Katakana)',
        romajiName: 'Romaji (Hepburn)',
        desc: 'Editable — minúsculas → Hiragana, MAYÚSCULAS → Katakana'
      },
      zh: {
        instruction: 'Dibuja en chino (Hanzi simplificado / tradicional)',
        romajiName: 'Pinyin (con tonos)',
        desc: 'Editable — escribe Pinyin para convertir a Hanzi'
      },
      ko: {
        instruction: 'Dibuja en coreano (Sílabas Hangul / Jamo)',
        romajiName: 'Romanización Revisada (RR)',
        desc: 'Editable — escribe romanización para convertir a Hangul'
      },
      ru: {
        instruction: 'Dibuja en ruso (Alfabeto cirílico)',
        romajiName: 'Transliteración latina',
        desc: 'Editable — escribe letras latinas para convertir a cirílico'
      }
    },
    canvas: {
      recognizing: 'Reconociendo...',
      undo: 'Deshacer',
      clearCanvas: 'Limpiar lienzo',
      candidateHeader: 'Candidatos de reconocimiento',
      candidateHint: 'Dibuja un carácter en el lienzo de arriba...',
      expandCanvas: 'Expandir lienzo',
      collapseCanvas: 'Volver a la vista predeterminada'
    },
    boxes: {
      recognizedText: 'Texto reconocido',
      charSingular: 'carácter',
      charPlural: 'caracteres',
      dictUnlockedTitle: 'Diccionario: ON — Caja desbloqueada (Inspeccionar y editar)',
      dictLockedTitle: 'Diccionario: ON — Caja bloqueada (Tocar para inspeccionar)',
      dictOffTitle: 'Diccionario: OFF — Caja desbloqueada',
      translateUnlockedTitle: 'Traducción: ON — Caja desbloqueada (Seleccionar o pasar/tocar oración)',
      translateLockedTitle: 'Traducción: ON — Caja bloqueada (Pasar/tocar oración)',
      translateOffTitle: 'Traducción: OFF',
      space: 'Espacio',
      spaceTitle: 'Insertar espacio',
      backspaceTitle: 'Retroceso',
      clear: 'Borrar',
      clearTitle: 'Borrar todo el texto',
      copy: 'Copiar',
      copyBox1Title: 'Copiar texto',
      copyBox2Title: 'Copiar romanización',
      box1Footer: 'Editable — dibuja o escribe directamente'
    },
    toasts: {
      nothingToCopy: '¡Nada que copiar!',
      copiedBox1: '¡Texto copiado al portapapeles!',
      copiedBox2: '¡Romanización copiada al portapapeles!',
      langChanged: 'Idioma cambiado a Español (ES)'
    }
  },
  pt: {
    pageTitle: 'Escrita à Mão e Romanizador Multilíngue',
    tabs: { ja: 'Japonês', zh: 'Chinês', ko: 'Coreano', ru: 'Russo' },
    status: {
      loading: 'Carregando dicionário...',
      ready: 'Kuroshiro + Kuromoji Pronto',
      'ready-fallback': 'Pronto (Modo kanjiapi.dev)'
    },
    theme: {
      toLight: 'Mudar para o modo claro',
      toDark: 'Mudar para o modo escuro'
    },
    langConfig: {
      ja: {
        instruction: 'Desenhe em japonês (Kanji, Hiragana, Katakana)',
        romajiName: 'Romaji (Hepburn)',
        desc: 'Editável — minúsculas → Hiragana, MAIÚSCULAS → Katakana'
      },
      zh: {
        instruction: 'Desenhe em chinês (Hanzi simplificado / tradicional)',
        romajiName: 'Pinyin (com tons)',
        desc: 'Editável — digite Pinyin para converter em Hanzi'
      },
      ko: {
        instruction: 'Desenhe em coreano (Sílabas Hangul / Jamo)',
        romajiName: 'Romanização Revisada (RR)',
        desc: 'Editável — digite a romanização para converter em Hangul'
      },
      ru: {
        instruction: 'Desenhe em russo (Alfabeto cirílico)',
        romajiName: 'Transliteração latina',
        desc: 'Editável — digite letras latinas para converter em cirílico'
      }
    },
    canvas: {
      recognizing: 'Reconhecendo...',
      undo: 'Desfazer',
      clearCanvas: 'Limpar tela',
      candidateHeader: 'Candidatos de reconhecimento',
      candidateHint: 'Desenhe um caractere na tela acima...',
      expandCanvas: 'Expandir tela',
      collapseCanvas: 'Voltar à visualização padrão'
    },
    boxes: {
      recognizedText: 'Texto reconhecido',
      charSingular: 'caractere',
      charPlural: 'caracteres',
      dictUnlockedTitle: 'Dicionário: ON — Caixa desbloqueada (Inspecionar e editar)',
      dictLockedTitle: 'Dicionário: ON — Caixa bloqueada (Tocar para inspecionar)',
      dictOffTitle: 'Dicionário: OFF — Caixa desbloqueada',
      translateUnlockedTitle: 'Tradução: ON — Caixa desbloqueada (Selecionar ou passar/tocar frase)',
      translateLockedTitle: 'Tradução: ON — Caixa bloqueada (Passar/tocar frase)',
      translateOffTitle: 'Tradução: OFF',
      space: 'Espaço',
      spaceTitle: 'Inserir espaço',
      backspaceTitle: 'Apagar',
      clear: 'Limpar',
      clearTitle: 'Limpar todo o texto',
      copy: 'Copiar',
      copyBox1Title: 'Copiar texto',
      copyBox2Title: 'Copiar romanização',
      box1Footer: 'Editável — desenhe ou digite diretamente'
    },
    toasts: {
      nothingToCopy: 'Nada para copiar!',
      copiedBox1: 'Texto copiado para a área de transferência!',
      copiedBox2: 'Romanização copiada para a área de transferência!',
      langChanged: 'Idioma alterado para Português (PT)'
    }
  }
};

function detectBrowserAppLang() {
  const navLangs = (typeof navigator !== 'undefined' && Array.isArray(navigator.languages) && navigator.languages.length > 0)
    ? navigator.languages
    : [(typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || 'en'];

  for (const raw of navLangs) {
    const lower = String(raw || '').toLowerCase();
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('pt')) return 'pt';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

let dictTargetLang = (() => {
  try {
    const saved = localStorage.getItem('appUiLang');
    if (saved && DICT_TARGET_LANGS.includes(saved)) return saved;
  } catch (_) {}
  return detectBrowserAppLang();
})();

function getAppStrings() {
  return APP_UI_STRINGS[dictTargetLang] || APP_UI_STRINGS.en;
}

function formatCharCountText(count) {
  const s = getAppStrings().boxes;
  return `${count} ${count === 1 ? s.charSingular : s.charPlural}`;
}

/* Override setEngineStatus from lang-ja.js so the status badge stays localized */
function setEngineStatus(type) {
  lastEngineStatusType = type || 'loading';
  const s = getAppStrings().status;
  const localizedMsg = s[lastEngineStatusType] || s.loading;

  statusText.textContent = localizedMsg;
  statusBadge.title = localizedMsg;
  statusBadge.className = 'group flex items-center text-xs font-medium p-1.5 hover:px-2.5 hover:py-1 rounded-full border transition-all cursor-default ';

  if (type === 'ready') {
    statusBadge.className += 'bg-emerald-50 text-emerald-700 border-emerald-200';
    statusBadge.querySelector('span').className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0';
  } else if (type === 'ready-fallback') {
    statusBadge.className += 'bg-blue-50 text-blue-700 border-blue-200';
    statusBadge.querySelector('span').className = 'w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0';
  } else {
    statusBadge.className += 'bg-amber-50 text-amber-700 border-amber-200';
    statusBadge.querySelector('span').className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse shrink-0';
  }
}

function applyAppLanguageUI() {
  const ui = getAppStrings();
  document.documentElement.lang = dictTargetLang;
  document.title = ui.pageTitle;

  // Sync LANGUAGES config object in memory so tab switches use localized strings
  if (typeof LANGUAGES === 'object' && LANGUAGES) {
    for (const langKey of ['ja', 'zh', 'ko', 'ru']) {
      if (LANGUAGES[langKey] && ui.langConfig[langKey]) {
        LANGUAGES[langKey].instruction = ui.langConfig[langKey].instruction;
        LANGUAGES[langKey].romajiName = ui.langConfig[langKey].romajiName;
        LANGUAGES[langKey].desc = ui.langConfig[langKey].desc;
      }
    }
  }

  // Top Language Tabs
  document.querySelectorAll('.lang-tab').forEach((tab) => {
    const code = tab.getAttribute('data-lang');
    const spans = tab.querySelectorAll('span');
    if (code && ui.tabs[code] && spans.length >= 2) {
      spans[1].textContent = ui.tabs[code];
    }
  });

  // Status Badge & Theme Toggle Tooltip
  setEngineStatus(lastEngineStatusType);
  const themeBtn = document.getElementById('btn-theme-toggle');
  if (themeBtn) {
    const isDark = document.body.classList.contains('dark-mode');
    themeBtn.title = isDark ? ui.theme.toLight : ui.theme.toDark;
  }

  // Canvas Header, Instructions & Buttons
  const activeLangCfg = ui.langConfig[currentLang] || ui.langConfig.ja;
  if (drawingInstructions) drawingInstructions.textContent = activeLangCfg.instruction;
  if (recognizingIndicator) recognizingIndicator.textContent = ui.canvas.recognizing;

  const undoBtn = document.getElementById('btn-undo');
  if (undoBtn) undoBtn.textContent = ui.canvas.undo;

  const clearCanvasBtn = document.getElementById('btn-clear-canvas');
  if (clearCanvasBtn) clearCanvasBtn.textContent = ui.canvas.clearCanvas;

  const candHeaderSpan = document.querySelector('.candidate-header span');
  if (candHeaderSpan) candHeaderSpan.textContent = ui.canvas.candidateHeader;

  if (candidatesContainer && candidatesContainer.children.length === 1 && candidatesContainer.firstElementChild.tagName === 'SPAN') {
    candidatesContainer.firstElementChild.textContent = ui.canvas.candidateHint;
  }

  const fsBtn = document.getElementById('btn-toggle-fullscreen');
  if (fsBtn) {
    const isExpanded = document.body.classList.contains('canvas-expanded');
    fsBtn.title = isExpanded ? ui.canvas.collapseCanvas : ui.canvas.expandCanvas;
  }

  // Box 1 & Box 2 Headers, Buttons, Char Count & Footers
  const box1HeaderTitle = document.querySelector('.box1-card .box-card-header h2');
  if (box1HeaderTitle) box1HeaderTitle.textContent = ui.boxes.recognizedText;

  if (charCount && textOutputBox) {
    charCount.textContent = formatCharCountText(textOutputBox.value.length);
  }

  updateDictInspectButtonUI();
  updateTranslateButtonUI();

  const spaceBtn = document.getElementById('btn-add-space');
  if (spaceBtn) {
    spaceBtn.textContent = ui.boxes.space;
    spaceBtn.title = ui.boxes.spaceTitle;
  }

  const backspaceBtn = document.getElementById('btn-backspace');
  if (backspaceBtn) backspaceBtn.title = ui.boxes.backspaceTitle;

  const clearTextBtn = document.getElementById('btn-clear-text');
  if (clearTextBtn) {
    clearTextBtn.textContent = ui.boxes.clear;
    clearTextBtn.title = ui.boxes.clearTitle;
  }

  const copyBox1Btn = document.getElementById('btn-copy-box1');
  if (copyBox1Btn) {
    copyBox1Btn.textContent = ui.boxes.copy;
    copyBox1Btn.title = ui.boxes.copyBox1Title;
  }

  const copyBox2Btn = document.getElementById('btn-copy-box2');
  if (copyBox2Btn) {
    copyBox2Btn.textContent = ui.boxes.copy;
    copyBox2Btn.title = ui.boxes.copyBox2Title;
  }

  if (romanizationLabel) romanizationLabel.textContent = activeLangCfg.romajiName;
  if (translitDesc) translitDesc.textContent = activeLangCfg.desc;

  const box1FooterSpan = document.querySelector('.box1-card .box-footer span');
  if (box1FooterSpan) box1FooterSpan.textContent = ui.boxes.box1Footer;

  updateDictLangHeaderButtonUI();
}

const HYBRID_DICT_LANG_CACHE = new Map();

const NUMBER_SPLIT_REGEX = /([0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)/g;
const IS_NUMBER_TOKEN_REGEX = /^([0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)$/;

/* ==========================================================================
   Collision-Free Box 2 Backdrop & Multilingual Number Helpers
   ========================================================================== */
function getBox2Backdrop() {
  let backdrop = document.getElementById('romanized-backdrop');
  if (backdrop) return backdrop;

  if (document.activeElement === romanizedOutputBox) return null;

  const wrapper = document.createElement('div');
  wrapper.id = 'box2-wrapper';
  wrapper.className = 'auto-grow-box relative w-full bg-slate-50/70 border border-slate-200 rounded-xl overflow-hidden transition-colors duration-150';

  backdrop = document.createElement('div');
  backdrop.id = 'romanized-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.className = 'box1-shared-metrics absolute inset-0 w-full h-full text-slate-700 pointer-events-none select-none overflow-hidden';

  const parent = romanizedOutputBox.parentNode;
  if (parent) {
    parent.insertBefore(wrapper, romanizedOutputBox);
    wrapper.appendChild(backdrop);
    wrapper.appendChild(romanizedOutputBox);
  }

  romanizedOutputBox.classList.add('overlay-box2-active', 'relative', 'z-10');
  romanizedOutputBox.readOnly = false;
  romanizedOutputBox.removeAttribute('readonly');
  return backdrop;
}

function setBox2Content(plainText, htmlText, forceSyncBox2 = false) {
  const backdrop = getBox2Backdrop();
  if (forceSyncBox2 || document.activeElement !== romanizedOutputBox) {
    romanizedOutputBox.value = plainText;
  }
  if (backdrop) {
    backdrop.innerHTML = htmlText.endsWith('\n') ? htmlText + '\u200b' : htmlText;
  }
}

function romanizeNumberByLang(rawToken, lang) {
  const normalized = normalizeAsciiDigits(rawToken);
  if (lang === 'ja') return numberToJapaneseRomaji(normalized);
  if (lang === 'zh') return numberToChinesePinyin(normalized);
  if (lang === 'ko') return numberToKoreanRomaji(normalized);
  if (lang === 'ru') return numberToRussianRomaji(normalized);
  return normalized;
}

/* Used by canvas-handwriting.js for single-character drawn candidate popups */
async function romanizeNonJapaneseTextAndNumbers(text, lang) {
  const parts = text.split(NUMBER_SPLIT_REGEX).filter(Boolean);
  const plainParts = [];
  const htmlParts = [];

  for (const part of parts) {
    if (IS_NUMBER_TOKEN_REGEX.test(part)) {
      const romNum = romanizeNumberByLang(part, lang);
      const needLeadingSpace = plainParts.length > 0 && !/\s$/.test(plainParts[plainParts.length - 1]);
      const prefix = needLeadingSpace ? ' ' : '';
      plainParts.push(prefix + romNum + ' ');
      htmlParts.push(`${prefix}<span class="romanized-number">${escapeHtml(romNum)}</span> `);
    } else {
      let romText = '';
      if (lang === 'zh') romText = romanizeChinese(part);
      else if (lang === 'ko') romText = romanizeKorean(part);
      else if (lang === 'ru') romText = romanizeRussian(part);
      plainParts.push(romText);
      htmlParts.push(escapeHtml(romText));
    }
  }

  return {
    plain: plainParts.join('').replace(/ +/g, ' ').trim(),
    html: htmlParts.join('').replace(/ +/g, ' ').trim()
  };
}

/* Build Box 2 plain and HTML strings while preserving exact line breaks (\n) from Box 1 */
function buildBox2SegmentedStrings(segments) {
  let plain = '';
  let html = '';
  let needSpaceBeforeNextWord = false;

  for (const s of segments) {
    if (!s || !s.rom) continue;
    if (s.isNewline) {
      plain += s.rom;
      html += s.romHtml || s.rom;
      needSpaceBeforeNextWord = false;
    } else {
      if (needSpaceBeforeNextWord) {
        plain += ' ';
        html += ' ';
      }
      plain += s.rom;
      html += `<span class="box2-seg" data-seg-idx="${s.idx}">${s.romHtml || escapeHtml(s.rom)}</span>`;
      needSpaceBeforeNextWord = true;
    }
  }

  return { plain, html };
}

/* ==========================================================================
   Writable Box 2 Segment Matcher & Bidirectional Input Handler
   ========================================================================== */
function formatBox2BackdropWithNumbers(rawText) {
  const parts = rawText.split(/([0-9０-９]+)/g).filter(Boolean);
  return parts
    .map(p => /^[0-9０-９]+$/.test(p)
      ? `<span class="romanized-number">${escapeHtml(p)}</span>`
      : escapeHtml(p))
    .join('');
}

function compareRomajiSegmentSlices(sliceA, sliceB) {
  if (currentLang === 'zh') {
    return foldPinyinAccents(sliceA) === foldPinyinAccents(sliceB);
  }
  return sliceA.toLowerCase() === sliceB.toLowerCase();
}

function matchUnchangedBox2Segments(rawBox2, segments) {
  const validSegs = segments.filter(s => s && s.src);
  let pos = 0;
  let prefixIdx = 0;

  while (prefixIdx < validSegs.length) {
    const seg = validSegs[prefixIdx];
    if (!seg.rom) {
      prefixIdx++;
      continue;
    }
    let scanPos = pos;
    while (scanPos < rawBox2.length && /[ \t\r]/.test(rawBox2[scanPos])) {
      scanPos++;
    }
    const candidateSlice = rawBox2.slice(scanPos, scanPos + seg.rom.length);
    if (candidateSlice.length === seg.rom.length && compareRomajiSegmentSlices(candidateSlice, seg.rom)) {
      pos = scanPos + seg.rom.length;
      prefixIdx++;
    } else {
      break;
    }
  }

  let endPos = rawBox2.length;
  let suffixIdx = validSegs.length;

  while (suffixIdx > prefixIdx) {
    const seg = validSegs[suffixIdx - 1];
    if (!seg.rom) {
      suffixIdx--;
      continue;
    }
    let scanEnd = endPos;
    while (scanEnd > pos && /[ \t\r]/.test(rawBox2[scanEnd - 1])) {
      scanEnd--;
    }
    const startCandidate = scanEnd - seg.rom.length;
    if (startCandidate >= pos) {
      const hasBoundaryBefore = seg.isNewline || startCandidate === pos || /\s/.test(rawBox2[startCandidate - 1]);
      const candidateSlice = rawBox2.slice(startCandidate, scanEnd);
      if (hasBoundaryBefore && candidateSlice.length === seg.rom.length && compareRomajiSegmentSlices(candidateSlice, seg.rom)) {
        endPos = startCandidate;
        suffixIdx--;
        continue;
      }
    }
    break;
  }

  return {
    prefixSrc: validSegs.slice(0, prefixIdx).map(s => s.src).join(''),
    suffixSrc: validSegs.slice(suffixIdx).map(s => s.src).join(''),
    middleRomaji: rawBox2.slice(pos, endPos)
  };
}

function convertBox2SubstringToBox1(subRomaji, lang) {
  if (!subRomaji) return '';
  if (lang === 'ja') return romajiToJapaneseKanaByCase(subRomaji, true);
  if (lang === 'ru') return latinToRussianCyrillic(subRomaji);
  if (lang === 'ko') return romanizedToHangul(subRomaji);
  if (lang === 'zh') {
    return subRomaji
      .split('\n')
      .map(line => {
        if (!line.trim()) return '';
        const localCands = buildLocalChineseSuggestions(line);
        return localCands[0] || line.trim();
      })
      .join('\n');
  }
  return subRomaji;
}

function showTypingSuggestions(suggestions, replaceRange) {
  if (typeof renderImeSuggestions === 'function') {
    renderImeSuggestions(suggestions, replaceRange);
    return;
  }

  if (typeof strokes !== 'undefined' && strokes.length > 0) return;

  candidatesContainer.innerHTML = '';
  if (!suggestions || suggestions.length === 0 || !replaceRange) {
    candidatesContainer.classList.add('hidden');
    return;
  }

  if (typeof isInitialCandidateHintDismissed !== 'undefined') {
    isInitialCandidateHintDismissed = true;
  }
  candidatesContainer.classList.remove('hidden');

  suggestions.forEach((suggestion) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'candidate-btn px-3.5 py-1.5 bg-white hover:bg-indigo-50 active:bg-indigo-100 text-slate-800 hover:text-indigo-600 font-medium text-lg border border-slate-200 rounded-xl transition-all shadow-sm flex items-center justify-center min-w-[44px] select-none';
    btn.textContent = suggestion;

    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyImeSuggestion(suggestion, replaceRange);
    });

    candidatesContainer.appendChild(btn);
  });
}

function clearAlignedSegmentsAndSuggestions() {
  alignedSegments = [];
  showTypingSuggestions([], null);
  hideDictionaryPopover();
}

async function handleBox2Input() {
  hideDictionaryPopover();
  const rawBox2 = romanizedOutputBox.value;
  const backdrop = getBox2Backdrop();

  if (backdrop) {
    const html = formatBox2BackdropWithNumbers(rawBox2);
    backdrop.innerHTML = html.endsWith('\n') ? html + '\u200b' : html;
  }

  if (!rawBox2.trim()) {
    textOutputBox.value = '';
    lastKnownBox1Text = '';
    furiganaBackdrop.innerHTML = '';
    charCount.textContent = formatCharCountText(0);
    clearAlignedSegmentsAndSuggestions();
    autoResizeBoxes();
    return;
  }

  const { prefixSrc, suffixSrc, middleRomaji } = matchUnchangedBox2Segments(rawBox2, alignedSegments);
  const convertedMiddle = convertBox2SubstringToBox1(middleRomaji, currentLang);

  const newBox1Text = prefixSrc + convertedMiddle + suffixSrc;
  textOutputBox.value = newBox1Text;
  lastKnownBox1Text = newBox1Text;
  charCount.textContent = formatCharCountText(newBox1Text.length);

  if (currentLang === 'ja') {
    await renderBox1FuriganaOnly(newBox1Text);
    const trimmedMidRom = middleRomaji.trim();
    if (trimmedMidRom) {
      const replaceStart = prefixSrc.length;
      const replaceEnd = replaceStart + convertedMiddle.length;
      updateTypingSuggestions(newBox1Text, {
        start: replaceStart,
        end: replaceEnd,
        rawRomajiOverride: trimmedMidRom
      });
    } else {
      showTypingSuggestions([], null);
    }
  } else if (currentLang === 'zh') {
    const zhBuilt = buildChineseAlignedSegmentsAndBackdrop(newBox1Text);
    furiganaBackdrop.innerHTML = zhBuilt.backdropHtml;
    const trimmedMidRom = middleRomaji.trim();
    if (trimmedMidRom) {
      const replaceStart = prefixSrc.length;
      const replaceEnd = replaceStart + convertedMiddle.length;
      updateChineseTypingSuggestions(trimmedMidRom, {
        start: replaceStart,
        end: replaceEnd,
        liveUpdateBox1: true,
        prefixSrc,
        suffixSrc
      });
    } else {
      showTypingSuggestions([], null);
    }
  } else if (currentLang === 'ko') {
    const koBuilt = buildKoreanAlignedSegmentsAndBackdrop(newBox1Text);
    furiganaBackdrop.innerHTML = koBuilt.backdropHtml;
    showTypingSuggestions([], null);
  } else if (currentLang === 'ru') {
    const ruBuilt = buildRussianAlignedSegmentsAndBackdrop(newBox1Text);
    furiganaBackdrop.innerHTML = ruBuilt.backdropHtml;
    showTypingSuggestions([], null);
  }

  autoResizeBoxes();
}

async function updateChineseTypingSuggestions(rawPinyin, replaceSpec) {
  if (currentLang !== 'zh') return;
  if (typeof strokes !== 'undefined' && strokes.length > 0) return;

  const { syllables, tonelessJoined, googleQuery } = parseChinesePinyinInput(rawPinyin);
  if (!tonelessJoined) {
    showTypingSuggestions([], null);
    return;
  }

  const reqId = ++imeSuggestRequestId;
  const hasExplicitTone = syllables.length === 1 && Boolean(syllables[0].tone);
  const localList = buildLocalChineseSuggestions(rawPinyin);
  let currentEnd = replaceSpec.end;

  showTypingSuggestions(localList, { start: replaceSpec.start, end: currentEnd });

  if (googleQuery) {
    const remoteList = await fetchGoogleChinesePinyinIme(googleQuery);
    if (reqId !== imeSuggestRequestId || currentLang !== 'zh') return;

    if (remoteList.length > 0) {
      const merged = [];
      const ordered = hasExplicitTone ? [...localList, ...remoteList] : [...remoteList, ...localList];
      for (const item of ordered) {
        if (item && !merged.includes(item)) merged.push(item);
      }

      if (replaceSpec.liveUpdateBox1 && merged[0] && document.activeElement === romanizedOutputBox) {
        const nextBox1 = (replaceSpec.prefixSrc || '') + merged[0] + (replaceSpec.suffixSrc || '');
        textOutputBox.value = nextBox1;
        lastKnownBox1Text = nextBox1;
        charCount.textContent = formatCharCountText(nextBox1.length);
        const zhBuilt = buildChineseAlignedSegmentsAndBackdrop(nextBox1);
        furiganaBackdrop.innerHTML = zhBuilt.backdropHtml;
        currentEnd = (replaceSpec.prefixSrc || '').length + merged[0].length;
        autoResizeBoxes();
      }

      showTypingSuggestions(merged.slice(0, 12), { start: replaceSpec.start, end: currentEnd });
    }
  }
}

async function updateTypingSuggestions(text, explicitRange = null) {
  if (typeof strokes !== 'undefined' && strokes.length > 0) return;

  if (currentLang === 'zh') {
    const zhRange = extractActiveChineseQueryRange(text);
    if (!zhRange || !zhRange.raw) {
      showTypingSuggestions([], null);
      return;
    }
    await updateChineseTypingSuggestions(zhRange.raw, { start: zhRange.start, end: zhRange.end });
    return;
  }

  if (currentLang !== 'ja') return;

  const activeRange = extractActiveJapaneseQueryRange(text, explicitRange);
  if (!activeRange || !activeRange.raw) {
    showTypingSuggestions([], null);
    return;
  }

  const reqId = ++imeSuggestRequestId;
  const raw = activeRange.raw;
  const isRomaji = /^[a-zA-Z'\s-]+$/.test(raw);
  const hiraQuery = isRomaji
    ? katakanaToHiragana(romajiToJapaneseKanaByCase(raw.toLowerCase(), false))
    : katakanaToHiragana(raw);
  const kataQuery = hiraganaToKatakana(hiraQuery);

  if (!hiraQuery) {
    showTypingSuggestions([], null);
    return;
  }

  const localList = buildLocalJapaneseSuggestions(hiraQuery, kataQuery);
  showTypingSuggestions(localList, { start: activeRange.start, end: activeRange.end });

  if (/^[\u3041-\u3096ー]+$/.test(hiraQuery)) {
    const remoteList = await fetchGoogleJapaneseCgiIme(hiraQuery);
    if (reqId !== imeSuggestRequestId) return;
    if (remoteList.length > 0) {
      const merged = [];
      for (const item of [...remoteList, ...localList]) {
        if (item && !merged.includes(item)) merged.push(item);
      }
      showTypingSuggestions(merged.slice(0, 10), { start: activeRange.start, end: activeRange.end });
    }
  }
}

function applyImeSuggestion(suggestion, replaceRange) {
  if (!replaceRange) return;
  const wasBox2Focused = document.activeElement === romanizedOutputBox;
  const currentText = textOutputBox.value;
  const before = currentText.slice(0, replaceRange.start);
  const after = currentText.slice(replaceRange.end);
  const nextText = before + suggestion + after;

  textOutputBox.value = nextText;
  const newCursorPos = before.length + suggestion.length;

  hideDictionaryPopover();
  showTypingSuggestions([], null);
  updateRomanization(false, true).then(() => {
    if (wasBox2Focused) {
      romanizedOutputBox.focus();
      const endLen = romanizedOutputBox.value.length;
      romanizedOutputBox.setSelectionRange(endLen, endLen);
    } else {
      textOutputBox.focus();
      textOutputBox.setSelectionRange(newCursorPos, newCursorPos);
    }
  });
}

/* ==========================================================================
   Header Dropdown Menu (EN / ES / PT) & Hybrid Dictionary Translator
   ========================================================================== */
function closeDictLangDropdown() {
  const menu = document.getElementById('dict-lang-dropdown');
  if (menu) menu.classList.add('hidden');
}

function selectAppAndDictLanguage(newLang) {
  if (!DICT_TARGET_LANGS.includes(newLang)) return;
  dictTargetLang = newLang;
  try {
    localStorage.setItem('appUiLang', dictTargetLang);
  } catch (_) {}

  closeDictLangDropdown();
  applyAppLanguageUI();

  if (typeof showToast === 'function') {
    showToast(getAppStrings().toasts.langChanged);
  }

  const pop = document.getElementById('jotoba-dict-popover');
  if (pop && !pop.classList.contains('hidden')) {
    if (isInspectModeActive && lastInspectedTokenEl && document.body.contains(lastInspectedTokenEl)) {
      triggerTokenDictionaryLookup(lastInspectedTokenEl);
    } else if (isTranslateModeActive && lastTranslatedContext) {
      triggerHoverTranslationPopover(lastTranslatedContext);
    }
  }
}

function ensureDictLangHeaderButton() {
  if (!document.getElementById('dict-lang-btn-styles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'dict-lang-btn-styles';
    styleEl.textContent = `
      body.dark-mode #btn-dict-lang {
        background-color: #334155;
        border-color: #475569;
        color: #e2e8f0;
      }
      body.dark-mode #btn-dict-lang:hover {
        background-color: #475569;
        color: #ffffff;
      }
      #dict-lang-dropdown {
        background-color: #ffffff;
        border-color: #e2e8f0;
        color: #1e293b;
      }
      body.dark-mode #dict-lang-dropdown {
        background-color: #1e293b;
        border-color: #334155;
        color: #f1f5f9;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5);
      }
      .dict-lang-option:hover {
        background-color: #f1f5f9;
      }
      body.dark-mode .dict-lang-option:hover {
        background-color: #334155;
      }
      .dict-lang-option.active-lang-opt {
        background-color: rgba(99, 102, 241, 0.12);
        color: #4f46e5;
        font-weight: 600;
      }
      body.dark-mode .dict-lang-option.active-lang-opt {
        background-color: rgba(99, 102, 241, 0.24);
        color: #a5b4fc;
      }
    `;
    document.head.appendChild(styleEl);
  }

  let wrapper = document.getElementById('app-lang-menu-wrapper');
  if (!wrapper) {
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn && themeBtn.parentNode) {
      wrapper = document.createElement('div');
      wrapper.id = 'app-lang-menu-wrapper';
      wrapper.className = 'relative inline-block shrink-0';

      const btn = document.createElement('button');
      btn.id = 'btn-dict-lang';
      btn.type = 'button';
      btn.className = 'px-2.5 py-1 rounded-full border border-slate-200 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition-all flex items-center gap-1 select-none';

      const dropdown = document.createElement('div');
      dropdown.id = 'dict-lang-dropdown';
      dropdown.className = 'hidden absolute right-0 top-full mt-1.5 w-36 rounded-xl border shadow-lg py-1 z-50 overflow-hidden';

      DICT_TARGET_LANGS.forEach((langCode) => {
        const meta = DICT_TARGET_META[langCode];
        const optBtn = document.createElement('button');
        optBtn.type = 'button';
        optBtn.setAttribute('data-ui-lang', langCode);
        optBtn.className = 'dict-lang-option w-full px-3 py-1.5 text-left text-xs flex items-center justify-between transition-colors';
        optBtn.innerHTML = `
          <span class="flex items-center gap-1.5">
            <span>${meta.flag}</span>
            <span>${meta.name}</span>
          </span>
          <span class="lang-check-mark text-indigo-500 font-bold"></span>
        `;
        optBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectAppAndDictLanguage(langCode);
        });
        dropdown.appendChild(optBtn);
      });

      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
      });

      dropdown.addEventListener('mousedown', (e) => e.stopPropagation());
      dropdown.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

      wrapper.appendChild(btn);
      wrapper.appendChild(dropdown);
      themeBtn.parentNode.insertBefore(wrapper, themeBtn);

      document.addEventListener('mousedown', (e) => {
        if (!wrapper.contains(e.target)) closeDictLangDropdown();
      });
      document.addEventListener('touchstart', (e) => {
        if (!wrapper.contains(e.target)) closeDictLangDropdown();
      }, { passive: true });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDictLangDropdown();
      });
    }
  }

  updateDictLangHeaderButtonUI();
}

function updateDictLangHeaderButtonUI() {
  const btn = document.getElementById('btn-dict-lang');
  if (!btn) return;
  const meta = DICT_TARGET_META[dictTargetLang] || DICT_TARGET_META.en;
  btn.innerHTML = `<span>🌐</span><span>${meta.code}</span><span class="text-[10px] opacity-75">▾</span>`;
  btn.title = `${meta.name} (${meta.code})`;
  btn.setAttribute('aria-label', `${meta.name} (${meta.code})`);

  const dropdown = document.getElementById('dict-lang-dropdown');
  if (dropdown) {
    dropdown.querySelectorAll('.dict-lang-option').forEach((opt) => {
      const code = opt.getAttribute('data-ui-lang');
      const isSelected = code === dictTargetLang;
      opt.classList.toggle('active-lang-opt', isSelected);
      const check = opt.querySelector('.lang-check-mark');
      if (check) check.textContent = isSelected ? '✓' : '';
    });
  }
}

const POS_LABEL_TRANSLATIONS = {
  es: {
    'noun': 'sustantivo',
    'verb': 'verbo',
    'adjective': 'adjetivo',
    'adverb': 'adverbio',
    'pronoun': 'pronombre',
    'particle': 'partícula',
    'conjunction': 'conjunción',
    'interjection': 'interjección',
    'expression': 'expresión',
    'numeral': 'numeral',
    'phrase': 'frase',
    'proper noun': 'nombre propio'
  },
  pt: {
    'noun': 'substantivo',
    'verb': 'verbo',
    'adjective': 'adjetivo',
    'adverb': 'advérbio',
    'pronoun': 'pronome',
    'particle': 'partícula',
    'conjunction': 'conjunção',
    'interjection': 'interjeição',
    'expression': 'expressão',
    'numeral': 'numeral',
    'phrase': 'frase',
    'proper noun': 'nome próprio'
  }
};

const GRAMMAR_BADGE_TRANSLATIONS = {
  es: {
    'Polite Negative': 'Negativo cortés',
    'Polite Past Negative': 'Pasado negativo cortés',
    'Polite Past': 'Pasado cortés',
    'Polite Form': 'Forma cortés',
    'Polite Volitional': 'Volitivo cortés',
    'Polite Conditional': 'Condicional cortés',
    'Polite Supposition': 'Suposición cortés',
    'Plain Supposition': 'Suposición simple',
    'Politeness Marker': 'Marcador de cortesía',
    'Negative Copula': 'Cópula negativa',
    'Polite Negative Copula': 'Cópula negativa cortés',
    'Past Negative Copula': 'Cópula pasada negativa',
    'Polite Past Negative Copula': 'Cópula pasada negativa cortés',
    'Past Negative': 'Pasado negativo',
    'Negative': 'Negativo',
    'Negative Volitional': 'Volitivo negativo',
    'Past Tense': 'Pasado',
    'Plain Past': 'Pasado simple',
    'Te-form': 'Forma -te',
    'Desiderative': 'Desiderativo',
    'Past Desiderative': 'Desiderativo pasado',
    'Negative Desiderative': 'Desiderativo negativo',
    'Polite Negative Desiderative': 'Desiderativo negativo cortés',
    'Past Negative Desiderative': 'Desiderativo pasado negativo',
    'Passive / Potential': 'Pasiva / Potencial',
    'Causative': 'Causativo',
    'Conditional': 'Condicional',
    'Negative Conditional': 'Condicional negativo',
    'Volitional': 'Volitivo',
    'Completed / Accidental Past': 'Pasado completado / accidental',
    'Colloquial Completion': 'Finalización coloquial',
    'Progressive / State (〜ている)': 'Progresivo / Estado (〜ている)',
    'Negative Progressive': 'Progresivo negativo',
    'Polite Negative Progressive': 'Progresivo negativo cortés',
    'Past Progressive': 'Progresivo pasado',
    'Polite Past Progressive': 'Progresivo pasado cortés',
    'Past Negative Progressive': 'Progresivo pasado negativo',
    'Polite Past Negative Progressive': 'Progresivo pasado negativo cortés',
    'Polite Request (〜てください)': 'Petición cortés (〜てください)',
    'Completion / Regret (〜てしまう)': 'Finalización / Lamento (〜てしまう)',
    'Try Doing (〜てみる)': 'Intentar (〜てみる)',
    'In Advance (〜ておく)': 'De antemano (〜ておく)',
    'Resulting State (〜てある)': 'Estado resultante (〜てある)',
    'Auxiliary: 〜ている': 'Auxiliar: 〜ている'
  },
  pt: {
    'Polite Negative': 'Negativo polido',
    'Polite Past Negative': 'Passado negativo polido',
    'Polite Past': 'Passado polido',
    'Polite Form': 'Forma polida',
    'Polite Volitional': 'Volitivo polido',
    'Polite Conditional': 'Condicional polido',
    'Polite Supposition': 'Suposição polida',
    'Plain Supposition': 'Suposição simples',
    'Politeness Marker': 'Marcador de polidez',
    'Negative Copula': 'Cópula negativa',
    'Polite Negative Copula': 'Cópula negativa polida',
    'Past Negative Copula': 'Cópula passada negativa',
    'Polite Past Negative Copula': 'Cópula passada negativa polida',
    'Past Negative': 'Passado negativo',
    'Negative': 'Negativo',
    'Negative Volitional': 'Volitivo negativo',
    'Past Tense': 'Passado',
    'Plain Past': 'Passado simples',
    'Te-form': 'Forma -te',
    'Desiderative': 'Desiderativo',
    'Past Desiderative': 'Desiderativo passado',
    'Negative Desiderative': 'Desiderativo negativo',
    'Polite Negative Desiderative': 'Desiderativo negativo polido',
    'Past Negative Desiderative': 'Desiderativo passado negativo',
    'Passive / Potential': 'Passiva / Potencial',
    'Causative': 'Causativo',
    'Conditional': 'Condicional',
    'Negative Conditional': 'Condicional negativo',
    'Volitional': 'Volitivo',
    'Completed / Accidental Past': 'Passado concluído / acidental',
    'Colloquial Completion': 'Conclusão coloquial',
    'Progressive / State (〜ている)': 'Progressivo / Estado (〜ている)',
    'Negative Progressive': 'Progressivo negativo',
    'Polite Negative Progressive': 'Progressivo negativo polido',
    'Past Progressive': 'Progressivo passado',
    'Polite Past Progressive': 'Progressivo passado polido',
    'Past Negative Progressive': 'Progressivo passado negativo',
    'Polite Past Negative Progressive': 'Progressivo passado negativo polido',
    'Polite Request (〜てください)': 'Pedido polido (〜てください)',
    'Completion / Regret (〜てしまう)': 'Conclusão / Lamentação (〜てしまう)',
    'Try Doing (〜てみる)': 'Tentar fazer (〜てみる)',
    'In Advance (〜ておく)': 'De antemão (〜ておく)',
    'Resulting State (〜てある)': 'Estado resultante (〜てある)',
    'Auxiliary: 〜ている': 'Auxiliar: 〜ている'
  }
};

function localizePosTag(posStr, targetLang) {
  if (!posStr || targetLang === 'en') return posStr;
  const table = POS_LABEL_TRANSLATIONS[targetLang];
  if (!table) return posStr;
  const lower = posStr.trim().toLowerCase();
  return table[lower] || posStr;
}

function localizeBadgeLabel(badgeStr, targetLang) {
  if (!badgeStr || targetLang === 'en') return badgeStr;
  const exactMap = GRAMMAR_BADGE_TRANSLATIONS[targetLang];
  if (exactMap && exactMap[badgeStr]) return exactMap[badgeStr];

  if (targetLang === 'es') {
    return badgeStr
      .replace(/^Root:\s*/i, 'Raíz: ')
      .replace(/^Common$/i, 'Común')
      .replace(/^Level\s+/i, 'Nivel ')
      .replace(/^Gender:\s*/i, 'Género: ')
      .replace(/^Aspect:\s*/i, 'Aspecto: ');
  }
  if (targetLang === 'pt') {
    return badgeStr
      .replace(/^Root:\s*/i, 'Raiz: ')
      .replace(/^Common$/i, 'Comum')
      .replace(/^Level\s+/i, 'Nível ')
      .replace(/^Gender:\s*/i, 'Gênero: ')
      .replace(/^Aspect:\s*/i, 'Aspecto: ');
  }
  return badgeStr;
}

/* Direct Source -> Target (ES/PT) Google GTX Bilingual Dictionary Lookup */
async function fetchDirectTargetGtxBilingual(sourceLang, word, targetLang, timeoutMs = 2200) {
  const slMap = { ja: 'ja', zh: 'zh-CN', ko: 'ko', ru: 'ru' };
  const sl = slMap[sourceLang] || sourceLang;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=bd&dt=t&dj=1&q=${encodeURIComponent(word)}`;
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Direct Jotoba Native Spanish Lookup for Japanese (when dictTargetLang === 'es') */
async function fetchJotobaSpanishSenses(surface, basicForm, readingHira, pos, timeoutMs = 2400) {
  const lookupKey = (basicForm && basicForm !== '*') ? basicForm : surface;
  const targetUrl = 'https://jotoba.de/api/search/words';
  const bodyPayload = JSON.stringify({
    query: lookupKey,
    language: 'Spanish',
    no_english: true
  });

  const urls = [
    targetUrl,
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
  ];

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: bodyPayload,
        signal: controller.signal
      });
      if (!res.ok) continue;
      const data = await res.json();
      const words = (data && Array.isArray(data.words)) ? data.words : [];
      if (words.length === 0) return [];

      const best = typeof selectBestJotobaWordEntry === 'function'
        ? selectBestJotobaWordEntry(words, surface, lookupKey, readingHira, pos)
        : words[0];

      if (!best || !Array.isArray(best.senses)) return [];
      const out = [];
      for (const sense of best.senses.slice(0, 4)) {
        const gloss = Array.isArray(sense.glosses) ? sense.glosses.join(', ') : '';
        const posList = Array.isArray(sense.pos) && typeof formatJotobaPosTag === 'function'
          ? sense.pos.map(formatJotobaPosTag).filter(Boolean).slice(0, 2).join(', ')
          : '';
        if (gloss) {
          out.push({ pos: localizePosTag(posList, 'es'), gloss });
        }
      }
      return out;
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

/* Index-Safe Batched Post-Lookup Translator (EN -> ES / PT) Using [#N] Markers */
async function translateBatchEnToTarget(stringsArray, targetLang, timeoutMs = 2400) {
  if (!Array.isArray(stringsArray) || stringsArray.length === 0 || targetLang === 'en') {
    return stringsArray;
  }

  const nonEmptyEntries = [];
  stringsArray.forEach((s, idx) => {
    const clean = String(s || '').replace(/\r?\n/g, ' ').trim();
    if (clean) {
      nonEmptyEntries.push({ origIdx: idx, text: clean });
    }
  });

  if (nonEmptyEntries.length === 0) return stringsArray;

  const joined = nonEmptyEntries
    .map((entry, i) => `[#${i}] ${entry.text}`)
    .join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1&q=${encodeURIComponent(joined)}`;
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal
    });
    if (!res.ok) return stringsArray;
    const data = await res.json();
    if (!data || !Array.isArray(data.sentences)) return stringsArray;

    const fullTrans = data.sentences.map(s => (s && s.trans) ? s.trans : '').join('');
    const output = [...stringsArray];

    const markerRegex = /\[\s*#\s*(\d+)\s*\]/g;
    const matches = [];
    let m;
    while ((m = markerRegex.exec(fullTrans)) !== null) {
      matches.push({
        batchIdx: Number(m[1]),
        start: m.index,
        end: markerRegex.lastIndex
      });
    }

    if (matches.length > 0) {
      for (let k = 0; k < matches.length; k++) {
        const curr = matches[k];
        const nextStart = k + 1 < matches.length ? matches[k + 1].start : fullTrans.length;
        const translatedText = fullTrans.slice(curr.end, nextStart).replace(/\r?\n/g, ' ').trim();
        const entry = nonEmptyEntries[curr.batchIdx];
        if (entry && translatedText) {
          output[entry.origIdx] = translatedText;
        }
      }
      return output;
    }

    const splitLines = fullTrans.split('\n').map(s => s.trim());
    nonEmptyEntries.forEach((entry, i) => {
      if (splitLines[i]) output[entry.origIdx] = splitLines[i];
    });
    return output;
  } catch (_) {
    return stringsArray;
  } finally {
    clearTimeout(timer);
  }
}

/* ==========================================================================
   API Option 3: Hover/Tap Translation Engine (Google GTX + Lingva Fallback)
   ========================================================================== */
const LINGVA_PUBLIC_INSTANCES = [
  'https://lingva.ml',
  'https://lingva.thedaviddelta.com',
  'https://translate.plausibility.cloud',
  'https://lingva.lunar.icu'
];
let lingvaInstanceCursor = 0;

async function fetchGoogleGtxPlainTranslation(sourceLang, text, targetLang, timeoutMs = 2600) {
  const slMap = { ja: 'ja', zh: 'zh-CN', ko: 'ko', ru: 'ru' };
  const sl = slMap[sourceLang] || sourceLang;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.sentences)) return null;
    const translated = data.sentences.map(s => (s && s.trans) ? s.trans : '').join('').trim();
    return translated || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLingvaTranslation(sourceLang, text, targetLang, timeoutMs = 2600) {
  const slMap = { ja: 'ja', zh: 'zh', ko: 'ko', ru: 'ru' };
  const sl = slMap[sourceLang] || sourceLang;
  const total = LINGVA_PUBLIC_INSTANCES.length;

  for (let attempt = 0; attempt < total; attempt++) {
    const idx = (lingvaInstanceCursor + attempt) % total;
    const baseUrl = LINGVA_PUBLIC_INSTANCES[idx];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${baseUrl}/api/v1/${encodeURIComponent(sl)}/${encodeURIComponent(targetLang)}/${encodeURIComponent(text)}`;
      const res = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && typeof data.translation === 'string' && data.translation.trim()) {
        lingvaInstanceCursor = idx;
        return data.translation.trim();
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function fetchHoverTranslation(sourceLang, rawText, targetLang) {
  const cleanText = String(rawText || '').trim();
  if (!cleanText) return null;

  const cacheKey = `${sourceLang}|${targetLang}|${cleanText}`;
  if (HOVER_TRANSLATION_CACHE.has(cacheKey)) {
    return HOVER_TRANSLATION_CACHE.get(cacheKey);
  }

  const gtxResult = await fetchGoogleGtxPlainTranslation(sourceLang, cleanText, targetLang);
  if (gtxResult) {
    const payload = { translation: gtxResult, provider: 'Google' };
    HOVER_TRANSLATION_CACHE.set(cacheKey, payload);
    return payload;
  }

  const lingvaResult = await fetchLingvaTranslation(sourceLang, cleanText, targetLang);
  if (lingvaResult) {
    const payload = { translation: lingvaResult, provider: 'Lingva' };
    HOVER_TRANSLATION_CACHE.set(cacheKey, payload);
    return payload;
  }

  return null;
}

/* Hybrid Coordinator: Combines Base Specialized Dict + Direct Target Dict + Batch Translation */
async function buildLocalizedDictionaryData(tokenMeta) {
  const { surface, basic, reading, pos, posDetail, stem, suffixes, prevToken, nextToken } = tokenMeta;
  const targetLang = dictTargetLang;
  const prevSurf = (prevToken && prevToken.surface) || '';
  const nextSurf = (nextToken && nextToken.surface) || '';
  const suffixKey = Array.isArray(suffixes)
    ? suffixes.map(s => (s && s.surface) ? s.surface : '').join('+')
    : '';
  const cacheKey = `${currentLang}|${targetLang}|${surface}|${basic}|${reading}|${pos}|s:${stem || ''}|x:${suffixKey}|p:${prevSurf}|n:${nextSurf}`;

  if (HYBRID_DICT_LANG_CACHE.has(cacheKey)) {
    return HYBRID_DICT_LANG_CACHE.get(cacheKey);
  }

  let baseData = null;
  if (currentLang === 'ja') {
    baseData = await lookupJapaneseTokenDict(tokenMeta);
  } else if (currentLang === 'zh') {
    baseData = await lookupChineseTokenDict(tokenMeta);
  } else if (currentLang === 'ko') {
    baseData = await lookupKoreanTokenDict(tokenMeta);
  } else if (currentLang === 'ru') {
    baseData = await lookupRussianTokenDict(tokenMeta);
  }

  if (!baseData) return null;

  if (targetLang === 'en') {
    HYBRID_DICT_LANG_CACHE.set(cacheKey, baseData);
    return baseData;
  }

  const hasSummary = Boolean(baseData.grammarSummary && baseData.grammarSummary.text);
  const summaryInputs = hasSummary ? [baseData.grammarSummary.text] : [];
  const baseSenses = Array.isArray(baseData.senses) ? baseData.senses : [];
  const baseGrammarRows = Array.isArray(baseData.grammarBreakdown) ? baseData.grammarBreakdown : [];
  const baseBreakdowns = Array.isArray(baseData.charBreakdown) ? baseData.charBreakdown : [];

  const batchInputs = [
    ...summaryInputs,
    ...baseSenses.map(s => s.gloss || ''),
    ...baseGrammarRows.map(g => g.title || ''),
    ...baseGrammarRows.map(g => g.sub || ''),
    ...baseBreakdowns.map(c => c.title || '')
  ];

  const isJaGrammarToken = Boolean(baseData.isContextGrammarOverride) || (
    currentLang === 'ja' &&
    typeof resolveLocalGrammarEntry === 'function' &&
    Boolean(resolveLocalGrammarEntry(surface, basic, pos, posDetail))
  );

  const queryTerm = (basic && basic !== '*') ? basic : surface;

  const [translatedBatch, directGtx, jotobaEsSenses] = await Promise.all([
    batchInputs.length > 0 ? translateBatchEnToTarget(batchInputs, targetLang) : Promise.resolve([]),
    !isJaGrammarToken ? fetchDirectTargetGtxBilingual(currentLang, queryTerm, targetLang) : Promise.resolve(null),
    (currentLang === 'ja' && targetLang === 'es' && !isJaGrammarToken)
      ? fetchJotobaSpanishSenses(surface, basic, reading, pos)
      : Promise.resolve([])
  ]);

  const sumCount = summaryInputs.length;
  const sCount = baseSenses.length;
  const gCount = baseGrammarRows.length;

  const translatedSummary = hasSummary
    ? {
        ...baseData.grammarSummary,
        text: translatedBatch[0] || baseData.grammarSummary.text
      }
    : null;

  const translatedSenses = baseSenses.map((s, idx) => ({
    pos: localizePosTag(s.pos || '', targetLang),
    gloss: translatedBatch[sumCount + idx] || s.gloss
  }));

  const translatedGrammarRows = baseGrammarRows.map((g, idx) => ({
    ...g,
    title: translatedBatch[sumCount + sCount + idx] || g.title,
    sub: translatedBatch[sumCount + sCount + gCount + idx] || g.sub
  }));

  const translatedBreakdowns = baseBreakdowns.map((c, idx) => ({
    ...c,
    title: translatedBatch[sumCount + sCount + gCount * 2 + idx] || c.title
  }));

  const directSenses = [];
  if (directGtx) {
    if (Array.isArray(directGtx.dict)) {
      for (const d of directGtx.dict.slice(0, 3)) {
        const dPos = localizePosTag(d.pos || '', targetLang);
        const gloss = Array.isArray(d.terms) ? d.terms.slice(0, 4).join(', ') : '';
        if (gloss) {
          directSenses.push({ pos: dPos, gloss });
        }
      }
    }
    if (directSenses.length === 0 && Array.isArray(directGtx.sentences) && directGtx.sentences[0] && directGtx.sentences[0].trans) {
      directSenses.push({ pos: '', gloss: directGtx.sentences[0].trans });
    }
  }

  const mergedSenses = [];
  const addSenseUnique = (item) => {
    if (!item || !item.gloss) return;
    const norm = item.gloss.trim().toLowerCase();
    if (!norm) return;
    if (!mergedSenses.some(existing => existing.gloss.trim().toLowerCase() === norm)) {
      mergedSenses.push(item);
    }
  };

  if (isJaGrammarToken) {
    translatedSenses.forEach(addSenseUnique);
  } else {
    jotobaEsSenses.forEach(addSenseUnique);
    translatedSenses.forEach(addSenseUnique);
    directSenses.forEach(addSenseUnique);
  }

  const localizedBadges = [
    ...(Array.isArray(baseData.badges) ? baseData.badges.map(b => localizeBadgeLabel(b, targetLang)) : []),
    DICT_TARGET_META[targetLang].code
  ];

  const localizedResult = {
    ...baseData,
    badges: localizedBadges,
    grammarSummary: translatedSummary,
    senses: mergedSenses.slice(0, 4),
    grammarBreakdown: translatedGrammarRows,
    charBreakdown: translatedBreakdowns
  };

  HYBRID_DICT_LANG_CACHE.set(cacheKey, localizedResult);
  return localizedResult;
}

/* ==========================================================================
   3-Way Dictionary Toggle, 3-Way Translation Toggle & Cross-Box Highlighting
   ========================================================================== */
function normalizeDictInspectMode(mode) {
  if (mode === true) return 'on-locked';
  if (mode === false) return 'off';
  return DICT_INSPECT_MODES.includes(mode) ? mode : 'off';
}

function normalizeTranslateHoverMode(mode) {
  if (mode === true) return 'on-locked';
  if (mode === false) return 'off';
  return TRANSLATE_HOVER_MODES.includes(mode) ? mode : 'off';
}

function getDictInspectModeTitle(mode) {
  const ui = getAppStrings().boxes;
  if (mode === 'on-unlocked') return ui.dictUnlockedTitle;
  if (mode === 'on-locked') return ui.dictLockedTitle;
  return ui.dictOffTitle;
}

function getTranslateHoverModeTitle(mode) {
  const ui = getAppStrings().boxes;
  if (mode === 'on-unlocked') return ui.translateUnlockedTitle;
  if (mode === 'on-locked') return ui.translateLockedTitle;
  return ui.translateOffTitle;
}

function getDictInspectModeCompactLabel(mode) {
  if (mode === 'on-unlocked') return '🔓';
  if (mode === 'on-locked') return '🔒';
  return 'OFF';
}

function updateDictInspectButtonUI() {
  const btn = document.getElementById('btn-inspect-dict');
  const label = document.getElementById('btn-inspect-dict-label');
  if (!btn || !label) return;

  btn.classList.toggle('inspect-unlocked', dictInspectMode === 'on-unlocked');
  btn.classList.toggle('inspect-locked', dictInspectMode === 'on-locked');
  label.textContent = getDictInspectModeCompactLabel(dictInspectMode);

  const titleText = getDictInspectModeTitle(dictInspectMode);
  btn.title = titleText;
  btn.setAttribute('aria-label', titleText);
}

function updateTranslateButtonUI() {
  const btn = document.getElementById('btn-translate-hover');
  const label = document.getElementById('btn-translate-hover-label');
  if (!btn || !label) return;

  btn.classList.toggle('translate-unlocked', translateHoverMode === 'on-unlocked');
  btn.classList.toggle('translate-locked', translateHoverMode === 'on-locked');
  label.textContent = getDictInspectModeCompactLabel(translateHoverMode);

  const titleText = getTranslateHoverModeTitle(translateHoverMode);
  btn.title = titleText;
  btn.setAttribute('aria-label', titleText);
}

function ensureDictInspectBar() {
  ensureDictLangHeaderButton();

  const box1Card = box1Wrapper ? box1Wrapper.closest('.box-card') : null;
  if (box1Card) {
    box1Card.classList.add('box1-card', 'dict-visible');
  }

  let btn = document.getElementById('btn-inspect-dict');
  if (!btn) {
    const addSpaceBtn = document.getElementById('btn-add-space');
    if (addSpaceBtn && addSpaceBtn.parentNode) {
      btn = document.createElement('button');
      btn.id = 'btn-inspect-dict';
      btn.type = 'button';
      btn.innerHTML = `
        <span>📖</span>
        <span id="btn-inspect-dict-label">${getDictInspectModeCompactLabel(dictInspectMode)}</span>
      `;
      addSpaceBtn.parentNode.insertBefore(btn, addSpaceBtn);

      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currIdx = DICT_INSPECT_MODES.indexOf(dictInspectMode);
        const nextMode = DICT_INSPECT_MODES[(currIdx + 1) % DICT_INSPECT_MODES.length];
        setInspectMode(nextMode, true);
      });
    }
  }

  let transBtn = document.getElementById('btn-translate-hover');
  if (!transBtn && btn && btn.parentNode) {
    transBtn = document.createElement('button');
    transBtn.id = 'btn-translate-hover';
    transBtn.type = 'button';
    transBtn.innerHTML = `
      <span>💬</span>
      <span id="btn-translate-hover-label">${getDictInspectModeCompactLabel(translateHoverMode)}</span>
    `;
    btn.parentNode.insertBefore(transBtn, btn);

    transBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    transBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    transBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currIdx = TRANSLATE_HOVER_MODES.indexOf(translateHoverMode);
      const nextMode = TRANSLATE_HOVER_MODES[(currIdx + 1) % TRANSLATE_HOVER_MODES.length];
      setTranslateMode(nextMode, true);
    });
  }

  if (btn) {
    btn.classList.remove('hidden');
    updateDictInspectButtonUI();
  }
  if (transBtn) {
    transBtn.classList.remove('hidden');
    updateTranslateButtonUI();
  }
}

function setInspectMode(mode, showFeedback = false) {
  dictInspectMode = normalizeDictInspectMode(mode);
  isInspectModeActive = dictInspectMode !== 'off';

  if (isInspectModeActive && translateHoverMode !== 'off') {
    setTranslateMode('off', false);
  }

  document.body.classList.toggle('inspect-mode-locked', dictInspectMode === 'on-locked');
  document.body.classList.toggle('inspect-mode-unlocked', dictInspectMode === 'on-unlocked');
  document.body.classList.toggle('inspect-mode-active', dictInspectMode === 'on-locked');

  updateDictInspectButtonUI();

  if (dictInspectMode === 'on-locked') {
    textOutputBox.blur();
    romanizedOutputBox.blur();
  } else if (dictInspectMode === 'off') {
    hideDictionaryPopover();
    syncBox1SelectionToBox2();
  }

  if (showFeedback && typeof showToast === 'function') {
    showToast(getDictInspectModeTitle(dictInspectMode));
  }
}

function setTranslateMode(mode, showFeedback = false) {
  translateHoverMode = normalizeTranslateHoverMode(mode);
  isTranslateModeActive = translateHoverMode !== 'off';

  if (isTranslateModeActive && dictInspectMode !== 'off') {
    setInspectMode('off', false);
  }

  document.body.classList.toggle('translate-mode-locked', translateHoverMode === 'on-locked');
  document.body.classList.toggle('translate-mode-unlocked', translateHoverMode === 'on-unlocked');

  updateTranslateButtonUI();

  if (translateHoverMode === 'on-locked') {
    textOutputBox.blur();
    romanizedOutputBox.blur();
    hideDictionaryPopover();
  } else if (translateHoverMode === 'off') {
    hideDictionaryPopover();
    syncBox1SelectionToBox2();
  } else {
    hideDictionaryPopover();
  }

  if (showFeedback && typeof showToast === 'function') {
    showToast(getTranslateHoverModeTitle(translateHoverMode));
  }
}

function ensureDictionaryPopoverElement() {
  let pop = document.getElementById('jotoba-dict-popover');
  if (pop) return pop;

  pop = document.createElement('div');
  pop.id = 'jotoba-dict-popover';
  pop.className = 'hidden';

  pop.addEventListener('mouseenter', () => {
    clearTimeout(dictHoverHideTimer);
  });
  pop.addEventListener('mouseleave', () => {
    scheduleHideDictionaryPopover(180);
  });
  pop.addEventListener('mousedown', (e) => e.stopPropagation());
  pop.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  document.body.appendChild(pop);
  return pop;
}

function hideDictionaryPopover() {
  clearTimeout(dictHoverHideTimer);
  clearTimeout(translateHoverDebounceTimer);
  clearTimeout(translateSelectionDebounceTimer);
  activeHoveredSegIdx = null;
  lastInspectedTokenEl = null;
  activeTranslatedSegIndices = new Set();
  activeTranslatedSpanKey = null;
  lastTranslatedContext = null;
  const pop = document.getElementById('jotoba-dict-popover');
  if (pop) {
    pop.classList.add('hidden');
  }
  syncBox1SelectionToBox2();
}

function scheduleHideDictionaryPopover(delayMs = 180) {
  clearTimeout(dictHoverHideTimer);
  dictHoverHideTimer = setTimeout(() => {
    hideDictionaryPopover();
  }, delayMs);
}

function hasActiveBox1TextSelection() {
  if (document.activeElement !== textOutputBox) return false;
  const selStart = textOutputBox.selectionStart ?? 0;
  const selEnd = textOutputBox.selectionEnd ?? 0;
  return selEnd > selStart;
}

function applySegmentHighlights(segIndicesSet) {
  const box1Tokens = furiganaBackdrop.querySelectorAll('.box1-token');
  box1Tokens.forEach((el) => {
    const idx = Number(el.getAttribute('data-seg-idx'));
    el.classList.toggle('cross-highlight', segIndicesSet.has(idx));
  });

  const backdrop = getBox2Backdrop();
  if (!backdrop) return;

  let firstHighlightedEl = null;
  const box2Segs = backdrop.querySelectorAll('.box2-seg');
  box2Segs.forEach((el) => {
    const idx = Number(el.getAttribute('data-seg-idx'));
    const isMatch = segIndicesSet.has(idx);
    el.classList.toggle('cross-highlight', isMatch);
    if (isMatch && !firstHighlightedEl) {
      firstHighlightedEl = el;
    }
  });

  if (firstHighlightedEl && backdrop.scrollWidth > backdrop.clientWidth) {
    const targetLeft = Math.max(0, firstHighlightedEl.offsetLeft - backdrop.clientWidth * 0.25);
    backdrop.scrollTo({ left: targetLeft, behavior: 'smooth' });
  }
}

function syncBox1SelectionToBox2() {
  const highlighted = new Set();
  const hasSelection = hasActiveBox1TextSelection();

  if (hasSelection) {
    const selStart = textOutputBox.selectionStart ?? 0;
    const selEnd = textOutputBox.selectionEnd ?? 0;
    for (const seg of alignedSegments) {
      if (seg && seg.rom && !seg.isNewline && seg.start < selEnd && seg.end > selStart) {
        highlighted.add(seg.idx);
      }
    }
    if (isInspectModeActive) {
      const pop = document.getElementById('jotoba-dict-popover');
      if (pop && !pop.classList.contains('hidden')) {
        clearTimeout(dictHoverHideTimer);
        activeHoveredSegIdx = null;
        lastInspectedTokenEl = null;
        pop.classList.add('hidden');
      }
    }
  } else if (isInspectModeActive && activeHoveredSegIdx !== null) {
    highlighted.add(Number(activeHoveredSegIdx));
  } else if (isTranslateModeActive && activeTranslatedSegIndices.size > 0) {
    activeTranslatedSegIndices.forEach((idx) => highlighted.add(idx));
  }

  applySegmentHighlights(highlighted);
}

function positionDictionaryPopover(anchorRect) {
  const pop = ensureDictionaryPopoverElement();
  const margin = 8;
  const popRect = pop.getBoundingClientRect();
  const popW = popRect.width || 320;
  const popH = popRect.height || 220;

  let left = anchorRect.left + (anchorRect.width / 2) - (popW / 2);
  left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));

  const spaceAbove = anchorRect.top;
  const spaceBelow = window.innerHeight - anchorRect.bottom;

  let top;
  if (spaceAbove >= popH + 12 || spaceAbove >= spaceBelow) {
    top = Math.max(margin, anchorRect.top - popH - 8);
  } else {
    top = Math.min(window.innerHeight - popH - margin, anchorRect.bottom + 8);
  }

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function extractTokenElementMeta(el) {
  if (!el || !el.classList || !el.classList.contains('box1-token')) return null;
  let suffixes = [];
  const rawSuffixAttr = el.getAttribute('data-suffixes');
  if (rawSuffixAttr) {
    try {
      suffixes = JSON.parse(rawSuffixAttr);
    } catch (_) {}
  }
  const surface = el.getAttribute('data-surface') || el.textContent || '';
  return {
    surface,
    basic: el.getAttribute('data-basic') || surface,
    reading: el.getAttribute('data-reading') || '',
    pos: el.getAttribute('data-pos') || '',
    posDetail: el.getAttribute('data-pos-detail') || '',
    stem: el.getAttribute('data-stem') || '',
    stemReading: el.getAttribute('data-stem-reading') || '',
    suffixes
  };
}

function getAdjacentBox1TokenMeta(tokenEl, direction) {
  let node = direction < 0 ? tokenEl.previousSibling : tokenEl.nextSibling;
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = node.textContent || '';
      if (/\n/.test(txt) || !/^[ \t\u3000]*$/.test(txt)) return null;
      node = direction < 0 ? node.previousSibling : node.nextSibling;
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('box1-token')) {
      return extractTokenElementMeta(node);
    }
    return null;
  }
  return null;
}

/* ==========================================================================
   Sentence & Selection Extraction for Hover/Tap Translation Mode
   ========================================================================== */
function isSentenceTerminatorAt(text, pos) {
  const ch = text[pos];
  if (!ch) return false;
  if (ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
    return true;
  }
  if (ch === '.') {
    const prev = pos > 0 ? text[pos - 1] : '';
    const next = pos + 1 < text.length ? text[pos + 1] : '';
    if (/[0-9]/.test(prev) && /[0-9]/.test(next)) return false;
    return true;
  }
  return false;
}

function collectSegIndicesForRange(start, end) {
  const set = new Set();
  for (const seg of alignedSegments) {
    if (seg && !seg.isNewline && seg.src && seg.src.trim() && seg.start < end && seg.end > start) {
      set.add(seg.idx);
    }
  }
  return set;
}

function getAnchorRectForSegIndices(segIndicesSet, fallbackEl = null) {
  const box1Tokens = furiganaBackdrop.querySelectorAll('.box1-token');
  let minLeft = Infinity;
  let maxRight = -Infinity;
  let minTop = Infinity;
  let maxBottom = -Infinity;
  let found = false;

  box1Tokens.forEach((el) => {
    const idx = Number(el.getAttribute('data-seg-idx'));
    if (!segIndicesSet.has(idx)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    found = true;
    if (rect.left < minLeft) minLeft = rect.left;
    if (rect.right > maxRight) maxRight = rect.right;
    if (rect.top < minTop) minTop = rect.top;
    if (rect.bottom > maxBottom) maxBottom = rect.bottom;
  });

  if (found) {
    return {
      left: minLeft,
      right: maxRight,
      top: minTop,
      bottom: maxBottom,
      width: Math.max(1, maxRight - minLeft),
      height: Math.max(1, maxBottom - minTop)
    };
  }
  if (fallbackEl && typeof fallbackEl.getBoundingClientRect === 'function') {
    return fallbackEl.getBoundingClientRect();
  }
  return box1Wrapper ? box1Wrapper.getBoundingClientRect() : { left: 16, right: 200, top: 80, bottom: 120, width: 184, height: 40 };
}

function extractSentenceSpanForToken(tokenEl) {
  if (!tokenEl) return null;
  const fullText = textOutputBox.value || '';
  if (!fullText.trim()) return null;

  const segIdx = Number(tokenEl.getAttribute('data-seg-idx'));
  const targetSeg = alignedSegments.find(s => s && s.idx === segIdx);
  if (!targetSeg) {
    const surf = (tokenEl.getAttribute('data-surface') || tokenEl.textContent || '').trim();
    if (!surf) return null;
    return {
      text: surf,
      start: 0,
      end: surf.length,
      segIndices: new Set([segIdx]),
      scope: 'sentence',
      key: `sent:tok:${segIdx}`,
      anchorEl: tokenEl
    };
  }

  let start = targetSeg.start;
  while (start > 0) {
    if (isSentenceTerminatorAt(fullText, start - 1)) break;
    start--;
  }

  let end = targetSeg.end;
  while (end < fullText.length) {
    if (fullText[end] === '\n') break;
    if (isSentenceTerminatorAt(fullText, end)) {
      end++;
      while (end < fullText.length && /^[」』）"'\]】》〕。！？!?]$/.test(fullText[end])) {
        end++;
      }
      break;
    }
    end++;
  }

  while (start < end && /\s/.test(fullText[start])) start++;
  while (end > start && /\s/.test(fullText[end - 1])) end--;

  const sentenceText = fullText.slice(start, end).trim();
  if (!sentenceText) return null;

  const segIndices = collectSegIndicesForRange(start, end);
  segIndices.add(segIdx);

  return {
    text: sentenceText,
    start,
    end,
    segIndices,
    scope: 'sentence',
    key: `sent:${start}:${end}`,
    anchorEl: tokenEl
  };
}

function extractSelectionSpanForTranslation() {
  if (!hasActiveBox1TextSelection()) return null;
  const fullText = textOutputBox.value || '';
  let start = textOutputBox.selectionStart ?? 0;
  let end = textOutputBox.selectionEnd ?? 0;
  while (start < end && /\s/.test(fullText[start])) start++;
  while (end > start && /\s/.test(fullText[end - 1])) end--;

  const selectedText = fullText.slice(start, end).trim();
  if (!selectedText) return null;

  const segIndices = collectSegIndicesForRange(start, end);
  return {
    text: selectedText,
    start,
    end,
    segIndices,
    scope: 'selection',
    key: `sel:${start}:${end}`,
    anchorEl: null
  };
}

async function triggerHoverTranslationPopover(spanContext) {
  if (!isTranslateModeActive || !spanContext || !spanContext.text) return;

  clearTimeout(dictHoverHideTimer);
  activeTranslatedSegIndices = new Set(spanContext.segIndices || []);
  activeTranslatedSpanKey = spanContext.key;
  lastTranslatedContext = spanContext;
  syncBox1SelectionToBox2();

  const reqId = ++translateLookupRequestId;
  const pop = ensureDictionaryPopoverElement();
  const langMeta = DICT_TARGET_META[dictTargetLang] || DICT_TARGET_META.en;
  const scopeLabel = spanContext.scope === 'selection'
    ? langMeta.translateSelectionBadge
    : langMeta.translateSentenceBadge;
  const srcLangCode = String(currentLang || '').toUpperCase();

  const anchorRect = spanContext.anchorEl && document.body.contains(spanContext.anchorEl)
    ? spanContext.anchorEl.getBoundingClientRect()
    : getAnchorRectForSegIndices(activeTranslatedSegIndices, box1Wrapper);

  const previewText = spanContext.text.length > 180
    ? spanContext.text.slice(0, 180) + '…'
    : spanContext.text;

  pop.innerHTML = `
    <div class="dict-popover-header">
      <div>
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="font-bold text-sm">${escapeHtml(langMeta.translateTitle)}</span>
          <span class="dict-badge trans-badge-sky">${escapeHtml(scopeLabel)}</span>
          <span class="dict-badge">${escapeHtml(srcLangCode)} → ${escapeHtml(langMeta.code)}</span>
        </div>
      </div>
      <button type="button" class="dict-close-btn" aria-label="${escapeHtml(langMeta.closeLabel)}">✕</button>
    </div>
    <div class="trans-source-preview">${escapeHtml(previewText)}</div>
    <div class="text-xs text-slate-400 animate-pulse py-1">${escapeHtml(langMeta.translating)}</div>
  `;
  pop.querySelector('.dict-close-btn').addEventListener('click', hideDictionaryPopover);
  pop.classList.remove('hidden');
  positionDictionaryPopover(anchorRect);

  const result = await fetchHoverTranslation(currentLang, spanContext.text, dictTargetLang);
  if (reqId !== translateLookupRequestId || !isTranslateModeActive) return;

  const providerBadge = result && result.provider
    ? `<span class="dict-badge">${escapeHtml(result.provider)}</span>`
    : '';

  const bodyHtml = result && result.translation
    ? `<div class="trans-result-text">${escapeHtml(result.translation)}</div>`
    : `<div class="text-xs opacity-75 py-0.5">${escapeHtml(langMeta.translateFailed)}</div>`;

  pop.innerHTML = `
    <div class="dict-popover-header">
      <div>
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="font-bold text-sm">${escapeHtml(langMeta.translateTitle)}</span>
          <span class="dict-badge trans-badge-sky">${escapeHtml(scopeLabel)}</span>
          <span class="dict-badge">${escapeHtml(srcLangCode)} → ${escapeHtml(langMeta.code)}</span>
          ${providerBadge}
        </div>
      </div>
      <button type="button" class="dict-close-btn" aria-label="${escapeHtml(langMeta.closeLabel)}">✕</button>
    </div>
    <div class="trans-source-preview">${escapeHtml(previewText)}</div>
    ${bodyHtml}
  `;
  pop.querySelector('.dict-close-btn').addEventListener('click', hideDictionaryPopover);

  const updatedAnchorRect = spanContext.anchorEl && document.body.contains(spanContext.anchorEl)
    ? spanContext.anchorEl.getBoundingClientRect()
    : getAnchorRectForSegIndices(activeTranslatedSegIndices, box1Wrapper);
  positionDictionaryPopover(updatedAnchorRect);
}

function scheduleSelectionTranslation() {
  if (translateHoverMode !== 'on-unlocked') return;
  clearTimeout(translateSelectionDebounceTimer);

  if (!hasActiveBox1TextSelection()) {
    if (lastTranslatedContext && lastTranslatedContext.scope === 'selection') {
      hideDictionaryPopover();
    }
    return;
  }

  translateSelectionDebounceTimer = setTimeout(() => {
    if (translateHoverMode !== 'on-unlocked' || !hasActiveBox1TextSelection()) return;
    const selSpan = extractSelectionSpanForTranslation();
    if (!selSpan) return;
    const pop = document.getElementById('jotoba-dict-popover');
    const isSameVisible = pop && !pop.classList.contains('hidden') && activeTranslatedSpanKey === selSpan.key;
    if (!isSameVisible) {
      triggerHoverTranslationPopover(selSpan);
    }
  }, 180);
}

async function triggerTokenDictionaryLookup(tokenEl) {
  if (!tokenEl || !isInspectModeActive) return;

  const segIdx = Number(tokenEl.getAttribute('data-seg-idx'));
  const baseMeta = extractTokenElementMeta(tokenEl);
  if (!baseMeta || !baseMeta.surface.trim()) return;

  clearTimeout(dictHoverHideTimer);
  activeHoveredSegIdx = segIdx;
  lastInspectedTokenEl = tokenEl;
  syncBox1SelectionToBox2();

  const reqId = ++dictLookupRequestId;
  const pop = ensureDictionaryPopoverElement();
  const anchorRect = tokenEl.getBoundingClientRect();
  const langMeta = DICT_TARGET_META[dictTargetLang] || DICT_TARGET_META.en;

  pop.innerHTML = `
    <div class="dict-popover-header">
      <div>
        <div>
          <span class="dict-headword">${escapeHtml(baseMeta.surface)}</span>
        </div>
        <div class="dict-romaji">${escapeHtml(baseMeta.reading)}</div>
      </div>
      <button type="button" class="dict-close-btn" aria-label="${escapeHtml(langMeta.closeLabel)}">✕</button>
    </div>
    <div class="text-xs text-slate-400 animate-pulse py-1">${escapeHtml(langMeta.searching)}</div>
  `;
  pop.querySelector('.dict-close-btn').addEventListener('click', hideDictionaryPopover);
  pop.classList.remove('hidden');
  positionDictionaryPopover(anchorRect);

  const tokenMeta = {
    ...baseMeta,
    prevToken: getAdjacentBox1TokenMeta(tokenEl, -1),
    nextToken: getAdjacentBox1TokenMeta(tokenEl, 1)
  };
  const dictData = await buildLocalizedDictionaryData(tokenMeta);

  if (reqId !== dictLookupRequestId || !isInspectModeActive || !dictData) return;

  const badgesHtml = Array.isArray(dictData.badges)
    ? dictData.badges.filter(Boolean).map(b => `<span class="dict-badge">${escapeHtml(b)}</span>`).join('')
    : '';

  /* Option 3: Top Polarity / Tense Summary Banner */
  let grammarSummaryHtml = '';
  if (dictData.grammarSummary && dictData.grammarSummary.text) {
    const negClass = dictData.grammarSummary.isNegative ? ' is-negative' : '';
    grammarSummaryHtml = `<div class="dict-grammar-summary${negClass}">${escapeHtml(dictData.grammarSummary.text)}</div>`;
  }

  let sensesHtml = '';
  if (Array.isArray(dictData.senses) && dictData.senses.length > 0) {
    const items = dictData.senses.map((s) => {
      const posPrefix = s.pos ? `<span class="opacity-70 text-[11px]">(${escapeHtml(s.pos)})</span> ` : '';
      return `<li class="dict-sense-item">${posPrefix}${escapeHtml(s.gloss)}</li>`;
    }).join('');
    sensesHtml = `<ol class="dict-senses-list">${items}</ol>`;
  } else {
    sensesHtml = `<div class="text-xs opacity-75 py-0.5">${escapeHtml(langMeta.notFound)} ${escapeHtml(baseMeta.surface)}.</div>`;
  }

  let grammarBreakdownHtml = '';
  if (Array.isArray(dictData.grammarBreakdown) && dictData.grammarBreakdown.length > 0) {
    const rows = dictData.grammarBreakdown.map((g) => {
      const chipClass = g.kind === 'stem'
        ? 'dict-grammar-chip is-stem'
        : (g.kind === 'context' ? 'dict-grammar-chip is-context' : 'dict-grammar-chip');
      return `
        <div class="dict-grammar-row">
          <span class="${chipClass}">${escapeHtml(g.literal)}</span>
          <div class="text-[11px] leading-snug">
            <div class="font-medium">${escapeHtml(g.title)} ${g.meta ? `<span class="opacity-60">(${escapeHtml(g.meta)})</span>` : ''}</div>
            ${g.sub ? `<div class="opacity-70 text-[10px]">${escapeHtml(g.sub)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');
    grammarBreakdownHtml = `
      <div class="dict-grammar-section">
        <div class="dict-section-label">${escapeHtml(langMeta.breakdownLabel)}</div>
        ${rows}
      </div>
    `;
  }

  let breakdownHtml = '';
  if (Array.isArray(dictData.charBreakdown) && dictData.charBreakdown.length > 0) {
    const cards = dictData.charBreakdown.map((c) => `
      <div class="dict-kanji-card">
        <span class="dict-kanji-literal">${escapeHtml(c.literal)}</span>
        <div class="text-[11px] leading-snug">
          <div class="font-medium">${escapeHtml(c.title)} ${c.meta ? `<span class="opacity-60">(${escapeHtml(c.meta)})</span>` : ''}</div>
          ${c.sub ? `<div class="opacity-75">${escapeHtml(c.sub)}</div>` : ''}
        </div>
      </div>
    `).join('');
    breakdownHtml = `<div class="dict-kanji-section">${cards}</div>`;
  }

  pop.innerHTML = `
    <div class="dict-popover-header">
      <div>
        <div>
          <span class="dict-headword">${escapeHtml(dictData.headword || baseMeta.surface)}</span>
          ${dictData.reading ? `<span class="dict-reading">${escapeHtml(dictData.reading)}</span>` : ''}
        </div>
        <div class="dict-romaji">${escapeHtml(dictData.romanization || '')}</div>
        ${badgesHtml ? `<div>${badgesHtml}</div>` : ''}
      </div>
      <button type="button" class="dict-close-btn" aria-label="${escapeHtml(langMeta.closeLabel)}">✕</button>
    </div>
    ${grammarSummaryHtml}
    ${sensesHtml}
    ${grammarBreakdownHtml}
    ${breakdownHtml}
  `;
  pop.querySelector('.dict-close-btn').addEventListener('click', hideDictionaryPopover);
  positionDictionaryPopover(tokenEl.getBoundingClientRect());
}

function findBox1TokenAtPoint(clientX, clientY) {
  const tokens = furiganaBackdrop.querySelectorAll('.box1-token');
  for (const tokenEl of tokens) {
    const rects = tokenEl.getClientRects();
    for (const r of rects) {
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return tokenEl;
      }
    }
  }
  return null;
}

function initDictionaryAndCrossBoxHighlight() {
  if (isDictAndHighlightInitialized) return;
  isDictAndHighlightInitialized = true;

  ensureDictInspectBar();
  ensureDictionaryPopoverElement();
  setTranslateMode('off', false);
  setInspectMode(dictInspectMode, false);
  applyAppLanguageUI();

  const syncEvents = ['select', 'keyup', 'mouseup', 'touchend'];
  syncEvents.forEach((evt) => {
    textOutputBox.addEventListener(evt, () => {
      requestAnimationFrame(() => {
        syncBox1SelectionToBox2();
        if (translateHoverMode === 'on-unlocked') {
          scheduleSelectionTranslation();
        }
      });
    });
  });

  // As soon as anything is written in Box 1 (including IME composition), hide the popover
  ['input', 'compositionstart', 'compositionupdate'].forEach((evt) => {
    textOutputBox.addEventListener(evt, () => {
      hideDictionaryPopover();
    });
  });

  textOutputBox.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter') {
      hideDictionaryPopover();
    }
  });

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === textOutputBox) {
      syncBox1SelectionToBox2();
      if (translateHoverMode === 'on-unlocked') {
        scheduleSelectionTranslation();
      }
    }
  });

  if (box1Wrapper) {
    box1Wrapper.addEventListener('mousemove', (e) => {
      if (e.buttons !== 0) return;

      // Dictionary Mode Hover
      if (isInspectModeActive) {
        if (hasActiveBox1TextSelection()) return;

        const hitToken = findBox1TokenAtPoint(e.clientX, e.clientY);
        if (hitToken) {
          const hitIdx = Number(hitToken.getAttribute('data-seg-idx'));
          if (hitIdx !== activeHoveredSegIdx) {
            triggerTokenDictionaryLookup(hitToken);
          } else {
            clearTimeout(dictHoverHideTimer);
          }
        } else if (activeHoveredSegIdx !== null) {
          scheduleHideDictionaryPopover(180);
        }
        return;
      }

      // Translation Mode Hover (Scope B in unlocked: respect active selection; Scope A in locked)
      if (isTranslateModeActive) {
        if (translateHoverMode === 'on-unlocked' && hasActiveBox1TextSelection()) return;

        const hitToken = findBox1TokenAtPoint(e.clientX, e.clientY);
        if (hitToken) {
          const sentSpan = extractSentenceSpanForToken(hitToken);
          if (!sentSpan) return;

          if (activeTranslatedSpanKey === sentSpan.key) {
            clearTimeout(dictHoverHideTimer);
            return;
          }

          clearTimeout(dictHoverHideTimer);
          clearTimeout(translateHoverDebounceTimer);
          translateHoverDebounceTimer = setTimeout(() => {
            if (!isTranslateModeActive) return;
            if (translateHoverMode === 'on-unlocked' && hasActiveBox1TextSelection()) return;
            triggerHoverTranslationPopover(sentSpan);
          }, 220);
        } else if (activeTranslatedSpanKey !== null) {
          clearTimeout(translateHoverDebounceTimer);
          scheduleHideDictionaryPopover(180);
        }
      }
    });

    box1Wrapper.addEventListener('mouseleave', () => {
      clearTimeout(translateHoverDebounceTimer);
      if (isInspectModeActive && activeHoveredSegIdx !== null) {
        scheduleHideDictionaryPopover(180);
      } else if (isTranslateModeActive && activeTranslatedSpanKey !== null) {
        if (translateHoverMode === 'on-unlocked' && hasActiveBox1TextSelection()) return;
        scheduleHideDictionaryPopover(180);
      }
    });

    box1Wrapper.addEventListener('click', (e) => {
      // Dictionary Mode Click / Tap
      if (isInspectModeActive) {
        if (dictInspectMode === 'on-locked') {
          const hitToken = e.target.closest('.box1-token') || findBox1TokenAtPoint(e.clientX, e.clientY);
          if (hitToken) {
            e.preventDefault();
            e.stopPropagation();
            triggerTokenDictionaryLookup(hitToken);
          }
          return;
        }

        // ON + Unlocked: let Box 1 focus/open keyboard naturally while showing the popover for the tapped word
        if (hasActiveBox1TextSelection()) {
          hideDictionaryPopover();
          return;
        }

        const hitToken = findBox1TokenAtPoint(e.clientX, e.clientY);
        if (hitToken) {
          const hitIdx = Number(hitToken.getAttribute('data-seg-idx'));
          const pop = document.getElementById('jotoba-dict-popover');
          const isSameVisible = pop && !pop.classList.contains('hidden') && hitIdx === activeHoveredSegIdx;
          if (isSameVisible) {
            clearTimeout(dictHoverHideTimer);
            positionDictionaryPopover(hitToken.getBoundingClientRect());
          } else {
            triggerTokenDictionaryLookup(hitToken);
          }
        } else {
          hideDictionaryPopover();
        }
        return;
      }

      // Translation Mode Click / Tap
      if (isTranslateModeActive) {
        if (translateHoverMode === 'on-locked') {
          const hitToken = e.target.closest('.box1-token') || findBox1TokenAtPoint(e.clientX, e.clientY);
          if (hitToken) {
            e.preventDefault();
            e.stopPropagation();
            clearTimeout(translateHoverDebounceTimer);
            const sentSpan = extractSentenceSpanForToken(hitToken);
            if (sentSpan) triggerHoverTranslationPopover(sentSpan);
          }
          return;
        }

        // ON + Unlocked (Scope Option B): Selection first, sentence fallback on tap
        if (hasActiveBox1TextSelection()) {
          scheduleSelectionTranslation();
          return;
        }

        const hitToken = findBox1TokenAtPoint(e.clientX, e.clientY);
        if (hitToken) {
          clearTimeout(translateHoverDebounceTimer);
          const sentSpan = extractSentenceSpanForToken(hitToken);
          if (sentSpan) {
            const pop = document.getElementById('jotoba-dict-popover');
            const isSameVisible = pop && !pop.classList.contains('hidden') && activeTranslatedSpanKey === sentSpan.key;
            if (isSameVisible) {
              clearTimeout(dictHoverHideTimer);
              positionDictionaryPopover(hitToken.getBoundingClientRect());
            } else {
              triggerHoverTranslationPopover(sentSpan);
            }
          }
        } else {
          hideDictionaryPopover();
        }
      }
    });
  }

  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('jotoba-dict-popover');
    const dictBtn = document.getElementById('btn-inspect-dict');
    const transBtn = document.getElementById('btn-translate-hover');
    const menuWrapper = document.getElementById('app-lang-menu-wrapper');
    if (pop && !pop.classList.contains('hidden')) {
      if (
        !pop.contains(e.target) &&
        (!box1Wrapper || !box1Wrapper.contains(e.target)) &&
        (!dictBtn || !dictBtn.contains(e.target)) &&
        (!transBtn || !transBtn.contains(e.target)) &&
        (!menuWrapper || !menuWrapper.contains(e.target))
      ) {
        hideDictionaryPopover();
      }
    }
  });

  document.addEventListener('touchstart', (e) => {
    const pop = document.getElementById('jotoba-dict-popover');
    const dictBtn = document.getElementById('btn-inspect-dict');
    const transBtn = document.getElementById('btn-translate-hover');
    const menuWrapper = document.getElementById('app-lang-menu-wrapper');
    if (pop && !pop.classList.contains('hidden')) {
      if (
        !pop.contains(e.target) &&
        (!box1Wrapper || !box1Wrapper.contains(e.target)) &&
        (!dictBtn || !dictBtn.contains(e.target)) &&
        (!transBtn || !transBtn.contains(e.target)) &&
        (!menuWrapper || !menuWrapper.contains(e.target))
      ) {
        hideDictionaryPopover();
      }
    }
  }, { passive: true });
}

/* ==========================================================================
   Main Romanization Sync (Box 1 -> Box 2 + Aligned Segments Update)
   ========================================================================== */
async function updateRomanization(triggerSuggestions = false, forceSyncBox2 = false) {
  initDictionaryAndCrossBoxHighlight();
  ensureDictInspectBar();

  const text = textOutputBox.value;
  if (text !== lastKnownBox1Text) {
    lastKnownBox1Text = text;
    hideDictionaryPopover();
  }

  const conversionId = ++currentConversionId;
  charCount.textContent = formatCharCountText(text.length);

  if (!text) {
    furiganaBackdrop.innerHTML = '';
    clearAlignedSegmentsAndSuggestions();
    setBox2Content('', '', true);
    autoResizeBoxes();
    return;
  }

  if (currentLang === 'ja') {
    if (triggerSuggestions) {
      updateTypingSuggestions(text);
    }

    if (!text.trim()) {
      furiganaBackdrop.innerHTML = escapeHtml(text);
      alignedSegments = [];
      setBox2Content('', '', forceSyncBox2);
      autoResizeBoxes();
      return;
    }

    if (isKuroshiroReady && kuroshiroInstance && kuroshiroAnalyzer) {
      try {
        const tokens = await kuroshiroAnalyzer.parse(text);
        const furiganaHtml = await buildFuriganaHtmlFromTokens(tokens);
        const newSegments = await buildJapaneseAlignedSegments(tokens);

        if (conversionId !== currentConversionId || currentLang !== 'ja') return;

        alignedSegments = newSegments;
        furiganaBackdrop.innerHTML = furiganaHtml.endsWith('\n')
          ? furiganaHtml + '\u200b'
          : furiganaHtml;

        const segStrings = buildBox2SegmentedStrings(newSegments);
        setBox2Content(segStrings.plain, segStrings.html, forceSyncBox2);
        syncBox1SelectionToBox2();
        autoResizeBoxes();
        return;
      } catch (e) {
        console.warn('Kuroshiro conversion error, running kanjiapi.dev fallback:', e);
      }
    }

    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
    alignedSegments = buildFallbackJapaneseAlignedSegments(text);
    const initialSegStrings = buildBox2SegmentedStrings(alignedSegments);
    setBox2Content(initialSegStrings.plain, initialSegStrings.html, forceSyncBox2);
    syncBox1SelectionToBox2();
    autoResizeBoxes();

    await ensureKanjiReadingsLoaded(text);
    if (conversionId !== currentConversionId || currentLang !== 'ja') return;

    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
    alignedSegments = buildFallbackJapaneseAlignedSegments(text);
    const updatedSegStrings = buildBox2SegmentedStrings(alignedSegments);
    setBox2Content(updatedSegStrings.plain, updatedSegStrings.html, forceSyncBox2);
    syncBox1SelectionToBox2();
    autoResizeBoxes();
    return;
  }

  // Non-Japanese Languages (zh, ko, ru)
  if (triggerSuggestions && currentLang === 'zh') {
    updateTypingSuggestions(text);
  }

  if (!text.trim()) {
    furiganaBackdrop.innerHTML = escapeHtml(text);
    alignedSegments = [];
    setBox2Content('', '', forceSyncBox2);
    autoResizeBoxes();
    return;
  }

  if (conversionId !== currentConversionId) return;

  let built = null;
  if (currentLang === 'zh') {
    built = buildChineseAlignedSegmentsAndBackdrop(text);
  } else if (currentLang === 'ko') {
    built = buildKoreanAlignedSegmentsAndBackdrop(text);
  } else if (currentLang === 'ru') {
    built = buildRussianAlignedSegmentsAndBackdrop(text);
  }

  if (built) {
    alignedSegments = built.segments;
    furiganaBackdrop.innerHTML = built.backdropHtml;
    const segStrings = buildBox2SegmentedStrings(built.segments);
    setBox2Content(segStrings.plain, segStrings.html, forceSyncBox2);
    syncBox1SelectionToBox2();
    autoResizeBoxes();
  }
}
