/* ==========================================================================
   Canvas & Stroke Tracking (Google Input Tools Ink Format)
   ========================================================================== */
let strokes = [];
let currentStroke = { x: [], y: [], t: [] };
let isDrawing = false;
let strokeStartTime = 0;
let recognizeTimeout = null;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1e1b4b';
  
  redrawStrokes();
  if (typeof autoResizeBoxes === 'function') {
    autoResizeBoxes();
  }
}

function redrawStrokes() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  
  for (const stroke of strokes) {
    if (stroke.x.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(stroke.x[0], stroke.y[0]);
    if (stroke.x.length === 1) {
      ctx.lineTo(stroke.x[0] + 0.01, stroke.y[0]);
    } else {
      for (let i = 1; i < stroke.x.length; i++) {
        ctx.lineTo(stroke.x[i], stroke.y[i]);
      }
    }
    ctx.stroke();
  }
}

function getCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: Math.round(clientX - rect.left),
    y: Math.round(clientY - rect.top)
  };
}

function startDrawing(e) {
  e.preventDefault();
  clearTimeout(recognizeTimeout);
  isDrawing = true;
  strokeStartTime = Date.now();
  
  const { x, y } = getCoords(e);
  currentStroke = { x: [x], y: [y], t: [0] };
  
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 0.01, y);
  ctx.stroke();
}

function draw(e) {
  if (!isDrawing) return;
  e.preventDefault();
  const { x, y } = getCoords(e);
  const elapsed = Date.now() - strokeStartTime;
  
  currentStroke.x.push(x);
  currentStroke.y.push(y);
  currentStroke.t.push(elapsed);
  
  ctx.lineTo(x, y);
  ctx.stroke();
}

function stopDrawing(e) {
  if (!isDrawing) return;
  e.preventDefault();
  isDrawing = false;
  
  if (currentStroke.x.length > 0) {
    strokes.push({ ...currentStroke });
  }
  
  clearTimeout(recognizeTimeout);
  recognizeTimeout = setTimeout(fetchHandwritingCandidates, 450);
}

function clearCanvas() {
  strokes = [];
  currentStroke = { x: [], y: [], t: [] };
  clearTimeout(recognizeTimeout);
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  renderCandidates([]);
}

function undoLastStroke() {
  if (strokes.length > 0) {
    strokes.pop();
    redrawStrokes();
    clearTimeout(recognizeTimeout);
    if (strokes.length > 0) {
      recognizeTimeout = setTimeout(fetchHandwritingCandidates, 300);
    } else {
      renderCandidates([]);
    }
  }
}

/* ==========================================================================
   === CHECKPOINT 5 (JS): VPN-Resilient Handwriting Recognition ===
   - Fix 1: Multi-Endpoint Fallback Chain (Direct + Google Mirror + Relay Proxy)
   - Fix 2: Sanitized `device` payload & stripped Referrer/Credentials
   - Fix 3: Offline Client-Side Recognition (KanjiCanvas + HanziLookupJS)
   ========================================================================== */
let isKanjiCanvasInitialized = false;
let isHanziLookupOrigReady = false;
let isHanziLookupMmahReady = false;

function initOfflineRecognizers() {
  if (typeof KanjiCanvas !== 'undefined' && KanjiCanvas.init && !isKanjiCanvasInitialized) {
    try {
      KanjiCanvas.init('offline-kanji-canvas');
      isKanjiCanvasInitialized = true;
    } catch (e) {
      console.warn('KanjiCanvas init warning:', e);
    }
  }

  if (typeof HanziLookup !== 'undefined' && HanziLookup.init) {
    const HANZI_CDN = 'https://cdn.jsdelivr.net/gh/gugray/HanziLookupJS@master/dist/';
    if (!isHanziLookupOrigReady) {
      HanziLookup.init('orig', HANZI_CDN + 'orig.json', (ok) => {
        if (ok) isHanziLookupOrigReady = true;
      });
    }
    if (!isHanziLookupMmahReady) {
      HanziLookup.init('mmah', HANZI_CDN + 'mmah.json', (ok) => {
        if (ok) isHanziLookupMmahReady = true;
      });
    }
  }
}

async function recognizeOfflineFallback(rect) {
  if (strokes.length === 0) return [];
  const results = [];

  const scaleX = 256 / Math.max(rect.width, 1);
  const scaleY = 256 / Math.max(rect.height, 1);

  const normalizedStrokes256 = strokes
    .filter(s => s.x.length > 0)
    .map(s => s.x.map((x, idx) => [
      Math.round(x * scaleX),
      Math.round(s.y[idx] * scaleY)
    ]));

  if (typeof KanjiCanvas !== 'undefined' && KanjiCanvas.refPatterns) {
    try {
      if (!isKanjiCanvasInitialized && KanjiCanvas.init) {
        KanjiCanvas.init('offline-kanji-canvas');
        isKanjiCanvasInitialized = true;
      }
      KanjiCanvas['recordedPattern_offline-kanji-canvas'] = normalizedStrokes256.map(stroke =>
        stroke.map(pt => [pt[0], pt[1]])
      );
      const rawOut = KanjiCanvas.recognize('offline-kanji-canvas');
      if (typeof rawOut === 'string' && rawOut.trim()) {
        const parsed = rawOut.trim().split(/\s+/).filter(Boolean);
        for (const ch of parsed) {
          if (!results.includes(ch)) results.push(ch);
        }
      }
    } catch (e) {
      console.warn('KanjiCanvas fallback error:', e);
    }
  }

  if (typeof HanziLookup !== 'undefined' && (isHanziLookupMmahReady || isHanziLookupOrigReady)) {
    try {
      const analyzedChar = new HanziLookup.AnalyzedCharacter(normalizedStrokes256);
      const matcherName = (currentLang === 'zh' && isHanziLookupMmahReady)
        ? 'mmah'
        : (isHanziLookupOrigReady ? 'orig' : 'mmah');
      const matcher = new HanziLookup.Matcher(matcherName);

      const hanziMatches = await new Promise((resolve) => {
        matcher.match(analyzedChar, 10, (matches) => resolve(matches || []));
      });

      for (const m of hanziMatches) {
        if (m && m.character && !results.includes(m.character)) {
          results.push(m.character);
        }
      }
    } catch (e) {
      console.warn('HanziLookup fallback error:', e);
    }
  }

  return results.slice(0, 10);
}

async function postHandwritingWithTimeout(url, bodyString, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: bodyString,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data && data[0] === "SUCCESS" && data[1] && data[1][0] && data[1][0][1]) {
      return data[1][0][1];
    }
    throw new Error("Invalid handwriting response payload");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHandwritingCandidates() {
  if (strokes.length === 0) return;
  
  recognizingIndicator.classList.remove('hidden');
  const rect = canvas.getBoundingClientRect();
  const inkPayload = strokes.map(s => [s.x, s.y, s.t]);
  const apiLang = LANGUAGES[currentLang].apiLang;
  
  const payload = {
    app_version: 0.4,
    api_level: "537.36",
    device: "5.0 (Windows)",
    input_type: 0,
    options: "enable_pre_space",
    requests: [
      {
        writing_guide: {
          writing_area_width: Math.round(rect.width),
          writing_area_height: Math.round(rect.height)
        },
        pre_context: "",
        max_num_results: 10,
        max_completions: 0,
        language: apiLang,
        ink: inkPayload
      }
    ]
  };

  const bodyString = JSON.stringify(payload);
  const primaryUrl = `https://inputtools.google.com/request?itc=${apiLang}&app=translate`;
  const mirrorUrl = `https://www.google.com/inputtools/request?ime=handwriting&itc=${apiLang}&app=mobilesearch&cs=1&oe=UTF-8`;

  const endpoints = [
    primaryUrl,
    mirrorUrl,
    `https://corsproxy.io/?${encodeURIComponent(primaryUrl)}`
  ];

  try {
    for (const endpoint of endpoints) {
      try {
        const candidates = await postHandwritingWithTimeout(endpoint, bodyString, 3500);
        if (candidates && candidates.length > 0) {
          renderCandidates(candidates);
          return;
        }
      } catch (endpointErr) {
        console.warn(`Endpoint failed (${endpoint}):`, endpointErr.message);
      }
    }

    const offlineCandidates = await recognizeOfflineFallback(rect);
    renderCandidates(offlineCandidates);
  } finally {
    recognizingIndicator.classList.add('hidden');
  }
}

/* ==========================================================================
   Candidate Rendering & Insertion (Without Highlighting Box 1)
   ========================================================================== */
function renderCandidates(candidates) {
  candidatesContainer.innerHTML = '';
  if (!candidates || candidates.length === 0) {
    candidatesContainer.innerHTML = '<span class="text-xs text-slate-400 italic px-3">Draw a character on the canvas above...</span>';
    return;
  }

  candidates.forEach((cand) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'candidate-btn px-3.5 py-1.5 bg-white hover:bg-indigo-50 active:bg-indigo-100 text-slate-800 hover:text-indigo-600 font-medium text-lg border border-slate-200 rounded-xl transition-all shadow-sm flex items-center justify-center min-w-[44px] select-none';
    btn.textContent = cand;
    
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      insertCharacter(cand);
      clearCanvas();
    });

    candidatesContainer.appendChild(btn);
  });
}

function insertCharacter(char) {
  const start = textOutputBox.selectionStart ?? textOutputBox.value.length;
  const end = textOutputBox.selectionEnd ?? textOutputBox.value.length;
  const originalText = textOutputBox.value;
  
  textOutputBox.value = originalText.substring(0, start) + char + originalText.substring(end);
  textOutputBox.blur();

  updateRomanization();
}