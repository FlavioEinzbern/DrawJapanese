/* ==========================================================================
   Chinese Language Module (Intl.Segmenter + Pinyin IME + CC-CEDICT Dictionary)
   ========================================================================== */
const ZH_PINYIN_TONELESS_INDEX = new Map();
const ZH_PINYIN_TONED_INDEX = new Map();
let isZhPinyinIndexBuilt = false;

const ZH_DICT_CACHE = new Map();
const zhWordSegmenter = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

/* ==========================================================================
   Chinese Pinyin & Number Romanization
   ========================================================================== */
function romanizeChinese(str) {
  if (typeof pinyinPro !== 'undefined' && pinyinPro.pinyin) {
    return pinyinPro.pinyin(str, { toneType: 'symbol' });
  }
  return str;
}

function zhUnder10000Pinyin(n, isLeadingSection) {
  const units = ['', 'shí', 'bǎi', 'qiān'];
  const digits = [
    Math.floor(n / 1000),
    Math.floor((n % 1000) / 100),
    Math.floor((n % 100) / 10),
    n % 10
  ];
  const words = [];
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
  const parts = [];
  if (wan > 0) parts.push(zhUnder10000Pinyin(wan, true) + ' wàn');
  if (rem > 0) parts.push(zhUnder10000Pinyin(rem, wan === 0));
  return parts.join(' ');
}

/* ==========================================================================
   Chinese Word Segmentation & Aligned Backdrop Builder
   ========================================================================== */
function segmentChineseText(text) {
  if (!text) return [];
  if (zhWordSegmenter) {
    const rawSegs = [];
    for (const item of zhWordSegmenter.segment(text)) {
      rawSegs.push(item.segment);
    }
    return rawSegs;
  }
  return text.split(/(\s+|[0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+|[\u4E00-\u9FAF])/g).filter(Boolean);
}

function buildChineseAlignedSegmentsAndBackdrop(text) {
  const pieces = segmentChineseText(text);
  const segs = [];
  let backdropHtml = '';
  let charCursor = 0;
  let idx = 0;

  for (const piece of pieces) {
    if (!piece) continue;
    const start = charCursor;
    const end = charCursor + piece.length;
    charCursor = end;

    if (/^\s+$/.test(piece)) {
      const nlCount = (piece.match(/\n/g) || []).length;
      const nlStr = nlCount > 0 ? '\n'.repeat(nlCount) : '';
      segs.push({
        idx,
        src: piece,
        rom: nlStr,
        romHtml: nlStr,
        isNewline: nlCount > 0,
        start,
        end
      });
      backdropHtml += escapeHtml(piece);
      idx++;
      continue;
    }

    const isNum = /^([0-9０-９]+|[零〇一二两三四五六七八九十百千万億亿]+)$/.test(piece);
    const rom = isNum
      ? numberToChinesePinyin(normalizeAsciiDigits(piece)).trim()
      : romanizeChinese(piece).trim();
    const romHtml = isNum
      ? `<span class="romanized-number">${escapeHtml(rom)}</span>`
      : escapeHtml(rom);

    segs.push({
      idx,
      src: piece,
      rom,
      romHtml,
      start,
      end,
      basic: piece,
      reading: rom,
      pos: isNum ? 'Numeral' : ''
    });

    backdropHtml += `<span class="box1-token" data-seg-idx="${idx}" data-surface="${escapeHtml(piece)}" data-basic="${escapeHtml(piece)}" data-reading="${escapeHtml(rom)}" data-pos="${isNum ? 'Numeral' : ''}">${escapeHtml(piece)}</span>`;
    idx++;
  }

  return {
    segments: segs,
    backdropHtml: backdropHtml.endsWith('\n') ? backdropHtml + '\u200b' : backdropHtml
  };
}

/* ==========================================================================
   In-Memory Pinyin Index (All Tones ˉ ˊ ˇ ˋ + Neutral) & Hybrid Pinyin IME
   ========================================================================== */
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

  for (const ch of HIGH_FREQ_HANZI_SEED) {
    if (KANJI_REGEX.test(ch)) addHanziToPinyinIndex(ch);
  }

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

const PINYIN_ACCENT_MAP = {
  'ā': { base: 'a', tone: '1' }, 'á': { base: 'a', tone: '2' }, 'ǎ': { base: 'a', tone: '3' }, 'à': { base: 'a', tone: '4' },
  'ē': { base: 'e', tone: '1' }, 'é': { base: 'e', tone: '2' }, 'ě': { base: 'e', tone: '3' }, 'è': { base: 'e', tone: '4' },
  'ī': { base: 'i', tone: '1' }, 'í': { base: 'i', tone: '2' }, 'ǐ': { base: 'i', tone: '3' }, 'ì': { base: 'i', tone: '4' },
  'ō': { base: 'o', tone: '1' }, 'ó': { base: 'o', tone: '2' }, 'ǒ': { base: 'o', tone: '3' }, 'ò': { base: 'o', tone: '4' },
  'ū': { base: 'u', tone: '1' }, 'ú': { base: 'u', tone: '2' }, 'ǔ': { base: 'u', tone: '3' }, 'ù': { base: 'u', tone: '4' },
  'ǖ': { base: 'v', tone: '1' }, 'ǘ': { base: 'v', tone: '2' }, 'ǚ': { base: 'v', tone: '3' }, 'ǜ': { base: 'v', tone: '4' },
  'ü': { base: 'v', tone: '' }
};

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

  if (toneNum) {
    const tonedKey = `${baseSyllable}${toneNum}`;
    if (ZH_PINYIN_TONED_INDEX.has(tonedKey)) {
      ZH_PINYIN_TONED_INDEX.get(tonedKey).forEach(add);
    }
  }

  if (LOCAL_ZH_IME_DICT[baseSyllable]) {
    LOCAL_ZH_IME_DICT[baseSyllable].forEach(add);
  }

  for (let round = 0; round < 4; round++) {
    for (const t of ['1', '2', '3', '4', '0']) {
      const tList = ZH_PINYIN_TONED_INDEX.get(`${baseSyllable}${t}`);
      if (tList && tList[round]) add(tList[round]);
    }
  }

  if (ZH_PINYIN_TONELESS_INDEX.has(baseSyllable)) {
    ZH_PINYIN_TONELESS_INDEX.get(baseSyllable).forEach(add);
  }

  return out;
}

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

  if (LOCAL_ZH_IME_DICT[tonelessJoined]) {
    LOCAL_ZH_IME_DICT[tonelessJoined].forEach(addUnique);
  }

  if (syllables.length === 1) {
    const singleSyl = syllables[0];
    lookupSinglePinyinSyllableCandidates(singleSyl.base, singleSyl.tone).forEach(addUnique);
  }

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

/* ==========================================================================
   CC-CEDICT Chinese Dictionary Engine (Core Lexicon + Live CC-CEDICT/Wiktionary)
   ========================================================================== */
const CC_CEDICT_CORE = {
  '你好': { trad: '你好', py: 'nǐ hǎo', pos: 'Expression', glosses: ['hello; hi; how do you do'] },
  '您好': { trad: '您好', py: 'nín hǎo', pos: 'Expression', glosses: ['hello (polite); how do you do'] },
  '谢谢': { trad: '謝謝', py: 'xiè xie', pos: 'Verb / Expr', glosses: ['to thank; thanks; thank you'] },
  '不客气': { trad: '不客氣', py: 'bù kè qi', pos: 'Expression', glosses: ["you're welcome; don't mention it"] },
  '再见': { trad: '再見', py: 'zài jiàn', pos: 'Expression', glosses: ['goodbye; see you again later'] },
  '对不起': { trad: '對不起', py: 'duì bu qǐ', pos: 'Expression', glosses: ["I'm sorry; excuse me; pardon me"] },
  '没关系': { trad: '沒關係', py: 'méi guān xi', pos: 'Expression', glosses: ['it doesn\'t matter; never mind'] },
  '我': { trad: '我', py: 'wǒ', pos: 'Pronoun', glosses: ['I; me; my'] },
  '你': { trad: '你', py: 'nǐ', pos: 'Pronoun', glosses: ['you (informal, singular)'] },
  '您': { trad: '您', py: 'nín', pos: 'Pronoun', glosses: ['you (courteous, as opposed to informal 你)'] },
  '他': { trad: '他', py: 'tā', pos: 'Pronoun', glosses: ['he; him; his'] },
  '她': { trad: '她', py: 'tā', pos: 'Pronoun', glosses: ['she; her'] },
  '它': { trad: '它', py: 'tā', pos: 'Pronoun', glosses: ['it'] },
  '我们': { trad: '我們', py: 'wǒ men', pos: 'Pronoun', glosses: ['we; us; ourselves; our'] },
  '你们': { trad: '你們', py: 'nǐ men', pos: 'Pronoun', glosses: ['you (plural)'] },
  '他们': { trad: '他們', py: 'tā men', pos: 'Pronoun', glosses: ['they; them'] },
  '是': { trad: '是', py: 'shì', pos: 'Verb', glosses: ['to be (is, am, are); yes; indeed'] },
  '不是': { trad: '不是', py: 'bù shì', pos: 'Verb / Noun', glosses: ['is not; no; fault; blame'] },
  '的': { trad: '的', py: 'de', pos: 'Particle', glosses: ['possessive, modifying, or descriptive particle (of, ~\'s)'] },
  '了': { trad: '了', py: 'le', pos: 'Particle', glosses: ['completed action marker; modal particle indicating change of state'] },
  '吗': { trad: '嗎', py: 'ma', pos: 'Particle', glosses: ['question particle for "yes-no" questions'] },
  '呢': { trad: '呢', py: 'ne', pos: 'Particle', glosses: ['question particle for subjects already mentioned ("and how about...?")'] },
  '吧': { trad: '吧', py: 'ba', pos: 'Particle', glosses: ['modal particle indicating suggestion, request, or mild supposition'] },
  '不': { trad: '不', py: 'bù', pos: 'Adverb', glosses: ['no; not (negative prefix)'] },
  '没': { trad: '沒', py: 'méi', pos: 'Adverb / Verb', glosses: ['not; have not; there is not'] },
  '没有': { trad: '沒有', py: 'méi yǒu', pos: 'Verb / Adv', glosses: ['haven\'t; hasn\'t; doesn\'t exist; to not have'] },
  '有': { trad: '有', py: 'yǒu', pos: 'Verb', glosses: ['to have; there is; there are; to exist'] },
  '在': { trad: '在', py: 'zài', pos: 'Verb / Prep', glosses: ['to be located at; in; on; progressive aspect marker'] },
  '好': { trad: '好', py: 'hǎo', pos: 'Adjective', glosses: ['good; well; fine; proper; easy to'] },
  '很': { trad: '很', py: 'hěn', pos: 'Adverb', glosses: ['very; quite; much'] },
  '人': { trad: '人', py: 'rén', pos: 'Noun', glosses: ['person; people; human being (CL: 个, 位)'] },
  '中国': { trad: '中國', py: 'Zhōng guó', pos: 'Proper Noun', glosses: ['China'] },
  '中文': { trad: '中文', py: 'Zhōng wén', pos: 'Noun', glosses: ['Chinese language (written or spoken)'] },
  '汉语': { trad: '漢語', py: 'Hàn yǔ', pos: 'Noun', glosses: ['Chinese language; Mandarin'] },
  '日本': { trad: '日本', py: 'Rì běn', pos: 'Proper Noun', glosses: ['Japan'] },
  '北京': { trad: '北京', py: 'Běi jīng', pos: 'Proper Noun', glosses: ['Beijing, capital of China'] },
  '学生': { trad: '學生', py: 'xué sheng', pos: 'Noun', glosses: ['student; schoolchild (CL: 个, 名)'] },
  '老师': { trad: '老師', py: 'lǎo shī', pos: 'Noun', glosses: ['teacher; instructor (CL: 个, 位)'] },
  '学校': { trad: '學校', py: 'xué xiào', pos: 'Noun', glosses: ['school; educational institute (CL: 所)'] },
  '朋友': { trad: '朋友', py: 'péng you', pos: 'Noun', glosses: ['friend (CL: 个, 位)'] },
  '今天': { trad: '今天', py: 'jīn tiān', pos: 'Noun', glosses: ['today; at the present; now'] },
  '明天': { trad: '明天', py: 'míng tiān', pos: 'Noun', glosses: ['tomorrow'] },
  '昨天': { trad: '昨天', py: 'zuó tiān', pos: 'Noun', glosses: ['yesterday'] },
  '天气': { trad: '天氣', py: 'tiān qì', pos: 'Noun', glosses: ['weather'] },
  '时间': { trad: '時間', py: 'shí jiān', pos: 'Noun', glosses: ['time; period (CL: 段)'] },
  '现在': { trad: '現在', py: 'xiàn zài', pos: 'Noun', glosses: ['now; at present; right now'] },
  '喜欢': { trad: '喜歡', py: 'xǐ huan', pos: 'Verb', glosses: ['to like; to be fond of'] },
  '爱': { trad: '愛', py: 'ài', pos: 'Verb / Noun', glosses: ['to love; affection; to be fond of'] },
  '吃': { trad: '吃', py: 'chī', pos: 'Verb', glosses: ['to eat; to consume'] },
  '吃饭': { trad: '吃飯', py: 'chī fàn', pos: 'Verb', glosses: ['to have a meal; to eat'] },
  '喝': { trad: '喝', py: 'hē', pos: 'Verb', glosses: ['to drink'] },
  '水': { trad: '水', py: 'shuǐ', pos: 'Noun', glosses: ['water; liquid; river'] },
  '看': { trad: '看', py: 'kàn', pos: 'Verb', glosses: ['to see; to look at; to read; to watch'] },
  '听': { trad: '聽', py: 'tīng', pos: 'Verb', glosses: ['to listen; to hear; to obey'] },
  '说': { trad: '說', py: 'shuō', pos: 'Verb', glosses: ['to speak; to say; to explain'] },
  '写': { trad: '寫', py: 'xiě', pos: 'Verb', glosses: ['to write; to compose'] },
  '读': { trad: '讀', py: 'dú', pos: 'Verb', glosses: ['to read; to study'] },
  '来': { trad: '來', py: 'lái', pos: 'Verb', glosses: ['to come; to arrive'] },
  '去': { trad: '去', py: 'qù', pos: 'Verb', glosses: ['to go; to leave'] },
  '想': { trad: '想', py: 'xiǎng', pos: 'Verb', glosses: ['to think; to want to; to miss'] },
  '要': { trad: '要', py: 'yào', pos: 'Verb', glosses: ['to want; to need; will / going to'] },
  '会': { trad: '會', py: 'huì', pos: 'Verb', glosses: ['can; to know how to; will / likely to'] },
  '可以': { trad: '可以', py: 'kě yǐ', pos: 'Verb', glosses: ['can; may; possible; permissible'] },
  '知道': { trad: '知道', py: 'zhī dào', pos: 'Verb', glosses: ['to know; to be aware of'] },
  '名字': { trad: '名字', py: 'míng zi', pos: 'Noun', glosses: ['name (of a person or thing, CL: 个)'] },
  '什么': { trad: '什麼', py: 'shén me', pos: 'Pronoun', glosses: ['what?; something; anything'] },
  '怎么': { trad: '怎麼', py: 'zěn me', pos: 'Adverb', glosses: ['how?; what way?; why?'] },
  '为什么': { trad: '為什麼', py: 'wèi shén me', pos: 'Adverb', glosses: ['why?; for what reason?'] }
};

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

async function lookupChineseSingleCharMeaning(ch) {
  if (CC_CEDICT_CORE[ch]) {
    return {
      literal: ch,
      py: CC_CEDICT_CORE[ch].py || romanizeChinese(ch),
      meaning: CC_CEDICT_CORE[ch].glosses[0]
    };
  }
  const kApi = await fetchKanjiApiData(ch);
  if (kApi && Array.isArray(kApi.meanings) && kApi.meanings.length > 0) {
    return {
      literal: ch,
      py: romanizeChinese(ch),
      meaning: kApi.meanings.slice(0, 3).join(', ')
    };
  }
  const gtx = await fetchGoogleGtxBilingualDict('zh-CN', ch, 1600);
  let gloss = '';
  if (gtx && Array.isArray(gtx.dict) && gtx.dict[0] && Array.isArray(gtx.dict[0].terms)) {
    gloss = gtx.dict[0].terms.slice(0, 3).join(', ');
  } else if (gtx && Array.isArray(gtx.sentences) && gtx.sentences[0]) {
    gloss = gtx.sentences[0].trans || '';
  }
  return {
    literal: ch,
    py: romanizeChinese(ch),
    meaning: gloss || 'Chinese character'
  };
}

async function lookupChineseTokenDict(tokenMeta) {
  const surface = (tokenMeta.surface || '').trim();
  const cacheKey = `zh|${surface}`;
  if (ZH_DICT_CACHE.has(cacheKey)) return ZH_DICT_CACHE.get(cacheKey);

  const py = romanizeChinese(surface);
  const badges = ['CC-CEDICT'];
  const senses = [];
  let tradForm = '';

  // 1. Check in-memory CC-CEDICT Core Lexicon
  if (CC_CEDICT_CORE[surface]) {
    const core = CC_CEDICT_CORE[surface];
    if (core.trad && core.trad !== surface) tradForm = `Trad: ${core.trad}`;
    if (core.pos) badges.push(core.pos);
    for (const g of core.glosses) {
      senses.push({ pos: core.pos || '', gloss: g });
    }
  }

  // 2. Query FreeDictionaryAPI (Wiktionary CC-CEDICT data) & Google GTX Bilingual Dict in parallel
  const [freeData, gtxData] = await Promise.all([
    senses.length === 0 ? fetchFreeDictApiEntry('zh', surface) : Promise.resolve(null),
    senses.length < 2 ? fetchGoogleGtxBilingualDict('zh-CN', surface) : Promise.resolve(null)
  ]);

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
        const gloss = Array.isArray(d.terms) ? d.terms.slice(0, 4).join(', ') : '';
        if (gloss && !senses.some(item => item.gloss === gloss)) {
          senses.push({ pos, gloss });
        }
      }
    }
    if (senses.length === 0 && Array.isArray(gtxData.sentences) && gtxData.sentences[0] && gtxData.sentences[0].trans) {
      senses.push({ pos: 'Phrase', gloss: gtxData.sentences[0].trans });
    }
  }

  // 3. Per-character Hanzi breakdown
  const hanziChars = [...new Set([...surface].filter(ch => KANJI_REGEX.test(ch)))];
  const charBreakdown = [];
  if (hanziChars.length > 0 && (hanziChars.length > 1 || senses.length === 0)) {
    const details = await Promise.all(hanziChars.slice(0, 4).map(ch => lookupChineseSingleCharMeaning(ch)));
    for (const d of details) {
      charBreakdown.push({
        literal: d.literal,
        title: d.meaning,
        meta: d.py,
        sub: ''
      });
    }
  }

  const result = {
    headword: surface,
    reading: tradForm,
    romanization: py,
    badges,
    senses: senses.slice(0, 4),
    charBreakdown
  };

  ZH_DICT_CACHE.set(cacheKey, result);
  return result;
}