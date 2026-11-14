/* ==========================================================================
   Language Engine & Romanization Handlers (Kuroshiro + Kuromoji + pinyin-pro)
   ========================================================================== */
let kuroshiroInstance = null;
let kuroshiroAnalyzer = null;
let isKuroshiroReady = false;
let alignedSegments = [];
let imeSuggestRequestId = 0;

/* In-memory Reading (Hiragana) -> Ranked Kanji Surface Forms extracted from Kuromoji */
const KUROMOJI_READING_INDEX = new Map();
let isKuromojiIndexBuilt = false;

/* In-memory Pinyin (toneless & toned) -> Ranked Hanzi built from pinyin-pro */
const ZH_PINYIN_TONELESS_INDEX = new Map();
const ZH_PINYIN_TONED_INDEX = new Map();
let isZhPinyinIndexBuilt = false;

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

/*
 * Build a non-blocking Chinese Pinyin (Toneless & Toned) -> Ranked Hanzi index
 * in memory using pinyin-pro so all tones (ˉ ˊ ˇ ˋ and neutral) work offline.
 */
const HIGH_FREQ_HANZI_SEED =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严首底液官德随病苏失尔死讲配女黄推显谈罪神艺呢吗妈麻骂码爸吧把八百北不吃茶车城出穿船床吹春词次从错打大但当到道得等点电店东懂动都读短对多饿儿二发饭方房放飞非分风服附父刚高哥歌个给跟更工公共狗古故刮关观光广贵国果过还海孩汉好号喝和河贺黑很红后候湖虎花画化话欢还换黄回会活火机鸡级极急几己记既家假价间见件健江讲交角脚叫觉姐解借今斤金进近京经景静九酒就旧局举句具剧决绝军开看康考棵科咳可渴克刻客空孔口哭苦库裤块快宽况矿困拉啦来蓝篮兰拦烂郎朗浪捞劳老乐雷累冷离梨礼李里理力历立丽利例连联脸练凉两亮谅辆聊林零领流留六龙楼路旅绿乱妈麻马骂吗慢忙毛冒么没眉梅美妹门闷们梦米迷秘蜜眠民敏名明鸣命摸模膜摩磨蘑魔抹末莫墨默谋某母亩木目牧拿哪那内男南难囊呢内嫩能你泥年中飯';

function addHanziToPinyinIndex(ch) {
  if (typeof pinyinPro === 'undefined' || !pinyinPro.pinyin) return;
  const pyNum = pinyinPro.pinyin(ch, { toneType: 'num' });
  if (!pyNum || !/^[a-züv]+[0-5]?$/i.test(pyNum)) return;

  const normalizedNum = pyNum.toLowerCase().replace(/ü/g, 'v');
  const toneless = normalizedNum.replace(/[0-5]/g, '');
  if (!toneless) return;

  let tonedList = ZH_PINYIN_TONED_INDEX.get(normalizedNum);
  if (!tonedList) {
    tonedList = [];
    ZH_PINYIN_TONED_INDEX.set(normalizedNum, tonedList);
  }
  if (!tonedList.includes(ch) && tonedList.length < 18) {
    tonedList.push(ch);
  }

  let tonelessList = ZH_PINYIN_TONELESS_INDEX.get(toneless);
  if (!tonelessList) {
    tonelessList = [];
    ZH_PINYIN_TONELESS_INDEX.set(toneless, tonelessList);
  }
  if (!tonelessList.includes(ch) && tonelessList.length < 24) {
    tonelessList.push(ch);
  }
}

function buildChinesePinyinIndex() {
  if (isZhPinyinIndexBuilt || typeof pinyinPro === 'undefined' || !pinyinPro.pinyin) return;
  isZhPinyinIndexBuilt = true;

  // 1. Immediate seed of high-frequency Chinese characters across all tones
  for (const ch of HIGH_FREQ_HANZI_SEED) {
    if (KANJI_REGEX.test(ch)) addHanziToPinyinIndex(ch);
  }

  // 2. Background chunked scan of common CJK block (0x4E00..0x9FA5)
  let code = 0x4E00;
  const END_CODE = 0x9FA5;
  const CHUNK = 450;

  function indexChunk() {
    const limit = Math.min(code + CHUNK, END_CODE);
    for (; code <= limit; code++) {
      addHanziToPinyinIndex(String.fromCharCode(code));
    }
    if (code <= END_CODE) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(indexChunk, { timeout: 120 });
      } else {
        setTimeout(indexChunk, 12);
      }
    }
  }

  indexChunk();
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

function buildChineseAlignedSegments(text) {
  const segs = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      segs.push({ src: ch, rom: '' });
      i++;
      continue;
    }
    const numMatch = text.slice(i).match(/^([0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)/);
    if (numMatch) {
      const token = numMatch[0];
      segs.push({ src: token, rom: romanizeNumberByLang(token, 'zh').trim() });
      i += token.length;
      continue;
    }
    const rom = romanizeChinese(ch).trim();
    segs.push({ src: ch, rom });
    i++;
  }
  return segs;
}

async function initKuroshiro() {
  ensureGzippedDictLoader();
  getBox2Backdrop();
  buildChinesePinyinIndex();

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
   Chinese Pinyin Tone Normalizer & Hybrid Phrase/All-Tone IME Engine
   ========================================================================== */
const PINYIN_ACCENT_MAP = {
  'ā': { base: 'a', tone: '1' }, 'á': { base: 'a', tone: '2' }, 'ǎ': { base: 'a', tone: '3' }, 'à': { base: 'a', tone: '4' },
  'ē': { base: 'e', tone: '1' }, 'é': { base: 'e', tone: '2' }, 'ě': { base: 'e', tone: '3' }, 'è': { base: 'e', tone: '4' },
  'ī': { base: 'i', tone: '1' }, 'í': { base: 'i', tone: '2' }, 'ǐ': { base: 'i', tone: '3' }, 'ì': { base: 'i', tone: '4' },
  'ō': { base: 'o', tone: '1' }, 'ó': { base: 'o', tone: '2' }, 'ǒ': { base: 'o', tone: '3' }, 'ò': { base: 'o', tone: '4' },
  'ū': { base: 'u', tone: '1' }, 'ú': { base: 'u', tone: '2' }, 'ǔ': { base: 'u', tone: '3' }, 'ù': { base: 'u', tone: '4' },
  'ǖ': { base: 'v', tone: '1' }, 'ǘ': { base: 'v', tone: '2' }, 'ǚ': { base: 'v', tone: '3' }, 'ǜ': { base: 'v', tone: '4' },
  'ü': { base: 'v', tone: '' }
};

/* Preserves string length while folding accented Pinyin vowels to plain ASCII */
function foldPinyinAccents(str) {
  if (!str) return '';
  const nfc = typeof str.normalize === 'function' ? str.normalize('NFC') : str;
  let out = '';
  for (const ch of nfc) {
    const lower = ch.toLowerCase();
    if (PINYIN_ACCENT_MAP[lower]) {
      out += PINYIN_ACCENT_MAP[lower].base;
    } else {
      out += lower;
    }
  }
  return out;
}

/* Parse a Pinyin syllable or phrase into toneless, toned (if specified), and Google API query */
function parseChinesePinyinInput(rawInput) {
  const nfc = (typeof rawInput.normalize === 'function' ? rawInput.normalize('NFC') : rawInput).trim();
  const rawTokens = nfc.split(/\s+/).filter(Boolean);
  const syllables = [];

  for (const tok of rawTokens) {
    let base = '';
    let detectedTone = '';
    for (const ch of tok) {
      const lower = ch.toLowerCase();
      if (PINYIN_ACCENT_MAP[lower]) {
        base += PINYIN_ACCENT_MAP[lower].base;
        if (PINYIN_ACCENT_MAP[lower].tone) detectedTone = PINYIN_ACCENT_MAP[lower].tone;
      } else if (/^[1-5]$/.test(lower)) {
        detectedTone = lower === '5' ? '0' : lower;
      } else if (/^[a-z']$/i.test(lower)) {
        base += lower;
      }
    }
    const cleanBase = base.replace(/'/g, '');
    if (cleanBase) {
      syllables.push({
        base: cleanBase,
        tone: detectedTone,
        tonedKey: detectedTone ? `${cleanBase}${detectedTone}` : cleanBase
      });
    }
  }

  const tonelessJoined = syllables.map(s => s.base).join('');
  const googleQuery = tonelessJoined.replace(/v/g, 'u');
  return { syllables, tonelessJoined, googleQuery };
}

const LOCAL_ZH_IME_DICT = {
  'nihao': ['你好', '您好'],
  'ninhao': ['您好', '你好'],
  'xiexie': ['谢谢', '謝謝'],
  'bukeqi': ['不客气', '不客氣'],
  'zaijian': ['再见', '再見'],
  'duibuqi': ['对不起', '對不起'],
  'meiguanxi': ['没关系', '沒關係'],
  'zaoshanghao': ['早上好'],
  'wanshanghao': ['晚上好'],
  'wanan': ['晚安'],
  'wo': ['我', '握', '窝', '卧', '沃'],
  'ni': ['你', '泥', '拟', '逆', '呢', '妳'],
  'ta': ['他', '她', '它', '塔', '踏', '塌'],
  'women': ['我们', '我們'],
  'nimen': ['你们', '你們'],
  'tamen': ['他们', '她们', '它们'],
  'shi': ['是', '十', '时', '事', '市', '师', '石', '食', '试', '室', '世', '识', '实', '史', '使', '始'],
  'bushi': ['不是'],
  'de': ['的', '地', '得', '德'],
  'le': ['了', '乐', '勒'],
  'ma': ['吗', '妈', '马', '麻', '骂', '码', '嘛', '蚂', '抹'],
  'ba': ['吧', '把', '爸', '八', '拔', '靶', '罢', '霸'],
  'ne': ['呢', '呐', '讷'],
  'a': ['啊', '阿', '呵'],
  'hao': ['好', '号', '毫', '豪', '耗', '浩'],
  'henhao': ['很好'],
  'bu': ['不', '步', '部', '布', '补', '捕', '簿'],
  'you': ['有', '又', '友', '右', '由', '油', '游', '优', '邮'],
  'meiyou': ['没有', '沒有'],
  'zai': ['在', '再', '载', '灾', '栽'],
  'zhe': ['这', '着', '者', '折', '哲', '浙'],
  'zheli': ['这里', '這裡'],
  'na': ['那', '哪', '拿', '纳', '娜', '呐'],
  'nali': ['哪里', '那里'],
  'shenme': ['什么', '什麼'],
  'zenme': ['怎么', '怎麼'],
  'weishenme': ['为什么', '為什麼'],
  'duoshao': ['多少'],
  'zhongguo': ['中国', '中國'],
  'zhongwen': ['中文'],
  'hanyu': ['汉语', '漢語'],
  'beijing': ['北京'],
  'shanghai': ['上海'],
  'riben': ['日本'],
  'meiguo': ['美国', '美國'],
  'xuesheng': ['学生', '學生'],
  'laoshi': ['老师', '老師'],
  'xuexiao': ['学校', '學校'],
  'pengyou': ['朋友'],
  'jia': ['家', '加', '假', '价', '架', '佳'],
  'ren': ['人', '任', '认', '忍', '仁', '刃'],
  'tian': ['天', '田', '填', '甜', '添'],
  'tianqi': ['天气', '天氣'],
  'jintian': ['今天'],
  'mingtian': ['明天'],
  'zuotian': ['昨天'],
  'jintiantianqihenhao': ['今天天气很好'],
  'xianzai': ['现在', '現在'],
  'shijian': ['时间', '時間'],
  'xiexieni': ['谢谢你'],
  'woaini': ['我爱你', '我愛你'],
  'xihuan': ['喜欢', '喜歡'],
  'ai': ['爱', '矮', '挨', '唉', '哀', '癌'],
  'chi': ['吃', '尺', '迟', '池', '持', '齿', '翅'],
  'chifan': ['吃饭', '吃飯'],
  'he': ['喝', '和', '河', '合', '盒', '何', '荷'],
  'heshui': ['喝水'],
  'shui': ['水', '谁', '睡', '税', '顺'],
  'kan': ['看', '砍', '侃', '刊', '堪'],
  'ting': ['听', '停', '挺', '厅', '亭', '庭'],
  'shuo': ['说', '硕', '烁', '朔'],
  'shuohua': ['说话', '說話'],
  'xie': ['写', '谢', '些', '鞋', '斜', '血', '蟹'],
  'du': ['读', '度', '毒', '独', '堵', '肚', '渡'],
  'lai': ['来', '赖', '莱'],
  'qu': ['去', '取', '区', '曲', '趣', '娶'],
  'hui': ['会', '回', '灰', '挥', '辉', '悔', '汇'],
  'xiang': ['想', '向', '像', '响', '香', '乡', '箱', '项'],
  'yao': ['要', '药', '咬', '摇', '腰', '邀', '耀'],
  'keyi': ['可以'],
  'zhidao': ['知道'],
  'mingzi': ['名字'],
  'wodemingzishi': ['我的名字是'],
  'woshi': ['我是'],
  'woshixuesheng': ['我是学生']
};

function lookupSinglePinyinSyllableCandidates(baseSyllable, toneNum = '') {
  buildChinesePinyinIndex();
  const out = [];
  const add = (ch) => {
    if (ch && !out.includes(ch)) out.push(ch);
  };

  // 1. If a specific tone (1..4) was typed via accent or digit, prioritize that exact tone first
  if (toneNum) {
    const tonedKey = `${baseSyllable}${toneNum}`;
    if (ZH_PINYIN_TONED_INDEX.has(tonedKey)) {
      ZH_PINYIN_TONED_INDEX.get(tonedKey).forEach(add);
    }
  }

  // 2. Curated dictionary for common syllables across all tones
  if (LOCAL_ZH_IME_DICT[baseSyllable]) {
    LOCAL_ZH_IME_DICT[baseSyllable].forEach(add);
  }

  // 3. Interleave characters across tones 1, 2, 3, 4, 0 so all tones (ˉ ˊ ˇ ˋ) are represented
  for (let round = 0; round < 4; round++) {
    for (const t of ['1', '2', '3', '4', '0']) {
      const tList = ZH_PINYIN_TONED_INDEX.get(`${baseSyllable}${t}`);
      if (tList && tList[round]) add(tList[round]);
    }
  }

  // 4. Fill remaining from toneless index
  if (ZH_PINYIN_TONELESS_INDEX.has(baseSyllable)) {
    ZH_PINYIN_TONELESS_INDEX.get(baseSyllable).forEach(add);
  }

  return out;
}

/* Split concatenated toneless Pinyin (e.g. "nihao" -> ["ni", "hao"]) using valid Pinyin keys */
function segmentConcatenatedPinyin(tonelessStr) {
  buildChinesePinyinIndex();
  const n = tonelessStr.length;
  const dp = new Array(n + 1).fill(null);
  dp[0] = [];

  for (let i = 0; i < n; i++) {
    if (!dp[i]) continue;
    for (let len = Math.min(6, n - i); len >= 1; len--) {
      const sub = tonelessStr.substr(i, len);
      if (ZH_PINYIN_TONELESS_INDEX.has(sub) || LOCAL_ZH_IME_DICT[sub]) {
        const nextIdx = i + len;
        const candidatePath = [...dp[i], sub];
        if (!dp[nextIdx] || candidatePath.length < dp[nextIdx].length) {
          dp[nextIdx] = candidatePath;
        }
      }
    }
  }
  return dp[n] || [tonelessStr];
}

function buildLocalChineseSuggestions(rawPinyin) {
  buildChinesePinyinIndex();
  const { syllables, tonelessJoined } = parseChinesePinyinInput(rawPinyin);
  if (!tonelessJoined) return [];

  const results = [];
  const addUnique = (val) => {
    if (val && !results.includes(val)) results.push(val);
  };

  // 1. Direct phrase match in LOCAL_ZH_IME_DICT
  if (LOCAL_ZH_IME_DICT[tonelessJoined]) {
    LOCAL_ZH_IME_DICT[tonelessJoined].forEach(addUnique);
  }

  // 2. If single syllable (with or without explicit tone), return all-tone options
  if (syllables.length === 1) {
    const singleSyl = syllables[0];
    lookupSinglePinyinSyllableCandidates(singleSyl.base, singleSyl.tone).forEach(addUnique);
  }

  // 3. Multi-syllable offline phrase assembly
  const effectiveSyllables = syllables.length > 1
    ? syllables
    : segmentConcatenatedPinyin(tonelessJoined).map(b => ({ base: b, tone: '' }));

  if (effectiveSyllables.length > 1) {
    let assembledBest = '';
    let i = 0;
    while (i < effectiveSyllables.length) {
      let matchedCompound = false;
      for (let span = Math.min(4, effectiveSyllables.length - i); span >= 2; span--) {
        const subKey = effectiveSyllables.slice(i, i + span).map(s => s.base).join('');
        if (LOCAL_ZH_IME_DICT[subKey]) {
          assembledBest += LOCAL_ZH_IME_DICT[subKey][0];
          i += span;
          matchedCompound = true;
          break;
        }
      }
      if (!matchedCompound) {
        const syl = effectiveSyllables[i];
        const cands = lookupSinglePinyinSyllableCandidates(syl.base, syl.tone);
        assembledBest += cands[0] || syl.base;
        i++;
      }
    }
    if (assembledBest) addUnique(assembledBest);

    // Also include top single-character options for the first syllable
    const firstSyl = effectiveSyllables[0];
    lookupSinglePinyinSyllableCandidates(firstSyl.base, firstSyl.tone).slice(0, 8).forEach(addUnique);
  }

  return results.slice(0, 12);
}

function fetchGoogleChinesePinyinJsonp(googleQuery, timeoutMs = 1800) {
  return new Promise((resolve, reject) => {
    const cbName = '_googleZhImeCb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
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
      reject(new Error('ZH JSONP timeout'));
    }, timeoutMs);

    window[cbName] = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (data && data[0] === 'SUCCESS' && data[1] && data[1][0] && Array.isArray(data[1][0][1])) {
        resolve(data[1][0][1]);
      } else {
        resolve([]);
      }
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error('ZH JSONP error'));
    };

    script.src = `https://inputtools.google.com/request?text=${encodeURIComponent(googleQuery)}&itc=zh-t-i0-pinyin&num=10&cp=0&cs=1&ie=utf-8&oe=utf-8&app=translate&cb=${cbName}`;
    document.head.appendChild(script);
  });
}

async function fetchGoogleChinesePinyinIme(googleQuery) {
  if (!googleQuery) return [];
  try {
    const jsonpList = await fetchGoogleChinesePinyinJsonp(googleQuery, 1800);
    if (jsonpList && jsonpList.length > 0) return jsonpList;
  } catch (_) {}

  const targetUrl = `https://inputtools.google.com/request?text=${encodeURIComponent(googleQuery)}&itc=zh-t-i0-pinyin&num=10&cp=0&cs=1&ie=utf-8&oe=utf-8&app=translate`;
  const endpoints = [
    targetUrl,
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      const res = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit', signal: controller.signal });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data[0] === 'SUCCESS' && data[1] && data[1][0] && Array.isArray(data[1][0][1])) {
        return data[1][0][1];
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
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
    while (scanPos < rawBox2.length && /\s/.test(rawBox2[scanPos])) {
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
    while (scanEnd > pos && /\s/.test(rawBox2[scanEnd - 1])) {
      scanEnd--;
    }
    const startCandidate = scanEnd - seg.rom.length;
    if (startCandidate > pos && /\s/.test(rawBox2[startCandidate - 1])) {
      const candidateSlice = rawBox2.slice(startCandidate, scanEnd);
      if (candidateSlice.length === seg.rom.length && compareRomajiSegmentSlices(candidateSlice, seg.rom)) {
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
    const localCands = buildLocalChineseSuggestions(subRomaji);
    return localCands[0] || subRomaji.trim();
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

function extractActiveChineseQueryRange(text) {
  const cursor = (document.activeElement === textOutputBox && textOutputBox.selectionEnd != null)
    ? textOutputBox.selectionEnd
    : text.length;

  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/([a-zA-Z0-5āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü']+)$/);
  if (!match) return null;

  const raw = match[1];
  const start = cursor - raw.length;
  return { start, end: cursor, raw };
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
      // If user explicitly typed a tone mark or tone number (e.g. mǎ or ma3), keep exact tone matches first
      const ordered = hasExplicitTone ? [...localList, ...remoteList] : [...remoteList, ...localList];
      for (const item of ordered) {
        if (item && !merged.includes(item)) merged.push(item);
      }

      // If user is actively typing in Box 2, update Box 1's live preview with the #1 phrase candidate
      if (replaceSpec.liveUpdateBox1 && merged[0] && document.activeElement === romanizedOutputBox) {
        const nextBox1 = (replaceSpec.prefixSrc || '') + merged[0] + (replaceSpec.suffixSrc || '');
        textOutputBox.value = nextBox1;
        charCount.textContent = `${nextBox1.length} char${nextBox1.length === 1 ? '' : 's'}`;
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
    if (triggerSuggestions && currentLang === 'zh') {
      updateTypingSuggestions(text);
    }
    if (!text.trim()) {
      alignedSegments = [];
      setBox2Content('', '', forceSyncBox2);
      autoResizeBoxes();
      return;
    }
    const result = await romanizeNonJapaneseTextAndNumbers(text, currentLang);
    if (conversionId !== currentConversionId) return;
    if (currentLang === 'zh') {
      alignedSegments = buildChineseAlignedSegments(text);
    } else {
      alignedSegments = text.trim().split(/\s+/).map(word => ({
        src: word,
        rom: currentLang === 'ru' ? romanizeRussian(word) : romanizeKorean(word)
      }));
    }
    setBox2Content(result.plain, result.html, forceSyncBox2);
    autoResizeBoxes();
  }
}
