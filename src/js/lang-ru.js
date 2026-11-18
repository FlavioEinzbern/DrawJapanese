/* ==========================================================================
   Russian Language Module (Cyrillic Romanizer + OpenRussian API Dictionary)
   ========================================================================== */
const RU_DICT_CACHE = new Map();

function romanizeRussian(str) {
  let res = '';
  for (const ch of str) {
    res += CYRILLIC_MAP[ch] !== undefined ? CYRILLIC_MAP[ch] : ch;
  }
  return res;
}

function ruUnder1000Romaji(n, isFeminine = false) {
  const parts = [];
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
  const parts = [];
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

/* ==========================================================================
   Writable Box 2 Reverse Latin -> Russian Cyrillic Converter
   ========================================================================== */
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

/* ==========================================================================
   Russian Aligned Segments & Backdrop Builder
   ========================================================================== */
function buildRussianAlignedSegmentsAndBackdrop(text) {
  const tokens = text.split(/(\s+|[0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)/g).filter(Boolean);
  const segs = [];
  let backdropHtml = '';
  let charCursor = 0;
  let idx = 0;

  for (const tok of tokens) {
    const start = charCursor;
    const end = charCursor + tok.length;
    charCursor = end;

    if (/^\s+$/.test(tok)) {
      const nlCount = (tok.match(/\n/g) || []).length;
      const nlStr = nlCount > 0 ? '\n'.repeat(nlCount) : '';
      segs.push({
        idx,
        src: tok,
        rom: nlStr,
        romHtml: nlStr,
        isNewline: nlCount > 0,
        start,
        end
      });
      backdropHtml += escapeHtml(tok);
      idx++;
      continue;
    }

    const isNum = /^([0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)$/.test(tok);
    const rom = isNum
      ? numberToRussianRomaji(normalizeAsciiDigits(tok)).trim()
      : romanizeRussian(tok).trim();
    const romHtml = isNum
      ? `<span class="romanized-number">${escapeHtml(rom)}</span>`
      : escapeHtml(rom);

    segs.push({
      idx,
      src: tok,
      rom,
      romHtml,
      start,
      end,
      basic: tok,
      reading: rom,
      pos: isNum ? 'Numeral' : ''
    });

    backdropHtml += `<span class="box1-token" data-seg-idx="${idx}" data-surface="${escapeHtml(tok)}" data-basic="${escapeHtml(tok)}" data-reading="${escapeHtml(rom)}" data-pos="${isNum ? 'Numeral' : ''}">${escapeHtml(tok)}</span>`;
    idx++;
  }

  return {
    segments: segs,
    backdropHtml: backdropHtml.endsWith('\n') ? backdropHtml + '\u200b' : backdropHtml
  };
}

/* ==========================================================================
   OpenRussian API Dictionary (`api.openrussian.org/suggestions`) + Fallbacks
   ========================================================================== */
function stripRussianAccents(str) {
  return String(str || '').replace(/\u0301/g, '').toLowerCase();
}

async function fetchOpenRussianSuggestions(word, timeoutMs = 2600) {
  const targetUrl = `https://api.openrussian.org/suggestions?q=${encodeURIComponent(word)}`;
  const urls = [
    targetUrl,
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
  ];

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.result && Array.isArray(data.result.words)) {
        return data.result.words;
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function lookupRussianTokenDict(tokenMeta) {
  const surface = (tokenMeta.surface || '').trim();
  const cleanWord = surface.replace(/[.,!?;:"'()[\]{}«»—-]/g, '').trim() || surface;
  const cacheKey = `ru|${cleanWord.toLowerCase()}`;
  if (RU_DICT_CACHE.has(cacheKey)) return RU_DICT_CACHE.get(cacheKey);

  const rom = romanizeRussian(cleanWord);
  const badges = [];
  const senses = [];
  let stressedHead = cleanWord;
  let rootNote = '';

  const [openRuWords, freeData, gtxData] = await Promise.all([
    fetchOpenRussianSuggestions(cleanWord),
    fetchFreeDictApiEntry('ru', cleanWord.toLowerCase()),
    fetchGoogleGtxBilingualDict('ru', cleanWord)
  ]);

  if (Array.isArray(openRuWords) && openRuWords.length > 0) {
    const cleanLower = cleanWord.toLowerCase();
    const exactMatch = openRuWords.find(w => w && w.ru && stripRussianAccents(w.ru) === cleanLower) || openRuWords[0];

    if (exactMatch) {
      badges.push('OpenRussian');
      if (exactMatch.ru) {
        const bareRu = stripRussianAccents(exactMatch.ru);
        if (bareRu === cleanLower) {
          stressedHead = exactMatch.ru;
        } else {
          rootNote = `Root: ${exactMatch.ru}`;
        }
      }
      if (exactMatch.type) badges.push(exactMatch.type);
      if (exactMatch.level) badges.push(`Level ${exactMatch.level}`);
      if (exactMatch.noun && exactMatch.noun.gender) {
        badges.push(`Gender: ${exactMatch.noun.gender}`);
      }
      if (exactMatch.verb && exactMatch.verb.aspect) {
        badges.push(`Aspect: ${exactMatch.verb.aspect}`);
      }

      if (Array.isArray(exactMatch.tl)) {
        for (const tlGroup of exactMatch.tl.slice(0, 4)) {
          const gloss = Array.isArray(tlGroup) ? tlGroup.join(', ') : String(tlGroup || '');
          if (gloss && !senses.some(item => item.gloss === gloss)) {
            senses.push({ pos: exactMatch.type || '', gloss });
          }
        }
      }
    }
  }

  if (freeData && Array.isArray(freeData.entries)) {
    for (const entry of freeData.entries.slice(0, 2)) {
      const pos = entry.partOfSpeech || '';
      if (pos && !badges.includes(pos)) badges.push(pos);
      if (Array.isArray(entry.senses)) {
        for (const s of entry.senses.slice(0, 3)) {
          if (s && s.definition && !senses.some(item => item.gloss === s.definition)) {
            senses.push({ pos, gloss: s.definition });
          }
        }
      }
    }
  }

  if (gtxData) {
    if (Array.isArray(gtxData.dict)) {
      for (const d of gtxData.dict.slice(0, 3)) {
        const pos = d.pos || '';
        if (d.base_form && d.base_form.toLowerCase() !== cleanWord.toLowerCase() && !rootNote) {
          rootNote = `Root: ${d.base_form}`;
        }
        const gloss = Array.isArray(d.terms) ? d.terms.slice(0, 4).join(', ') : '';
        if (gloss && !senses.some(item => item.gloss === gloss)) {
          senses.push({ pos, gloss });
        }
      }
    }
    if (senses.length === 0 && Array.isArray(gtxData.sentences) && gtxData.sentences[0] && gtxData.sentences[0].trans) {
      senses.push({ pos: '', gloss: gtxData.sentences[0].trans });
    }
  }

  if (rootNote) badges.unshift(rootNote);

  const result = {
    headword: stressedHead,
    reading: stressedHead !== surface ? surface : '',
    romanization: rom,
    badges,
    senses: senses.slice(0, 4),
    charBreakdown: []
  };

  RU_DICT_CACHE.set(cacheKey, result);
  return result;
}