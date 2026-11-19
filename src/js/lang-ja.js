/* ==========================================================================
   Japanese Language Module (Kuroshiro + Kuromoji + CGI IME + Jotoba Dict)
   ========================================================================== */
let kuroshiroInstance = null;
let kuroshiroAnalyzer = null;
let isKuroshiroReady = false;

/* In-memory Reading (Hiragana) -> Ranked Kanji Surface Forms extracted from Kuromoji */
const KUROMOJI_READING_INDEX = new Map();
let isKuromojiIndexBuilt = false;

/* Jotoba Dictionary Caches */
const JOTOBA_WORD_CACHE = new Map();
const JOTOBA_KANJI_CACHE = new Map();

const KANJI_API_CACHE = {};
const KANJI_REGEX = /[\u4E00-\u9FAF\u3400-\u4DBF]/;
const PURE_JA_NUMBER_SURFACE_REGEX = /^[0-9０-９零〇一二两三四五六七八九十百千万億亿]+$/;
const PRECEDING_NUM_SURFACE_REGEX = /[0-9０-９零〇一二两三四五六七八九十百千万億亿]$/;
const PRECEDING_NUMBER_REGEX = /[0-9０-９零〇一二两三四五六七八九十百千万億亿]/;
const CLAUSE_BREAK_END_REGEX = /[\s\u3000、。，．・：；！？「『（［｛〈《【〔…‥〜～.,!?;:'"(\[{/\\]$/;

/* ==========================================================================
   Shared String & CJK Number Helpers (Used Across Language Modules)
   ========================================================================== */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function normalizeAsciiDigits(str) {
  return String(str || '').replace(/[０-９]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
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

function katakanaToHiragana(str) {
  return String(str || '').replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function hiraganaToKatakana(str) {
  return String(str || '').replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

function getSokuonHepburnConsonant(nextRomaji) {
  if (!nextRomaji) return "'";
  const lower = nextRomaji.toLowerCase();
  if (lower.startsWith('ch')) return 't';
  if (/^[bcdfghjklmnpqrstvwxyz]/.test(lower)) return lower[0];
  return "'";
}

function expandLeftoverChouonpu(str) {
  return String(str || '').replace(/([aiueoAIUEO])ー+/g, (_, v) => v + v.toLowerCase());
}

function kanaToRomajiString(str) {
  let res = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];

    // Sokuon (っ / ッ): Hepburn 't' before 'ch', doubled consonant otherwise, glottal stop (') at end/punctuation
    if (ch === 'っ' || ch === 'ッ') {
      if (i + 1 < str.length) {
        const nextTwo = str.substr(i + 1, 2);
        const nextOne = str[i + 1];
        const nextRomaji = KANA_MAP[nextTwo] || KANA_MAP[nextOne] || '';
        res += getSokuonHepburnConsonant(nextRomaji);
      } else {
        res += "'";
      }
      i++;
      continue;
    }

    // Chouonpu (ー): lengthen previous vowel dynamically
    if (ch === 'ー') {
      const prevChar = res.length > 0 ? res[res.length - 1] : '';
      if (/[aiueoAIUEO]/.test(prevChar)) {
        res += prevChar.toLowerCase();
      } else {
        res += '-';
      }
      i++;
      continue;
    }

    // Syllabic 'n' before vowel or 'y' (Hepburn n')
    if (ch === 'ん' || ch === 'ン') {
      if (i + 1 < str.length) {
        const nextTwo = str.substr(i + 1, 2);
        const nextOne = str[i + 1];
        const nextRomaji = KANA_MAP[nextTwo] || KANA_MAP[nextOne] || '';
        if (/^[aiueoy]/i.test(nextRomaji)) {
          res += "n'";
          i++;
          continue;
        }
      }
      res += 'n';
      i++;
      continue;
    }

    const twoChar = str.substr(i, 2);
    if (KANA_MAP[twoChar]) {
      res += KANA_MAP[twoChar];
      i += 2;
      continue;
    }
    if (KANA_MAP[ch]) {
      res += KANA_MAP[ch];
      i++;
      continue;
    }
    res += ch;
    i++;
  }
  return res;
}

/* ==========================================================================
   Japanese Number Romanizer
   ========================================================================== */
function jaUnder10000Romaji(n) {
  const parts = [];
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
  const parts = [];
  if (man > 0) parts.push(jaUnder10000Romaji(man) + 'man');
  if (rem > 0) parts.push(jaUnder10000Romaji(rem));
  return parts.join(' ');
}

/* ==========================================================================
   kanjiapi.dev Fallback & Kuromoji Loader / Analyzer Patching
   ========================================================================== */
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
        if (stem && okuri) okuriRules.push({ stem, okuri });
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
      okuriRules,
      meanings: data.meanings || [],
      jlpt: data.jlpt || null,
      grade: data.grade || null,
      onReadingsRaw: data.on_readings || [],
      kunReadingsRaw: data.kun_readings || []
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
          if (spec.disallowNext && spec.disallowNext.test(nextSurf)) continue;
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

/* ==========================================================================
   Option 3: Japanese Conjugation & Sokuon Merger (Preserves Suffix Metadata)
   ========================================================================== */
const MERGEABLE_AUX_BASICS = new Set([
  'た', 'ます', 'ない', 'たい', 'う', 'よう', 'ん', 'ぬ', 'まい',
  'たら', 'れる', 'られる', 'せる', 'させる', 'ちゃ', 'ちゃう', 'じゃ', 'じゃう'
]);
const MERGEABLE_CONJ_PARTICLES = new Set(['て', 'で', 'ば', 'たら', 'たり', 'だり', 'ちゃ', 'じゃ']);
const MERGEABLE_VERB_SUFFIX_BASICS = new Set(['れる', 'られる', 'せる', 'させる', 'ちゃう', 'じゃう']);

function getSafeTokenReadingKata(tok) {
  if (tok && tok.reading && tok.reading !== '*') return tok.reading;
  return hiraganaToKatakana((tok && tok.surface_form) || '');
}

function getSafeTokenPronunciationKata(tok) {
  if (tok && tok.pronunciation && tok.pronunciation !== '*') return tok.pronunciation;
  return getSafeTokenReadingKata(tok);
}

function startsWithConsonantKana(tok) {
  const readHira = katakanaToHiragana(getSafeTokenReadingKata(tok));
  if (!readHira) return false;
  const two = readHira.substr(0, 2);
  const one = readHira[0];
  const rom = KANA_MAP[two] || KANA_MAP[one] || '';
  return /^[bcdfghjklmnpqrstvwxyz]/i.test(rom);
}

function shouldMergeConjugationToken(curr, next) {
  if (!curr || !next) return false;
  const currSurf = curr.surface_form || '';
  const nextSurf = next.surface_form || '';

  if (!currSurf || !nextSurf) return false;
  if (/^\s+$/.test(currSurf) || /^\s+$/.test(nextSurf)) return false;
  if (curr.pos === '記号' || next.pos === '記号') return false;

  // 1. Universal sokuon bridge: if current token ends in っ/ッ and next starts with a consonant kana
  if (/[っッ]$/.test(currSurf) && startsWithConsonantKana(next)) {
    return true;
  }

  // Only merge grammatical endings onto verbs, i-adjectives, or auxiliaries (never onto nouns)
  const isConjugableHost =
    curr.pos === '動詞' ||
    curr.pos === '形容詞' ||
    curr.pos === '助動詞';

  if (!isConjugableHost) return false;

  const nextBasic = (next.basic_form && next.basic_form !== '*') ? next.basic_form : nextSurf;

  // Keep polite/plain copula (です / だ) separate from preceding verbs/adjectives (e.g., 食べません でした, おいしい です)
  if (next.pos === '助動詞' && (nextBasic === 'です' || nextBasic === 'だ')) {
    // Exception: voiced past tense だ after verb stem ending in ん (e.g., 読ん + だ -> 読んだ)
    if (nextSurf === 'だ' && curr.pos === '動詞' && currSurf.endsWith('ん')) {
      return true;
    }
    return false;
  }

  // Keep く-form adjective + ない separate (e.g., 大きく なかった) so なかった merges cleanly as its own word
  if (curr.pos === '形容詞' && currSurf.endsWith('く') && nextBasic === 'ない') {
    return false;
  }

  // Do not glue another auxiliary onto an already-closed conjunctive te/de-form (e.g., 食べて ない)
  if (curr._endsWithConjParticle) {
    return false;
  }

  // 2. Bound auxiliary verbs (た, ます, ない, たい, う, よう, ん, ぬ, まい, etc.)
  if (next.pos === '助動詞' && MERGEABLE_AUX_BASICS.has(nextBasic)) {
    return true;
  }

  // 3. Bound verb suffixes (れる, られる, せる, させる, ちゃう, じゃう)
  if (
    next.pos === '動詞' &&
    (next.pos_detail_1 === '接尾' || next.pos_detail_1 === '非自立') &&
    MERGEABLE_VERB_SUFFIX_BASICS.has(nextBasic)
  ) {
    return true;
  }

  // 4. Bound conjunctive / representative particles directly on verb/adj/aux stems (て, で, ば, たら, たり, だり)
  if (
    next.pos === '助詞' &&
    (next.pos_detail_1 === '接続助詞' || next.pos_detail_1 === '並立助詞') &&
    MERGEABLE_CONJ_PARTICLES.has(nextSurf)
  ) {
    return true;
  }

  return false;
}

function mergeJapaneseConjugationTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return tokens;
  const result = [];

  for (let i = 0; i < tokens.length; i++) {
    const next = { ...tokens[i] };
    const curr = result.length > 0 ? result[result.length - 1] : null;

    if (curr && shouldMergeConjugationToken(curr, next)) {
      const currRead = getSafeTokenReadingKata(curr);
      const nextRead = getSafeTokenReadingKata(next);
      const currPron = getSafeTokenPronunciationKata(curr);
      const nextPron = getSafeTokenPronunciationKata(next);

      const nextBasic = (next.basic_form && next.basic_form !== '*') ? next.basic_form : (next.surface_form || '');
      const suffixInfo = {
        surface: next.surface_form || '',
        basic: nextBasic,
        reading: katakanaToHiragana(nextRead),
        pos: next.pos || '',
        posDetail: next.pos_detail_1 || ''
      };

      curr.surface_form = (curr.surface_form || '') + (next.surface_form || '');
      curr.reading = currRead + nextRead;
      curr.pronunciation = currPron + nextPron;
      curr._mergedSuffixes = [...(curr._mergedSuffixes || []), suffixInfo];

      if (
        next.pos === '助詞' &&
        (next.pos_detail_1 === '接続助詞' || next.pos_detail_1 === '並立助詞') &&
        (next.surface_form === 'て' || next.surface_form === 'で')
      ) {
        curr._endsWithConjParticle = true;
      } else {
        curr._endsWithConjParticle = false;
      }
    } else {
      result.push(next);
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
    const mergedCounters = mergeIrregularCounterTokens(rawTokens);
    const mergedConjugations = mergeJapaneseConjugationTokens(mergedCounters);
    return applyParticleGrammarRules(mergedConjugations);
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

/* ==========================================================================
   Furigana HTML & Japanese Aligned Segments Builder
   ========================================================================== */
async function buildFuriganaHtmlFromTokens(tokens) {
  let html = '';

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    const surf = tok.surface_form || '';
    if (!surf) continue;

    let innerHtml = '';
    if (tok._isParticleWa) {
      innerHtml = '<ruby>は<rt>わ</rt></ruby>';
    } else if (tok._isParticleE) {
      innerHtml = '<ruby>へ<rt>え</rt></ruby>';
    } else if (tok._hasTrailingWa) {
      const prefixSurf = surf.slice(0, -1);
      const prefixRead = (tok.reading || '').slice(0, -1);
      const prefixPron = (tok.pronunciation || '').slice(0, -1);
      if (KANJI_REGEX.test(prefixSurf)) {
        innerHtml = await convertTokensWithKuroshiro([{
          ...tok,
          surface_form: escapeHtml(prefixSurf),
          reading: prefixRead,
          pronunciation: prefixPron
        }], {
          to: 'hiragana',
          mode: 'furigana'
        });
      } else {
        innerHtml = escapeHtml(prefixSurf);
      }
      innerHtml += '<ruby>は<rt>わ</rt></ruby>';
    } else if (KANJI_REGEX.test(surf)) {
      innerHtml = await convertTokensWithKuroshiro([{
        ...tok,
        surface_form: escapeHtml(surf)
      }], {
        to: 'hiragana',
        mode: 'furigana'
      });
    } else {
      innerHtml = escapeHtml(surf);
    }

    if (/^\s+$/.test(surf)) {
      html += innerHtml;
    } else {
      const basic = (tok.basic_form && tok.basic_form !== '*') ? tok.basic_form : surf;
      const pronOrRead = (tok._isParticleWa || tok._isParticleE)
        ? (tok.pronunciation || tok.reading || surf)
        : (tok.reading || surf);
      const readHira = katakanaToHiragana(pronOrRead);
      const pos = tok.pos || '';
      const posDetail = tok.pos_detail_1 || '';
      const suffixesAttr = (Array.isArray(tok._mergedSuffixes) && tok._mergedSuffixes.length > 0)
        ? ` data-suffixes="${escapeHtml(JSON.stringify(tok._mergedSuffixes))}"`
        : '';
      html += `<span class="box1-token" data-seg-idx="${idx}" data-surface="${escapeHtml(surf)}" data-basic="${escapeHtml(basic)}" data-reading="${escapeHtml(readHira)}" data-pos="${escapeHtml(pos)}" data-pos-detail="${escapeHtml(posDetail)}"${suffixesAttr}>${innerHtml}</span>`;
    }
  }

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

async function convertJapaneseTokenToRomaji(tok) {
  const src = tok.surface_form || '';
  const readingKata = (tok.reading && tok.reading !== '*') ? tok.reading : '';

  // Handle true trailing sokuon (e.g., あっ！ -> a'!) instead of Kuroshiro's "tsu" fallback
  if (/[っッ]$/.test(src)) {
    const trimmedSrc = src.slice(0, -1);
    const trimmedRead = readingKata.endsWith('ッ') ? readingKata.slice(0, -1) : readingKata;
    const trimmedPron = (tok.pronunciation && tok.pronunciation.endsWith('ッ'))
      ? tok.pronunciation.slice(0, -1)
      : (tok.pronunciation || trimmedRead);

    if (!trimmedSrc) return "'";

    const baseRom = await convertTokensWithKuroshiro([{
      ...tok,
      surface_form: trimmedSrc,
      reading: trimmedRead || undefined,
      pronunciation: trimmedPron || undefined
    }], {
      to: 'romaji',
      mode: 'spaced',
      romajiSystem: 'hepburn'
    });
    return expandLeftoverChouonpu(baseRom.trim()) + "'";
  }

  const rawRom = await convertTokensWithKuroshiro([tok], {
    to: 'romaji',
    mode: 'spaced',
    romajiSystem: 'hepburn'
  });
  return expandLeftoverChouonpu(rawRom);
}

async function buildJapaneseAlignedSegments(tokens) {
  const segs = [];
  let charCursor = 0;

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    const src = tok.surface_form || '';
    if (!src) continue;

    const start = charCursor;
    const end = charCursor + src.length;
    charCursor = end;

    if (/^\s+$/.test(src)) {
      const nlCount = (src.match(/\n/g) || []).length;
      const nlStr = nlCount > 0 ? '\n'.repeat(nlCount) : '';
      segs.push({
        idx,
        src,
        rom: nlStr,
        romHtml: nlStr,
        isNewline: nlCount > 0,
        start,
        end
      });
      continue;
    }

    const rawRom = await convertJapaneseTokenToRomaji(tok);
    const isKanjiOrDigitNumber = PURE_JA_NUMBER_SURFACE_REGEX.test(src);
    const processed = postProcessJapaneseRomajiNumbers(rawRom, isKanjiOrDigitNumber);
    segs.push({
      idx,
      src,
      rom: processed.plain.trim(),
      romHtml: processed.html.trim(),
      start,
      end,
      basic: (tok.basic_form && tok.basic_form !== '*') ? tok.basic_form : src,
      reading: katakanaToHiragana(tok.reading || src),
      pos: tok.pos || '',
      posDetail: tok.pos_detail_1 || '',
      suffixes: tok._mergedSuffixes || []
    });
  }
  return segs;
}

function buildFallbackJapaneseAlignedSegments(text) {
  const segs = [];
  let charCursor = 0;
  let idx = 0;
  for (const ch of text) {
    const start = charCursor;
    const end = charCursor + ch.length;
    charCursor = end;
    if (ch === '\n') {
      segs.push({ idx, src: ch, rom: '\n', romHtml: '\n', isNewline: true, start, end });
    } else if (/\s/.test(ch)) {
      segs.push({ idx, src: ch, rom: '', romHtml: '', start, end });
    } else {
      const processed = fallbackJapaneseRomanizeWithBlueNumbers(ch);
      segs.push({
        idx,
        src: ch,
        rom: processed.plain.trim(),
        romHtml: processed.html.trim(),
        start,
        end,
        basic: ch,
        reading: katakanaToHiragana(ch),
        pos: '',
        posDetail: ''
      });
    }
    idx++;
  }
  return segs;
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
  let segIdx = 0;
  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) {
      html += escapeHtml(ch);
      i++;
      segIdx++;
      continue;
    }

    const kanjiMatch = resolveFallbackKanjiAt(str, i);
    const inner = (kanjiMatch && kanjiMatch.kana)
      ? `<ruby>${escapeHtml(ch)}<rt>${kanjiMatch.kana}</rt></ruby>`
      : escapeHtml(ch);

    html += `<span class="box1-token" data-seg-idx="${segIdx}" data-surface="${escapeHtml(ch)}" data-basic="${escapeHtml(ch)}" data-reading="${escapeHtml(kanjiMatch ? kanjiMatch.kana : ch)}" data-pos="" data-pos-detail="">${inner}</span>`;
    i++;
    segIdx++;
  }
  return html.endsWith('\n') ? html + '\u200b' : html;
}

function postProcessJapaneseRomajiNumbers(rawRomaji, isWholeTokenNumber = false) {
  const normalizedRaw = expandLeftoverChouonpu(rawRomaji);
  const parts = normalizedRaw.split(/([0-9０-９]+)/g).filter(Boolean);
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

  const cleanPlain = plainOut.replace(/ +/g, ' ').trim();
  const cleanHtml = isWholeTokenNumber && cleanPlain
    ? `<span class="romanized-number">${escapeHtml(cleanPlain)}</span>`
    : htmlOut.replace(/ +/g, ' ').trim();

  return {
    plain: cleanPlain,
    html: cleanHtml
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
      const nextTwo = str.substr(i + 1, 2);
      const nextOne = str[i + 1] || '';
      const nextRomaji = KANA_MAP[nextTwo] || KANA_MAP[nextOne] || '';
      const outCh = getSokuonHepburnConsonant(nextRomaji);
      plain += outCh;
      html += escapeHtml(outCh);
      i++;
      continue;
    }

    if (str[i] === 'ー') {
      const prevChar = plain.length > 0 ? plain[plain.length - 1] : '';
      const outCh = /[aiueoAIUEO]/.test(prevChar) ? prevChar.toLowerCase() : '-';
      plain += outCh;
      html += escapeHtml(outCh);
      i++;
      continue;
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

/* ==========================================================================
   Writable Box 2 Reverse Romaji -> Hiragana (lowercase) / Katakana (UPPERCASE)
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

    if (ch === '\n') {
      out += '\n';
      i++;
      continue;
    }

    if (/[ \t\r]/.test(ch)) {
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

/* ==========================================================================
   Japanese Hybrid Phrase IME (Google CGI API + Kuromoji 160k-Word Index)
   ========================================================================== */
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

const GRAMMAR_PARTICLES = new Set(['は', 'が', 'を', 'に', 'へ', 'で', 'と', 'の', 'も', 'や', 'か', 'ね', 'よ']);
const MULTI_CHAR_ENDINGS = ['だけの', 'だけ', 'から', 'まで', 'より', 'ほど', 'くらい', 'ぐらい', 'です', 'ます', 'でした', 'ました', 'ません', 'ない', 'たい'];

function assembleOfflineKanjiPhrase(hiraStr) {
  if (!hiraStr || hiraStr.length < 2) return [];

  const n = hiraStr.length;
  const dp = new Array(n + 1).fill(null);
  dp[0] = { cost: 0, text: '', altText: '' };

  for (let i = 0; i < n; i++) {
    if (!dp[i]) continue;

    for (const ending of MULTI_CHAR_ENDINGS) {
      if (i > 0 && hiraStr.startsWith(ending, i)) {
        const nextIdx = i + ending.length;
        const newCost = dp[i].cost + 1800;
        if (!dp[nextIdx] || newCost < dp[nextIdx].cost) {
          dp[nextIdx] = {
            cost: newCost,
            text: dp[i].text + ending,
            altText: dp[i].altText + ending
          };
        }
      }
    }

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

  const top1Phrase = data.map(seg => (seg[1] && seg[1][0]) ? seg[1][0] : seg[0]).join('');
  addUnique(top1Phrase);

  for (let segIdx = 0; segIdx < data.length; segIdx++) {
    const segCands = data[segIdx][1] || [];
    for (let cIdx = 1; cIdx < Math.min(3, segCands.length); cIdx++) {
      const variedPhrase = data
        .map((seg, idx) => idx === segIdx ? segCands[cIdx] : ((seg[1] && seg[1][0]) ? seg[1][0] : seg[0]))
        .join('');
      addUnique(variedPhrase);
    }
  }

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
  } catch (_) {}

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

  lookupWordCandidatesForHira(hiraQuery).forEach(addUnique);

  const assembledPhrases = assembleOfflineKanjiPhrase(hiraQuery);
  assembledPhrases.forEach(addUnique);

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

  if (hiraQuery.length >= 2) {
    for (const [key, list] of Object.entries(LOCAL_JA_IME_DICT)) {
      if (key.startsWith(hiraQuery) && key !== hiraQuery) {
        addUnique(list[0]);
        if (results.length >= 8) break;
      }
    }
  }

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

/* ==========================================================================
   Option 1 + Option 3: Kuromoji Grammar/POS Table + Conjugation Breakdowns
   ========================================================================== */
const JA_GRAMMAR_TOKEN_DICT = {
  'の': {
    posLabel: 'Particle (助詞)',
    senses: [
      "possessive particle ('s, of)",
      "nominalizer (turns a verb or clause into a noun: 'the one that...')",
      "explanatory or question-softening sentence-ending particle"
    ]
  },
  'は': {
    posLabel: 'Topic Particle (係助詞)',
    senses: [
      "topic marker (as for..., speaking of...)",
      "contrastive marker (at least..., in contrast to...)"
    ]
  },
  'が': {
    posLabel: 'Particle (格助詞 / 接続助詞)',
    senses: [
      "grammatical subject marker",
      "but / although / however (when linking two clauses)"
    ]
  },
  'を': {
    posLabel: 'Object Particle (格助詞)',
    senses: [
      "direct object marker (indicates the target of an action)",
      "through / along / departure point (with motion verbs)"
    ]
  },
  'に': {
    posLabel: 'Particle (格助詞)',
    senses: [
      "direction or destination (to, toward)",
      "location of existence (at, in, on)",
      "specific point in time (at, on, in)",
      "indirect object, purpose, or agent (to, for, by)"
    ]
  },
  'へ': {
    posLabel: 'Direction Particle (格助詞)',
    senses: [
      "direction / destination marker (to, toward, headed for)"
    ]
  },
  'で': {
    posLabel: 'Particle (格助詞)',
    senses: [
      "location where an action takes place (at, in)",
      "means, instrument, or tool (by, with, using)",
      "reason or cause (because of, due to)"
    ]
  },
  'と': {
    posLabel: 'Particle (格助詞 / 接続助詞)',
    senses: [
      "and / together with (accompaniment)",
      "quotation marker (that..., '...')",
      "natural conditional (when, if, whenever)"
    ]
  },
  'も': {
    posLabel: 'Particle (係助詞)',
    senses: [
      "also / too / as well",
      "both... and... / neither... nor... (when repeated)",
      "even (emphasis)"
    ]
  },
  'から': {
    posLabel: 'Particle (格助詞 / 接続助詞)',
    senses: [
      "from / since (starting point in time or space)",
      "because / since (reason or cause)"
    ]
  },
  'まで': {
    posLabel: 'Particle (副助詞)',
    senses: [
      "until / up to / as far as",
      "even (to the extent of)"
    ]
  },
  'より': {
    posLabel: 'Particle (格助詞)',
    senses: [
      "than / rather than (comparison)",
      "from (formal starting point)"
    ]
  },
  'だけ': {
    posLabel: 'Particle (副助詞)',
    senses: [
      "only / just / merely",
      "as much as / to the extent of"
    ]
  },
  'しか': {
    posLabel: 'Particle (係助詞)',
    senses: [
      "only / nothing but (used with a negative verb)"
    ]
  },
  'ばかり': {
    posLabel: 'Particle (副助詞)',
    senses: [
      "only / nothing but / always doing",
      "just finished doing (after ta-form)",
      "approximately / about"
    ]
  },
  'ほど': {
    posLabel: 'Particle (副助詞)',
    senses: [
      "to the extent of / degree / about",
      "the more... the more..."
    ]
  },
  'くらい': {
    posLabel: 'Particle (副助詞)',
    senses: [
      "approximately / about / around",
      "to the extent that / at least"
    ]
  },
  'ぐらい': {
    posLabel: 'Particle (副助詞)',
    senses: [
      "approximately / about / around",
      "to the extent that / at least"
    ]
  },
  'など': {
    posLabel: 'Particle (副助詞)',
    senses: [
      "et cetera (etc.) / and so on / such as"
    ]
  },
  'や': {
    posLabel: 'Particle (並立助詞)',
    senses: [
      "and (non-exhaustive list: 'things like A and B')"
    ]
  },
  'か': {
    posLabel: 'Particle (終助詞 / 副助詞)',
    senses: [
      "question marker (at end of sentence)",
      "or / whether / some-"
    ]
  },
  'ね': {
    posLabel: 'Sentence Particle (終助詞)',
    senses: [
      "isn't it? / right? (seeking agreement or confirmation)",
      "softens a statement"
    ]
  },
  'よ': {
    posLabel: 'Sentence Particle (終助詞)',
    senses: [
      "you know! / I tell you (adds emphasis or informs listener)"
    ]
  },
  'わ': {
    posLabel: 'Sentence Particle (終助詞)',
    senses: [
      "expressive or emphatic sentence-ending particle"
    ]
  },
  'ぞ': {
    posLabel: 'Sentence Particle (終助詞)',
    senses: [
      "strong assertive / emphatic sentence-ending particle"
    ]
  },
  'ぜ': {
    posLabel: 'Sentence Particle (終助詞)',
    senses: [
      "friendly assertive sentence-ending particle"
    ]
  },
  'て': {
    posLabel: 'Conjunctive Particle (接続助詞)',
    senses: [
      "te-form connector (links actions in sequence, 'and', 'by doing')"
    ]
  },
  'ば': {
    posLabel: 'Conditional Particle (接続助詞)',
    senses: [
      "if / when / provided that (conditional)"
    ]
  },
  'たら': {
    posLabel: 'Conditional Auxiliary (助動詞)',
    senses: [
      "if / when / after doing (conditional)"
    ]
  },
  'なら': {
    posLabel: 'Conditional Auxiliary (助動詞)',
    senses: [
      "if it is the case that / as for"
    ]
  },
  'ながら': {
    posLabel: 'Conjunctive Particle (接続助詞)',
    senses: [
      "while doing (simultaneous actions)",
      "although / despite"
    ]
  },
  'たり': {
    posLabel: 'Particle (並立助詞)',
    senses: [
      "doing things like A and B (representative actions)"
    ]
  },
  'だり': {
    posLabel: 'Particle (並立助詞)',
    senses: [
      "voiced form of たり (doing things like A and B)"
    ]
  },
  'のに': {
    posLabel: 'Conjunctive Particle (接続助詞)',
    senses: [
      "although / despite / even though",
      "in order to / for the purpose of"
    ]
  },
  'ので': {
    posLabel: 'Conjunctive Particle (接続助詞)',
    senses: [
      "because / since (polite reason or cause)"
    ]
  },
  'ても': {
    posLabel: 'Conjunctive Particle (接続助詞)',
    senses: [
      "even if / even though"
    ]
  },
  'でも': {
    posLabel: 'Particle (副助詞 / 接続助詞)',
    senses: [
      "even / also / or something",
      "but / however / even if"
    ]
  },
  'よう': {
    posLabel: 'Auxiliary / Grammar (助動詞)',
    senses: [
      "volitional suffix ('let's...', 'I will...') or supposition ('probably')",
      "manner / appearance / likeness ('like', 'seems that', 'in order to')"
    ]
  },
  'う': {
    posLabel: 'Volitional Auxiliary (助動詞)',
    senses: [
      "volitional / presumptive suffix ('let's...', 'will probably...')"
    ]
  },
  'まい': {
    posLabel: 'Negative Volitional (助動詞)',
    senses: [
      "will not / probably not / intend not to"
    ]
  },
  'です': {
    posLabel: 'Polite Copula (助動詞)',
    senses: [
      "is / am / are (polite copula)"
    ]
  },
  'だ': {
    posLabel: 'Plain Copula (助動詞)',
    senses: [
      "is / am / are (plain declarative copula)"
    ]
  },
  'ます': {
    posLabel: 'Polite Auxiliary (助動詞)',
    senses: [
      "polite verb suffix (present / future affirmative)"
    ]
  },
  'た': {
    posLabel: 'Past Auxiliary (助動詞)',
    senses: [
      "past tense or completed action suffix (-ed, did)"
    ]
  },
  'ない': {
    posLabel: 'Negative Auxiliary (助動詞)',
    senses: [
      "not / negation suffix (does not, is not)"
    ]
  },
  'ん': {
    posLabel: 'Auxiliary / Contraction (助動詞)',
    senses: [
      "contracted negative suffix (from ぬ, e.g. ません) or explanatory の"
    ]
  },
  'ぬ': {
    posLabel: 'Negative Auxiliary (助動詞)',
    senses: [
      "not / literary negation suffix"
    ]
  },
  'たい': {
    posLabel: 'Desiderative Auxiliary (助動詞)',
    senses: [
      "want to do... (expresses speaker's desire)"
    ]
  },
  'らしい': {
    posLabel: 'Auxiliary (助動詞)',
    senses: [
      "seems like / I heard that / typical of"
    ]
  },
  'そう': {
    posLabel: 'Auxiliary / Grammar (助動詞語幹)',
    senses: [
      "looks like / appears to be (visual impression) or 'I heard that'"
    ]
  },
  'れる': {
    posLabel: 'Auxiliary Verb (助動詞)',
    senses: [
      "passive ('is done'), potential ('can do'), or honorific suffix"
    ]
  },
  'られる': {
    posLabel: 'Auxiliary Verb (助動詞)',
    senses: [
      "passive ('is done'), potential ('can do'), or honorific suffix"
    ]
  },
  'せる': {
    posLabel: 'Causative Auxiliary (助動詞)',
    senses: [
      "causative suffix ('make someone do' / 'let someone do')"
    ]
  },
  'させる': {
    posLabel: 'Causative Auxiliary (助動詞)',
    senses: [
      "causative suffix ('make someone do' / 'let someone do')"
    ]
  },
  'ちゃう': {
    posLabel: 'Colloquial Auxiliary (補助動詞)',
    senses: [
      "colloquial contraction of てしまう (completely / accidentally / regrettably)"
    ]
  },
  'じゃう': {
    posLabel: 'Colloquial Auxiliary (補助動詞)',
    senses: [
      "voiced colloquial contraction of でしまう (completely / accidentally / regrettably)"
    ]
  },
  'ちゃ': {
    posLabel: 'Colloquial Contraction (助詞)',
    senses: [
      "colloquial contraction of ては or てしまう"
    ]
  },
  'じゃ': {
    posLabel: 'Colloquial Contraction (助詞)',
    senses: [
      "colloquial contraction of では or でしまう"
    ]
  },
  'とく': {
    posLabel: 'Colloquial Auxiliary (補助動詞)',
    senses: [
      "colloquial contraction of ておく (do in advance / leave as is)"
    ]
  },
  'てる': {
    posLabel: 'Colloquial Auxiliary (補助動詞)',
    senses: [
      "colloquial contraction of ている (ongoing action or resulting state)"
    ]
  }
};

function resolveLocalGrammarEntry(surface, basicForm, pos, posDetail) {
  if (KANJI_REGEX.test(surface)) return null;

  const isGrammarPos =
    pos === '助詞' ||
    pos === '助動詞' ||
    posDetail === '非自立' ||
    posDetail === '助動詞語幹' ||
    posDetail === '接尾';

  if (!isGrammarPos) return null;

  if (JA_GRAMMAR_TOKEN_DICT[surface]) return JA_GRAMMAR_TOKEN_DICT[surface];
  if (basicForm && JA_GRAMMAR_TOKEN_DICT[basicForm]) return JA_GRAMMAR_TOKEN_DICT[basicForm];
  return null;
}

function resolveConjugationSuffixExplanation(sfx) {
  if (!sfx) return null;
  const surf = sfx.surface || '';
  const basic = sfx.basic || surf;

  // Voiced conjunctive で (e.g., 飲んで) vs location particle で
  if (surf === 'で' && sfx.posDetail === '接続助詞') {
    return {
      title: "voiced te-form connector (links actions in sequence, 'and', 'by doing')",
      sub: 'Conjunctive Particle (接続助詞)'
    };
  }

  // Voiced past-tense だ (e.g., 読んだ) vs plain copula だ
  if (surf === 'だ' && (basic === 'た' || sfx.pos === '助動詞')) {
    return {
      title: 'voiced past tense or completed action suffix (-ed, did)',
      sub: 'Past Auxiliary (助動詞)'
    };
  }

  const entry = JA_GRAMMAR_TOKEN_DICT[surf] || JA_GRAMMAR_TOKEN_DICT[basic];
  if (entry && Array.isArray(entry.senses) && entry.senses.length > 0) {
    return {
      title: entry.senses[0],
      sub: entry.posLabel || sfx.pos || ''
    };
  }

  return {
    title: basic !== surf ? `Conjugation ending (${basic})` : 'Conjugation ending',
    sub: sfx.pos || ''
  };
}

function buildConjugationBreakdownCards(mergedSuffixes) {
  if (!Array.isArray(mergedSuffixes) || mergedSuffixes.length === 0) return [];
  const cards = [];
  for (const sfx of mergedSuffixes) {
    if (!sfx || !sfx.surface) continue;
    const info = resolveConjugationSuffixExplanation(sfx);
    if (!info) continue;
    cards.push({
      literal: `+${sfx.surface}`,
      title: info.title,
      meta: kanaToRomajiString(katakanaToHiragana(sfx.reading || sfx.surface)),
      sub: info.sub
    });
  }
  return cards;
}

function formatJotobaPosTag(posItem) {
  if (!posItem) return '';
  if (typeof posItem === 'string') return posItem;
  if (typeof posItem === 'object') {
    const keys = Object.keys(posItem);
    if (keys.length > 0) return keys[0];
  }
  return '';
}

function doesJotobaSenseMatchKuromojiPos(wordEntry, kuromojiPos) {
  if (!kuromojiPos || !wordEntry || !Array.isArray(wordEntry.senses)) return false;
  const posTags = wordEntry.senses
    .flatMap(s => Array.isArray(s.pos) ? s.pos.map(formatJotobaPosTag) : [])
    .join(' ')
    .toLowerCase();

  if (kuromojiPos === '動詞') return posTags.includes('verb');
  if (kuromojiPos === '名詞') return posTags.includes('noun') || posTags.includes('pronoun') || posTags.includes('counter') || posTags.includes('numeric');
  if (kuromojiPos === '形容詞') return posTags.includes('adjective') || posTags.includes('adjectival');
  if (kuromojiPos === '副詞') return posTags.includes('adverb');
  if (kuromojiPos === '連体詞') return posTags.includes('pre-noun') || posTags.includes('adjective');
  if (kuromojiPos === '接続詞') return posTags.includes('conjunction');
  if (kuromojiPos === '感動詞') return posTags.includes('interjection') || posTags.includes('expression');
  return false;
}

function selectBestJotobaWordEntry(words, surface, basicForm, readingHira, pos) {
  if (!Array.isArray(words) || words.length === 0) return null;

  const hasKanjiInBox1 = KANJI_REGEX.test(surface);
  const targetHira = katakanaToHiragana(readingHira || surface);
  const basicHira = katakanaToHiragana(basicForm || surface);

  let bestWord = null;
  let bestScore = -9999;

  for (const w of words) {
    if (!w || !w.reading) continue;
    let score = 0;
    const wKanji = w.reading.kanji || '';
    const wKanaHira = katakanaToHiragana(w.reading.kana || '');

    if (hasKanjiInBox1) {
      if (wKanji === basicForm || wKanji === surface) {
        score += 120;
      } else if (wKanji && (surface.includes(wKanji) || wKanji.includes(surface))) {
        score += 45;
      } else {
        score -= 80;
      }
    } else {
      if (wKanaHira === basicHira || wKanaHira === targetHira) {
        score += 60;
      } else {
        score -= 50;
      }
      if (!wKanji) score += 35;
      const sensesJson = JSON.stringify(w.senses || []);
      if (sensesJson.includes('UsuallyWrittenInKana')) score += 30;
    }

    if (wKanaHira === targetHira || wKanaHira === basicHira) score += 25;
    if (doesJotobaSenseMatchKuromojiPos(w, pos)) score += 45;
    if (w.common) score += 20;

    if (score > bestScore) {
      bestScore = score;
      bestWord = w;
    }
  }

  return bestWord || words[0];
}

async function postJotobaEndpoint(path, queryStr, timeoutMs = 2800) {
  const targetUrl = `https://jotoba.de/api/search/${path}`;
  const bodyPayload = JSON.stringify({
    query: queryStr,
    language: 'English',
    no_english: false
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
      return await res.json();
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function fetchJotobaDictionaryData(surface, basicForm, readingHira, pos, posDetail) {
  const lookupKey = (basicForm && basicForm !== '*') ? basicForm : surface;
  const cacheKey = `${surface}|${lookupKey}|${readingHira}|${pos}|${posDetail}`;
  if (JOTOBA_WORD_CACHE.has(cacheKey)) {
    return JOTOBA_WORD_CACHE.get(cacheKey);
  }

  const grammarEntry = resolveLocalGrammarEntry(surface, lookupKey, pos, posDetail);
  if (grammarEntry) {
    const grammarResult = {
      surface,
      basicForm: lookupKey,
      readingHira,
      isGrammar: true,
      grammarEntry,
      selectedWord: null,
      kanjiDetails: []
    };
    JOTOBA_WORD_CACHE.set(cacheKey, grammarResult);
    return grammarResult;
  }

  const wordData = await postJotobaEndpoint('words', lookupKey);
  let words = (wordData && Array.isArray(wordData.words)) ? wordData.words : [];

  if (words.length === 0 && lookupKey !== surface) {
    const fallbackWordData = await postJotobaEndpoint('words', surface);
    if (fallbackWordData && Array.isArray(fallbackWordData.words)) {
      words = fallbackWordData.words;
    }
  }

  const selectedWord = selectBestJotobaWordEntry(words, surface, lookupKey, readingHira, pos);

  const kanjiChars = [...new Set([...surface].filter(ch => KANJI_REGEX.test(ch)))];
  const kanjiDetails = [];

  if (kanjiChars.length > 0) {
    const jotobaKanjiList = (wordData && Array.isArray(wordData.kanji)) ? wordData.kanji : [];
    for (const kChar of kanjiChars) {
      if (JOTOBA_KANJI_CACHE.has(kChar)) {
        kanjiDetails.push(JOTOBA_KANJI_CACHE.get(kChar));
        continue;
      }

      let foundK = jotobaKanjiList.find(k => k && k.literal === kChar);
      if (!foundK) {
        const kRes = await postJotobaEndpoint('kanji', kChar, 2000);
        if (kRes && Array.isArray(kRes.kanji)) {
          foundK = kRes.kanji.find(k => k && k.literal === kChar) || kRes.kanji[0];
        }
      }

      if (foundK && foundK.meanings) {
        const kEntry = {
          literal: kChar,
          meanings: foundK.meanings.slice(0, 4),
          onyomi: (foundK.onyomi || []).slice(0, 3),
          kunyomi: (foundK.kunyomi || []).slice(0, 3),
          jlpt: foundK.jlpt || null,
          grade: foundK.grade || null
        };
        JOTOBA_KANJI_CACHE.set(kChar, kEntry);
        kanjiDetails.push(kEntry);
      } else {
        const apiK = await fetchKanjiApiData(kChar);
        if (apiK) {
          const kEntry = {
            literal: kChar,
            meanings: (apiK.meanings || []).slice(0, 4),
            onyomi: (apiK.onReadingsRaw || []).slice(0, 3),
            kunyomi: (apiK.kunReadingsRaw || []).slice(0, 3),
            jlpt: apiK.jlpt,
            grade: apiK.grade
          };
          JOTOBA_KANJI_CACHE.set(kChar, kEntry);
          kanjiDetails.push(kEntry);
        }
      }
    }
  }

  const result = {
    surface,
    basicForm: lookupKey,
    readingHira,
    isGrammar: false,
    grammarEntry: null,
    selectedWord,
    kanjiDetails
  };

  JOTOBA_WORD_CACHE.set(cacheKey, result);
  return result;
}

/* Standardized Japanese dictionary popover payload for romanizer.js */
async function lookupJapaneseTokenDict(tokenMeta) {
  const { surface, basic, reading, pos, posDetail } = tokenMeta;
  const hasKanjiInSurface = KANJI_REGEX.test(surface);
  const data = await fetchJotobaDictionaryData(surface, basic, reading, pos, posDetail);

  // Extract merged conjugation suffixes attached to this token (Option 3)
  let mergedSuffixes = Array.isArray(tokenMeta.suffixes) ? tokenMeta.suffixes : [];
  if (mergedSuffixes.length === 0 && typeof lastInspectedTokenEl !== 'undefined' && lastInspectedTokenEl) {
    const rawSuffixAttr = lastInspectedTokenEl.getAttribute('data-suffixes');
    if (rawSuffixAttr) {
      try {
        mergedSuffixes = JSON.parse(rawSuffixAttr);
      } catch (_) {}
    }
  }

  const badges = [];
  if (basic && basic !== surface) badges.push(`Root: ${basic}`);

  const senses = [];
  if (data.isGrammar && data.grammarEntry) {
    badges.push(data.grammarEntry.posLabel);
    for (const s of data.grammarEntry.senses) {
      senses.push({ pos: '', gloss: s });
    }
  } else {
    const topWord = data.selectedWord;
    if (topWord && topWord.common) badges.push('Common');
    if (pos) badges.push(pos);

    if (topWord && Array.isArray(topWord.senses)) {
      for (const sense of topWord.senses.slice(0, 4)) {
        const gloss = Array.isArray(sense.glosses) ? sense.glosses.join(', ') : '';
        const posList = Array.isArray(sense.pos)
          ? sense.pos.map(formatJotobaPosTag).filter(Boolean).slice(0, 2).join(', ')
          : '';
        if (gloss) senses.push({ pos: posList, gloss });
      }
    }
  }

  const charBreakdown = buildConjugationBreakdownCards(mergedSuffixes);
  if (hasKanjiInSurface && Array.isArray(data.kanjiDetails)) {
    for (const k of data.kanjiDetails) {
      const meanings = (k.meanings || []).join(', ') || 'Kanji';
      const readings = [...(k.onyomi || []), ...(k.kunyomi || [])].slice(0, 4).join(' · ');
      const meta = [k.jlpt ? `JLPT N${k.jlpt}` : '', k.grade ? `G${k.grade}` : ''].filter(Boolean).join(' ');
      charBreakdown.push({
        literal: k.literal,
        title: meanings,
        meta,
        sub: readings
      });
    }
  }

  return {
    headword: surface,
    reading: hasKanjiInSurface ? reading : '',
    romanization: kanaToRomajiString(katakanaToHiragana(reading || surface)),
    badges,
    senses,
    charBreakdown
  };
}

/* ==========================================================================
   Kuroshiro + Kuromoji Startup Initialization
   ========================================================================== */
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

async function initKuroshiro() {
  ensureGzippedDictLoader();
  if (typeof getBox2Backdrop === 'function') getBox2Backdrop();
  if (typeof initDictionaryAndCrossBoxHighlight === 'function') initDictionaryAndCrossBoxHighlight();
  if (typeof buildChinesePinyinIndex === 'function') buildChinesePinyinIndex();

  const KuroshiroClass = typeof Kuroshiro !== 'undefined' ? (Kuroshiro.default || Kuroshiro) : null;
  const KuromojiAnalyzerClass = typeof KuromojiAnalyzer !== 'undefined' ? (KuromojiAnalyzer.default || KuromojiAnalyzer) : null;

  if (typeof KuroshiroClass !== 'function' || typeof KuromojiAnalyzerClass !== 'function') {
    setEngineStatus('ready-fallback', 'Ready (kanjiapi.dev Mode)');
    return;
  }

  const cdnDictPaths = [
    'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/',
    'https://unpkg.com/kuromoji@0.1.2/dict/',
    'https://cdn.jsdelivr.net/npm/kuromoji-fix-dict@0.1.2/dict/'
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
      if (typeof updateRomanization === 'function') updateRomanization(false, true);
      return;
    } catch (e) {
      console.warn(`Kuromoji failed at ${dictPath}:`, e.message);
    }
  }

  setEngineStatus('ready-fallback', 'Ready (kanjiapi.dev Mode)');
  if (typeof updateRomanization === 'function') updateRomanization(false, true);
}
