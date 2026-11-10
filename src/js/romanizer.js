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
  ensureBox2Backdrop();

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

/* ==========================================================================
   === CHECKPOINT 6 (JS): Multilingual Number Romanizer & Blue Box 2 Backdrop ===
   ========================================================================== */
let romanizedBackdrop = null;

function ensureBox2Backdrop() {
  if (romanizedBackdrop) return;
  romanizedBackdrop = document.getElementById('romanized-backdrop');
  if (romanizedBackdrop) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'box2-wrapper';
  wrapper.className = 'relative w-full bg-slate-50/70 border border-slate-200 rounded-xl overflow-hidden';

  romanizedBackdrop = document.createElement('div');
  romanizedBackdrop.id = 'romanized-backdrop';
  romanizedBackdrop.setAttribute('aria-hidden', 'true');
  romanizedBackdrop.className = 'box1-shared-metrics absolute inset-0 w-full h-full text-slate-700 pointer-events-none select-none overflow-hidden';

  const parent = romanizedOutputBox.parentNode;
  parent.insertBefore(wrapper, romanizedOutputBox);
  wrapper.appendChild(romanizedBackdrop);
  wrapper.appendChild(romanizedOutputBox);

  romanizedOutputBox.classList.add('overlay-box2-active', 'relative', 'z-10');
  romanizedOutputBox.classList.remove('bg-slate-50/70', 'border', 'border-slate-200');

  const clearBtn = document.getElementById('btn-clear-text');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (romanizedBackdrop) romanizedBackdrop.innerHTML = '';
    });
  }
}

function setBox2Content(plainText, htmlText) {
  ensureBox2Backdrop();
  romanizedOutputBox.value = plainText;
  if (romanizedBackdrop) {
    romanizedBackdrop.innerHTML = htmlText.endsWith('\n') ? htmlText + '\u200b' : htmlText;
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
/* === END CHECKPOINT 6 (JS) === */

/* ==========================================================================
   === CHECKPOINT 7 & 8 (JS): Fix A — Native Kuroshiro Spaced Romaji on
       Unsplit Text + Post-Processed Blue Numbers (Kanji-Only Furigana in Box 1) ===
   To revert to Checkpoint 7 (DOM-derived romaji), uncomment deriveJapaneseRomajiFromFuriganaHtml.
   ========================================================================== */
/*
function deriveJapaneseRomajiFromFuriganaHtml(furiganaHtml) { ... }
*/

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

/* Fallback Furigana HTML for Box 1: Furigana ONLY on Kanji (never on Arabic numbers) */
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

/*
 * Fix A (CHECKPOINT 8): Post-process Kuroshiro's native `mode: 'spaced'` Romaji output.
 * Kuroshiro has already converted the full unsplit sentence (preserving word spacing,
 * `は` -> `wa`, `へ` -> `e`, and `2026年` -> `2026 nen`). This replaces the remaining
 * digit tokens with their romanized pronunciation in blue.
 */
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

/* Fallback Japanese Romanizer (when Kuromoji dict is still loading) with full string context & blue numbers */
function fallbackJapaneseRomanizeWithBlueNumbers(str) {
  let plain = '';
  let html = '';
  let i = 0;

  while (i < str.length) {
    // 1. Arabic digit run
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

    // 2. Multi-char Kanji compound match
    let compoundFound = false;
    for (let len = 4; len >= 2; len--) {
      const sub = str.substr(i, len);
      if (KANJI_FALLBACK[sub]) {
        const prefix = (plain && !/\s$/.test(plain)) ? ' ' : '';
        plain += prefix + KANJI_FALLBACK[sub].romaji + ' ';
        html += prefix + escapeHtml(KANJI_FALLBACK[sub].romaji) + ' ';
        i += len;
        compoundFound = true;
        break;
      }
    }
    if (compoundFound) continue;

    // 3. Single Kanji match (with full string `i` index so `2026年` sees `2026` before `年`)
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

    // 4. Sokuon (っ / ッ)
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

    // 5. Youon / Digraph (2-char Kana)
    const twoChar = str.substr(i, 2);
    if (KANA_MAP[twoChar]) {
      plain += KANA_MAP[twoChar];
      html += escapeHtml(KANA_MAP[twoChar]);
      i += 2;
      continue;
    }

    // 6. 1-char Kana
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
/* === END CHECKPOINT 7 & 8 (JS) === */

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
   Non-Japanese (zh, ko, ru) Text + Blue Number Romanizer
   ========================================================================== */
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

let currentConversionId = 0;

async function updateRomanization() {
  ensureBox2Backdrop();
  const text = textOutputBox.value;
  const conversionId = ++currentConversionId;
  charCount.textContent = `${text.length} char${text.length === 1 ? '' : 's'}`;

  if (!text) {
    furiganaBackdrop.innerHTML = '';
    setBox2Content('', '');
    autoResizeBoxes();
    return;
  }

  if (currentLang === 'ja') {
    // Immediate synchronous render from fallback cache
    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);

    if (!text.trim()) {
      setBox2Content('', '');
      autoResizeBoxes();
      return;
    }

    // Primary Path (CHECKPOINT 8 - Fix A): Run Kuroshiro's native spaced Romaji & Furigana on the full unsplit string
    if (isKuroshiroReady && kuroshiroInstance) {
      try {
        const safeText = escapeHtml(text);
        const [furiganaHtml, rawRomaji] = await Promise.all([
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

        const romResult = postProcessJapaneseRomajiNumbers(rawRomaji);
        setBox2Content(romResult.plain, romResult.html);
        autoResizeBoxes();
        return;
      } catch (e) {
        console.warn("Kuroshiro conversion error, running kanjiapi.dev fallback:", e);
      }
    }

    // Fallback Path: Full-string context romanizer + kanjiapi.dev
    const initialFallbackRom = fallbackJapaneseRomanizeWithBlueNumbers(text);
    setBox2Content(initialFallbackRom.plain, initialFallbackRom.html);
    autoResizeBoxes();

    await ensureKanjiReadingsLoaded(text);
    if (conversionId !== currentConversionId || currentLang !== 'ja') return;

    furiganaBackdrop.innerHTML = fallbackJapaneseFuriganaHtml(text);
    const updatedFallbackRom = fallbackJapaneseRomanizeWithBlueNumbers(text);
    setBox2Content(updatedFallbackRom.plain, updatedFallbackRom.html);
    autoResizeBoxes();
  } else {
    furiganaBackdrop.innerHTML = '';
    if (!text.trim()) {
      setBox2Content('', '');
      autoResizeBoxes();
      return;
    }
    const result = await romanizeNonJapaneseTextAndNumbers(text, currentLang);
    if (conversionId !== currentConversionId) return;
    setBox2Content(result.plain, result.html);
    autoResizeBoxes();
  }
}
