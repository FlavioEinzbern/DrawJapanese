/* ==========================================================================
   Shared Cross-Language Utilities, Bounded Cache & Common Dictionary APIs
   Loaded after config-dictionaries.js and before all lang-*.js modules
   ========================================================================== */
const KANJI_REGEX = /[\u4E00-\u9FAF\u3400-\u4DBF]/;
const KANJI_API_CACHE = new Map();

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/* Bounded LRU-style Map cache helper to prevent unbounded memory growth */
function setBoundedCache(cacheMap, key, value, maxSize = 300) {
  if (!cacheMap || typeof cacheMap.set !== 'function') return;
  if (cacheMap.has(key)) {
    cacheMap.delete(key);
  } else if (cacheMap.size >= maxSize) {
    const oldestKey = cacheMap.keys().next().value;
    if (oldestKey !== undefined) {
      cacheMap.delete(oldestKey);
    }
  }
  cacheMap.set(key, value);
}

/* ==========================================================================
   Shared Dictionary & Kanji Lookup APIs (Used Across JA, ZH, KO, RU)
   ========================================================================== */
async function fetchKanjiApiData(char) {
  if (KANJI_API_CACHE.has(char)) return KANJI_API_CACHE.get(char);
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

    const toRomaji = typeof kanaToRomajiString === 'function' ? kanaToRomajiString : (s) => s;
    const entry = {
      kana: primaryKana,
      romaji: toRomaji(primaryKana),
      onKana: onList[0] || primaryKana,
      onRomaji: toRomaji(onList[0] || primaryKana),
      okuriRules,
      meanings: data.meanings || [],
      jlpt: data.jlpt || null,
      grade: data.grade || null,
      onReadingsRaw: data.on_readings || [],
      kunReadingsRaw: data.kun_readings || []
    };

    setBoundedCache(KANJI_API_CACHE, char, entry, 500);
    return entry;
  } catch (e) {
    console.warn(`kanjiapi.dev lookup failed for ${char}:`, e.message);
    return null;
  }
}

async function ensureKanjiReadingsLoaded(str) {
  const missing = [];
  for (const ch of str) {
    if (KANJI_REGEX.test(ch) && !KANJI_API_CACHE.has(ch)) {
      missing.push(ch);
    }
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    await Promise.all(unique.map(ch => fetchKanjiApiData(ch)));
  }
}

async function fetchFreeDictApiEntry(lang, word, timeoutMs = 2400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://freedictionaryapi.com/api/v1/entries/${lang}/${encodeURIComponent(word)}`, {
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

async function fetchGoogleGtxBilingualDict(sl, word, timeoutMs = 2400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=en&dt=bd&dt=t&dj=1&q=${encodeURIComponent(word)}`;
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
