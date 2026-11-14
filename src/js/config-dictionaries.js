/* ==========================================================================
   Shared DOM Elements & Global State
   ========================================================================== */
const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d');
const candidatesContainer = document.getElementById('candidates-container');
const box1Wrapper = document.getElementById('box1-wrapper');
const textOutputBox = document.getElementById('text-output-box');
const furiganaBackdrop = document.getElementById('furigana-backdrop');
const box2Wrapper = document.getElementById('box2-wrapper');
const romanizedOutputBox = document.getElementById('romanized-output-box');
const romanizedBackdrop = document.getElementById('romanized-backdrop');
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const recognizingIndicator = document.getElementById('recognizing-indicator');
const gridGuide = document.getElementById('grid-guide');
const drawingInstructions = document.getElementById('drawing-instructions');
const romanizationLabel = document.getElementById('romanization-label');
const translitDesc = document.getElementById('translit-mode-description');
const charCount = document.getElementById('char-count');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');

/* ==========================================================================
   Language Profiles Configuration
   ========================================================================== */
const LANGUAGES = {
  ja: {
    id: 'ja',
    name: 'Japanese',
    apiLang: 'ja-t-i0-handwrit',
    guideType: 'cjk',
    romajiName: 'Romaji (Hepburn)',
    instruction: 'Draw Japanese (Kanji, Hiragana, Katakana)',
    desc: 'Editable — lowercase → Hiragana, UPPERCASE → Katakana'
  },
  zh: {
    id: 'zh',
    name: 'Chinese',
    apiLang: 'zh-t-i0-handwrit',
    guideType: 'cjk',
    romajiName: 'Pinyin (with Tones)',
    instruction: 'Draw Chinese Characters (Hanzi / Hanja)',
    desc: 'Editable — Pinyin to Simplified & Traditional Hanzi'
  },
  ko: {
    id: 'ko',
    name: 'Korean',
    apiLang: 'ko-t-i0-handwrit',
    guideType: 'cjk',
    romajiName: 'Revised Romanization (RR)',
    instruction: 'Draw Korean Characters (Hangul)',
    desc: 'Editable — Revised Romanization (RR) to Hangul'
  },
  ru: {
    id: 'ru',
    name: 'Russian',
    apiLang: 'ru-t-i0-handwrit',
    guideType: 'cyrillic',
    romajiName: 'Latin Transliteration',
    instruction: 'Draw Russian Cyrillic (Print or Cursive)',
    desc: 'Editable — Latin Transliteration to Russian Cyrillic'
  }
};

let currentLang = 'ja';

/* ==========================================================================
   Japanese Kana, Irregular Counter & Starter Kanji Dictionaries
   ========================================================================== */
const KANA_MAP = {
  // Standard Hiragana
  'あ':'a','い':'i','う':'u','え':'e','お':'o',
  'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko',
  'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so',
  'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to',
  'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no',
  'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho',
  'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo',
  'や':'ya','ゆ':'yu','よ':'yo',
  'ら':'ra','り':'ri','る':'ru','れ':'れ','ろ':'ro',
  'わ':'wa','ゐ':'wi','ゑ':'we','を':'wo','ん':'n',
  'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go',
  'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo',
  'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do',
  'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo',
  'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po',
  'ゔ':'vu',

  // Standard Hiragana Digraphs (Youon)
  'きゃ':'kya','きゅ':'kyu','きょ':'kyo',
  'しゃ':'sha','しゅ':'shu','しょ':'sho',
  'ちゃ':'cha','ちゅ':'chu','ちょ':'cho',
  'にゃ':'nya','にゅ':'nyu','にょ':'nyo',
  'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo',
  'みゃ':'mya','みゅ':'myu','みょ':'myo',
  'りゃ':'rya','りゅ':'ryu','りょ':'ryo',
  'ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
  'じゃ':'ja','じゅ':'ju','じょ':'jo',
  'ぢゃ':'ja','ぢゅ':'ju','ぢょ':'jo',
  'びゃ':'bya','びゅ':'byu','びょ':'byo',
  'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo',

  // Extended Hiragana Digraphs
  'ふぁ':'fa','ふぃ':'fi','ふぇ':'fe','ふぉ':'fo','ふゃ':'fya','ふゅ':'fyu','ふょ':'fyo',
  'てぃ':'ti','でぃ':'di','とぅ':'tu','どぅ':'du','てゅ':'tyu','でゅ':'dyu',
  'しぇ':'she','じぇ':'je','ちぇ':'che',
  'うぃ':'wi','うぇ':'we','うぉ':'wo','いぇ':'ye',
  'ゔぁ':'va','ゔぃ':'vi','ゔぇ':'ve','ゔぉ':'vo','ゔゃ':'vya','ゔゅ':'vyu','ゔょ':'vyo',
  'つぁ':'tsa','つぃ':'tsi','つぇ':'tse','つぉ':'tso',
  'くぁ':'kwa','くぃ':'kwi','くぇ':'kwe','くぉ':'kwo','ぐぁ':'gwa',

  // Small Hiragana Standalone Fallbacks
  'ぁ':'a','ぃ':'i','ぅ':'u','ぇ':'e','ぉ':'o','ゃ':'ya','ゅ':'yu','ょ':'yo','ゎ':'wa',

  // Standard Katakana
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o',
  'カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
  'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so',
  'タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no',
  'ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
  'マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
  'ヤ':'ya','ユ':'yu','ヨ':'yo',
  'ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro',
  'ワ':'wa','ヰ':'wi','ヱ':'we','ヲ':'wo','ン':'n',
  'ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go',
  'ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo',
  'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do',
  'バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
  'パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po',
  'ヴ':'vu',

  // Standard Katakana Digraphs (Youon)
  'キャ':'kya','キュ':'kyu','キョ':'kyo',
  'シャ':'sha','シュ':'shu','ショ':'sho',
  'チャ':'cha','チュ':'chu','チョ':'cho',
  'ニャ':'nya','ニュ':'nyu','ニョ':'nyo',
  'ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo',
  'ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo',
  'ギャ':'gya','ギュ':'gyu','ギョ':'gyo',
  'ジャ':'ja','ジュ':'ju','ジョ':'jo',
  'ヂャ':'ja','ヂュ':'ju','ヂョ':'jo',
  'ビャ':'bya','ビュ':'byu','ビョ':'byo',
  'ピャ':'pya','ピュ':'pyu','ピョ':'pyo',

  // Modern Extended Katakana Digraphs
  'ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo','フャ':'fya','フュ':'fyu','フョ':'fyo',
  'ティ':'ti','ディ':'di','トゥ':'tu','ドゥ':'du','テュ':'tyu','デュ':'dyu',
  'シェ':'she','ジェ':'je','チェ':'che','スィ':'si','ズィ':'zi',
  'ウィ':'wi','ウェ':'we','ウォ':'wo','イェ':'ye',
  'ヴァ':'va','ヴィ':'vi','ヴェ':'ve','ヴォ':'vo','ヴャ':'vya','ヴュ':'vyu','ヴョ':'vyo',
  'ツァ':'tsa','ツィ':'tsi','ツェ':'tse','ツォ':'tso',
  'クァ':'kwa','クィ':'kwi','クェ':'kwe','クォ':'kwo',
  'グァ':'gwa','グィ':'gwi','グェ':'gwe','グォ':'gwo',

  // Small Katakana Standalone Fallbacks
  'ァ':'a','ィ':'i','ゥ':'u','ェ':'e','ォ':'o','ャ':'ya','ュ':'yu','ョ':'yo','ヮ':'wa','ヵ':'ka','ヶ':'ke',
  'ー': '-'
};
KANA_MAP['れ'] = 're';

// Irregular Japanese counters that Kuromoji splits when followed by particles like だけ / ほど / くらい
const IRREGULAR_COUNTER_COMPOUNDS = {
  '一人': { reading: 'ヒトリ', pronunciation: 'ヒトリ', disallowNext: /^(前|称|当|一|っ|ッ)/ },
  '二人': { reading: 'フタリ', pronunciation: 'フタリ', disallowNext: /^(前|称|三脚|羽織|静)/ },
  '二日': { reading: 'フツカ', pronunciation: 'フツカ', disallowNext: /^(酔)/ },
  '三日': { reading: 'ミッカ', pronunciation: 'ミッカ', disallowNext: /^(月|天下|坊主)/ },
  '四日': { reading: 'ヨッカ', pronunciation: 'ヨッカ', disallowNext: /^(市)/ },
  '五日': { reading: 'イツカ', pronunciation: 'イツカ', disallowNext: /^(市)/ },
  '六日': { reading: 'ムイカ', pronunciation: 'ムイカ', disallowNext: /^(町)/ },
  '七日': { reading: 'ナノカ', pronunciation: 'ナノカ' },
  '八日': { reading: 'ヨウカ', pronunciation: 'ヨウカ', disallowNext: /^(市|町|市場)/ },
  '九日': { reading: 'ココノカ', pronunciation: 'ココノカ' },
  '十日': { reading: 'トオカ', pronunciation: 'トオカ', disallowNext: /^(町|戎)/ },
  '十四日': { reading: 'ジュウヨッカ', pronunciation: 'ジュウヨッカ' },
  '二十日': { reading: 'ハツカ', pronunciation: 'ハツカ', disallowNext: /^(鼠|大根)/ },
  '二十四日': { reading: 'ニジュウヨッカ', pronunciation: 'ニジュウヨッカ' },
  '二十歳': { reading: 'ハタチ', pronunciation: 'ハタチ' }
};

const KANJI_FALLBACK = {
  // CJK Numeral Kanji Readings
  '零': { romaji: 'rei', kana: 'れい' },
  '〇': { romaji: 'maru', kana: 'まる' },
  '一': { romaji: 'ichi', kana: 'いち' },
  '二': { romaji: 'ni', kana: 'に' },
  '三': { romaji: 'san', kana: 'さん' },
  '四': { romaji: 'yon', kana: 'よん' },
  '五': { romaji: 'go', kana: 'ご' },
  '六': { romaji: 'roku', kana: 'ろく' },
  '七': { romaji: 'nana', kana: 'なな' },
  '八': { romaji: 'hachi', kana: 'はち' },
  '九': { romaji: 'kyuu', kana: 'きゅう' },
  '十': { romaji: 'juu', kana: 'じゅう' },
  '百': { romaji: 'hyaku', kana: 'ひゃく' },
  '千': { romaji: 'sen', kana: 'せん' },
  '万': { romaji: 'man', kana: 'まん' },
  '億': { romaji: 'oku', kana: 'おく' },

  // Irregular People, Day & Age Counters
  '一人': { romaji: 'hitori', kana: 'ひとり' },
  '二人': { romaji: 'futari', kana: 'ふたり' },
  '二日': { romaji: 'futsuka', kana: 'ふつか' },
  '三日': { romaji: 'mikka', kana: 'みっか' },
  '四日': { romaji: 'yokka', kana: 'よっか' },
  '五日': { romaji: 'itsuka', kana: 'いつか' },
  '六日': { romaji: 'muika', kana: 'むいか' },
  '七日': { romaji: 'nanoka', kana: 'なのか' },
  '八日': { romaji: 'youka', kana: 'ようか' },
  '九日': { romaji: 'kokonoka', kana: 'ここのか' },
  '十日': { romaji: 'tooka', kana: 'とおか' },
  '十四日': { romaji: 'juuyokka', kana: 'じゅうよっか' },
  '二十日': { romaji: 'hatsuka', kana: 'はつか' },
  '二十四日': { romaji: 'nijuuyokka', kana: 'にじゅうよっか' },
  '二十歳': { romaji: 'hatachi', kana: 'はたち' },

  // Common Starter Vocabulary
  '日本': { romaji: 'nihon', kana: 'にほん' },
  '東京': { romaji: 'toukyou', kana: 'とうきょう' },
  '私': { romaji: 'watashi', kana: 'わたし' },
  '俺': { romaji: 'ore', kana: 'おれ' },
  '僕': { romaji: 'boku', kana: 'ぼく' },
  '人': { romaji: 'hito', kana: 'ひと' },
  '学校': { romaji: 'gakkou', kana: 'がっこう' },
  '学生': { romaji: 'gakusei', kana: 'がくせい' },
  '先生': { romaji: 'sensei', kana: 'せんせい' },
  '大学': { romaji: 'daigaku', kana: 'だいがく' },
  '本': { romaji: 'hon', kana: 'ほん' },
  '愛': { romaji: 'ai', kana: 'あい' },
  '友': { romaji: 'tomo', kana: 'とも' },
  '友達': { romaji: 'tomodachi', kana: 'ともだち' },
  '水': { romaji: 'mizu', kana: 'みず' },
  '火': { romaji: 'hi', kana: 'ひ' },
  '金': { romaji: 'kane', kana: 'かね' },
  '木': { romaji: 'ki', kana: 'き' },
  '土': { romaji: 'tsuchi', kana: 'つち' },
  '日': { romaji: 'hi', kana: 'ひ' },
  '月': { romaji: 'tsuki', kana: 'つき' },
  '年': { romaji: 'toshi', kana: 'とし' },
  '時間': { romaji: 'jikan', kana: 'じかん' },
  '食べる': { romaji: 'taberu', kana: 'たべる' },
  '見る': { romaji: 'miru', kana: 'みる' },
  '聞く': { romaji: 'kiku', kana: 'きく' },
  '行く': { romaji: 'iku', kana: 'いく' },
  '来る': { romaji: 'kuru', kana: 'くる' },
  '何': { romaji: 'nani', kana: 'なに' }
};

/* ==========================================================================
   Multilingual Number Dictionaries
   ========================================================================== */
const CJK_DIGIT_VALUE = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
};

const CJK_SMALL_UNIT = { '十': 10, '百': 100, '千': 1000 };
const CJK_LARGE_UNIT = { '万': 10000, '億': 100000000, '亿': 100000000 };

const JA_DIGITS_ROMAJI = ['zero', 'ichi', 'ni', 'san', 'yon', 'go', 'roku', 'nana', 'hachi', 'kyuu'];
const JA_DIGITS_KANA   = ['ぜろ', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];

const ZH_DIGITS_HANZI  = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const ZH_DIGITS_PINYIN = ['líng', 'yī', 'èr', 'sān', 'sì', 'wǔ', 'liù', 'qī', 'bā', 'jiǔ'];

const KO_DIGITS_HANGUL = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

const RU_ONES = ["nol'", "odin", "dva", "tri", "chetyre", "pyat'", "shest'", "sem'", "vosem'", "devyat'"];
const RU_TEENS = ["desyat'", "odinnadtsat'", "dvenadtsat'", "trinadtsat'", "chetyrnadtsat'", "pyatnadtsat'", "shestnadtsat'", "semnadtsat'", "vosemnadtsat'", "devyatnadtsat'"];
const RU_TENS = ["", "desyat'", "dvadtsat'", "tridtsat'", "sorok", "pyat'desyat", "shest'desyat", "sem'desyat", "vosem'desyat", "devyanosto"];
const RU_HUNDREDS = ["", "sto", "dvesti", "trista", "chetyresta", "pyat'sot", "shest'sot", "sem'sot", "vosem'sot", "devyat'sot"];

/* ==========================================================================
   Korean Hangul & Jamo Lookup Tables
   ========================================================================== */
const CHO_JAMO  = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const JUNG_JAMO = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
const JONG_JAMO = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

const CHO_RR = {
  'ㄱ':'g','ㄲ':'kk','ㄴ':'n','ㄷ':'d','ㄸ':'tt','ㄹ':'r','ㅁ':'m','ㅂ':'b','ㅃ':'pp',
  'ㅅ':'s','ㅆ':'ss','ㅇ':'','ㅈ':'j','ㅉ':'jj','ㅊ':'ch','ㅋ':'k','ㅌ':'t','ㅍ':'p','ㅎ':'h'
};
const JUNG_RR = {
  'ㅏ':'a','ㅐ':'ae','ㅑ':'ya','ㅒ':'yae','ㅓ':'eo','ㅔ':'e','ㅕ':'yeo','ㅖ':'ye',
  'ㅗ':'o','ㅘ':'wa','ㅙ':'wae','ㅚ':'oe','ㅛ':'yo','ㅜ':'u','ㅝ':'wo','ㅞ':'we',
  'ㅟ':'wi','ㅠ':'yu','ㅡ':'eu','ㅢ':'ui','ㅣ':'i'
};
const JONG_RR = {
  '':'','ㄱ':'k','ㄲ':'k','ㄳ':'k','ㄴ':'n','ㄵ':'n','ㄶ':'n','ㄷ':'t',
  'ㄹ':'l','ㄺ':'k','ㄻ':'m','ㄼ':'l','ㄽ':'l','ㄾ':'l','ㄿ':'p','ㅀ':'l',
  'ㅁ':'m','ㅂ':'p','ㅄ':'p','ㅅ':'t','ㅆ':'t','ㅇ':'ng','ㅈ':'t','ㅊ':'t','ㅋ':'k','ㅌ':'t','ㅍ':'p','ㅎ':'t'
};

const STANDALONE_JAMO_MAP = {
  'ㄱ':'g','ㄲ':'kk','ㄳ':'ks','ㄴ':'n','ㄵ':'nj','ㄶ':'nh','ㄷ':'d','ㄸ':'tt','ㄹ':'r',
  'ㄺ':'lg','ㄻ':'lm','ㄼ':'lb','ㄽ':'ls','ㄾ':'lt','ㄿ':'lp','ㅀ':'lh','ㅁ':'m','ㅂ':'b',
  'ㅃ':'pp','ㅄ':'bs','ㅅ':'s','ㅆ':'ss','ㅇ':'ng','ㅈ':'j','ㅉ':'jj','ㅊ':'ch','ㅋ':'k','ㅌ':'t','ㅍ':'p','ㅎ':'h',
  'ㅏ':'a','ㅐ':'ae','ㅑ':'ya','ㅒ':'yae','ㅓ':'eo','ㅔ':'e','ㅕ':'yeo','ㅖ':'ye',
  'ㅗ':'o','ㅘ':'wa','ㅙ':'wae','ㅚ':'oe','ㅛ':'yo','ㅜ':'u','ㅝ':'wo','ㅞ':'we',
  'ㅟ':'wi','ㅠ':'yu','ㅡ':'eu','ㅢ':'ui','ㅣ':'i',
  'ᄀ':'g','ᄁ':'kk','ᄂ':'n','ᄃ':'d','ᄄ':'tt','ᄅ':'r','ᄆ':'m','ᄇ':'b','ᄈ':'pp',
  'ᄉ':'s','ᄊ':'ss','ᄋ':'ng','ᄌ':'j','ᄍ':'jj','ᄎ':'ch','ᄏ':'k','ᄐ':'t','ᄑ':'p','ᄒ':'h',
  'ᅡ':'a','ᅢ':'ae','ᅣ':'ya','ᅤ':'yae','ᅥ':'eo','ᅦ':'e','ᅧ':'yeo','ᅨ':'ye',
  'ᅩ':'o','ᅪ':'wa','ᅫ':'wae','ᅬ':'oe','ᅭ':'yo','ᅮ':'u','ᅯ':'wo','ᅰ':'we',
  'ᅱ':'wi','ᅲ':'yu','ᅳ':'eu','ᅴ':'ui','ᅵ':'i',
  'ᆨ':'k','ᆩ':'k','ᆪ':'k','ᆫ':'n','ᆬ':'n','ᆭ':'n','ᆮ':'t','ᆯ':'l','ᆰ':'k','ᆱ':'m',
  'ᆲ':'l','ᆳ':'l','ᆴ':'l','ᆵ':'p','ᆶ':'l','ᆷ':'m','ᆸ':'p','ᆹ':'p','ᆺ':'t','ᆻ':'t',
  'ᆼ':'ng','ᆽ':'t','ᆾ':'t','ᆿ':'k','ᇀ':'t','ᇁ':'p','ᇂ':'t'
};

const DOUBLE_JONG_SPLIT = {
  'ㄳ': ['ㄱ', 'ㅅ'],
  'ㄵ': ['ㄴ', 'ㅈ'],
  'ㄶ': ['ㄴ', 'ㅇ'],
  'ㄺ': ['ㄹ', 'ㄱ'],
  'ㄻ': ['ㄹ', 'ㅁ'],
  'ㄼ': ['ㄹ', 'ㅂ'],
  'ㄽ': ['ㄹ', 'ㅅ'],
  'ㄾ': ['ㄹ', 'ㅌ'],
  'ㄿ': ['ㄹ', 'ㅍ'],
  'ㅀ': ['ㄹ', 'ㅇ'],
  'ㅄ': ['ㅂ', 'ㅅ']
};

/* ==========================================================================
   Russian Cyrillic Lookup Table
   ========================================================================== */
const CYRILLIC_MAP = {
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I','Й':'Y',
  'К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F',
  'Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ъ':'"','Ы':'Y','Ь':"'",'Э':'E','Ю':'Yu','Я':'Ya',
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y',
  'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
  'х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'"','ы':'y','ь':"'",'э':'e','ю':'yu','я':'ya'
};
