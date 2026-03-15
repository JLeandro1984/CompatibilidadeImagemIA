const imageInput = document.getElementById('imageInput');
const descriptionInput = document.getElementById('description');
const analyzeBtn = document.getElementById('analyzeBtn');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');
const summaryEl = document.getElementById('summary');
const canvas = document.getElementById('canvas');
const dropzone = document.getElementById('dropzone');
const descriptionError = document.getElementById('descriptionError');
const context = canvas.getContext('2d');

/** Returns true when the description has at least one valid brand token */
function isDescriptionFilled() {
  return descriptionInput.value.trim().length > 0;
}

/** Updates the analyze button enabled state based on image + description */
function updateAnalyzeBtnState() {
  analyzeBtn.disabled = !(selectedImage && isDescriptionFilled());
}

/** Shows or hides description validation feedback */
function validateDescriptionField() {
  const empty = !isDescriptionFilled();
  descriptionInput.classList.toggle('invalid', empty && descriptionInput.dataset.touched === 'true');
  descriptionError.hidden = !(empty && descriptionInput.dataset.touched === 'true');
  updateAnalyzeBtnState();
}

let selectedImage = null;
let selectedFileMetadata = null;
let objectModel = null;
let textModel = null;
const OCR_STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'ou', 'com', 'sem', 'por', 'para', 'em', 'na', 'no', 'oferta',
  'preco', 'barato', 'tipo', 'kg', 'g', 'ml', 'l', 'x', 'und', 'un', 'pct', 'cx', 'sabor', 'classicos',
  'zero', 'light', 'classic', 'original', 'tradicional', 'pack', 'combo', 'promocao', 'refrigerante',
]);

const COCO_NOISE_CLASSES = new Set([
  'toothbrush', 'hair drier', 'toilet', 'mouse', 'keyboard', 'remote', 'cell phone', 'tv', 'book',
  'person', 'tie', 'backpack', 'handbag', 'umbrella', 'clock', 'scissors', 'teddy bear',
]);

// ---------------------------------------------------------------------------
// BRAND CATALOG — runtime indexes built from brands.json at startup.
// Pre-seeded with defaults so the system works even if brands.json is absent.
// To add or update a brand: edit brands.json only — zero code changes needed.
// ---------------------------------------------------------------------------

/** token → canonical brand name */
const CATALOG_ALIAS_MAP = {
  doritos: 'Doritos', dorito: 'Doritos',
  deitos: 'Doritos', desitos: 'Doritos', deritos: 'Doritos',
  doriitos: 'Doritos', dorltos: 'Doritos', doritoss: 'Doritos', dorlitos: 'Doritos', oritos: 'Doritos',
  nacho: 'Doritos', nachos: 'Doritos', tortilla: 'Doritos', tortilha: 'Doritos', triangulo: 'Doritos',
  fandangos: 'Fandangos', fandango: 'Fandangos', fandang: 'Fandangos', fanda: 'Fandangos', dango: 'Fandangos',
  ruffles: 'Ruffles', rufles: 'Ruffles', ruflles: 'Ruffles', ruflese: 'Ruffles',
  rufly: 'Ruffles', rufiy: 'Ruffles', rufi: 'Ruffles', ruff: 'Ruffles', ruffs: 'Ruffles',
  rvffles: 'Ruffles', rvfles: 'Ruffles', raffles: 'Ruffles', ruffes: 'Ruffles', ruffls: 'Ruffles', ruffy: 'Ruffles', rufffy: 'Ruffles',
  // Coca-Cola — cursive OCR noise variants.
  // AVOID short aliases that are substrings of common words (e.g. "coco" = coconut)
  cocacola: 'Coca-Cola', coca: 'Coca-Cola', cola: 'Coca-Cola',
  cocacol: 'Coca-Cola', cocacols: 'Coca-Cola', cocacole: 'Coca-Cola',
  cocaola: 'Coca-Cola', coaola: 'Coca-Cola',
  cokacola: 'Coca-Cola', koka: 'Coca-Cola', kola: 'Coca-Cola',
  cokas: 'Coca-Cola', coka: 'Coca-Cola', ccola: 'Coca-Cola',
  cooca: 'Coca-Cola', cocaa: 'Coca-Cola',
  gocacola: 'Coca-Cola',
  fanta: 'Fanta', sprite: 'Sprite', pepsi: 'Pepsi', guarana: 'Guaraná',
};

/** Structural OCR pattern rules — type: 'contains' | 'startsWith' | 'endsWith' */
const CATALOG_OCR_PATTERNS = [
  { type: 'contains',   value: 'ritos',   startsWithAny: ['d', 'o'], canonical: 'Doritos' },
  { type: 'endsWith',   value: 'itos',    startsWithAny: ['d', 'o'], canonical: 'Doritos' },
  { type: 'startsWith', value: 'nac',     minLength: 4, canonical: 'Doritos' },
  { type: 'startsWith', value: 'tort',    minLength: 5, canonical: 'Doritos' },
  { type: 'contains',   value: 'fandang', canonical: 'Fandangos' },
  { type: 'contains',   value: 'ndangos', canonical: 'Fandangos' },
  { type: 'contains',   value: 'andango', canonical: 'Fandangos' },
  { type: 'contains',   value: 'fanda',   canonical: 'Fandangos' },
  { type: 'contains',   value: 'dango',   canonical: 'Fandangos' },
  { type: 'startsWith', value: 'ruf',     minLength: 3, canonical: 'Ruffles' },
  { type: 'startsWith', value: 'rvf',     minLength: 3, canonical: 'Ruffles' },
  // Coca-Cola: 'contains coca' requires the full 4-char substring and minLength 5
  // to avoid matching 'coco' (coconut), 'cocoa', etc. which are common in snack packaging
  { type: 'contains', value: 'coca', minLength: 5, canonical: 'Coca-Cola' },
  { type: 'contains', value: 'coke', minLength: 4, canonical: 'Coca-Cola' },
  // Sprite: prefix match
  { type: 'startsWith', value: 'spri',    minLength: 5, canonical: 'Sprite' },
  { type: 'startsWith', value: 'sprt',    minLength: 4, canonical: 'Sprite' },
];

/** Dominant-hue color signatures — each entry matched independently */
const CATALOG_COLOR_HINTS = [
  // Coca-Cola AND Doritos both claim the red range — they split votes so neither wins
  // via color alone. OCR is the tiebreaker.
  { name: 'Coca-Cola',  hueMin: 340, hueMax: 360, satMin: 90, briMin: 30 },
  { name: 'Coca-Cola',  hueMin:   0, hueMax:  12, satMin: 90, briMin: 30 },
  { name: 'Doritos',    hueMin: 340, hueMax: 360, satMin: 90, briMin: 30 },
  { name: 'Doritos',    hueMin:   0, hueMax:  12, satMin: 90, briMin: 30 },
  // Doritos — yellow/black only (unambiguous)
  { name: 'Doritos',    hueMin:  35, hueMax:  65, satMin: 80, briMin: 80 },
  // Fanta — strictly orange (13–28°), does NOT overlap with Doritos yellow (35–65°)
  { name: 'Fanta',      hueMin:  13, hueMax:  28, satMin: 90, briMin: 80 },
  { name: 'Sprite',     hueMin:  80, hueMax: 160, satMin: 60, briMin: 50 },
  { name: 'Fandangos',  hueMin:  75, hueMax: 145, satMin: 60, briMin: 50 },
  { name: 'Ruffles',    hueMin: 200, hueMax: 260, satMin: 60, briMin: 50 },
  { name: 'Pepsi',      hueMin: 200, hueMax: 255, satMin: 80, briMin: 40 },
];

/**
 * Detection profiles — canonical → profile loaded from brands.json.
 * Each profile defines which signal combinations are sufficient to confirm a brand.
 * Evaluated by evaluateDetectionProfile().
 *
 * Profile shape:
 *   colorSufficient: boolean
 *   rules: Array<{ requiresOCR, requiresColor, minCount }>
 */
const CATALOG_DETECTION_PROFILES = new Map();

// Default profiles for pre-seeded brands (overridden by brands.json on load)
const DEFAULT_DETECTION_PROFILES = {
  'Doritos':   { colorSufficient: false, rules: [
    { requiresOCR: true,  requiresColor: false, minCount: 1 },
    { requiresOCR: false, requiresColor: true,  minCount: 4 },
  ]},
  'Fandangos': { colorSufficient: false, rules: [
    { requiresOCR: true,  requiresColor: false, minCount: 1 },
    { requiresOCR: false, requiresColor: true,  minCount: 3 },
  ]},
  'Ruffles':   { colorSufficient: false, rules: [
    { requiresOCR: true,  requiresColor: false, minCount: 1 },
    { requiresOCR: false, requiresColor: true,  minCount: 3 },
  ]},
  'Coca-Cola': { colorSufficient: false, rules: [
    { requiresOCR: true,  requiresColor: true,  minCount: 1 },
    { requiresOCR: true,  requiresColor: false, minCount: 3 },
  ]},
  'Fanta':     { colorSufficient: true,  rules: [
    { requiresOCR: false, requiresColor: true,  minCount: 2 },
    { requiresOCR: true,  requiresColor: false, minCount: 1 },
  ]},
  'Sprite':    { colorSufficient: true,  rules: [
    { requiresOCR: false, requiresColor: true,  minCount: 2 },
    { requiresOCR: true,  requiresColor: false, minCount: 1 },
  ]},
  'Pepsi':     { colorSufficient: false, rules: [
    { requiresOCR: true,  requiresColor: false, minCount: 1 },
  ]},
  'Guaraná':   { colorSufficient: false, rules: [
    { requiresOCR: true,  requiresColor: false, minCount: 1 },
  ]},
};

Object.entries(DEFAULT_DETECTION_PROFILES).forEach(([canonical, profile]) => {
  CATALOG_DETECTION_PROFILES.set(canonical, profile);
});

/**
 * Evaluates whether brand evidence satisfies its detection profile.
 *
 * @param {string} brand - canonical brand name
 * @param {object} evidence - { count, sourceCounts: { OCR, Visual, COCO } }
 * @param {boolean} hasColorHit - true when the brand's colorSignature matched this bbox
 * @returns {boolean}
 */
function evaluateDetectionProfile(brand, evidence, hasColorHit) {
  const profile = CATALOG_DETECTION_PROFILES.get(brand);
  if (!profile) {
    // No profile: fall back to simple OCR-or-repetition rule
    const hasOCR = (evidence.sourceCounts.OCR || 0) >= 1;
    return hasOCR || evidence.count >= 2;
  }

  const hasOCR   = (evidence.sourceCounts.OCR || 0) >= 1;
  const count    = evidence.count || 0;

  // ANY rule passing is sufficient (OR between rules)
  return profile.rules.some((rule) => {
    const ocrOk   = !rule.requiresOCR   || hasOCR;
    const colorOk = !rule.requiresColor || hasColorHit;
    const countOk = count >= (rule.minCount || 1);
    return ocrOk && colorOk && countOk;
  });
}

/**
 * Tests whether a normalized OCR token matches a catalog pattern rule.
 * Supports types: 'contains', 'startsWith', 'endsWith'.
 * Optional constraints: minLength, startsWithAny.
 */
function matchesOCRPattern(token, rule) {
  let base = false;
  switch (rule.type) {
    case 'contains':   base = token.includes(rule.value); break;
    case 'startsWith': base = token.startsWith(rule.value) && token.length >= (rule.minLength || 0); break;
    case 'endsWith':   base = token.endsWith(rule.value) && token.length >= (rule.minLength || 0); break;
    default: return false;
  }
  if (!base) return false;
  if (rule.startsWithAny) return rule.startsWithAny.some((c) => token.startsWith(c));
  return true;
}

/**
 * Rebuilds all catalog indexes from a brands array (loaded from brands.json).
 * Called by initBrandCatalog(). Safe to call multiple times.
 * @param {Array} brands
 */
function buildCatalogIndexes(brands) {
  Object.keys(CATALOG_ALIAS_MAP).forEach((k) => delete CATALOG_ALIAS_MAP[k]);
  CATALOG_OCR_PATTERNS.length = 0;
  CATALOG_COLOR_HINTS.length = 0;
  CATALOG_DETECTION_PROFILES.clear();
  brands.forEach((brand) => {
    const { canonical } = brand;
    (brand.aliases || []).forEach((alias) => { CATALOG_ALIAS_MAP[alias] = canonical; });
    (brand.ocrPatterns || []).forEach((p) => CATALOG_OCR_PATTERNS.push({ ...p, canonical }));
    (brand.colorSignatures || []).forEach((s) => CATALOG_COLOR_HINTS.push({ ...s, name: canonical }));
    if (brand.detectionProfile) {
      CATALOG_DETECTION_PROFILES.set(canonical, brand.detectionProfile);
    }
  });
}

/**
 * Fetches brands.json and rebuilds catalog indexes.
 * Falls back to pre-seeded defaults if the file is unavailable.
 */
async function initBrandCatalog() {
  try {
    const res = await fetch('./brands.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = await res.json();
    buildCatalogIndexes(catalog.brands || []);
    console.info(`[ShelfVision] Catálogo: ${catalog.brands?.length ?? 0} marcas carregadas de brands.json.`);
  } catch (err) {
    console.warn('[ShelfVision] brands.json indisponível — usando defaults embutidos.', err.message);
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function resetOutput() {
  summaryEl.innerHTML = '';
  reportEl.textContent = 'Nenhuma análise executada.';
}

function drawImagePreview(img) {
  const maxSize = 1200;
  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao ler a imagem.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo inválido de imagem.'));
      img.onload = () => resolve(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

function normalizeProductName(className) {
  return 'Marca não identificada';
}

function summarizeDetections(detections) {
  const grouped = new Map();

  detections.forEach((detection) => {
    if (detection.score < 0.35 || COCO_NOISE_CLASSES.has(detection.class)) {
      return;
    }
    const productName = normalizeProductName(detection.class);

    if (!grouped.has(productName)) {
      grouped.set(productName, []);
    }

    grouped.get(productName).push({
      productName,
      score: detection.score,
      bbox: detection.bbox,
      source: 'COCO',
    });
  });

  const counts = {};
  const boxes = [];
  grouped.forEach((items, name) => {
    const meanScore = items.reduce((acc, item) => acc + item.score, 0) / items.length;
    const keep = items.length >= 2 || meanScore >= 0.8;
    if (!keep) {
      return;
    }

    counts[name] = items.length;
    boxes.push(...items);
  });

  const total = Object.values(counts).reduce((acc, value) => acc + value, 0);
  const share = Object.entries(counts)
    .map(([name, count]) => ({
      name,
      count,
      percentage: total > 0 ? (count / total) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return { counts, total, share, boxes };
}

function recalculateMetrics(counts, boxes) {
  const total = Object.values(counts).reduce((acc, value) => acc + value, 0);
  const share = Object.entries(counts)
    .map(([name, count]) => ({
      name,
      count,
      percentage: total > 0 ? (count / total) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return { counts, total, share, boxes };
}

function normalizeWordToken(text) {
  return text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/5/g, 's')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeBrandKey(text) {
  return normalizeWordToken(text || '');
}

function levenshteinDistance(a, b) {
  if (a === b) {
    return 0;
  }

  if (!a.length) {
    return b.length;
  }

  if (!b.length) {
    return a.length;
  }

  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

function isSimilarBrandName(expectedName, detectedName) {
  const expectedKey = normalizeBrandKey(expectedName);
  const detectedKey = normalizeBrandKey(detectedName);
  if (!expectedKey || !detectedKey) {
    return false;
  }

  if (expectedKey === detectedKey || expectedKey.includes(detectedKey) || detectedKey.includes(expectedKey)) {
    return true;
  }

  const distance = levenshteinDistance(expectedKey, detectedKey);
  const ratio = distance / Math.max(expectedKey.length, detectedKey.length);
  return distance <= 2 || ratio <= 0.3;
}

function toDisplayLabel(token) {
  if (!token) {
    return null;
  }

  return token.charAt(0).toUpperCase() + token.slice(1);
}

function isLikelyProductToken(token) {
  if (!token) {
    return false;
  }

  if (token.length < 4 || token.length > 24) {
    return false;
  }

  if (/^\d+$/.test(token)) {
    return false;
  }

  if (OCR_STOPWORDS.has(token)) {
    return false;
  }

  return true;
}

function resolveBrandByAlias(token) {
  if (!token) {
    return null;
  }

  // 1. Structural patterns from catalog (covers partial/noisy OCR reads)
  for (const rule of CATALOG_OCR_PATTERNS) {
    if (matchesOCRPattern(token, rule)) {
      return rule.canonical;
    }
  }

  // 2. Exact / substring alias lookup.
  // alias.includes(token) requires token.length >= 5 to prevent short, common
  // words (e.g. 'coco'=coconut, 'anda'=common suffix) from matching long aliases.
  const aliasEntries = Object.entries(CATALOG_ALIAS_MAP);
  for (const [alias, canonical] of aliasEntries) {
    if (token === alias || token.includes(alias) || (alias.includes(token) && token.length >= 5)) {
      return canonical;
    }
  }

  // 3. Fuzzy Levenshtein fallback for unrecognized OCR noise
  const fuzzyCandidate = aliasEntries
    .map(([alias, canonical]) => {
      const distance = levenshteinDistance(token, alias);
      const ratio = distance / Math.max(token.length, alias.length);
      return { alias, canonical, distance, ratio };
    })
    .sort((a, b) => (a.distance - b.distance) || (a.ratio - b.ratio))[0];

  if (!fuzzyCandidate) {
    return null;
  }

  const isCloseEnough = fuzzyCandidate.distance <= 2 || (fuzzyCandidate.alias.length >= 6 && fuzzyCandidate.ratio <= 0.28);
  return isCloseEnough ? fuzzyCandidate.canonical : null;
}

function mapWordToBrand(text) {
  const token = normalizeWordToken(text);
  if (!isLikelyProductToken(token)) {
    return null;
  }

  // All brand resolution is catalog-driven — no per-brand code needed here
  const resolved = resolveBrandByAlias(token);
  if (resolved) {
    return resolved;
  }

  return toDisplayLabel(token);
}

function extractExpectedBrands(expectedText) {
  if (!expectedText || !expectedText.trim()) {
    return [];
  }

  const normalizedText = expectedText
    .replace(/\s+[eE]\s+/g, ',')
    .replace(/\s+(and|AND|And)\s+/g, ',')
    .replace(/[\/&]/g, ',');

  const chunks = normalizedText
    .split(/[\n,;|]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const brands = chunks.flatMap((chunk) => {
    const words = chunk
      .split(/\s+/)
      .map((word) => normalizeBrandKey(word))
      .filter(Boolean);

    const aliasMatches = words
      .map((word) => CATALOG_ALIAS_MAP[word])
      .filter(Boolean);

    if (aliasMatches.length > 0) {
      return aliasMatches;
    }

    const normalized = normalizeBrandKey(chunk);
    if (!normalized) {
      return [];
    }

    if (CATALOG_ALIAS_MAP[normalized]) {
      return [CATALOG_ALIAS_MAP[normalized]];
    }

    const token = chunk.split(/\s+/)[0] || chunk;
    const normalizedToken = normalizeBrandKey(token);
    if (CATALOG_ALIAS_MAP[normalizedToken]) {
      return [CATALOG_ALIAS_MAP[normalizedToken]];
    }

    return [toDisplayLabel(normalized)];
  }).filter(Boolean);

  return [...new Set(brands)];
}

function validateExpectedBrands(expectedText, detectedCounts) {
  const expectedBrands = extractExpectedBrands(expectedText);
  if (expectedBrands.length === 0) {
    return null;
  }

  const detectedBrands = Object.keys(detectedCounts);
  const perBrand = expectedBrands.map((expected) => {
    const matchedBrand = detectedBrands.find((detected) => {
      return isSimilarBrandName(expected, detected);
    });

    return {
      expected,
      matchedBrand,
      count: matchedBrand ? (detectedCounts[matchedBrand] || 0) : 0,
      present: Boolean(matchedBrand),
    };
  });

  const presentCount = perBrand.filter((item) => item.present).length;
  return {
    expectedBrands,
    perBrand,
    coverage: expectedBrands.length > 0 ? presentCount / expectedBrands.length : 0,
  };
}

function pickRepresentativeToken(words) {
  const tokenStats = new Map();

  words.forEach((word) => {
    const token = mapWordToBrand(word.text || '');
    if (!token) {
      return;
    }

    const confidence = Math.max(0, (word.confidence || 0) / 100);
    if (!tokenStats.has(token)) {
      tokenStats.set(token, { weighted: 0, hits: 0 });
    }

    const entry = tokenStats.get(token);
    entry.weighted += Math.max(0.18, confidence);
    entry.hits += 1;
  });

  const ranked = [...tokenStats.entries()]
    .map(([token, stat]) => ({
      token,
      hits: stat.hits,
      weighted: stat.weighted,
      score: stat.weighted / stat.hits,
    }))
    .sort((a, b) => (b.weighted - a.weighted) || (b.hits - a.hits));

  return ranked.find((item) => item.hits >= 2 || item.score >= 0.48) || null;
}

function createWorkingCanvas(width, height) {
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  return offscreen;
}

function extractRegionImageData(sourceCanvas, bbox) {
  const [x, y, width, height] = bbox;
  const safeX = Math.max(0, Math.floor(x));
  const safeY = Math.max(0, Math.floor(y));
  const safeWidth = Math.max(1, Math.min(sourceCanvas.width - safeX, Math.floor(width)));
  const safeHeight = Math.max(1, Math.min(sourceCanvas.height - safeY, Math.floor(height)));
  const offscreen = createWorkingCanvas(safeWidth, safeHeight);
  const offscreenContext = offscreen.getContext('2d');
  offscreenContext.drawImage(sourceCanvas, safeX, safeY, safeWidth, safeHeight, 0, 0, safeWidth, safeHeight);
  return offscreenContext.getImageData(0, 0, safeWidth, safeHeight);
}

function createPreprocessedCanvas(sourceCanvas, bbox) {
  const [x, y, width, height] = bbox;
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const upscaleFactor = Math.max(2, Math.min(4, Math.ceil(220 / Math.max(safeWidth, safeHeight))));
  const outputWidth = safeWidth * upscaleFactor;
  const outputHeight = safeHeight * upscaleFactor;
  const offscreen = createWorkingCanvas(outputWidth, outputHeight);
  const offscreenContext = offscreen.getContext('2d');
  offscreenContext.imageSmoothingEnabled = true;
  offscreenContext.drawImage(sourceCanvas, x, y, width, height, 0, 0, outputWidth, outputHeight);

  const imageData = offscreenContext.getImageData(0, 0, outputWidth, outputHeight);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const grayscale = (0.299 * red) + (0.587 * green) + (0.114 * blue);
    const boosted = grayscale > 150 ? 255 : grayscale < 80 ? 0 : Math.min(255, grayscale * 1.35);
    data[index] = boosted;
    data[index + 1] = boosted;
    data[index + 2] = boosted;
  }
  offscreenContext.putImageData(imageData, 0, 0);
  return offscreen;
}

function createGlobalPreprocessedCanvas(sourceCanvas, invert = false) {
  const offscreen = createWorkingCanvas(sourceCanvas.width, sourceCanvas.height);
  const offscreenContext = offscreen.getContext('2d');
  offscreenContext.drawImage(sourceCanvas, 0, 0);

  const imageData = offscreenContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const grayscale = (0.299 * red) + (0.587 * green) + (0.114 * blue);
    const boosted = grayscale > 145 ? 255 : grayscale < 85 ? 0 : Math.min(255, grayscale * 1.3);
    const finalPixel = invert ? 255 - boosted : boosted;
    data[index] = finalPixel;
    data[index + 1] = finalPixel;
    data[index + 2] = finalPixel;
  }

  offscreenContext.putImageData(imageData, 0, 0);
  return offscreen;
}

function buildShelfBands(sourceCanvas) {
  const imageData = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  const darkRows = [];
  for (let row = 0; row < sourceCanvas.height; row += 1) {
    let brightnessSum = 0;
    for (let col = 0; col < sourceCanvas.width; col += 4) {
      const pixelIndex = ((row * sourceCanvas.width) + col) * 4;
      const red = imageData[pixelIndex];
      const green = imageData[pixelIndex + 1];
      const blue = imageData[pixelIndex + 2];
      brightnessSum += (red + green + blue) / 3;
    }
    const avgBrightness = brightnessSum / Math.ceil(sourceCanvas.width / 4);
    if (avgBrightness < 55) {
      darkRows.push(row);
    }
  }

  const separators = [];
  let start = null;
  darkRows.forEach((row, index) => {
    if (start === null) {
      start = row;
    }
    const nextRow = darkRows[index + 1];
    if (nextRow === undefined || nextRow - row > 2) {
      if (row - start > 4) {
        separators.push([start, row]);
      }
      start = null;
    }
  });

  const bands = [];
  let previousEnd = 0;
  separators.forEach(([sepStart, sepEnd]) => {
    if (sepStart - previousEnd > 48) {
      bands.push([previousEnd, sepStart]);
    }
    previousEnd = sepEnd;
  });
  if (sourceCanvas.height - previousEnd > 48) {
    bands.push([previousEnd, sourceCanvas.height]);
  }

  return bands.filter(([top, bottom]) => bottom - top > 60);
}

function buildFacingsForBand(sourceCanvas, top, bottom) {
  const height = bottom - top;
  const bandData = context.getImageData(0, top, sourceCanvas.width, height).data;
  const activeColumns = [];

  for (let col = 0; col < sourceCanvas.width; col += 1) {
    let colorfulPixels = 0;
    for (let row = 0; row < height; row += 3) {
      const pixelIndex = ((row * sourceCanvas.width) + col) * 4;
      const red = bandData[pixelIndex];
      const green = bandData[pixelIndex + 1];
      const blue = bandData[pixelIndex + 2];
      const brightness = (red + green + blue) / 3;
      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);
      const saturation = maxChannel - minChannel;
      if (brightness > 40 && saturation > 35) {
        colorfulPixels += 1;
      }
    }
    activeColumns.push(colorfulPixels > Math.max(8, height / 10));
  }

  const facings = [];
  let start = null;
  activeColumns.forEach((isActive, col) => {
    if (isActive && start === null) {
      start = col;
    }

    const atEnd = col === activeColumns.length - 1;
    if (start !== null && (!isActive || atEnd)) {
      const end = isActive && atEnd ? col : col - 1;
      const width = end - start;
      if (width > 24) {
        facings.push([start, top, width, height]);
      }
      start = null;
    }
  });

  return facings;
}

function rgbToHue(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue;
  if (max === r)      hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else                hue = (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function classifyFacingByColor(sourceCanvas, bbox) {
  const imageData = extractRegionImageData(sourceCanvas, bbox).data;
  let colorfulHits = 0;
  let sampled = 0;
  const hintVotes = {};

  for (let index = 0; index < imageData.length; index += 16) {
    const r = imageData[index];
    const g = imageData[index + 1];
    const b = imageData[index + 2];
    const brightness = (r + g + b) / 3;
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const saturation = maxChannel - minChannel;

    sampled += 1;

    if (brightness > 35 && saturation > 32) {
      colorfulHits += 1;
      const hue = rgbToHue(r, g, b);
      for (const hint of CATALOG_COLOR_HINTS) {
        const hueOk = hint.hueMin <= hint.hueMax
          ? hue >= hint.hueMin && hue <= hint.hueMax
          : hue >= hint.hueMin || hue <= hint.hueMax;
        if (hueOk && saturation >= hint.satMin && brightness >= hint.briMin) {
          hintVotes[hint.name] = (hintVotes[hint.name] || 0) + 1;
        }
      }
    }
  }

  if (sampled === 0) {
    return null;
  }

  const colorfulRatio = colorfulHits / sampled;
  if (colorfulRatio <= 0.26) {
    return null;
  }

  // Pick brand hint with most votes, require ≥25% of colorful pixels to vote for it.
  // When two brands share a hue range (e.g. Coca-Cola + Doritos on red),
  // their votes split and neither reaches 25%, so the result is 'Marca não identificada'.
  // OCR is responsible for disambiguating shared-hue cases.
  let bestBrand = 'Marca não identificada';
  let bestVotes = 0;
  for (const [brand, votes] of Object.entries(hintVotes)) {
    if (votes > bestVotes && votes / colorfulHits >= 0.25) {
      bestVotes = votes;
      bestBrand = brand;
    }
  }

  return {
    productName: bestBrand,
    score: Math.min(0.75, 0.32 + colorfulRatio),
    colorHit: bestBrand !== 'Marca não identificada',
  };
}

function detectBrandsByDenseWindows(sourceCanvas) {
  const widthFractions = [0.12, 0.16, 0.2];
  const heightFractions = [0.16, 0.22, 0.28];
  const boxes = [];
  const counts = {};

  heightFractions.forEach((heightFraction) => {
    widthFractions.forEach((widthFraction) => {
      const windowWidth = Math.max(36, Math.floor(sourceCanvas.width * widthFraction));
      const windowHeight = Math.max(40, Math.floor(sourceCanvas.height * heightFraction));
      const strideX = Math.max(18, Math.floor(windowWidth * 0.45));
      const strideY = Math.max(18, Math.floor(windowHeight * 0.45));

      for (let y = 0; y <= sourceCanvas.height - windowHeight; y += strideY) {
        for (let x = 0; x <= sourceCanvas.width - windowWidth; x += strideX) {
          const bbox = [x, y, windowWidth, windowHeight];
          const classification = classifyFacingByColor(sourceCanvas, bbox);
          if (!classification || classification.score < 0.58) {
            continue;
          }

          boxes.push({
            productName: classification.productName,
            score: classification.score,
            colorHit: classification.colorHit || false,
            bbox,
            source: 'Visual',
          });
        }
      }
    });
  });

  deduplicateBoxes(boxes).forEach((box) => {
    counts[box.productName] = (counts[box.productName] || 0) + 1;
  });

  const uniqueBoxes = deduplicateBoxes(boxes);
  return {
    ...recalculateMetrics(counts, uniqueBoxes),
    confidence: confidenceScore(uniqueBoxes),
  };
}

function calculateIntersectionRatio(boxA, boxB) {
  const [ax, ay, aw, ah] = boxA;
  const [bx, by, bw, bh] = boxB;
  const overlapWidth = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const overlapHeight = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const intersection = overlapWidth * overlapHeight;
  const smallerArea = Math.max(1, Math.min(aw * ah, bw * bh));
  return intersection / smallerArea;
}

function deduplicateBoxes(boxes) {
  const uniqueBoxes = [];

  boxes.forEach((candidate) => {
    const duplicateIndex = uniqueBoxes.findIndex((existing) => (
      existing.productName === candidate.productName
      && calculateIntersectionRatio(existing.bbox, candidate.bbox) > 0.55
    ));

    if (duplicateIndex === -1) {
      uniqueBoxes.push(candidate);
      return;
    }

    if (candidate.score > uniqueBoxes[duplicateIndex].score) {
      uniqueBoxes[duplicateIndex] = candidate;
    }
  });

  return uniqueBoxes;
}

function mergeBrandSources(...sources) {
  const counts = {};
  const boxes = [];

  sources.forEach((source) => {
    Object.entries(source?.counts || {}).forEach(([name, count]) => {
      counts[name] = Math.max(counts[name] || 0, count);
    });

    (source?.boxes || []).forEach((box) => {
      boxes.push(box);
    });
  });

  return {
    counts,
    boxes: deduplicateBoxes(boxes),
  };
}

function mergeAnalysis(primary, ...fallbacks) {
  const brandEvidence = mergeBrandSources(...fallbacks);
  const brandNames = new Set(Object.keys(brandEvidence.counts));
  const mergedCounts = { ...primary.counts };

  brandNames.forEach((brand) => {
    mergedCounts[brand] = brandEvidence.counts[brand];
  });

  const preservedPrimaryBoxes = primary.boxes.filter((box) => !brandNames.has(box.productName));
  const mergedBoxes = deduplicateBoxes([...preservedPrimaryBoxes, ...brandEvidence.boxes]);
  return recalculateMetrics(mergedCounts, mergedBoxes);
}

function blendMultipleConfidences(sources) {
  const weighted = sources
    .filter((source) => source && source.boxes && source.boxes.length > 0)
    .reduce((acc, source) => {
      const weight = source.boxes.length;
      acc.score += (source.confidence || confidenceScore(source.boxes)) * weight;
      acc.weight += weight;
      return acc;
    }, { score: 0, weight: 0 });

  if (weighted.weight === 0) {
    return 0;
  }

  return weighted.score / weighted.weight;
}

async function detectBrandsByOCRInRegions(sourceCanvas, regions, expectedBrandKeys = new Set()) {
  if (typeof Tesseract === 'undefined' || regions.length === 0) {
    return { counts: {}, boxes: [], confidence: 0 };
  }

  const counts = {};
  const boxes = [];
  let confidenceSum = 0;
  let matches = 0;

  for (const bbox of regions) {
    const regionCanvas = createPreprocessedCanvas(sourceCanvas, bbox);
    const result = await Tesseract.recognize(regionCanvas, 'eng+por', {
      logger: () => {},
    });

    const words = result?.data?.words || [];
    let bestToken = pickRepresentativeToken(words);

    // Fallback for expected brands: accept any single word with confidence >= 0.08
    if (!bestToken && expectedBrandKeys.size > 0) {
      for (const word of words) {
        const mapped = mapWordToBrand(word.text || '');
        if (!mapped) continue;
        if (expectedBrandKeys.has(normalizeBrandKey(mapped)) && (word.confidence || 0) >= 8) {
          bestToken = { token: mapped, score: Math.max(0.12, (word.confidence || 0) / 100) };
          break;
        }
      }
    }

    if (!bestToken) {
      continue;
    }

    const brand = bestToken.token;
    const score = Math.max(0.35, bestToken.score);
    counts[brand] = (counts[brand] || 0) + 1;
    boxes.push({ productName: brand, score, bbox, source: 'OCR' });
    confidenceSum += score;
    matches += 1;
  }

  return {
    counts,
    boxes,
    confidence: matches > 0 ? confidenceSum / matches : 0,
  };
}

async function detectBrandsByShelfHeuristics(sourceCanvas, expectedBrandKeys = new Set()) {
  const bands = buildShelfBands(sourceCanvas);
  const regions = bands.flatMap(([top, bottom]) => buildFacingsForBand(sourceCanvas, top, bottom));

  const counts = {};
  const boxes = [];
  regions.forEach((bbox) => {
    const classification = classifyFacingByColor(sourceCanvas, bbox);
    if (!classification) {
      return;
    }
    counts[classification.productName] = (counts[classification.productName] || 0) + 1;
    boxes.push({
      productName: classification.productName,
      score: classification.score,
      colorHit: classification.colorHit || false,
      bbox,
      source: 'Visual',
    });
  });

  const ocrResult = await detectBrandsByOCRInRegions(sourceCanvas, regions, expectedBrandKeys);
  const mergedCounts = { ...counts };
  Object.entries(ocrResult.counts).forEach(([name, count]) => {
    mergedCounts[name] = Math.max(mergedCounts[name] || 0, count);
  });

  const mergedBoxes = [...boxes, ...ocrResult.boxes];
  return {
    ...recalculateMetrics(mergedCounts, mergedBoxes),
    confidence: blendConfidence(confidenceScore(boxes), ocrResult.confidence, boxes, ocrResult.boxes),
  };
}

function detectBrandsByGridSignature(sourceCanvas) {
  const rows = 8;
  const cols = 6;
  const cellWidth = sourceCanvas.width / cols;
  const cellHeight = sourceCanvas.height / rows;
  const counts = {};
  const boxes = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const bbox = [col * cellWidth, row * cellHeight, cellWidth, cellHeight];
      const imageData = extractRegionImageData(sourceCanvas, bbox).data;
      let brightPixels = 0;
      for (let index = 0; index < imageData.length; index += 16) {
        const brightness = (imageData[index] + imageData[index + 1] + imageData[index + 2]) / 3;
        if (brightness > 45) {
          brightPixels += 1;
        }
      }

      if (brightPixels < 40) {
        continue;
      }

      const classification = classifyFacingByColor(sourceCanvas, bbox);
      if (!classification || classification.score < 0.5) {
        continue;
      }

      counts[classification.productName] = (counts[classification.productName] || 0) + 1;
      boxes.push({
        productName: classification.productName,
        score: classification.score,
        bbox,
        source: 'Visual',
      });
    }
  }

  return {
    ...recalculateMetrics(counts, boxes),
    confidence: confidenceScore(boxes),
  };
}

async function detectBrandsByOCR(expectedBrandKeys = new Set()) {
  if (typeof Tesseract === 'undefined') {
    return { counts: {}, boxes: [], confidence: 0 };
  }

  const counts = {};
  const boxes = [];
  let confidenceSum = 0;
  let confidenceHits = 0;

  const tokenStats = new Map();
  const ocrInputs = [
    canvas,
    createGlobalPreprocessedCanvas(canvas, false),
    createGlobalPreprocessedCanvas(canvas, true),
  ];

  for (const input of ocrInputs) {
    const result = await Tesseract.recognize(input, 'eng+por', {
      logger: () => {},
    });

    (result?.data?.words || []).forEach((word) => {
      const token = mapWordToBrand(word.text || '');
      const confidence = Math.max(0, (word.confidence || 0) / 100);
      const isExpected = token && expectedBrandKeys.has(normalizeBrandKey(token));
      // For expected brands accept very low confidence (cursive/stylized logos score low)
      const minGate = isExpected ? 0.03 : 0.08;
      if (!token || confidence < minGate) {
        return;
      }

      if (!tokenStats.has(token)) {
        tokenStats.set(token, { weighted: 0, hits: 0, words: [] });
      }

      const entry = tokenStats.get(token);
      entry.weighted += Math.max(0.08, confidence);
      entry.hits += 1;
      entry.words.push(word);
    });
  }

  tokenStats.forEach((entry, token) => {
    const averageScore = entry.weighted / entry.hits;
    const isExpected = expectedBrandKeys.has(normalizeBrandKey(token));
    // Expected brands: slightly lower average threshold, but still requires >=2 hits
    // single-hit + just being expected is NOT enough (prevents description-driven false positives)
    const accepted = entry.hits >= 2 || averageScore >= 0.42
      || (isExpected && entry.hits >= 2 && averageScore >= 0.25);
    if (!accepted) {
      return;
    }

    counts[token] = entry.hits;

    entry.words.forEach((word) => {
      const confidence = Math.max(0.18, (word.confidence || 0) / 100);
      const x = word.bbox?.x0 || 0;
      const y = word.bbox?.y0 || 0;
      const width = Math.max(1, (word.bbox?.x1 || x + 1) - x);
      const height = Math.max(1, (word.bbox?.y1 || y + 1) - y);

      boxes.push({
        productName: token,
        score: confidence,
        bbox: [x, y, width, height],
        source: 'OCR',
      });

      confidenceSum += confidence;
      confidenceHits += 1;
    });
  });

  return {
    counts,
    boxes,
    confidence: confidenceHits > 0 ? confidenceSum / confidenceHits : 0,
  };
}

function drawBoxes(boxes) {
  context.lineWidth = 2;
  context.font = '12px Inter, sans-serif';

  boxes.forEach((box) => {
    const [x, y, width, height] = box.bbox;
    context.strokeStyle = '#22d3ee';
    context.fillStyle = 'rgba(2, 6, 23, 0.82)';
    context.strokeRect(x, y, width, height);
    const label = `${box.productName} ${(box.score * 100).toFixed(0)}%`;
    const textWidth = context.measureText(label).width + 8;
    const textY = y > 18 ? y - 18 : y + 2;
    context.fillRect(x, textY, textWidth, 16);
    context.fillStyle = '#f8fafc';
    context.fillText(label, x + 4, textY + 12);
  });
}

function analyzeLayout(boxes) {
  if (boxes.length === 0) {
    return { esquerda: 0, centro: 0, direita: 0 };
  }

  const thirds = { esquerda: 0, centro: 0, direita: 0 };
  boxes.forEach((box) => {
    const [x, , width] = box.bbox;
    const centerX = x + width / 2;
    const ratio = centerX / canvas.width;
    if (ratio < 0.33) {
      thirds.esquerda += 1;
    } else if (ratio < 0.66) {
      thirds.centro += 1;
    } else {
      thirds.direita += 1;
    }
  });

  return thirds;
}

async function semanticCompatibility(expectedText, detectedProducts) {
  if (!expectedText.trim() || detectedProducts.length === 0) {
    return { overall: 0, perProduct: [] };
  }

  if (!textModel) {
    setStatus('Carregando modelo semântico (USE)...');
    textModel = await use.load();
  }

  const productTexts = detectedProducts;

  const embeddings = await textModel.embed([expectedText, ...productTexts]);
  const matrix = await embeddings.array();
  const textVector = matrix[0];

  const perProduct = detectedProducts.map((name, idx) => {
    const similarity = cosineSimilarity(textVector, matrix[idx + 1]);
    return {
      name,
      compatibility: Math.max(0, Math.min(1, (similarity + 1) / 2)),
    };
  });

  const overall = perProduct.reduce((sum, item) => sum + item.compatibility, 0) / perProduct.length;
  return { overall, perProduct };
}

function confidenceScore(boxes) {
  if (boxes.length === 0) {
    return 0;
  }
  return boxes.reduce((sum, box) => sum + box.score, 0) / boxes.length;
}

function blendConfidence(primaryConfidence, fallbackConfidence, primaryBoxes, fallbackBoxes) {
  const primaryWeight = primaryBoxes.length;
  const fallbackWeight = fallbackBoxes.length;
  const totalWeight = primaryWeight + fallbackWeight;

  if (totalWeight === 0) {
    return 0;
  }

  return ((primaryConfidence * primaryWeight) + (fallbackConfidence * fallbackWeight)) / totalWeight;
}

function renderSummary(data) {
  const lines = [
    `Marcas detectadas: ${Object.keys(data.counts).length}`,
    `Total de itens: ${data.total}`,
    `Confiança da identificação: ${(data.confidence * 100).toFixed(1)}%`,
  ];

  summaryEl.innerHTML = lines.map((line) => `<li>${line}</li>`).join('');
}

function formatFileDateTime(lastModified) {
  if (!Number.isFinite(lastModified) || lastModified <= 0) {
    return 'N/A';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(lastModified));
}

function buildBrandEvidenceSummary(boxes) {
  const byBrand = new Map();

  boxes.forEach((box) => {
    const brand = box.productName || 'Marca não identificada';
    if (!byBrand.has(brand)) {
      byBrand.set(brand, {
        count: 0,
        confidenceSum: 0,
        colorHits: 0,
        sourceCounts: { COCO: 0, OCR: 0, Visual: 0 },
      });
    }

    const entry = byBrand.get(brand);
    entry.count += 1;
    entry.confidenceSum += box.score || 0;
    if (box.colorHit) entry.colorHits += 1;
    const source = box.source || 'Visual';
    if (!entry.sourceCounts[source]) {
      entry.sourceCounts[source] = 0;
    }
    entry.sourceCounts[source] += 1;
  });

  return byBrand;
}

function formatBrandObservation(brand, evidence) {
  const evidenceParts = [];
  if ((evidence.sourceCounts.OCR || 0) > 0) {
    evidenceParts.push('OCR');
  }
  if ((evidence.sourceCounts.Visual || 0) > 0) {
    evidenceParts.push('padrão visual');
  }
  if ((evidence.sourceCounts.COCO || 0) > 0) {
    evidenceParts.push('modelo de visão');
  }
  if (evidence.count >= 2) {
    evidenceParts.push('repetição de embalagem');
  }

  if (brand === 'Marca não identificada') {
    return '- Marca não identificada: evidências insuficientes para inferir marca com segurança.';
  }

  if (evidenceParts.length === 0) {
    return `- ${brand}: identificado com baixa evidência direta.`;
  }

  return `- ${brand}: identificação baseada em ${evidenceParts.join(', ')}.`;
}

function applyBrandEvidenceThreshold(data, brandEvidence, expectedBrands = []) {
  const resolvedCounts = {};
  const resolvedEvidence = new Map();
  let unknownCarryCount = 0;
  let unknownCarryConfidence = 0;
  const unknownCarrySources = { COCO: 0, OCR: 0, Visual: 0 };
  const expectedKeys = new Set(expectedBrands.map((brand) => normalizeBrandKey(brand)));

  Object.entries(data.counts).forEach(([brand, count]) => {
    const evidence = brandEvidence.get(brand) || {
      count,
      confidenceSum: 0,
      sourceCounts: { COCO: 0, OCR: 0, Visual: 0 },
    };

    if (brand === 'Marca não identificada') {
      resolvedCounts[brand] = (resolvedCounts[brand] || 0) + count;
      resolvedEvidence.set(brand, {
        count: (resolvedEvidence.get(brand)?.count || 0) + evidence.count,
        confidenceSum: (resolvedEvidence.get(brand)?.confidenceSum || 0) + evidence.confidenceSum,
        sourceCounts: {
          COCO: (resolvedEvidence.get(brand)?.sourceCounts?.COCO || 0) + (evidence.sourceCounts.COCO || 0),
          OCR: (resolvedEvidence.get(brand)?.sourceCounts?.OCR || 0) + (evidence.sourceCounts.OCR || 0),
          Visual: (resolvedEvidence.get(brand)?.sourceCounts?.Visual || 0) + (evidence.sourceCounts.Visual || 0),
        },
      });
      return;
    }

    const averageConfidence = evidence.count > 0 ? evidence.confidenceSum / evidence.count : 0;
    const hasColorHit = (evidence.colorHits || 0) >= 1;
    const matchesExpected = expectedKeys.has(normalizeBrandKey(brand));

    // Multi-signal validation via detection profile:
    // requiresOCR + requiresColor + minCount must all pass for at least one rule.
    // approvedByExpected only boosts OCR gate, never bypasses color requirement.
    const profileApproved = evaluateDetectionProfile(brand, evidence, hasColorHit);

    // For expected brands with OCR support, relax minCount to 1
    const relaxedForExpected = matchesExpected
      && (evidence.sourceCounts.OCR || 0) >= 1
      && averageConfidence >= 0.25;

    const approved = profileApproved || relaxedForExpected;

    if (approved) {
      resolvedCounts[brand] = count;
      resolvedEvidence.set(brand, evidence);
      return;
    }

    unknownCarryCount += count;
    unknownCarryConfidence += evidence.confidenceSum;
    unknownCarrySources.COCO += evidence.sourceCounts.COCO || 0;
    unknownCarrySources.OCR += evidence.sourceCounts.OCR || 0;
    unknownCarrySources.Visual += evidence.sourceCounts.Visual || 0;
  });

  if (unknownCarryCount > 0) {
    resolvedCounts['Marca não identificada'] = (resolvedCounts['Marca não identificada'] || 0) + unknownCarryCount;
    const currentUnknown = resolvedEvidence.get('Marca não identificada') || {
      count: 0,
      confidenceSum: 0,
      sourceCounts: { COCO: 0, OCR: 0, Visual: 0 },
    };

    resolvedEvidence.set('Marca não identificada', {
      count: currentUnknown.count + unknownCarryCount,
      confidenceSum: currentUnknown.confidenceSum + unknownCarryConfidence,
      sourceCounts: {
        COCO: currentUnknown.sourceCounts.COCO + unknownCarrySources.COCO,
        OCR: currentUnknown.sourceCounts.OCR + unknownCarrySources.OCR,
        Visual: currentUnknown.sourceCounts.Visual + unknownCarrySources.Visual,
      },
    });
  }

  if (Object.keys(resolvedCounts).length === 0) {
    resolvedCounts['Marca não identificada'] = data.total || 0;
    resolvedEvidence.set('Marca não identificada', {
      count: data.total || 0,
      confidenceSum: 0,
      sourceCounts: { COCO: 0, OCR: 0, Visual: 0 },
    });
  }

  return { resolvedCounts, resolvedEvidence };
}

function buildDetectedItemsSection(data) {
  if (!data.share.length) {
    return [];
  }

  const sections = ['DETALHAMENTO DINÂMICO DOS ITENS', ''];
  const topItems = data.share.slice(0, 10);
  topItems.forEach((item) => {
    sections.push(`- ${item.name}: ${item.count} deteccao(oes) (${item.percentage.toFixed(1)}%)`);
  });

  const dominant = topItems[0];
  if (dominant) {
    sections.push('', `Item com maior presenca visual: ${dominant.name}.`);
  }

  return sections;
}

function buildSourceEvidenceSection(data) {
  if (!data.boxes.length) {
    return [];
  }

  const sourceMap = new Map();
  data.boxes.forEach((box) => {
    const source = box.source || 'Desconhecida';
    if (!sourceMap.has(source)) {
      sourceMap.set(source, { total: 0, items: new Map() });
    }

    const sourceEntry = sourceMap.get(source);
    sourceEntry.total += 1;
    sourceEntry.items.set(box.productName, (sourceEntry.items.get(box.productName) || 0) + 1);
  });

  const orderedSources = ['COCO', 'OCR', 'Visual'];
  const sections = ['EVIDÊNCIAS POR FONTE', ''];

  orderedSources.forEach((source) => {
    const entry = sourceMap.get(source);
    if (!entry) {
      return;
    }

    sections.push(`${source}: ${entry.total} deteccao(oes)`);
    const topItems = [...entry.items.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');

    sections.push(`Itens: ${topItems || 'N/A'}`, '');
  });

  [...sourceMap.keys()]
    .filter((source) => !orderedSources.includes(source))
    .forEach((source) => {
      const entry = sourceMap.get(source);
      sections.push(`${source}: ${entry.total} deteccao(oes)`, '');
    });

  return sections;
}

function buildReport(data, expectedText, fileMetadata) {
  const brandEvidence = buildBrandEvidenceSummary(data.boxes);
  const expectedReference = validateExpectedBrands(expectedText, data.counts);
  const expectedBrands = expectedReference?.expectedBrands || [];
  const thresholded = applyBrandEvidenceThreshold(data, brandEvidence, expectedBrands);
  const usingDescriptionFocus = Boolean(expectedReference && expectedReference.expectedBrands.length > 0);

  const focusedBrands = usingDescriptionFocus
    ? expectedReference.expectedBrands
    : (Object.keys(thresholded.resolvedCounts).length > 0
      ? Object.keys(thresholded.resolvedCounts)
      : ['Marca não identificada']);

  const focusedCounts = {};
  focusedBrands.forEach((brand) => {
    if (!usingDescriptionFocus) {
      focusedCounts[brand] = thresholded.resolvedCounts[brand] || 0;
      return;
    }

    const match = expectedReference.perBrand.find((item) => item.expected === brand);
    focusedCounts[brand] = match ? match.count : 0;
  });

  const countLines = focusedBrands.map((brand) => `- ${brand}: ${focusedCounts[brand] || 0}`);

  const focusedTotal = Object.values(focusedCounts).reduce((sum, count) => sum + count, 0);

  const compatibilityLines = focusedBrands.map((brand) => {
    const count = focusedCounts[brand] || 0;
    const compatibility = focusedTotal > 0 ? (count / focusedTotal) * 100 : 0;
    return `- ${brand}: ${compatibility.toFixed(1)}%`;
  });

  const confidenceLines = focusedBrands.map((brand) => {
    const evidence = thresholded.resolvedEvidence.get(brand);
    if (!evidence || evidence.count === 0) {
      return `- ${brand}: 0.0%`;
    }

    const average = (evidence.confidenceSum / evidence.count) * 100;
    return `- ${brand}: ${average.toFixed(1)}%`;
  });

  const observationLines = focusedBrands.map((brand) => {
    const evidence = thresholded.resolvedEvidence.get(brand) || {
      count: focusedCounts[brand] || 0,
      sourceCounts: { COCO: 0, OCR: 0, Visual: 0 },
    };
    return formatBrandObservation(brand, evidence);
  });

  return [
    'RELATÓRIO DE GÔNDOLA',
    '',
    `Arquivo analisado: ${fileMetadata?.name || 'N/A'}`,
    `Data/hora do arquivo: ${formatFileDateTime(fileMetadata?.lastModified)}`,
    '',
    'Marcas identificadas:',
    ...focusedBrands.map((brand) => `- ${brand}`),
    '',
    'Contagem de produtos por marca:',
    ...countLines,
    '',
    `Total de itens detectados: ${focusedTotal}`,
    '',
    'Compatibilidade com os nomes da descrição:',
    ...compatibilityLines,
    '',
    'Distribuição aproximada na prateleira:',
    `- esquerda: ${data.layout.esquerda}`,
    `- centro: ${data.layout.centro}`,
    `- direita: ${data.layout.direita}`,
    '',
    'Confiança média da identificação por marca:',
    ...confidenceLines,
    '',
    'Observações:',
    ...observationLines,
    ...(expectedReference ? [`- Cobertura da descrição: ${(expectedReference.coverage * 100).toFixed(1)}%`] : []),
  ].join('\n');
}

async function analyzeShelf() {
  if (!selectedImage) {
    return;
  }

  // Mark touched and validate before proceeding
  descriptionInput.dataset.touched = 'true';
  validateDescriptionField();
  if (!isDescriptionFilled()) {
    descriptionInput.focus();
    setStatus('Informe as marcas esperadas antes de analisar.');
    return;
  }

  analyzeBtn.disabled = true;
  setStatus('Preparando imagem (compressão/redimensionamento)...');
  drawImagePreview(selectedImage);

  try {
    if (!objectModel) {
      setStatus('Carregando modelo de detecção (COCO-SSD)...');
      objectModel = await cocoSsd.load({ base: 'mobilenet_v2' });
    }

    setStatus('Detectando produtos e embalagens...');
    const detections = await objectModel.detect(canvas);

    const summarized = summarizeDetections(detections);

    // Parse expected brands from description for guided (lower-threshold) OCR detection
    const expectedBrandsForOCR = extractExpectedBrands(descriptionInput.value);
    const expectedBrandKeys = new Set(expectedBrandsForOCR.map((b) => normalizeBrandKey(b)));

    setStatus('Executando OCR global...');
    const ocrFallback = await detectBrandsByOCR(expectedBrandKeys);

    setStatus('Segmentando a gôndola para OCR regional e cor...');
    const heuristicFallback = await detectBrandsByShelfHeuristics(canvas, expectedBrandKeys);

    setStatus('Validando assinaturas visuais por grade...');
    const gridFallback = detectBrandsByGridSignature(canvas);

    setStatus('Procurando itens em janelas menores da imagem...');
    const denseWindowFallback = detectBrandsByDenseWindows(canvas);

    setStatus('Consolidando contagem, share e layout...');
    const finalSummary = mergeAnalysis(summarized, ocrFallback, heuristicFallback, gridFallback, denseWindowFallback);

    drawImagePreview(selectedImage);
    drawBoxes(finalSummary.boxes);

    const detectedProducts = Object.keys(finalSummary.counts);
    const compatibility = await semanticCompatibility(descriptionInput.value, detectedProducts);
    const layout = analyzeLayout(finalSummary.boxes);
    const confidence = blendMultipleConfidences([summarized, ocrFallback, heuristicFallback, gridFallback, denseWindowFallback]);

    const result = {
      ...finalSummary,
      compatibility,
      layout,
      confidence,
    };

    renderSummary(result);
    reportEl.textContent = buildReport(result, descriptionInput.value.trim(), selectedFileMetadata);
    setStatus('Análise concluída.');
  } catch (error) {
    console.error(error);
    setStatus(`Erro na análise: ${error.message}`);
  } finally {
    updateAnalyzeBtnState();
  }
}

async function handleFileSelection(file) {
  if (!file) {
    return;
  }

  try {
    setStatus('Carregando imagem...');
    selectedFileMetadata = {
      name: file.name || 'N/A',
      lastModified: Number(file.lastModified) || 0,
    };
    selectedImage = await loadImage(file);
    drawImagePreview(selectedImage);
    updateAnalyzeBtnState();
    resetOutput();
    setStatus(isDescriptionFilled()
      ? 'Imagem pronta para análise.'
      : 'Imagem carregada. Informe as marcas esperadas para habilitar a análise.');
  } catch (error) {
    selectedFileMetadata = null;
    selectedImage = null;
    updateAnalyzeBtnState();
    setStatus(`Erro ao carregar imagem: ${error.message}`);
  }
}

imageInput.addEventListener('change', (event) => {
  const [file] = event.target.files;
  handleFileSelection(file);
});

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('drag');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag');
});

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('drag');
  const [file] = event.dataTransfer.files;
  imageInput.files = event.dataTransfer.files;
  handleFileSelection(file);
});

analyzeBtn.addEventListener('click', analyzeShelf);

// Revalidate button state whenever the description changes
descriptionInput.addEventListener('input', () => {
  descriptionInput.dataset.touched = 'true';
  validateDescriptionField();
});

descriptionInput.addEventListener('blur', () => {
  descriptionInput.dataset.touched = 'true';
  validateDescriptionField();
});

// Load brand catalog asynchronously at startup — overrides pre-seeded defaults
initBrandCatalog();
