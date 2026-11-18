/* ==========================================================================
   Shared Multi-Language Romanization, Writable Box 2 & Dictionary Coordinator
   Dispatches to: lang-ja.js, lang-zh.js, lang-ko.js, and lang-ru.js
   ========================================================================== */
let alignedSegments = [];
let imeSuggestRequestId = 0;
let isInspectModeActive = false;
let activeHoveredSegIdx = null;
let lastInspectedTokenEl = null;
let dictHoverHideTimer = null;
let dictLookupRequestId = 0;
let isDictAndHighlightInitialized = false;
let currentConversionId = 0;

/* Dictionary Target Language State ('en' | 'es' | 'pt') & Hybrid Cache */
const DICT_TARGET_LANGS = ['en', 'es', 'pt'];
const DICT_TARGET_META = {
  en: {
    code: 'EN',
    name: 'English',
    searching: 'Searching dictionary...',
    notFound: 'No exact entry found for'
  },
  es: {
    code: 'ES',
    name: 'Español',
    searching: 'Buscando en el diccionario...',
    notFound: 'No se encontró entrada exacta para'
  },
  pt: {
    code: 'PT',
    name: 'Português',
    searching: 'Pesquisando no dicionário...',
    notFound: 'Nenhuma entrada exata encontrada para'
  }
};

let dictTargetLang = (() => {
  try {
    const saved = localStorage.getItem('dictTargetLang');
    if (saved && DICT_TARGET_LANGS.includes(saved)) return saved;
  } catch (_) {}
  return 'en';
})();

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
  const rawBox2 = romanizedOutputBox.value;
  const backdrop = getBox2Backdrop();

  if (backdrop) {
    const html = formatBox2BackdropWithNumbers(rawBox2);
    backdrop.innerHTML = html.endsWith('\n') ? html + '\u200b' : html;
  }

  if (!rawBox2.trim()) {
    textOutputBox.value = '';
    furiganaBackdrop.innerHTML = '';
    charCount.textContent = '0 chars';
    clearAlignedSegmentsAndSuggestions();
    autoResizeBoxes();
    return;
  }

  const { prefixSrc, suffixSrc, middleRomaji } = matchUnchangedBox2Segments(rawBox2, alignedSegments);
  const convertedMiddle = convertBox2SubstringToBox1(middleRomaji, currentLang);

  const newBox1Text = prefixSrc + convertedMiddle + suffixSrc;
  textOutputBox.value = newBox1Text;
  charCount.textContent = `${newBox1Text.length} char${newBox1Text.length === 1 ? '' : 's'}`;

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
        charCount.textContent = `${nextBox1.length} char${nextBox1.length === 1 ? '' : 's'}`;
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
   Option 2 + UI Option B: Top Header EN/ES/PT Selector & Hybrid Translator
   ========================================================================== */
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
    `;
    document.head.appendChild(styleEl);
  }

  let btn = document.getElementById('btn-dict-lang');
  if (!btn) {
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (themeBtn && themeBtn.parentNode) {
      btn = document.createElement('button');
      btn.id = 'btn-dict-lang';
      btn.type = 'button';
      btn.className = 'px-2.5 py-1 rounded-full border border-slate-200 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition-all flex items-center gap-1 shrink-0 select-none';

      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const currIdx = DICT_TARGET_LANGS.indexOf(dictTargetLang);
        dictTargetLang = DICT_TARGET_LANGS[(currIdx + 1) % DICT_TARGET_LANGS.length];
        try {
          localStorage.setItem('dictTargetLang', dictTargetLang);
        } catch (_) {}

        updateDictLangHeaderButtonUI();

        const meta = DICT_TARGET_META[dictTargetLang] || DICT_TARGET_META.en;
        if (typeof showToast === 'function') {
          showToast(`Dictionary language: ${meta.name} (${meta.code})`);
        }

        // If a dictionary popover is currently open, immediately re-translate it in place
        const pop = document.getElementById('jotoba-dict-popover');
        if (pop && !pop.classList.contains('hidden') && lastInspectedTokenEl && document.body.contains(lastInspectedTokenEl)) {
          triggerTokenDictionaryLookup(lastInspectedTokenEl);
        }
      });

      themeBtn.parentNode.insertBefore(btn, themeBtn);
    }
  }

  updateDictLangHeaderButtonUI();
}

function updateDictLangHeaderButtonUI() {
  const btn = document.getElementById('btn-dict-lang');
  if (!btn) return;
  const meta = DICT_TARGET_META[dictTargetLang] || DICT_TARGET_META.en;
  btn.innerHTML = `<span>🌐</span><span>${meta.code}</span>`;
  btn.title = `Dictionary Language: ${meta.name} (Click to switch EN / ES / PT)`;
  btn.setAttribute('aria-label', `Dictionary Language: ${meta.name}`);
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

function localizePosTag(posStr, targetLang) {
  if (!posStr || targetLang === 'en') return posStr;
  const table = POS_LABEL_TRANSLATIONS[targetLang];
  if (!table) return posStr;
  const lower = posStr.trim().toLowerCase();
  return table[lower] || posStr;
}

function localizeBadgeLabel(badgeStr, targetLang) {
  if (!badgeStr || targetLang === 'en') return badgeStr;
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

/* Batched Post-Lookup Translator (EN -> ES / PT) for Specialized Glosses & Character Cards */
async function translateBatchEnToTarget(stringsArray, targetLang, timeoutMs = 2200) {
  if (!Array.isArray(stringsArray) || stringsArray.length === 0 || targetLang === 'en') {
    return stringsArray;
  }

  const joined = stringsArray.map(s => String(s || '').replace(/\r?\n/g, ' ')).join('\n');
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
    const splitLines = fullTrans.split('\n').map(s => s.trim());

    return stringsArray.map((orig, idx) => splitLines[idx] || orig);
  } catch (_) {
    return stringsArray;
  } finally {
    clearTimeout(timer);
  }
}

/* Option 2 Hybrid Coordinator: Combines Base Specialized Dict + Direct Target Dict + Batch Translation */
async function buildLocalizedDictionaryData(tokenMeta) {
  const { surface, basic, reading, pos, posDetail } = tokenMeta;
  const targetLang = dictTargetLang;
  const cacheKey = `${currentLang}|${targetLang}|${surface}|${basic}|${reading}|${pos}`;

  if (HYBRID_DICT_LANG_CACHE.has(cacheKey)) {
    return HYBRID_DICT_LANG_CACHE.get(cacheKey);
  }

  // 1. Fetch structural base dictionary entry (Jotoba / CC-CEDICT / Direct-CORS KO / OpenRussian)
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

  // 2. Prepare batch of English specialized senses & character breakdown titles for translation
  const baseSenses = Array.isArray(baseData.senses) ? baseData.senses : [];
  const baseBreakdowns = Array.isArray(baseData.charBreakdown) ? baseData.charBreakdown : [];

  const batchInputs = [
    ...baseSenses.map(s => s.gloss || ''),
    ...baseBreakdowns.map(c => c.title || '')
  ];

  const isJaGrammarToken = currentLang === 'ja' && typeof resolveLocalGrammarEntry === 'function'
    && Boolean(resolveLocalGrammarEntry(surface, basic, pos, posDetail));

  const queryTerm = (basic && basic !== '*') ? basic : surface;

  // 3. Run Direct Source -> Target (ES/PT) lookup + Jotoba Spanish (if JA+ES) + Batch EN->ES/PT in parallel
  const [translatedBatch, directGtx, jotobaEsSenses] = await Promise.all([
    batchInputs.length > 0 ? translateBatchEnToTarget(batchInputs, targetLang) : Promise.resolve([]),
    !isJaGrammarToken ? fetchDirectTargetGtxBilingual(currentLang, queryTerm, targetLang) : Promise.resolve(null),
    (currentLang === 'ja' && targetLang === 'es' && !isJaGrammarToken)
      ? fetchJotobaSpanishSenses(surface, basic, reading, pos)
      : Promise.resolve([])
  ]);

  const translatedSenses = baseSenses.map((s, idx) => ({
    pos: localizePosTag(s.pos || '', targetLang),
    gloss: translatedBatch[idx] || s.gloss
  }));

  const translatedBreakdowns = baseBreakdowns.map((c, idx) => ({
    ...c,
    title: translatedBatch[baseSenses.length + idx] || c.title
  }));

  // 4. Extract Direct Source -> Target (ES/PT) bilingual dictionary terms
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

  // 5. Merge senses (Prioritize grammar accuracy for JA particles, native Jotoba ES, translated specialized dict, and direct GTX)
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
    senses: mergedSenses.slice(0, 4),
    charBreakdown: translatedBreakdowns
  };

  HYBRID_DICT_LANG_CACHE.set(cacheKey, localizedResult);
  return localizedResult;
}

/* ==========================================================================
   Unified Multi-Language Dictionary Popover & Cross-Box Highlighting
   ========================================================================== */
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
      btn.title = 'Toggle Dictionary (Hover on Desktop / Tap on Mobile)';
      btn.innerHTML = `
        <span>📖</span>
        <span id="btn-inspect-dict-label">Dictionary: OFF</span>
      `;
      addSpaceBtn.parentNode.insertBefore(btn, addSpaceBtn);

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setInspectMode(!isInspectModeActive);
      });
    }
  }

  if (btn) {
    btn.classList.remove('hidden');
  }
}

function setInspectMode(enabled) {
  isInspectModeActive = Boolean(enabled);
  document.body.classList.toggle('inspect-mode-active', isInspectModeActive);

  const btn = document.getElementById('btn-inspect-dict');
  const label = document.getElementById('btn-inspect-dict-label');

  if (btn && label) {
    btn.classList.toggle('inspect-active', isInspectModeActive);
    label.textContent = isInspectModeActive ? 'Dictionary: ON' : 'Dictionary: OFF';
  }

  if (isInspectModeActive) {
    textOutputBox.blur();
    romanizedOutputBox.blur();
  } else {
    hideDictionaryPopover();
    syncBox1SelectionToBox2();
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
  activeHoveredSegIdx = null;
  lastInspectedTokenEl = null;
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

  if (isInspectModeActive && activeHoveredSegIdx !== null) {
    highlighted.add(Number(activeHoveredSegIdx));
  }

  if (document.activeElement === textOutputBox) {
    const selStart = textOutputBox.selectionStart ?? 0;
    const selEnd = textOutputBox.selectionEnd ?? 0;
    if (selEnd > selStart) {
      for (const seg of alignedSegments) {
        if (seg && seg.rom && !seg.isNewline && seg.start < selEnd && seg.end > selStart) {
          highlighted.add(seg.idx);
        }
      }
    }
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

async function triggerTokenDictionaryLookup(tokenEl) {
  // Strictly disabled on both Desktop and Mobile when Dictionary button is OFF
  if (!tokenEl || !isInspectModeActive) return;

  const segIdx = Number(tokenEl.getAttribute('data-seg-idx'));
  const surface = tokenEl.getAttribute('data-surface') || tokenEl.textContent || '';
  const basic = tokenEl.getAttribute('data-basic') || surface;
  const reading = tokenEl.getAttribute('data-reading') || '';
  const pos = tokenEl.getAttribute('data-pos') || '';
  const posDetail = tokenEl.getAttribute('data-pos-detail') || '';

  if (!surface.trim()) return;

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
          <span class="dict-headword">${escapeHtml(surface)}</span>
        </div>
        <div class="dict-romaji">${escapeHtml(reading)}</div>
      </div>
      <button type="button" class="dict-close-btn" aria-label="Close dictionary">✕</button>
    </div>
    <div class="text-xs text-slate-400 animate-pulse py-1">${escapeHtml(langMeta.searching)}</div>
  `;
  pop.querySelector('.dict-close-btn').addEventListener('click', hideDictionaryPopover);
  pop.classList.remove('hidden');
  positionDictionaryPopover(anchorRect);

  const tokenMeta = { surface, basic, reading, pos, posDetail };
  const dictData = await buildLocalizedDictionaryData(tokenMeta);

  if (reqId !== dictLookupRequestId || !isInspectModeActive || !dictData) return;

  const badgesHtml = Array.isArray(dictData.badges)
    ? dictData.badges.filter(Boolean).map(b => `<span class="dict-badge">${escapeHtml(b)}</span>`).join('')
    : '';

  let sensesHtml = '';
  if (Array.isArray(dictData.senses) && dictData.senses.length > 0) {
    const items = dictData.senses.map((s) => {
      const posPrefix = s.pos ? `<span class="opacity-70 text-[11px]">(${escapeHtml(s.pos)})</span> ` : '';
      return `<li class="dict-sense-item">${posPrefix}${escapeHtml(s.gloss)}</li>`;
    }).join('');
    sensesHtml = `<ol class="dict-senses-list">${items}</ol>`;
  } else {
    sensesHtml = `<div class="text-xs opacity-75 py-0.5">${escapeHtml(langMeta.notFound)} ${escapeHtml(surface)}.</div>`;
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
          <span class="dict-headword">${escapeHtml(dictData.headword || surface)}</span>
          ${dictData.reading ? `<span class="dict-reading">${escapeHtml(dictData.reading)}</span>` : ''}
        </div>
        <div class="dict-romaji">${escapeHtml(dictData.romanization || '')}</div>
        ${badgesHtml ? `<div>${badgesHtml}</div>` : ''}
      </div>
      <button type="button" class="dict-close-btn" aria-label="Close dictionary">✕</button>
    </div>
    ${sensesHtml}
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

  const syncEvents = ['select', 'keyup', 'mouseup', 'touchend'];
  syncEvents.forEach((evt) => {
    textOutputBox.addEventListener(evt, () => {
      requestAnimationFrame(syncBox1SelectionToBox2);
    });
  });

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === textOutputBox) {
      syncBox1SelectionToBox2();
    }
  });

  if (box1Wrapper) {
    box1Wrapper.addEventListener('mousemove', (e) => {
      if (!isInspectModeActive) return;
      if (e.buttons !== 0) return;

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
    });

    box1Wrapper.addEventListener('mouseleave', () => {
      if (isInspectModeActive && activeHoveredSegIdx !== null) {
        scheduleHideDictionaryPopover(180);
      }
    });

    box1Wrapper.addEventListener('click', (e) => {
      if (!isInspectModeActive) return;
      const hitToken = e.target.closest('.box1-token') || findBox1TokenAtPoint(e.clientX, e.clientY);
      if (hitToken) {
        e.preventDefault();
        e.stopPropagation();
        triggerTokenDictionaryLookup(hitToken);
      }
    });
  }

  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('jotoba-dict-popover');
    const dictBtn = document.getElementById('btn-inspect-dict');
    const langBtn = document.getElementById('btn-dict-lang');
    if (pop && !pop.classList.contains('hidden')) {
      if (
        !pop.contains(e.target) &&
        (!box1Wrapper || !box1Wrapper.contains(e.target)) &&
        (!dictBtn || !dictBtn.contains(e.target)) &&
        (!langBtn || !langBtn.contains(e.target))
      ) {
        hideDictionaryPopover();
      }
    }
  });

  document.addEventListener('touchstart', (e) => {
    const pop = document.getElementById('jotoba-dict-popover');
    const dictBtn = document.getElementById('btn-inspect-dict');
    const langBtn = document.getElementById('btn-dict-lang');
    if (pop && !pop.classList.contains('hidden')) {
      if (
        !pop.contains(e.target) &&
        (!box1Wrapper || !box1Wrapper.contains(e.target)) &&
        (!dictBtn || !dictBtn.contains(e.target)) &&
        (!langBtn || !langBtn.contains(e.target))
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
  const conversionId = ++currentConversionId;
  charCount.textContent = `${text.length} char${text.length === 1 ? '' : 's'}`;

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
