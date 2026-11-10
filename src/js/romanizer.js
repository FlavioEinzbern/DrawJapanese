/* ==========================================================================
   Language Engine & Romanization Handlers (Kuroshiro + Kuromoji + kanjiapi.dev)
   ========================================================================== */
let kuroshiroInstance = null;
let isKuroshiroReady = false;

function katakanaToHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function kanaToRomajiString(str) {
  let res = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] === 'っ' || str[i] === 'ッ') {
      if (i + 1 < str.length) {
        const nextTwo = str.substr(i + 1, 2);
        const nextOne = str[i + 1];
        const nextRomaji = KANA_MAP[nextTwo] || KANA_MAP[nextOne] || '';
        if (nextRomaji) {
          res += nextRomaji[0];
          i++;
          continue;
        }
      }
    }
    const twoChar = str.substr(i, 2);
    if (KANA_MAP[twoChar]) {
      res += KANA_MAP[twoChar];
      i += 2;
      continue;
    }
    if (KANA_MAP[str[i]]) {
      res += KANA_MAP[str[i]];
      i++;
      continue;
    }
    res += str[i];
    i++;
  }
  return res;
}

const KANJI_API_CACHE = {};
const KANJI_REGEX = /[\u4E00-\u9FAF\u3400-\u4DBF]/;

async function fetchKanjiApiData(char) {
  if (KANJI_API_CACHE[char]) return KANJI_API_CACHE[char];
  try {
    const res = await fetch(`https://kanjiapi.dev/v1/kanji/${encodeURIComponent(char)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const kunList = (data.kun_readings || []).map(r => r.replace(/^-|-$/g, ''));
    const onList = (data.on_readings || []).map(r => katakanaToHiragana(r.replace(/^-|-$/g, '')));

    const okuriRules = [];
    let standaloneKun = null;

    for (const kun of kunList) {
      if (kun.includes('.')) {
        const [stem, okuri] = kun.split('.');
        if (stem && okuri) {
          okuriRules.push({ stem, okuri });
        }
      } else if (!standaloneKun && kun) {
        standaloneKun = kun;
      }
    }

    const primaryKana = standaloneKun
      || onList[0]
      || (okuriRules[0] ? okuriRules[0].stem : '')
      || (data.name_readings && data.name_readings[0])
      || '';

    const entry = {
      kana: primaryKana,
      romaji: kanaToRomajiString(primaryKana),
      onKana: onList[0] || primaryKana,
      onRomaji: kanaToRomajiString(onList[0] || primaryKana),
      okuriRules
    };

    KANJI_API_CACHE[char] = entry;
    return entry;
  } catch (e) {
    console.warn(`kanjiapi.dev lookup failed for ${char}:`, e.message);
    return null;
  }
}

async function ensureKanjiReadingsLoaded(str) {
  const missing = [];
  for (const ch of str) {
    if (KANJI_REGEX.test(ch) && !KANJI_API_CACHE[ch]) {
      missing.push(ch);
    }
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    await Promise.all(unique.map(ch => fetchKanjiApiData(ch)));
  }
}

/* Fix A: Repair Kuromoji's path.join() URLs & normalize .dat.gz streams */
let isDictLoaderPatched = false;
function ensureGzippedDictLoader() {
  if (isDictLoaderPatched) return;
  isDictLoaderPatched = true;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string') {
      url = url.replace(/^(https?:)\/(?!\/)/i, '$1//');
    }
    this._kuromojiUrl = typeof url === 'string' && url.endsWith('.dat.gz') ? url : null;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (!this._kuromojiUrl || typeof CompressionStream === 'undefined') {
      return origSend.apply(this, args);
    }

    const xhr = this;
    fetch(this._kuromojiUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

        if (!isGzip) {
          const cs = new CompressionStream('gzip');
          const writer = cs.writable.getWriter();
          writer.write(bytes);
          writer.close();
          buf = await new Response(cs.readable).arrayBuffer();
        }

        Object.defineProperty(xhr, 'status', { value: 200, configurable: true });
        Object.defineProperty(xhr, 'response', { value: buf, configurable: true });
        if (typeof xhr.onload === 'function') xhr.onload();
      })
      .catch((err) => {
        if (typeof xhr.onerror === 'function') xhr.onerror(err);
      });
  };
}

async function initKuroshiro() {
  ensureGzippedDictLoader();

  const KuroshiroClass = typeof Kuroshiro !== 'undefined' ? (Kuroshiro.default || Kuroshiro) : null;
  const KuromojiAnalyzerClass = typeof KuromojiAnalyzer !== 'undefined' ? (KuromojiAnalyzer.default || KuromojiAnalyzer) : null;

  if (typeof KuroshiroClass !== 'function' || typeof KuromojiAnalyzerClass !== 'function') {
    setEngineStatus('ready-fallback', 'Ready (kanjiapi.dev Mode)');
    return;
  }

  const cdnDictPaths = [
    "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/",
    "https://unpkg.com/kuromoji@0.1.2/dict/",
    "https://cdn.jsdelivr.net/npm/kuromoji-fix-dict@0.1.2/dict/"
  ];

  for (const dictPath of cdnDictPaths) {
    try {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Dictionary load timeout')), 15000)
      );

      const loadPromise = (async () => {
        const ks = new KuroshiroClass();
        const analyzer = new KuromojiAnalyzerClass({ dictPath });
        await ks.init(analyzer);
        return ks;
      })();

      kuroshiroInstance = await Promise.race([loadPromise, timeoutPromise]);
      isKuroshiroReady = true;
      setEngineStatus('ready', 'Kuroshiro + Kuromoji Ready');
      updateRomanization();
      return;
    } catch (e) {
      console.warn(`Kuromoji failed at ${dictPath}:`, e.message);
    }
  }

  setEngineStatus('ready-fallback', 'Ready (kanjiapi.dev Mode)');
  updateRomanization();
}

function setEngineStatus(type, msg) {
  statusText.textContent = msg;
  statusBadge.title = msg;
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

function escapeHtml(str) {
  return str
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

function resolveFallbackKanjiAt(str, i) {
  const ch = str[i];
  const rest = str.slice(i + 1);
  const apiEntry = KANJI_API_CACHE[ch];

  if (apiEntry && apiEntry.okuriRules) {
    for (const rule of apiEntry.okuriRules) {
      if (rest.startsWith(rule.okuri)) {
        return {
          kana: rule.stem,
          romaji: kanaToRomajiString(rule.stem),
          isOkuriStem: true
        };
      }
    }
  }

  if (KANJI_FALLBACK[ch]) {
    return {
      kana: KANJI_FALLBACK[ch].kana,
      romaji: KANJI_FALLBACK[ch].romaji,
      isOkuriStem: false
    };
  }

  if (apiEntry && apiEntry.kana) {
    const adjKanji = (i > 0 && KANJI_REGEX.test(str[i - 1])) || (i + 1 < str.length && KANJI_REGEX.test(str[i + 1]));
    return {
      kana: adjKanji ? apiEntry.onKana : apiEntry.kana,
      romaji: adjKanji ? apiEntry.onRomaji : apiEntry.romaji,
      isOkuriStem: false
    };
  }

  return null;
}

function fallbackJapaneseRomanize(str) {
  let res = '';
  let i = 0;
  while (i < str.length) {
    let compoundFound = false;
    for (let len = 4; len >= 2; len--) {
      const sub = str.substr(i, len);
      if (KANJI_FALLBACK[sub]) {
        res += (res && !res.endsWith(' ') ? ' ' : '') + KANJI_FALLBACK[sub].romaji + ' ';
        i += len;
        compoundFound = true;
        break;
      }
    }
    if (compoundFound) continue;

    const kanjiMatch = resolveFallbackKanjiAt(str, i);
    if (kanjiMatch) {
      if (kanjiMatch.isOkuriStem) {
        res += (res && !res.endsWith(' ') ? ' ' : '') + kanjiMatch.romaji;
      } else {
        res += (res && !res.endsWith(' ') ? ' ' : '') + kanjiMatch.romaji + ' ';
      }
      i++;
      continue;
    }

    if (str[i] === 'っ' || str[i] === 'ッ') {
      if (i + 1 < str.length) {
        const nextTwo = str.substr(i + 1, 2);
        const nextOne = str[i + 1];
        const nextRomaji = KANA_MAP[nextTwo] || KANA_MAP[nextOne] || '';
        if (nextRomaji) {
          res += nextRomaji[0];
          i++;
          continue;
        }
      }
    }

    const twoChar = str.substr(i, 2);
    if (KANA_MAP[twoChar]) {
      res += KANA_MAP[twoChar];
      i += 2;
      continue;
    }

    if (KANA_MAP[str[i]]) {
      res += KANA_MAP[str[i]];
      i++;
      continue;
    }

    res += str[i];
    i++;
  }
  return res.replace(/\s+/g, ' ').trim();
}

function fallbackJapaneseFuriganaHtml(str) {
  let html = '';
  let i = 0;
  while (i < str.length) {
    let compoundFound = false;
    for (let len = 4; len >= 2; len--) {
      const sub = str.substr(i, len);
      if (KANJI_FALLBACK[sub]) {
        html += `<ruby>${escapeHtml(sub)}<rt>${KANJI_FALLBACK[sub].kana}</rt></ruby>`;
        i += len;
        compoundFound = true;
        break;
      }
    }
    if (compoundFound) continue;

    const kanjiMatch = resolveFallbackKanjiAt(str, i);
    if (kanjiMatch && kanjiMatch.kana) {
      html += `<ruby>${escapeHtml(str[i])}<rt>${kanjiMatch.kana}</rt></ruby>`;
      i++;
      continue;
    }

    html += escapeHtml(str[i]);
    i++;
  }
  return html.endsWith('\n') ? html + '\u200b' : html;
}

/* ==========================================================================
   Korean Hangul & Standalone Jamo Phonological Processor
   ========================================================================== */
function neutralizeCoda(jong) {
  if (!jong) return '';
  if (['ㄱ','ㄲ','ㅋ','ㄳ','ㄺ'].includes(jong)) return 'ㄱ';
  if (['ㄴ','ㄵ','ㄶ'].includes(jong)) return 'ㄴ';
  if (['ㄷ','ㅅ','ㅆ','ㅈ','ㅊ','ㅌ','ㅎ'].includes(jong)) return 'ㄷ';
  if (['ㄹ','ㄼ','ㄽ','ㄾ','ㅀ'].includes(jong)) return 'ㄹ';
  if (['ㅁ','ㄻ'].includes(jong)) return 'ㅁ';
  if (['ㅂ','ㅍ','ㄿ','ㅄ'].includes(jong)) return 'ㅂ';
  if (jong === 'ㅇ') return 'ㅇ';
  return jong;
}

function romanizeKorean(str) {
  const tokens = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const syl = code - 0xAC00;
      const choIdx = Math.floor(syl / (21 * 28));
      const jungIdx = Math.floor((syl % (21 * 28)) / 28);
      const jongIdx = syl % 28;
      tokens.push({
        isSyl: true,
        cho: CHO_JAMO[choIdx],
        jung: JUNG_JAMO[jungIdx],
        jong: JONG_JAMO[jongIdx]
      });
    } else {
      tokens.push({
        isSyl: false,
        char: str[i]
      });
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const curr = tokens[i];
    if (!curr.isSyl) continue;

    const next = (i + 1 < tokens.length && tokens[i + 1].isSyl) ? tokens[i + 1] : null;
    if (!next || !curr.jong) {
      curr.jong = neutralizeCoda(curr.jong);
      continue;
    }

    // Rule A: Palatalization (구개음화)
    if (next.cho === 'ㅇ' && (next.jung === 'ㅣ' || next.jung === 'ㅕ')) {
      if (curr.jong === 'ㄷ') { curr.jong = ''; next.cho = 'ㅈ'; continue; }
      if (curr.jong === 'ㅌ') { curr.jong = ''; next.cho = 'ㅊ'; continue; }
      if (curr.jong === 'ㄾ') { curr.jong = 'ㄹ'; next.cho = 'ㅊ'; continue; }
    }
    if (curr.jong === 'ㄷ' && next.cho === 'ㅎ' && next.jung === 'ㅣ') {
      curr.jong = '';
      next.cho = 'ㅊ';
      continue;
    }

    // Rule B: Liaison / Resyllabification before vowel ('ㅇ')
    if (next.cho === 'ㅇ') {
      if (DOUBLE_JONG_SPLIT[curr.jong]) {
        const [rem, moved] = DOUBLE_JONG_SPLIT[curr.jong];
        curr.jong = rem;
        next.cho = moved;
      } else if (curr.jong === 'ㅎ') {
        curr.jong = '';
      } else if (curr.jong !== 'ㅇ') {
        next.cho = curr.jong;
        curr.jong = '';
      }
      continue;
    }

    // Rule C: Aspiration / 'ㅎ' Coalescence (격음화)
    const ASPIRATION_TARGET = { 'ㄱ': 'ㅋ', 'ㄷ': 'ㅌ', 'ㅂ': 'ㅍ', 'ㅈ': 'ㅊ' };
    if (['ㅎ', 'ㄶ', 'ㅀ'].includes(curr.jong) && ASPIRATION_TARGET[next.cho]) {
      next.cho = ASPIRATION_TARGET[next.cho];
      curr.jong = curr.jong === 'ㄶ' ? 'ㄴ' : (curr.jong === 'ㅀ' ? 'ㄹ' : '');
    } else if (['ㅎ', 'ㄶ', 'ㅀ'].includes(curr.jong) && next.cho === 'ㅅ') {
      next.cho = 'ㅆ';
      curr.jong = curr.jong === 'ㄶ' ? 'ㄴ' : (curr.jong === 'ㅀ' ? 'ㄹ' : '');
    } else if (['ㅎ', 'ㄶ', 'ㅀ'].includes(curr.jong) && next.cho === 'ㄴ') {
      curr.jong = curr.jong === 'ㄶ' ? 'ㄴ' : (curr.jong === 'ㅀ' ? 'ㄹ' : 'ㄴ');
    } else if (next.cho === 'ㅎ') {
      const normJong = neutralizeCoda(curr.jong);
      if (['ㄷ', 'ㅈ', 'ㅊ', 'ㅌ'].includes(curr.jong)) {
        curr.jong = '';
        next.cho = curr.jong === 'ㄷ' || curr.jong === 'ㅌ' ? 'ㅌ' : 'ㅊ';
        continue;
      } else if (normJong === 'ㄱ' || normJong === 'ㅂ') {
        curr.jong = normJong;
      }
    }

    curr.jong = neutralizeCoda(curr.jong);

    // Rule D: Nasalization of 'ㄹ' after non-'ㄹ' consonants
    if (next.cho === 'ㄹ' && ['ㄱ', 'ㄷ', 'ㅂ', 'ㅁ', 'ㅇ'].includes(curr.jong)) {
      next.cho = 'ㄴ';
    }

    // Rule E: Obstruent Nasalization before 'ㄴ' or 'ㅁ'
    if (next.cho === 'ㄴ' || next.cho === 'ㅁ') {
      if (curr.jong === 'ㄱ') curr.jong = 'ㅇ';
      else if (curr.jong === 'ㄷ') curr.jong = 'ㄴ';
      else if (curr.jong === 'ㅂ') curr.jong = 'ㅁ';
    }

    // Rule F: Liquidization of 'ㄴ'+'ㄹ' or 'ㄹ'+'ㄴ' -> 'ㄹ'+'ㄹ'
    if ((curr.jong === 'ㄴ' && next.cho === 'ㄹ') || (curr.jong === 'ㄹ' && next.cho === 'ㄴ')) {
      curr.jong = 'ㄹ';
      next.cho = 'ㄹ';
    }
  }

  let result = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.isSyl) {
      result += STANDALONE_JAMO_MAP[tok.char] !== undefined ? STANDALONE_JAMO_MAP[tok.char] : tok.char;
      continue;
    }

    const prev = (i > 0 && tokens[i - 1].isSyl) ? tokens[i - 1] : null;
    const choRom = (tok.cho === 'ㄹ' && prev && prev.jong === 'ㄹ')
      ? 'l'
      : (CHO_RR[tok.cho] ?? '');
    const jungRom = JUNG_RR[tok.jung] ?? '';
    const jongRom = JONG_RR[tok.jong] ?? '';

    result += choRom + jungRom + jongRom;
  }

  return result;
}

/* ==========================================================================
   Russian & Chinese Transliterators
   ========================================================================== */
function romanizeRussian(str) {
  let res = '';
  for (const ch of str) {
    res += CYRILLIC_MAP[ch] !== undefined ? CYRILLIC_MAP[ch] : ch;
  }
  return res;
}

function romanizeChinese(str) {
  if (typeof pinyinPro !== 'undefined' && pinyinPro.pinyin) {
    return pinyinPro.pinyin(str, { toneType: 'symbol' });
  }
  return str;
}

/* ==========================================================================
   === CHECKPOINT 3 & 4 (JS): Single-Source-of-Truth Furigana + Romaji Sync ===
   ========================================================================== */
let currentConversionId = 0;

async function updateRomanization() {
  const text = textOutputBox.value;
  const conversionId = ++currentConversionId;
  charCount.textContent = `${text.length} char${text.length === 1 ? '' : 's'}`;

  if (!text) {
    furiganaBackdrop.innerHTML = '';
    romanizedOutputBox.value = '';
    autoResizeBoxes();
    return;
  }

  if (currentLang === 'ja') {
    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
    autoResizeBoxes();

    if (!text.trim()) {
      romanizedOutputBox.value = '';
      autoResizeBoxes();
      return;
    }

    if (isKuroshiroReady && kuroshiroInstance) {
      try {
        const safeText = escapeHtml(text);
        const [furiganaHtml, romaji] = await Promise.all([
          kuroshiroInstance.convert(safeText, {
            to: 'hiragana',
            mode: 'furigana'
          }),
          kuroshiroInstance.convert(text, {
            to: 'romaji',
            mode: 'spaced',
            romajiSystem: 'hepburn'
          })
        ]);

        if (conversionId !== currentConversionId || currentLang !== 'ja') return;

        furiganaBackdrop.innerHTML = furiganaHtml.endsWith('\n')
          ? furiganaHtml + '\u200b'
          : furiganaHtml;
        romanizedOutputBox.value = romaji;
        autoResizeBoxes();
        return;
      } catch (e) {
        console.warn("Kuroshiro conversion error, running kanjiapi.dev fallback:", e);
      }
    }

    romanizedOutputBox.value = fallbackJapaneseRomanize(text);
    autoResizeBoxes();

    await ensureKanjiReadingsLoaded(text);
    if (conversionId !== currentConversionId || currentLang !== 'ja') return;

    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
    romanizedOutputBox.value = fallbackJapaneseRomanize(text);
    autoResizeBoxes();
  } else {
    furiganaBackdrop.innerHTML = '';
    if (!text.trim()) {
      romanizedOutputBox.value = '';
      autoResizeBoxes();
      return;
    }
    if (currentLang === 'zh') {
      romanizedOutputBox.value = romanizeChinese(text);
    } else if (currentLang === 'ko') {
      romanizedOutputBox.value = romanizeKorean(text);
    } else if (currentLang === 'ru') {
      romanizedOutputBox.value = romanizeRussian(text);
    }
    autoResizeBoxes();
  }
}