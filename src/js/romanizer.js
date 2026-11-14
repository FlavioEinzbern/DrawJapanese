/* ==========================================================================
   Language Engine & Romanization Handlers (Kuroshiro + Kuromoji + kanjiapi.dev)
   ========================================================================== */
let kuroshiroInstance = null;
let kuroshiroAnalyzer = null;
let isKuroshiroReady = false;
let alignedSegments = [];
let imeSuggestRequestId = 0;

/* In-memory Reading (Hiragana) -> Ranked Kanji Surface Forms extracted from Kuromoji */
const KUROMOJI_READING_INDEX = new Map();
let isKuromojiIndexBuilt = false;

function katakanaToHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function hiraganaToKatakana(str) {
  return str.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
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

/* Repair Kuromoji's path.join() URLs & normalize .dat.gz streams */
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

/*
 * Build a non-blocking Hiragana Reading -> Ranked Kanji Words index
 * directly from Kuromoji's already-loaded in-memory IPADIC dictionary (~160k words).
 */
function buildKuromojiReadingIndex(analyzer) {
  if (isKuromojiIndexBuilt || !analyzer || !analyzer._analyzer) return;
  const tokenizer = analyzer._analyzer;
  const tid = tokenizer.token_info_dictionary;
  if (!tid || !tid.target_map || typeof tid.getFeatures !== 'function') return;

  isKuromojiIndexBuilt = true;
  const trieIds = Object.keys(tid.target_map);
  const total = trieIds.length;
  let cursor = 0;
  const CHUNK_SIZE = 6000;

  function processChunk() {
    const limit = Math.min(cursor + CHUNK_SIZE, total);
    for (; cursor < limit; cursor++) {
      const tokenInfoIds = tid.target_map[trieIds[cursor]];
      if (!tokenInfoIds) continue;

      for (let j = 0; j < tokenInfoIds.length; j++) {
        const infoId = tokenInfoIds[j];
        const featStr = tid.getFeatures(String(infoId));
        if (!featStr) continue;

        const parts = featStr.split(',');
        const surface = parts[0];
        const pos = parts[1];
        const readingKata = parts[8];

        if (!surface || !readingKata || readingKata === '*' || pos === '記号') continue;
        // Index entries that contain Kanji or useful vocabulary
        if (!KANJI_REGEX.test(surface) && surface.length < 2) continue;

        const hira = katakanaToHiragana(readingKata);
        if (!hira || !/^[\u3041-\u3096ー]+$/.test(hira)) continue;

        const cost = (tid.dictionary && typeof tid.dictionary.getShort === 'function')
          ? tid.dictionary.getShort(infoId + 4)
          : 5000;

        let list = KUROMOJI_READING_INDEX.get(hira);
        if (!list) {
          list = [];
          KUROMOJI_READING_INDEX.set(hira, list);
        }

        const existing = list.find(item => item.surf === surface);
        if (existing) {
          if (cost < existing.cost) existing.cost = cost;
        } else {
          list.push({ surf: surface, cost });
          list.sort((a, b) => a.cost - b.cost);
          if (list.length > 8) list.pop();
        }
      }
    }

    if (cursor < total) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(processChunk, { timeout: 100 });
      } else {
        setTimeout(processChunk, 8);
      }
    }
  }

  processChunk();
}

const PRECEDING_NUM_SURFACE_REGEX = /[0-9０-９零〇一二两三四五六七八九十百千万億亿]$/;
const CLAUSE_BREAK_END_REGEX = /[\s\u3000、。，．・：；！？「『（［｛〈《【〔…‥〜～.,!?;:'"(\[{/\\]$/;

function mergeIrregularCounterTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return tokens;
  const result = [];
  let i = 0;

  while (i < tokens.length) {
    const prevToken = result.length > 0 ? result[result.length - 1] : null;
    const isPrecededByNumber = prevToken && (
      prevToken.pos_detail_1 === '数' ||
      PRECEDING_NUM_SURFACE_REGEX.test(prevToken.surface_form || '')
    );

    let matchedLen = 0;
    let matchedSpec = null;
    let combinedSurface = '';

    if (!isPrecededByNumber) {
      const maxSpan = Math.min(4, tokens.length - i);
      for (let len = maxSpan; len >= 1; len--) {
        let surf = '';
        for (let k = 0; k < len; k++) {
          surf += tokens[i + k].surface_form || '';
        }
        const spec = IRREGULAR_COUNTER_COMPOUNDS[surf];
        if (spec) {
          const nextToken = (i + len < tokens.length) ? tokens[i + len] : null;
          const nextSurf = nextToken ? (nextToken.surface_form || '') : '';
          if (spec.disallowNext && spec.disallowNext.test(nextSurf)) {
            continue;
          }
          matchedLen = len;
          matchedSpec = spec;
          combinedSurface = surf;
          break;
        }
      }
    }

    if (matchedSpec && matchedLen > 0) {
      result.push({
        ...tokens[i],
        surface_form: combinedSurface,
        pos: '名詞',
        pos_detail_1: '一般',
        pos_detail_2: '*',
        pos_detail_3: '*',
        basic_form: combinedSurface,
        reading: matchedSpec.reading,
        pronunciation: matchedSpec.pronunciation
      });
      i += matchedLen;
    } else {
      result.push(tokens[i]);
      i++;
    }
  }

  return result;
}

function hasPrecedingWordForParticle(tokens, index) {
  if (index <= 0) return false;
  const prev = tokens[index - 1];
  if (!prev || prev._wasDemotedParticle) return false;

  const prevSurf = prev.surface_form || '';
  if (!prevSurf || !prevSurf.trim()) return false;
  if (CLAUSE_BREAK_END_REGEX.test(prevSurf)) return false;

  if (prev.pos === '記号') {
    if (/^[」』）］｝〉》】〕"')\]}]+$/.test(prevSurf)) {
      return index >= 2 && hasPrecedingWordForParticle(tokens, index - 1);
    }
    return false;
  }

  return true;
}

function applyParticleGrammarRules(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return tokens;
  const result = tokens.map(t => ({ ...t }));

  for (let i = 0; i < result.length; i++) {
    const t = result[i];
    const surf = t.surface_form || '';

    if (surf === 'は' && (t.pos === '助詞' || t.pronunciation === 'ワ')) {
      if (hasPrecedingWordForParticle(result, i)) {
        t.reading = 'ハ';
        t.pronunciation = 'ワ';
        t._isParticleWa = true;
      } else {
        t.pos = '名詞';
        t.pos_detail_1 = '一般';
        t.reading = 'ハ';
        t.pronunciation = 'ハ';
        t._isParticleWa = false;
        t._wasDemotedParticle = true;
      }
    } else if (surf === 'へ' && (t.pos === '助詞' || t.pronunciation === 'エ')) {
      if (hasPrecedingWordForParticle(result, i)) {
        t.reading = 'ヘ';
        t.pronunciation = 'エ';
        t._isParticleE = true;
      } else {
        t.pos = '名詞';
        t.pos_detail_1 = '一般';
        t.reading = 'ヘ';
        t.pronunciation = 'ヘ';
        t._isParticleE = false;
        t._wasDemotedParticle = true;
      }
    } else if (
      surf.length > 1 &&
      surf.endsWith('は') &&
      (t.reading || '').endsWith('ハ') &&
      (t.pronunciation || '').endsWith('ワ')
    ) {
      t._hasTrailingWa = true;
    }
  }

  return result;
}

let preParsedTokensOverride = null;

function patchKuromojiAnalyzer(analyzer) {
  if (!analyzer || typeof analyzer.parse !== 'function' || analyzer._customRulesPatched) return;
  const origParse = analyzer.parse.bind(analyzer);
  analyzer.parse = async function (str) {
    if (preParsedTokensOverride) {
      const override = preParsedTokensOverride;
      preParsedTokensOverride = null;
      return override;
    }
    const rawTokens = await origParse(str);
    const mergedTokens = mergeIrregularCounterTokens(rawTokens);
    return applyParticleGrammarRules(mergedTokens);
  };
  analyzer._customRulesPatched = true;
}

async function convertTokensWithKuroshiro(tokens, options) {
  if (!tokens || tokens.length === 0) return '';
  const segmentStr = tokens.map(t => t.surface_form || '').join('');
  if (!segmentStr) return '';
  preParsedTokensOverride = tokens.map(t => ({ ...t }));
  return await kuroshiroInstance.convert(segmentStr, options);
}

async function buildFuriganaHtmlFromTokens(tokens) {
  let html = '';
  let buffer = [];

  const flushBuffer = async () => {
    if (buffer.length === 0) return;
    const safeBuffer = buffer.map(tok => ({
      ...tok,
      surface_form: escapeHtml(tok.surface_form || '')
    }));
    buffer = [];
    html += await convertTokensWithKuroshiro(safeBuffer, {
      to: 'hiragana',
      mode: 'furigana'
    });
  };

  for (const tok of tokens) {
    if (tok._isParticleWa) {
      await flushBuffer();
      html += '<ruby>は<rt>わ</rt></ruby>';
    } else if (tok._isParticleE) {
      await flushBuffer();
      html += '<ruby>へ<rt>え</rt></ruby>';
    } else if (tok._hasTrailingWa) {
      await flushBuffer();
      const prefixSurf = tok.surface_form.slice(0, -1);
      const prefixRead = (tok.reading || '').slice(0, -1);
      const prefixPron = (tok.pronunciation || '').slice(0, -1);
      if (KANJI_REGEX.test(prefixSurf)) {
        html += await convertTokensWithKuroshiro([{
          ...tok,
          surface_form: escapeHtml(prefixSurf),
          reading: prefixRead,
          pronunciation: prefixPron
        }], {
          to: 'hiragana',
          mode: 'furigana'
        });
      } else {
        html += escapeHtml(prefixSurf);
      }
      html += '<ruby>は<rt>わ</rt></ruby>';
    } else {
      buffer.push(tok);
    }
  }

  await flushBuffer();
  return html;
}

async function renderBox1FuriganaOnly(text) {
  if (!text) {
    furiganaBackdrop.innerHTML = '';
    return;
  }
  if (isKuroshiroReady && kuroshiroInstance && kuroshiroAnalyzer) {
    try {
      const tokens = await kuroshiroAnalyzer.parse(text);
      const furiganaHtml = await buildFuriganaHtmlFromTokens(tokens);
      furiganaBackdrop.innerHTML = furiganaHtml.endsWith('\n')
        ? furiganaHtml + '\u200b'
        : furiganaHtml;
      return;
    } catch (e) {
      console.warn('Furigana render fallback:', e);
    }
  }
  furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
}

async function buildJapaneseAlignedSegments(tokens) {
  const segs = [];
  for (const tok of tokens) {
    const src = tok.surface_form || '';
    if (!src) continue;
    const rawRom = await convertTokensWithKuroshiro([tok], {
      to: 'romaji',
      mode: 'spaced',
      romajiSystem: 'hepburn'
    });
    const rom = postProcessJapaneseRomajiNumbers(rawRom).plain.trim();
    segs.push({ src, rom });
  }
  return segs;
}

function buildFallbackJapaneseAlignedSegments(text) {
  const segs = [];
  for (const ch of text) {
    if (/\s/.test(ch)) {
      segs.push({ src: ch, rom: '' });
    } else {
      const rom = fallbackJapaneseRomanizeWithBlueNumbers(ch).plain.trim();
      segs.push({ src: ch, rom });
    }
  }
  return segs;
}

async function initKuroshiro() {
  ensureGzippedDictLoader();
  getBox2Backdrop();

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
        patchKuromojiAnalyzer(analyzer);
        return { ks, analyzer };
      })();

      const loaded = await Promise.race([loadPromise, timeoutPromise]);
      kuroshiroInstance = loaded.ks;
      kuroshiroAnalyzer = loaded.analyzer;
      isKuroshiroReady = true;
      buildKuromojiReadingIndex(loaded.analyzer);
      setEngineStatus('ready', 'Kuroshiro + Kuromoji Ready');
      updateRomanization(false, true);
      return;
    } catch (e) {
      console.warn(`Kuromoji failed at ${dictPath}:`, e.message);
    }
  }

  setEngineStatus('ready-fallback', 'Ready (kanjiapi.dev Mode)');
  updateRomanization(false, true);
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

/* ==========================================================================
   Collision-Free Box 2 Backdrop Helper & Multilingual Number Romanizer
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

function normalizeAsciiDigits(str) {
  return str.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function parseCjkNumberString(str) {
  if (!/^[零〇一二两三四五六七八九十百千万億亿]+$/.test(str)) return null;

  if (!/[十百千万億亿]/.test(str)) {
    let digits = '';
    for (const ch of str) {
      if (CJK_DIGIT_VALUE[ch] === undefined) return null;
      digits += String(CJK_DIGIT_VALUE[ch]);
    }
    return digits;
  }

  let total = 0;
  let section = 0;
  let currentDigit = 0;

  for (const ch of str) {
    if (CJK_DIGIT_VALUE[ch] !== undefined) {
      currentDigit = CJK_DIGIT_VALUE[ch];
    } else if (CJK_SMALL_UNIT[ch]) {
      const unit = CJK_SMALL_UNIT[ch];
      section += (currentDigit || 1) * unit;
      currentDigit = 0;
    } else if (CJK_LARGE_UNIT[ch]) {
      const largeUnit = CJK_LARGE_UNIT[ch];
      section += currentDigit;
      total += (section || 1) * largeUnit;
      section = 0;
      currentDigit = 0;
    }
  }
  return String(total + section + currentDigit);
}

function jaUnder10000Romaji(n) {
  let parts = [];
  const q = Math.floor(n / 1000);
  const h = Math.floor((n % 1000) / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;

  if (q > 0) {
    if (q === 1) parts.push('sen');
    else if (q === 3) parts.push('sanzen');
    else if (q === 8) parts.push('hassen');
    else parts.push(JA_DIGITS_ROMAJI[q] + 'sen');
  }
  if (h > 0) {
    if (h === 1) parts.push('hyaku');
    else if (h === 3) parts.push('sanbyaku');
    else if (h === 6) parts.push('roppyaku');
    else if (h === 8) parts.push('happyaku');
    else parts.push(JA_DIGITS_ROMAJI[h] + 'hyaku');
  }
  if (t > 0) {
    if (t === 1) parts.push('juu');
    else parts.push(JA_DIGITS_ROMAJI[t] + 'juu');
  }
  if (u > 0) {
    parts.push(JA_DIGITS_ROMAJI[u]);
  }
  return parts.join('');
}

function numberToJapaneseRomaji(rawStr) {
  const numStr = /^[0-9]+$/.test(rawStr) ? rawStr : (parseCjkNumberString(rawStr) || '');
  if (!numStr) return rawStr;
  if ((numStr.length > 1 && numStr.startsWith('0')) || numStr.length > 8) {
    return [...numStr].map(d => JA_DIGITS_ROMAJI[Number(d)]).join(' ');
  }
  const n = parseInt(numStr, 10);
  if (n === 0) return rawStr === '零' ? 'rei' : (rawStr === '〇' ? 'maru' : 'zero');
  const man = Math.floor(n / 10000);
  const rem = n % 10000;
  let parts = [];
  if (man > 0) parts.push(jaUnder10000Romaji(man) + 'man');
  if (rem > 0) parts.push(jaUnder10000Romaji(rem));
  return parts.join(' ');
}

function zhUnder10000Pinyin(n, isLeadingSection) {
  const units = ['', 'shí', 'bǎi', 'qiān'];
  const digits = [Math.floor(n / 1000), Math.floor((n % 1000) / 100), Math.floor((n % 100) / 10), n % 10];
  let words = [];
  let zeroPending = false;

  for (let i = 0; i < 4; i++) {
    const d = digits[i];
    const unitIdx = 3 - i;
    if (d === 0) {
      if (words.length > 0 || !isLeadingSection) zeroPending = true;
    } else {
      if (zeroPending) {
        words.push('líng');
        zeroPending = false;
      }
      if (d === 1 && unitIdx === 1 && words.length === 0 && isLeadingSection) {
        words.push('shí');
      } else {
        words.push(ZH_DIGITS_PINYIN[d] + (units[unitIdx] ? ' ' + units[unitIdx] : ''));
      }
    }
  }
  return words.join(' ');
}

function numberToChinesePinyin(rawStr) {
  if (!/^[0-9]+$/.test(rawStr) && typeof pinyinPro !== 'undefined' && pinyinPro.pinyin) {
    return pinyinPro.pinyin(rawStr, { toneType: 'symbol' });
  }
  const numStr = /^[0-9]+$/.test(rawStr) ? rawStr : (parseCjkNumberString(rawStr) || '');
  if (!numStr) return rawStr;
  if ((numStr.length > 1 && numStr.startsWith('0')) || numStr.length > 8) {
    return [...numStr].map(d => ZH_DIGITS_PINYIN[Number(d)]).join(' ');
  }
  const n = parseInt(numStr, 10);
  if (n === 0) return 'líng';
  const wan = Math.floor(n / 10000);
  const rem = n % 10000;
  let parts = [];
  if (wan > 0) parts.push(zhUnder10000Pinyin(wan, true) + ' wàn');
  if (rem > 0) parts.push(zhUnder10000Pinyin(rem, wan === 0));
  return parts.join(' ');
}

function koUnder10000Hangul(n) {
  let str = '';
  const q = Math.floor(n / 1000);
  const h = Math.floor((n % 1000) / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;

  if (q > 0) str += (q === 1 ? '' : KO_DIGITS_HANGUL[q]) + '천';
  if (h > 0) str += (h === 1 ? '' : KO_DIGITS_HANGUL[h]) + '백';
  if (t > 0) str += (t === 1 ? '' : KO_DIGITS_HANGUL[t]) + '십';
  if (u > 0) str += KO_DIGITS_HANGUL[u];
  return str;
}

function numberToKoreanRomaji(rawStr) {
  const numStr = /^[0-9]+$/.test(rawStr) ? rawStr : (parseCjkNumberString(rawStr) || '');
  if (!numStr) return rawStr;
  if ((numStr.length > 1 && numStr.startsWith('0')) || numStr.length > 8) {
    return [...numStr].map(d => romanizeKorean(KO_DIGITS_HANGUL[Number(d)])).join(' ');
  }
  const n = parseInt(numStr, 10);
  if (n === 0) return 'yeong';
  const man = Math.floor(n / 10000);
  const rem = n % 10000;
  let hangul = '';
  if (man > 0) hangul += (man === 1 ? '' : koUnder10000Hangul(man)) + '만';
  if (rem > 0) hangul += koUnder10000Hangul(rem);
  return romanizeKorean(hangul);
}

function ruUnder1000Romaji(n, isFeminine = false) {
  let parts = [];
  const h = Math.floor(n / 100);
  const rem = n % 100;
  if (h > 0) parts.push(RU_HUNDREDS[h]);
  if (rem >= 10 && rem <= 19) {
    parts.push(RU_TEENS[rem - 10]);
  } else {
    const t = Math.floor(rem / 10);
    const u = rem % 10;
    if (t > 0) parts.push(RU_TENS[t]);
    if (u > 0) {
      if (isFeminine && u === 1) parts.push('odna');
      else if (isFeminine && u === 2) parts.push('dve');
      else parts.push(RU_ONES[u]);
    }
  }
  return parts.join(' ');
}

function numberToRussianRomaji(rawStr) {
  const numStr = /^[0-9]+$/.test(rawStr) ? rawStr : (parseCjkNumberString(rawStr) || '');
  if (!numStr) return rawStr;
  if ((numStr.length > 1 && numStr.startsWith('0')) || numStr.length > 6) {
    return [...numStr].map(d => RU_ONES[Number(d)]).join(' ');
  }
  const n = parseInt(numStr, 10);
  if (n === 0) return RU_ONES[0];
  const thousands = Math.floor(n / 1000);
  const rem = n % 1000;
  let parts = [];
  if (thousands > 0) {
    const thMod100 = thousands % 100;
    const thMod10 = thousands % 10;
    let thWord = 'tysyach';
    if (thMod100 < 11 || thMod100 > 14) {
      if (thMod10 === 1) thWord = 'tysyacha';
      else if (thMod10 >= 2 && thMod10 <= 4) thWord = 'tysyachi';
    }
    if (thousands === 1) parts.push('tysyacha');
    else parts.push(ruUnder1000Romaji(thousands, true) + ' ' + thWord);
  }
  if (rem > 0) parts.push(ruUnder1000Romaji(rem, false));
  return parts.join(' ');
}

function romanizeNumberByLang(rawToken, lang) {
  const normalized = normalizeAsciiDigits(rawToken);
  if (lang === 'ja') return numberToJapaneseRomaji(normalized);
  if (lang === 'zh') return numberToChinesePinyin(normalized);
  if (lang === 'ko') return numberToKoreanRomaji(normalized);
  if (lang === 'ru') return numberToRussianRomaji(normalized);
  return normalized;
}

const COUNTER_AFTER_NUMBER_MAP = {
  '年': { kana: 'ねん', romaji: 'nen' },
  '月': { kana: 'がつ', romaji: 'gatsu' },
  '日': { kana: 'にち', romaji: 'nichi' },
  '人': { kana: 'にん', romaji: 'nin' },
  '時': { kana: 'じ', romaji: 'ji' },
  '分': { kana: 'ふん', romaji: 'fun' },
  '円': { kana: 'えん', romaji: 'en' },
  '歳': { kana: 'さい', romaji: 'sai' },
  '本': { kana: 'ほん', romaji: 'hon' },
  '回': { kana: 'かい', romaji: 'kai' }
};

const PRECEDING_NUMBER_REGEX = /[0-9０-９零〇一二两三四五六七八九十百千万億亿]/;

function resolveFallbackKanjiAt(str, i) {
  const ch = str[i];
  const rest = str.slice(i + 1);
  const prevChar = i > 0 ? str[i - 1] : '';
  const precededByNumber = prevChar && PRECEDING_NUMBER_REGEX.test(prevChar);
  const apiEntry = KANJI_API_CACHE[ch];

  if (precededByNumber && COUNTER_AFTER_NUMBER_MAP[ch]) {
    return {
      kana: COUNTER_AFTER_NUMBER_MAP[ch].kana,
      romaji: COUNTER_AFTER_NUMBER_MAP[ch].romaji,
      isOkuriStem: false
    };
  }

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
    const adjKanjiOrNum = precededByNumber
      || (i > 0 && KANJI_REGEX.test(str[i - 1]))
      || (i + 1 < str.length && KANJI_REGEX.test(str[i + 1]));
    return {
      kana: adjKanjiOrNum ? apiEntry.onKana : apiEntry.kana,
      romaji: adjKanjiOrNum ? apiEntry.onRomaji : apiEntry.romaji,
      isOkuriStem: false
    };
  }

  return null;
}

function canUseFallbackCompoundAt(str, i, sub) {
  const spec = IRREGULAR_COUNTER_COMPOUNDS[sub];
  if (!spec) return true;
  if (i > 0 && PRECEDING_NUMBER_REGEX.test(str[i - 1])) return false;
  const rest = str.slice(i + sub.length);
  if (spec.disallowNext && spec.disallowNext.test(rest)) return false;
  return true;
}

function fallbackJapaneseFuriganaHtml(str) {
  let html = '';
  let i = 0;
  while (i < str.length) {
    const digitMatch = str.slice(i).match(/^[0-9０-９]+/);
    if (digitMatch) {
      html += escapeHtml(digitMatch[0]);
      i += digitMatch[0].length;
      continue;
    }

    let compoundFound = false;
    for (let len = 4; len >= 2; len--) {
      const sub = str.substr(i, len);
      if (KANJI_FALLBACK[sub] && canUseFallbackCompoundAt(str, i, sub)) {
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

function postProcessJapaneseRomajiNumbers(rawRomaji) {
  const parts = rawRomaji.split(/([0-9０-９]+)/g).filter(Boolean);
  let plainOut = '';
  let htmlOut = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/^[0-9０-９]+$/.test(part)) {
      const romNum = numberToJapaneseRomaji(normalizeAsciiDigits(part));
      const needLeadingSpace = plainOut.length > 0 && !/\s$/.test(plainOut);
      const nextPart = i + 1 < parts.length ? parts[i + 1] : '';
      const needTrailingSpace = nextPart.length > 0 && !/^[\s.,!?;:)\]]/.test(nextPart);

      const lead = needLeadingSpace ? ' ' : '';
      const trail = needTrailingSpace ? ' ' : '';

      plainOut += lead + romNum + trail;
      htmlOut += `${lead}<span class="romanized-number">${escapeHtml(romNum)}</span>${trail}`;
    } else {
      plainOut += part;
      htmlOut += escapeHtml(part);
    }
  }

  return {
    plain: plainOut.replace(/ +/g, ' ').trim(),
    html: htmlOut.replace(/ +/g, ' ').trim()
  };
}

function fallbackJapaneseRomanizeWithBlueNumbers(str) {
  let plain = '';
  let html = '';
  let i = 0;

  while (i < str.length) {
    const digitMatch = str.slice(i).match(/^[0-9０-９]+/);
    if (digitMatch) {
      const rawDigits = digitMatch[0];
      const romNum = numberToJapaneseRomaji(normalizeAsciiDigits(rawDigits));
      const prefix = (plain && !/\s$/.test(plain)) ? ' ' : '';
      plain += prefix + romNum + ' ';
      html += `${prefix}<span class="romanized-number">${escapeHtml(romNum)}</span> `;
      i += rawDigits.length;
      continue;
    }

    let compoundFound = false;
    for (let len = 4; len >= 2; len--) {
      const sub = str.substr(i, len);
      if (KANJI_FALLBACK[sub] && canUseFallbackCompoundAt(str, i, sub)) {
        const prefix = (plain && !/\s$/.test(plain)) ? ' ' : '';
        plain += prefix + KANJI_FALLBACK[sub].romaji + ' ';
        html += prefix + escapeHtml(KANJI_FALLBACK[sub].romaji) + ' ';
        i += len;
        compoundFound = true;
        break;
      }
    }
    if (compoundFound) continue;

    const kanjiMatch = resolveFallbackKanjiAt(str, i);
    if (kanjiMatch) {
      const prefix = (plain && !/\s$/.test(plain)) ? ' ' : '';
      const suffix = kanjiMatch.isOkuriStem ? '' : ' ';
      const isNumKanji = /^[零〇一二两三四五六七八九十百千万億亿]$/.test(str[i]);
      plain += prefix + kanjiMatch.romaji + suffix;
      if (isNumKanji) {
        html += `${prefix}<span class="romanized-number">${escapeHtml(kanjiMatch.romaji)}</span>${suffix}`;
      } else {
        html += prefix + escapeHtml(kanjiMatch.romaji) + suffix;
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
          plain += nextRomaji[0];
          html += escapeHtml(nextRomaji[0]);
          i++;
          continue;
        }
      }
    }

    const twoChar = str.substr(i, 2);
    if (KANA_MAP[twoChar]) {
      plain += KANA_MAP[twoChar];
      html += escapeHtml(KANA_MAP[twoChar]);
      i += 2;
      continue;
    }

    if (KANA_MAP[str[i]]) {
      plain += KANA_MAP[str[i]];
      html += escapeHtml(KANA_MAP[str[i]]);
      i++;
      continue;
    }

    plain += str[i];
    html += escapeHtml(str[i]);
    i++;
  }

  return {
    plain: plain.replace(/ +/g, ' ').trim(),
    html: html.replace(/ +/g, ' ').trim()
  };
}

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

    if (next.cho === 'ㄹ' && ['ㄱ', 'ㄷ', 'ㅂ', 'ㅁ', 'ㅇ'].includes(curr.jong)) {
      next.cho = 'ㄴ';
    }

    if (next.cho === 'ㄴ' || next.cho === 'ㅁ') {
      if (curr.jong === 'ㄱ') curr.jong = 'ㅇ';
      else if (curr.jong === 'ㄷ') curr.jong = 'ㄴ';
      else if (curr.jong === 'ㅂ') curr.jong = 'ㅁ';
    }

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

const NUMBER_SPLIT_REGEX = /([0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)/g;
const IS_NUMBER_TOKEN_REGEX = /^([0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)$/;

async function romanizeNonJapaneseTextAndNumbers(text, lang) {
  const parts = text.split(NUMBER_SPLIT_REGEX).filter(Boolean);
  let plainParts = [];
  let htmlParts = [];

  for (const part of parts) {
    if (IS_NUMBER_TOKEN_REGEX.test(part)) {
      const romNum = romanizeNumberByLang(part, lang);
      const needLeadingSpace = plainParts.length > 0 && !/\s$/.test(plainParts[plainParts.length - 1]);
      const prefix = needLeadingSpace ? ' ' : '';
      plainParts.push(prefix + romNum + ' ');
      htmlParts.push(`${prefix}<span class="romanized-number">${escapeHtml(romNum)}</span> `);
    } else {
      let romText = '';
      if (lang === 'zh') {
        romText = romanizeChinese(part);
      } else if (lang === 'ko') {
        romText = romanizeKorean(part);
      } else if (lang === 'ru') {
        romText = romanizeRussian(part);
      }
      plainParts.push(romText);
      htmlParts.push(escapeHtml(romText));
    }
  }

  return {
    plain: plainParts.join('').replace(/ +/g, ' ').trim(),
    html: htmlParts.join('').replace(/ +/g, ' ').trim()
  };
}

/* ==========================================================================
   Writable Box 2 Reverse Transliteration & Hybrid Phrase/Kanji IME Engine
   ========================================================================== */
const ROMAJI_TO_HIRA_MAP = (() => {
  const map = {};
  for (const [kana, rom] of Object.entries(KANA_MAP)) {
    if (/^[\u3041-\u3096]+$/.test(kana) && rom && !map[rom]) {
      map[rom] = kana;
    }
  }
  Object.assign(map, {
    'si': 'し', 'ti': 'ち', 'tu': 'つ', 'hu': 'ふ', 'zi': 'じ',
    'sya': 'しゃ', 'syu': 'しゅ', 'syo': 'しょ',
    'tya': 'ちゃ', 'tyu': 'ちゅ', 'tyo': 'ちょ',
    'cya': 'ちゃ', 'cyu': 'ちゅ', 'cyo': 'ちょ',
    'jya': 'じゃ', 'jyu': 'じゅ', 'jyo': 'じょ',
    'zya': 'じゃ', 'zyu': 'じゅ', 'zyo': 'じょ',
    'dya': 'ぢゃ', 'dyu': 'ぢゅ', 'dyo': 'ぢょ',
    'pha': 'ふぁ', 'phi': 'ふぃ', 'phe': 'ふぇ', 'pho': 'ふぉ',
    'la': 'ぁ', 'li': 'ぃ', 'lu': 'ぅ', 'le': 'ぇ', 'lo': 'ぉ',
    'xa': 'ぁ', 'xi': 'ぃ', 'xu': 'ぅ', 'xe': 'ぇ', 'xo': 'ぉ',
    'lya': 'ゃ', 'lyu': 'ゅ', 'lyo': 'ょ',
    'xya': 'ゃ', 'xyu': 'ゅ', 'xyo': 'ょ',
    'ltu': 'っ', 'xtu': 'っ', 'ltsu': 'っ', 'xtsu': 'っ',
    'nn': 'ん', "n'": 'ん'
  });
  return map;
})();

const ROMAJI_KEYS_DESC = Object.keys(ROMAJI_TO_HIRA_MAP).sort((a, b) => b.length - a.length);

function stripPendingRomajiTail(input) {
  if (!input) return '';
  const match = input.match(/(?:(?<![nN])[nN]|[bcdfghjklmpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]{1,3})$/);
  if (!match) return input;
  const tail = match[0];
  if (/^(nn|n')$/i.test(tail)) return input;
  return input.slice(0, -tail.length);
}

function romajiToJapaneseKanaByCase(rawInput, isLiveBox2Typing = false) {
  const input = isLiveBox2Typing ? stripPendingRomajiTail(rawInput) : rawInput;
  let out = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '-') {
      out += 'ー';
      i++;
      continue;
    }

    const rest = input.slice(i);
    const lowerRest = rest.toLowerCase();

    if (lowerRest.length >= 2) {
      const c1 = lowerRest[0];
      const c2 = lowerRest[1];
      if (
        (c1 === c2 && /^[bcdfghjklmpqrstvwxyz]$/.test(c1) && c1 !== 'n') ||
        (c1 === 't' && c2 === 'c' && lowerRest[2] === 'h')
      ) {
        const isUpper = rest[0] >= 'A' && rest[0] <= 'Z';
        out += isUpper ? 'ッ' : 'っ';
        i++;
        continue;
      }
    }

    if (lowerRest.startsWith("n'") || lowerRest.startsWith('nn')) {
      const isUpper = rest[0] === 'N';
      out += isUpper ? 'ン' : 'ん';
      i += 2;
      continue;
    }

    let matchedKey = null;
    for (const key of ROMAJI_KEYS_DESC) {
      if (lowerRest.startsWith(key)) {
        matchedKey = key;
        break;
      }
    }

    if (matchedKey) {
      const rawChunk = rest.slice(0, matchedKey.length);
      const isUpper = /[A-Z]/.test(rawChunk);
      const hira = ROMAJI_TO_HIRA_MAP[matchedKey];
      out += isUpper ? hiraganaToKatakana(hira) : hira;
      i += matchedKey.length;
      continue;
    }

    if (lowerRest[0] === 'n') {
      const nextCh = lowerRest[1] || '';
      if ((!nextCh && !isLiveBox2Typing) || (nextCh && !/^[aiueoy']$/.test(nextCh))) {
        const isUpper = rest[0] === 'N';
        out += isUpper ? 'ン' : 'ん';
        i++;
        continue;
      }
    }

    if (!isLiveBox2Typing) {
      out += ch;
    }
    i++;
  }

  return out;
}

const LATIN_TO_CYRILLIC_TOKENS = [
  ['Shch', 'Щ'], ['SHCH', 'Щ'], ['shch', 'щ'],
  ['Yo', 'Ё'], ['YO', 'Ё'], ['yo', 'ё'],
  ['Zh', 'Ж'], ['ZH', 'Ж'], ['zh', 'ж'],
  ['Kh', 'Х'], ['KH', 'Х'], ['kh', 'х'],
  ['Ts', 'Ц'], ['TS', 'Ц'], ['ts', 'ц'],
  ['Ch', 'Ч'], ['CH', 'Ч'], ['ch', 'ч'],
  ['Sh', 'Ш'], ['SH', 'Ш'], ['sh', 'ш'],
  ['Yu', 'Ю'], ['YU', 'Ю'], ['yu', 'ю'],
  ['Ya', 'Я'], ['YA', 'Я'], ['ya', 'я'],
  ['A', 'А'], ['B', 'Б'], ['V', 'В'], ['G', 'Г'], ['D', 'Д'],
  ['E', 'Е'], ['Z', 'З'], ['I', 'И'], ['Y', 'Й'], ['K', 'К'],
  ['L', 'Л'], ['M', 'М'], ['N', 'Н'], ['O', 'О'], ['P', 'П'],
  ['R', 'Р'], ['S', 'С'], ['T', 'Т'], ['U', 'У'], ['F', 'Ф'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'],
  ['e', 'е'], ['z', 'з'], ['i', 'и'], ['y', 'й'], ['k', 'к'],
  ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'],
  ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'],
  ['"', 'ъ'], ["'", 'ь']
];

function latinToRussianCyrillic(str) {
  let out = '';
  let i = 0;
  while (i < str.length) {
    let matched = false;
    for (const [lat, cyr] of LATIN_TO_CYRILLIC_TOKENS) {
      if (str.startsWith(lat, i)) {
        out += cyr;
        i += lat.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += str[i];
      i++;
    }
  }
  return out;
}

const RR_CHO_LIST = [
  ['kk', 1], ['tt', 4], ['pp', 8], ['ss', 10], ['jj', 13], ['ch', 14],
  ['g', 0], ['k', 15], ['n', 2], ['d', 3], ['t', 16], ['r', 5], ['l', 5],
  ['m', 6], ['b', 7], ['p', 17], ['s', 9], ['j', 12], ['h', 18]
];
const RR_JUNG_LIST = [
  ['wae', 10], ['yae', 3], ['yeo', 6], ['wa', 9], ['oe', 11], ['wo', 14],
  ['we', 15], ['wi', 16], ['ui', 19], ['ae', 1], ['ya', 2], ['eo', 4],
  ['ye', 7], ['yo', 12], ['yu', 17], ['eu', 18],
  ['a', 0], ['e', 5], ['o', 8], ['u', 13], ['i', 20]
];
const RR_JONG_LIST = [
  ['ng', 21], ['k', 1], ['n', 4], ['t', 7], ['l', 8], ['r', 8], ['m', 16], ['p', 17], ['g', 1], ['b', 17], ['s', 19]
];

function romanizedToHangul(str) {
  let out = '';
  let i = 0;
  const lower = str.toLowerCase();

  while (i < lower.length) {
    if (!/[a-z]/.test(lower[i])) {
      out += str[i];
      i++;
      continue;
    }

    let choIdx = 11;
    let choLen = 0;
    for (const [rom, idx] of RR_CHO_LIST) {
      if (lower.startsWith(rom, i)) {
        choIdx = idx;
        choLen = rom.length;
        break;
      }
    }

    let jungIdx = -1;
    let jungLen = 0;
    for (const [rom, idx] of RR_JUNG_LIST) {
      if (lower.startsWith(rom, i + choLen)) {
        jungIdx = idx;
        jungLen = rom.length;
        break;
      }
    }

    if (jungIdx === -1) {
      out += CHO_JAMO[choIdx] || str[i];
      i += Math.max(1, choLen);
      continue;
    }

    const posAfterVowel = i + choLen + jungLen;
    let jongIdx = 0;
    let jongLen = 0;

    for (const [rom, idx] of RR_JONG_LIST) {
      if (lower.startsWith(rom, posAfterVowel)) {
        const afterJong = posAfterVowel + rom.length;
        let followedByVowel = false;
        if (rom !== 'ng') {
          for (const [vRom] of RR_JUNG_LIST) {
            if (lower.startsWith(vRom, afterJong)) {
              followedByVowel = true;
              break;
            }
          }
        }
        if (!followedByVowel) {
          jongIdx = idx;
          jongLen = rom.length;
          break;
        }
      }
    }

    const code = 0xAC00 + (choIdx * 21 + jungIdx) * 28 + jongIdx;
    out += String.fromCharCode(code);
    i = posAfterVowel + jongLen;
  }

  return out;
}

function formatBox2BackdropWithNumbers(rawText) {
  const parts = rawText.split(/([0-9０-９]+)/g).filter(Boolean);
  return parts
    .map(p => /^[0-9０-９]+$/.test(p)
      ? `<span class="romanized-number">${escapeHtml(p)}</span>`
      : escapeHtml(p))
    .join('');
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
    while (scanPos < rawBox2.length && /\s/.test(rawBox2[scanPos])) {
      scanPos++;
    }
    const candidateSlice = rawBox2.slice(scanPos, scanPos + seg.rom.length);
    if (candidateSlice.toLowerCase() === seg.rom.toLowerCase()) {
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
    while (scanEnd > pos && /\s/.test(rawBox2[scanEnd - 1])) {
      scanEnd--;
    }
    const startCandidate = scanEnd - seg.rom.length;
    if (startCandidate > pos && /\s/.test(rawBox2[startCandidate - 1])) {
      const candidateSlice = rawBox2.slice(startCandidate, scanEnd);
      if (candidateSlice.toLowerCase() === seg.rom.toLowerCase()) {
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

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

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
    furiganaBackdrop.innerHTML = '';
    const trimmedMidRom = middleRomaji.trim();
    if (trimmedMidRom) {
      const replaceStart = prefixSrc.length;
      const replaceEnd = replaceStart + convertedMiddle.length;
      fetchChinesePinyinSuggestions(trimmedMidRom, { start: replaceStart, end: replaceEnd });
    } else {
      showTypingSuggestions([], null);
    }
  } else {
    furiganaBackdrop.innerHTML = '';
    showTypingSuggestions([], null);
  }

  autoResizeBoxes();
}

const LOCAL_JA_IME_DICT = {
  'わたし': ['私', 'わたし', '私は', '私が', '私の', '私も'],
  'わたしは': ['私は', 'わたしは'],
  'わたしの': ['私の', 'わたしの'],
  'ぼく': ['僕', 'ぼく', '僕は', '僕が', '僕の'],
  'おれ': ['俺', 'おれ', '俺は', '俺の'],
  'あなた': ['貴方', 'あなた', 'あなたは', 'あなたの'],
  'かれ': ['彼', 'かれ', '彼は', '彼の'],
  'かのじょ': ['彼女', 'かのじょ', '彼女は', '彼女の'],
  'にほん': ['日本', 'にほん', '日本へ', '日本の', '日本語'],
  'にほんご': ['日本語', 'にほんご'],
  'とうきょう': ['東京', 'とうきょう', '東京へ'],
  'がっこう': ['学校', 'がっこう', '学校へ', '学校に'],
  'がくせい': ['学生', 'がくせい', '学生です'],
  'せんせい': ['先生', 'せんせい'],
  'だいがく': ['大学', 'だいがく'],
  'ともだち': ['友達', 'ともだち'],
  'とも': ['友', '共', 'とも'],
  'ひと': ['人', 'ひと'],
  'ひとり': ['一人', 'ひとり', '一人だけ', '一人で'],
  'ふたり': ['二人', 'ふたり', '二人だけ', '二人だけの', '二人で'],
  'ふたりだけの': ['二人だけの', 'ふたりだけの'],
  'ほん': ['本', 'ほん'],
  'あい': ['愛', 'あい'],
  'みず': ['水', 'みず'],
  'ひ': ['日', '火', 'ひ'],
  'つき': ['月', 'つき'],
  'とし': ['年', 'とし'],
  'じかん': ['時間', 'じかん'],
  'いま': ['今', 'いま'],
  'きょう': ['今日', 'きょう', '今日は'],
  'あした': ['明日', 'あした', '明日は'],
  'きのう': ['昨日', 'きのう', '昨日は'],
  'まいにち': ['毎日', 'まいにち'],
  'てんき': ['天気', 'てんき', 'いい天気'],
  'いいてんき': ['いい天気', '良い天気'],
  'なまえ': ['名前', 'なまえ'],
  'たべる': ['食べる', 'たべる', '食べます'],
  'みる': ['見る', 'みる', '見ます'],
  'きく': ['聞く', '聴く', 'きく'],
  'いく': ['行く', 'いく', '行きます'],
  'くる': ['来る', 'くる', '来ます'],
  'する': ['する', 'します'],
  'なに': ['何', 'なに', '何が', '何を'],
  'すき': ['好き', 'すき', '好きです', '大好き'],
  'だいすき': ['大好き', 'だいすき'],
  'げんき': ['元気', 'げんき', 'お元気ですか'],
  'こんにちは': ['こんにちは', '今日は'],
  'こんばんは': ['こんばんは', '今晩は'],
  'ありがとう': ['ありがとう', 'ありがとうございます', '有難う'],
  'おはよう': ['おはよう', 'おはようございます'],
  'さようなら': ['さようなら', '左様なら'],
  'でんしゃ': ['電車', 'でんしゃ'],
  'くるま': ['車', 'くるま'],
  'えき': ['駅', 'えき'],
  'いえ': ['家', 'いえ'],
  'へや': ['部屋', 'へや'],
  'しごと': ['仕事', 'しごと'],
  'でんわ': ['電話', 'でんわ'],
  'おんがく': ['音楽', 'おんがく'],
  'えいが': ['映画', 'えいが'],
  'ねこ': ['猫', 'ねこ'],
  'いぬ': ['犬', 'いぬ']
};

function lookupWordCandidatesForHira(hiraWord) {
  const cands = [];
  const add = (w) => {
    if (w && !cands.includes(w)) cands.push(w);
  };

  if (LOCAL_JA_IME_DICT[hiraWord]) {
    LOCAL_JA_IME_DICT[hiraWord].forEach(add);
  }
  if (KUROMOJI_READING_INDEX.has(hiraWord)) {
    for (const item of KUROMOJI_READING_INDEX.get(hiraWord)) {
      add(item.surf);
    }
  }
  for (const [kanji, info] of Object.entries(KANJI_FALLBACK)) {
    if (info.kana === hiraWord) add(kanji);
  }
  return cands;
}

/*
 * Offline Cohesive Phrase Builder:
 * Segments multi-word Hiragana input across grammatical particles & verb endings
 * using Kuromoji's 160k-word reading index + LOCAL_JA_IME_DICT.
 */
const GRAMMAR_PARTICLES = new Set(['は', 'が', 'を', 'に', 'へ', 'で', 'と', 'の', 'も', 'や', 'か', 'ね', 'よ']);
const MULTI_CHAR_ENDINGS = ['だけの', 'だけ', 'から', 'まで', 'より', 'ほど', 'くらい', 'ぐらい', 'です', 'ます', 'でした', 'ました', 'ません', 'ない', 'たい'];

function assembleOfflineKanjiPhrase(hiraStr) {
  if (!hiraStr || hiraStr.length < 2) return [];

  const n = hiraStr.length;
  // dp[i] = { cost, text, altText }
  const dp = new Array(n + 1).fill(null);
  dp[0] = { cost: 0, text: '', altText: '' };

  for (let i = 0; i < n; i++) {
    if (!dp[i]) continue;

    // 1. Try multi-character grammatical endings / particles
    for (const ending of MULTI_CHAR_ENDINGS) {
      if (i > 0 && hiraStr.startsWith(ending, i)) {
        const nextIdx = i + ending.length;
        const stepCost = 1800;
        const newCost = dp[i].cost + stepCost;
        if (!dp[nextIdx] || newCost < dp[nextIdx].cost) {
          dp[nextIdx] = {
            cost: newCost,
            text: dp[i].text + ending,
            altText: dp[i].altText + ending
          };
        }
      }
    }

    // 2. Try single-character particle (when preceded by a word)
    if (i > 0 && GRAMMAR_PARTICLES.has(hiraStr[i])) {
      const p = hiraStr[i];
      const nextIdx = i + 1;
      const newCost = dp[i].cost + 1400;
      if (!dp[nextIdx] || newCost < dp[nextIdx].cost) {
        dp[nextIdx] = {
          cost: newCost,
          text: dp[i].text + p,
          altText: dp[i].altText + p
        };
      }
    }

    // 3. Try vocabulary spans from length 1 up to 10
    const maxLen = Math.min(10, n - i);
    for (let len = maxLen; len >= 1; len--) {
      const sub = hiraStr.substr(i, len);
      const wordCands = lookupWordCandidatesForHira(sub);
      if (wordCands.length > 0) {
        const bestWord = wordCands[0];
        const secondWord = wordCands[1] || bestWord;
        const kuroEntry = KUROMOJI_READING_INDEX.get(sub);
        const baseCost = LOCAL_JA_IME_DICT[sub]
          ? 2200
          : (kuroEntry && kuroEntry[0] ? Math.max(1500, kuroEntry[0].cost) : 4500);
        // Prefer longer meaningful words over single-char splits
        const spanCost = baseCost - (len * 350);
        const nextIdx = i + len;
        const newCost = dp[i].cost + spanCost;

        if (!dp[nextIdx] || newCost < dp[nextIdx].cost) {
          dp[nextIdx] = {
            cost: newCost,
            text: dp[i].text + bestWord,
            altText: dp[i].altText + secondWord
          };
        }
      } else if (len === 1) {
        // Unmatched single kana fallback
        const nextIdx = i + 1;
        const newCost = dp[i].cost + 8500;
        if (!dp[nextIdx] || newCost < dp[nextIdx].cost) {
          dp[nextIdx] = {
            cost: newCost,
            text: dp[i].text + sub,
            altText: dp[i].altText + sub
          };
        }
      }
    }
  }

  const out = [];
  if (dp[n]) {
    if (dp[n].text && dp[n].text !== hiraStr) out.push(dp[n].text);
    if (dp[n].altText && dp[n].altText !== hiraStr && !out.includes(dp[n].altText)) {
      out.push(dp[n].altText);
    }
  }
  return out;
}

/*
 * Google Japanese Input CGI API (`www.google.com/transliterate?langpair=ja-Hira|ja`)
 * Uses cross-origin JSONP first, with direct/proxy fetch fallback.
 * Parses multi-segment bunsetsu responses into full cohesive phrases + segment candidates.
 */
function parseGoogleTransliterateBunsetsu(data) {
  if (!Array.isArray(data) || data.length === 0) return [];
  const results = [];
  const addUnique = (s) => {
    if (s && !results.includes(s)) results.push(s);
  };

  if (data.length === 1) {
    const cands = Array.isArray(data[0][1]) ? data[0][1] : [];
    cands.forEach(addUnique);
    return results;
  }

  // Multi-clause phrase: join the top candidate of every bunsetsu into a cohesive sentence
  const top1Phrase = data.map(seg => (seg[1] && seg[1][0]) ? seg[1][0] : seg[0]).join('');
  addUnique(top1Phrase);

  // Generate cohesive phrase variations by varying each bunsetsu's 2nd and 3rd candidates
  for (let segIdx = 0; segIdx < data.length; segIdx++) {
    const segCands = data[segIdx][1] || [];
    for (let cIdx = 1; cIdx < Math.min(3, segCands.length); cIdx++) {
      const variedPhrase = data
        .map((seg, idx) => idx === segIdx ? segCands[cIdx] : ((seg[1] && seg[1][0]) ? seg[1][0] : seg[0]))
        .join('');
      addUnique(variedPhrase);
    }
  }

  // Also include first clause's top candidates for partial conversion
  if (Array.isArray(data[0][1])) {
    data[0][1].slice(0, 4).forEach(addUnique);
  }

  return results;
}

function fetchGoogleCgiJsonp(hiraQuery, timeoutMs = 1800) {
  return new Promise((resolve, reject) => {
    const cbName = '_googleJaImeCb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const script = document.createElement('script');
    let settled = false;

    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      try {
        delete window[cbName];
      } catch (_) {
        window[cbName] = undefined;
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('JSONP timeout'));
    }, timeoutMs);

    window[cbName] = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(parseGoogleTransliterateBunsetsu(data));
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error('JSONP script error'));
    };

    script.src = `https://www.google.com/transliterate?langpair=ja-Hira|ja&text=${encodeURIComponent(hiraQuery)}&jsonp=${cbName}`;
    document.head.appendChild(script);
  });
}

async function fetchGoogleJapaneseCgiIme(hiraQuery) {
  try {
    const jsonpResults = await fetchGoogleCgiJsonp(hiraQuery, 1800);
    if (jsonpResults && jsonpResults.length > 0) return jsonpResults;
  } catch (_) {
    // Fall through to fetch endpoints if JSONP is blocked
  }

  const targetUrl = `https://www.google.com/transliterate?langpair=ja-Hira|ja&text=${encodeURIComponent(hiraQuery)}`;
  const endpoints = [
    targetUrl,
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      const res = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!res.ok) continue;
      const data = await res.json();
      const parsed = parseGoogleTransliterateBunsetsu(data);
      if (parsed.length > 0) return parsed;
    } catch (_) {
      // Continue to next fallback
    } finally {
      clearTimeout(timer);
    }
  }

  return [];
}

function buildLocalJapaneseSuggestions(hiraQuery, kataQuery) {
  const results = [];
  const addUnique = (val) => {
    if (val && !results.includes(val)) results.push(val);
  };

  // 1. Direct match in curated + Kuromoji 160k-word reading index
  lookupWordCandidatesForHira(hiraQuery).forEach(addUnique);

  // 2. Offline cohesive phrase assembly (handles multi-word phrases & particles like わたしのなまえは -> 私の名前は)
  const assembledPhrases = assembleOfflineKanjiPhrase(hiraQuery);
  assembledPhrases.forEach(addUnique);

  // 3. Stem + particle/ending assembly (e.g., がっこうへ -> 学校へ, たべます -> 食べます)
  const endings = ['だけの', 'だけ', 'から', 'まで', 'です', 'ます', 'は', 'が', 'を', 'に', 'へ', 'で', 'と', 'の', 'も'];
  for (const p of endings) {
    if (hiraQuery.length > p.length && hiraQuery.endsWith(p)) {
      const stem = hiraQuery.slice(0, -p.length);
      const stemMatches = lookupWordCandidatesForHira(stem);
      for (let i = 0; i < Math.min(3, stemMatches.length); i++) {
        addUnique(stemMatches[i] + p);
      }
    }
  }

  // 4. Predictive prefix matches from LOCAL_JA_IME_DICT
  if (hiraQuery.length >= 2) {
    for (const [key, list] of Object.entries(LOCAL_JA_IME_DICT)) {
      if (key.startsWith(hiraQuery) && key !== hiraQuery) {
        addUnique(list[0]);
        if (results.length >= 8) break;
      }
    }
  }

  // 5. Include Hiragana and Katakana forms at the end
  addUnique(hiraQuery);
  addUnique(kataQuery);

  return results.slice(0, 10);
}

function extractActiveJapaneseQueryRange(text, explicitRange) {
  if (explicitRange) {
    const raw = explicitRange.rawRomajiOverride || text.slice(explicitRange.start, explicitRange.end);
    if (raw && raw.trim()) {
      return { start: explicitRange.start, end: explicitRange.end, raw: raw.trim() };
    }
  }

  const cursor = (document.activeElement === textOutputBox && textOutputBox.selectionEnd != null)
    ? textOutputBox.selectionEnd
    : text.length;

  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/([a-zA-Z']+|[ぁ-んァ-ヶー]+)$/);
  if (!match) return null;

  const raw = match[1];
  const start = cursor - raw.length;
  return { start, end: cursor, raw };
}

async function updateTypingSuggestions(text, explicitRange = null) {
  if (currentLang !== 'ja') return;
  if (typeof strokes !== 'undefined' && strokes.length > 0) return;

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

async function fetchChinesePinyinSuggestions(pinyinQuery, replaceRange) {
  const cleanPinyin = pinyinQuery.replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (!cleanPinyin) return;
  const reqId = ++imeSuggestRequestId;
  const url = `https://inputtools.google.com/request?text=${encodeURIComponent(cleanPinyin)}&itc=zh-t-i0-pinyin&num=8&cp=0&cs=1&ie=utf-8&oe=utf-8&app=translate`;
  try {
    const res = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' });
    if (!res.ok) return;
    const data = await res.json();
    if (reqId !== imeSuggestRequestId) return;
    if (data && data[0] === 'SUCCESS' && data[1] && data[1][0] && Array.isArray(data[1][0][1])) {
      showTypingSuggestions(data[1][0][1], replaceRange);
    }
  } catch (_) {}
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
   Main Romanization Sync (Box 1 -> Box 2 + Aligned Segments Update)
   ========================================================================== */
let currentConversionId = 0;

async function updateRomanization(triggerSuggestions = false, forceSyncBox2 = false) {
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
        const rawRomaji = await convertTokensWithKuroshiro(tokens, {
          to: 'romaji',
          mode: 'spaced',
          romajiSystem: 'hepburn'
        });
        const newSegments = await buildJapaneseAlignedSegments(tokens);

        if (conversionId !== currentConversionId || currentLang !== 'ja') return;

        alignedSegments = newSegments;
        furiganaBackdrop.innerHTML = furiganaHtml.endsWith('\n')
          ? furiganaHtml + '\u200b'
          : furiganaHtml;

        const romResult = postProcessJapaneseRomajiNumbers(rawRomaji);
        setBox2Content(romResult.plain, romResult.html, forceSyncBox2);
        autoResizeBoxes();
        return;
      } catch (e) {
        console.warn("Kuroshiro conversion error, running kanjiapi.dev fallback:", e);
      }
    }

    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
    const initialFallbackRom = fallbackJapaneseRomanizeWithBlueNumbers(text);
    alignedSegments = buildFallbackJapaneseAlignedSegments(text);
    setBox2Content(initialFallbackRom.plain, initialFallbackRom.html, forceSyncBox2);
    autoResizeBoxes();

    await ensureKanjiReadingsLoaded(text);
    if (conversionId !== currentConversionId || currentLang !== 'ja') return;

    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
    const updatedFallbackRom = fallbackJapaneseRomanizeWithBlueNumbers(text);
    alignedSegments = buildFallbackJapaneseAlignedSegments(text);
    setBox2Content(updatedFallbackRom.plain, updatedFallbackRom.html, forceSyncBox2);
    autoResizeBoxes();
  } else {
    furiganaBackdrop.innerHTML = '';
    if (!text.trim()) {
      alignedSegments = [];
      setBox2Content('', '', forceSyncBox2);
      autoResizeBoxes();
      return;
    }
    const result = await romanizeNonJapaneseTextAndNumbers(text, currentLang);
    if (conversionId !== currentConversionId) return;
    alignedSegments = text.trim().split(/\s+/).map(word => ({
      src: word,
      rom: currentLang === 'ru'
        ? romanizeRussian(word)
        : (currentLang === 'ko' ? romanizeKorean(word) : romanizeChinese(word))
    }));
    setBox2Content(result.plain, result.html, forceSyncBox2);
    autoResizeBoxes();
  }
}
