/* ==========================================================================
   Korean Language Module (Revised Romanization + Direct-CORS Dictionary)
   ========================================================================== */
const KO_DICT_CACHE = new Map();

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
        const prevJong = curr.jong;
        curr.jong = '';
        next.cho = (prevJong === 'ㄷ' || prevJong === 'ㅌ') ? 'ㅌ' : 'ㅊ';
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

/* ==========================================================================
   Writable Box 2 Reverse RR -> Hangul Syllable Composer
   ========================================================================== */
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

/* ==========================================================================
   Korean Aligned Segments & Backdrop Builder
   ========================================================================== */
function buildKoreanAlignedSegmentsAndBackdrop(text) {
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
      ? numberToKoreanRomaji(normalizeAsciiDigits(tok)).trim()
      : romanizeKorean(tok).trim();
    const romHtml = isNum
      ? `<span class="romanized-number">${escapeHtml(rom)}</span>`
      : escapeHtml(rom);

    const morph = analyzeKoreanMorphology(tok);

    segs.push({
      idx,
      src: tok,
      rom,
      romHtml,
      start,
      end,
      basic: morph.lemma,
      reading: rom,
      pos: morph.suffixLabel
    });

    backdropHtml += `<span class="box1-token" data-seg-idx="${idx}" data-surface="${escapeHtml(tok)}" data-basic="${escapeHtml(morph.lemma)}" data-reading="${escapeHtml(rom)}" data-pos="${escapeHtml(morph.suffixLabel)}">${escapeHtml(tok)}</span>`;
    idx++;
  }

  return {
    segments: segs,
    backdropHtml: backdropHtml.endsWith('\n') ? backdropHtml + '\u200b' : backdropHtml
  };
}

/* ==========================================================================
   Direct-CORS Korean Dictionary (FreeDictionaryAPI ko + Google GTX dt=bd)
   ========================================================================== */
const KO_PARTICLE_SUFFIXES = [
  ['에서부터', 'Particle: from (a place)'],
  ['으로부터', 'Particle: from (origin)'],
  ['로부터', 'Particle: from (origin)'],
  ['에게서', 'Particle: from (a person)'],
  ['한테서', 'Particle: from (a person)'],
  ['입니다', 'Copula: is / am / are (formal polite)'],
  ['입니까', 'Copula: is / am / are? (formal question)'],
  ['이에요', 'Copula: is / am / are (polite)'],
  ['예요', 'Copula: is / am / are (polite)'],
  ['습니다', 'Verb Ending: formal polite present'],
  ['ㅂ니다', 'Verb Ending: formal polite present'],
  ['었어요', 'Verb Ending: polite past (-ed)'],
  ['았어요', 'Verb Ending: polite past (-ed)'],
  ['했습니다', 'Verb: did (formal polite past of 하다)'],
  ['해요', 'Verb: does / is (polite present of 하다)'],
  ['어요', 'Verb Ending: polite present'],
  ['아요', 'Verb Ending: polite present'],
  ['에서', 'Particle: at / in / from (action location)'],
  ['에게', 'Particle: to / for (a person)'],
  ['한테', 'Particle: to / for (a person)'],
  ['으로', 'Particle: toward / by means of'],
  ['부터', 'Particle: from / since'],
  ['까지', 'Particle: until / up to'],
  ['처럼', 'Particle: like / as'],
  ['보다', 'Particle: than (comparison)'],
  ['마다', 'Particle: every / each'],
  ['하고', 'Particle: and / with'],
  ['은', 'Topic Particle (as for...)'],
  ['는', 'Topic Particle (as for...)'],
  ['이', 'Subject Particle'],
  ['가', 'Subject Particle'],
  ['을', 'Object Particle'],
  ['를', 'Object Particle'],
  ['에', 'Particle: at / in / to (location or time)'],
  ['로', 'Particle: toward / by means of'],
  ['와', 'Particle: and / with'],
  ['과', 'Particle: and / with'],
  ['도', 'Particle: also / too'],
  ['만', 'Particle: only / just'],
  ['의', "Possessive Particle ('s, of)"]
];

function analyzeKoreanMorphology(surface) {
  const clean = surface.replace(/[.,!?~"'()[\]{}]/g, '');
  if (clean.length <= 1) {
    return { lemma: clean || surface, stem: clean || surface, suffix: '', suffixLabel: '' };
  }

  for (const [sfx, label] of KO_PARTICLE_SUFFIXES) {
    if (clean.length > sfx.length && clean.endsWith(sfx)) {
      const stem = clean.slice(0, -sfx.length);
      const isVerbEnding = label.startsWith('Verb');
      const lemma = sfx === '했습니다' || sfx === '해요'
        ? stem + '하다'
        : (isVerbEnding ? stem + '다' : stem);
      return { lemma, stem, suffix: sfx, suffixLabel: label };
    }
  }

  return { lemma: clean, stem: clean, suffix: '', suffixLabel: '' };
}

async function lookupKoreanTokenDict(tokenMeta) {
  const surface = (tokenMeta.surface || '').trim();
  const cacheKey = `ko|${surface}`;
  if (KO_DICT_CACHE.has(cacheKey)) return KO_DICT_CACHE.get(cacheKey);

  const morph = analyzeKoreanMorphology(surface);
  const rr = romanizeKorean(surface);
  const badges = [];
  const senses = [];

  if (morph.lemma && morph.lemma !== surface) {
    badges.push(`Root: ${morph.lemma}`);
  }
  if (morph.suffixLabel) {
    badges.push(morph.suffixLabel);
  }

  // Direct-CORS parallel lookup: FreeDictionaryAPI (ko) + Google GTX Bilingual Dict (dt=bd & dt=t)
  const [freeLemma, gtxSurface, gtxLemma] = await Promise.all([
    fetchFreeDictApiEntry('ko', morph.lemma),
    fetchGoogleGtxBilingualDict('ko', surface),
    morph.lemma !== surface ? fetchGoogleGtxBilingualDict('ko', morph.lemma) : Promise.resolve(null)
  ]);

  if (freeLemma && Array.isArray(freeLemma.entries)) {
    for (const entry of freeLemma.entries.slice(0, 2)) {
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

  const processGtx = (gtxObj) => {
    if (!gtxObj) return;
    if (Array.isArray(gtxObj.dict)) {
      for (const d of gtxObj.dict.slice(0, 3)) {
        const pos = d.pos || '';
        if (d.base_form && d.base_form !== surface && !badges.some(b => b.startsWith('Root:'))) {
          badges.unshift(`Root: ${d.base_form}`);
        }
        const gloss = Array.isArray(d.terms) ? d.terms.slice(0, 4).join(', ') : '';
        if (gloss && !senses.some(item => item.gloss === gloss)) {
          senses.push({ pos, gloss });
        }
      }
    }
    if (senses.length === 0 && Array.isArray(gtxObj.sentences) && gtxObj.sentences[0] && gtxObj.sentences[0].trans) {
      senses.push({ pos: '', gloss: gtxObj.sentences[0].trans });
    }
  };

  processGtx(gtxLemma);
  processGtx(gtxSurface);

  const charBreakdown = [];
  if (morph.suffix && morph.suffixLabel) {
    charBreakdown.push({
      literal: `+${morph.suffix}`,
      title: morph.suffixLabel,
      meta: romanizeKorean(morph.suffix),
      sub: `Attached to ${morph.stem}`
    });
  }

  const result = {
    headword: surface,
    reading: morph.lemma !== surface ? morph.lemma : '',
    romanization: rr,
    badges,
    senses: senses.slice(0, 4),
    charBreakdown
  };

  setBoundedCache(KO_DICT_CACHE, cacheKey, result, 300);
  return result;
}
