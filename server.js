const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

loadEnvFile();

const PORT = Number(process.env.PORT || 3001);
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || process.env.TMDB_API_READ_ACCESS_TOKEN || '';
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const STATIC_ROOT = __dirname;
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const POOL_SNAPSHOT_TTL_MS = CACHE_TTL_MS;
const POOL_STALE_FALLBACK_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const POOL_SNAPSHOT_VERSION = 'server-rotation-2';
const SNAPSHOT_ROOT = path.join(STATIC_ROOT, '.cache');
const STARTUP_PREWARM_THEMES = ['horror', 'animation', 'eighties', 'noir', 'romcom'];
const BASE_REEL_COUNT = 4;
const THEME_REEL_COUNT = 3;

if (typeof fetch !== 'function') {
  throw new Error('This server requires Node 18+ because it uses the built-in fetch API.');
}

const cache = {
  configuration: { value: null, expiresAt: 0 },
  genres: { value: null, expiresAt: 0 },
  cardPools: new Map(),
  poolBuilds: new Map(),
  poolRotationCursor: new Map(),
  movieArt: new Map(),
  movieCredits: new Map()
};

const DISCOVER_RECIPES = [
  { key: 'popular', pages: 3, params: { sort_by: 'popularity.desc', 'primary_release_date.lte': '2022-12-31' } },
  { key: 'watched', pages: 3, params: { sort_by: 'vote_count.desc', 'vote_count.gte': '250', 'primary_release_date.lte': '2020-12-31' } },
  { key: 'prestige', pages: 10, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '400', 'primary_release_date.lte': '2021-12-31' } },
  { key: 'horror', pages: 5, params: { sort_by: 'popularity.desc', with_genres: '27', 'primary_release_date.lte': '2018-12-31' } },
  { key: 'crime', pages: 4, params: { sort_by: 'popularity.desc', with_genres: '80', 'primary_release_date.lte': '2015-12-31' } },
  { key: 'mystery', pages: 5, params: { sort_by: 'vote_average.desc', with_genres: '9648', 'vote_count.gte': '150', 'primary_release_date.lte': '2016-12-31' } },
  { key: 'blockbuster', pages: 1, params: { sort_by: 'popularity.desc', with_genres: '28,12,878', 'primary_release_date.lte': '2018-12-31' } },
  { key: 'animation', pages: 3, params: { sort_by: 'popularity.desc', with_genres: '16', 'primary_release_date.lte': '2015-12-31' } },
  { key: 'romcom', pages: 5, params: { sort_by: 'popularity.desc', with_genres: '10749,35', 'vote_count.gte': '80', 'primary_release_date.lte': '2020-12-31' } },
  { key: 'romantic-drama', pages: 4, params: { sort_by: 'vote_average.desc', with_genres: '10749,18', 'vote_count.gte': '120', 'primary_release_date.lte': '2018-12-31' } },
  { key: 'documentary', pages: 4, params: { sort_by: 'vote_count.desc', with_genres: '99', 'vote_count.gte': '80', 'primary_release_date.lte': '2018-12-31' } },
  { key: 'classics', pages: 8, params: { sort_by: 'vote_average.desc', 'primary_release_date.lte': '1990-12-31', 'vote_count.gte': '120' } },
  { key: 'scifi', pages: 3, params: { sort_by: 'popularity.desc', with_genres: '878', 'primary_release_date.lte': '2015-12-31' } },
  { key: 'world-cinema', pages: 8, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '80', with_original_language: 'fr|ja|ko|es|it|de|pt|sv|da|zh|cn|hi', 'primary_release_date.lte': '2018-12-31' } },
  { key: 'deep-cuts', pages: 8, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '15', 'vote_count.lte': '450', 'primary_release_date.lte': '2018-12-31' } },
  { key: 'international-deep-cuts', pages: 7, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '10', 'vote_count.lte': '260', with_original_language: 'fr|ja|ko|es|it|de|pt|sv|da|zh|cn|hi', 'primary_release_date.lte': '2018-12-31' } },
  { key: 'micro-obscure', pages: 8, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '5', 'vote_count.lte': '90', 'primary_release_date.lte': '2012-12-31' } },
  { key: 'micro-obscure-world', pages: 6, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '3', 'vote_count.lte': '70', with_original_language: 'fr|ja|ko|es|it|de|pt|sv|da|zh|cn|hi', 'primary_release_date.lte': '2012-12-31' } },
  { key: 'silent-era', pages: 4, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '8', 'primary_release_date.gte': '1900-01-01', 'primary_release_date.lte': '1929-12-31' } },
  { key: 'thirties', pages: 3, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '18', 'primary_release_date.gte': '1930-01-01', 'primary_release_date.lte': '1939-12-31' } },
  { key: 'forties', pages: 3, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '35', 'primary_release_date.gte': '1940-01-01', 'primary_release_date.lte': '1949-12-31' } },
  { key: 'fifties', pages: 3, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '45', 'primary_release_date.gte': '1950-01-01', 'primary_release_date.lte': '1959-12-31' } },
  { key: 'sixties', pages: 3, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '55', 'primary_release_date.gte': '1960-01-01', 'primary_release_date.lte': '1969-12-31' } },
  { key: 'seventies', pages: 3, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '65', 'primary_release_date.gte': '1970-01-01', 'primary_release_date.lte': '1979-12-31' } },
  { key: 'eighties', pages: 3, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '80', 'primary_release_date.gte': '1980-01-01', 'primary_release_date.lte': '1989-12-31' } },
  { key: 'nineties', pages: 4, params: { sort_by: 'vote_average.desc', 'vote_count.gte': '110', 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '1999-12-31' } },
  { key: 'weird-horror', pages: 4, params: { sort_by: 'vote_average.desc', with_genres: '27,14,878', 'vote_count.gte': '12', 'vote_count.lte': '220', 'primary_release_date.lte': '2015-12-31' } },
  { key: 'grindhouse-ish', pages: 3, params: { sort_by: 'vote_average.desc', with_genres: '28,27,53,878', 'vote_count.gte': '12', 'vote_count.lte': '180', 'primary_release_date.lte': '1999-12-31' } }
];

const FEMALE_DIRECTOR_NAMES = {
  'agnes varda': true,
  'alice rohrwacher': true,
  'ana lily amirpour': true,
  'celine sciamma': true,
  'chantal akerman': true,
  'claire denis': true,
  'dee rees': true,
  'greta gerwig': true,
  'ida lupino': true,
  'jane campion': true,
  'joanna hogg': true,
  'karyn kusama': true,
  'kelly reichardt': true,
  'lucrecia martel': true,
  'lynn ramsay': true,
  'mia hansen-love': true,
  'sarah polley': true,
  'sofia coppola': true
};

const RARITY_ORDER = {
  Prolific: 1,
  Common: 1,
  Respected: 2,
  Uncommon: 2,
  Awarded: 3,
  Rare: 3,
  Iconic: 4,
  Epic: 4,
  Canon: 5,
  Legendary: 5
};

const TITLE_RARITY_FLOORS = {
  '2001: a space odyssey': 'Legendary',
  '8 1/2': 'Epic',
  '8½': 'Epic',
  '12 angry men': 'Legendary',
  'a brighter summer day': 'Epic',
  'all that jazz': 'Epic',
  'andrei rublev': 'Epic',
  'apocalypse now': 'Legendary',
  'badlands': 'Epic',
  'barry lyndon': 'Epic',
  'beau travail': 'Epic',
  'bicycle thieves': 'Epic',
  'chungking express': 'Epic',
  'citizen kane': 'Legendary',
  'city of god': 'Epic',
  'cleo from 5 to 7': 'Epic',
  'close-up': 'Epic',
  'come and see': 'Legendary',
  'do the right thing': 'Legendary',
  'goodfellas': 'Legendary',
  'grave of the fireflies': 'Epic',
  'harakiri': 'Legendary',
  'high and low': 'Epic',
  'ikiru': 'Legendary',
  'in the mood for love': 'Legendary',
  'jeanne dielman, 23, quai du commerce, 1080 bruxelles': 'Legendary',
  'la haine': 'Epic',
  'late spring': 'Epic',
  'le cercle rouge': 'Epic',
  'le trou': 'Epic',
  'mirror': 'Epic',
  'mulholland drive': 'Legendary',
  'nights of cabiria': 'Epic',
  'paper moon': 'Rare',
  'parasite': 'Epic',
  'paris, texas': 'Epic',
  'paris is burning': 'Epic',
  'persona': 'Legendary',
  'playtime': 'Epic',
  'rashomon': 'Legendary',
  'seven samurai': 'Legendary',
  'stalker': 'Legendary',
  'sunrise: a song of two humans': 'Epic',
  'taste of cherry': 'Epic',
  'the 400 blows': 'Epic',
  'the battle of algiers': 'Epic',
  'the color of pomegranates': 'Epic',
  'the french connection': 'Rare',
  'the godfather': 'Legendary',
  'the godfather part ii': 'Legendary',
  'the long goodbye': 'Epic',
  'the night of the hunter': 'Epic',
  'the passion of joan of arc': 'Legendary',
  'the red shoes': 'Epic',
  'the rules of the game': 'Legendary',
  'the third man': 'Epic',
  'the umbrellas of cherbourg': 'Epic',
  'the wizard of oz': 'Epic',
  'there will be blood': 'Legendary',
  'tokyo story': 'Legendary',
  'vertigo': 'Legendary',
  'woman in the dunes': 'Epic',
  'yi yi': 'Legendary'
};

const THEME_SOURCE_LABELS = {
  all: 'All Cinema',
  horror: 'Scary Movie Night',
  animation: 'Animation',
  eighties: '80s',
  noir: 'Film Noir',
  romcom: 'Rom Com'
};

function titleKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function rarityByRank(rank) {
  return {
    1: 'Prolific',
    2: 'Respected',
    3: 'Awarded',
    4: 'Iconic',
    5: 'Canon'
  }[Math.max(1, Math.min(5, Number(rank) || 1))] || 'Prolific';
}

function normalizeRarityLabel(value) {
  return rarityByRank(RARITY_ORDER[value] || 1);
}

function maxRarity(left, right) {
  const leftRank = RARITY_ORDER[left] || 0;
  const rightRank = RARITY_ORDER[right] || 0;
  return rarityByRank(Math.max(leftRank, rightRank));
}

function minRarity(left, right) {
  const leftRank = RARITY_ORDER[left] || 0;
  const rightRank = RARITY_ORDER[right] || 0;
  return rarityByRank(Math.min(leftRank || 1, rightRank || 1));
}

function filterPoolByTheme(pool, theme) {
  const selectedTheme = String(theme || '').trim().toLowerCase();
  if (!selectedTheme || selectedTheme === 'all') return Array.isArray(pool) ? pool.slice() : [];

  return (Array.isArray(pool) ? pool : []).filter(function (movie) {
    return Array.isArray(movie.packs) && movie.packs.indexOf(selectedTheme) !== -1;
  });
}

function mergeUniqueMovies(primary, secondary) {
  const merged = new Map();

  (Array.isArray(primary) ? primary : []).concat(Array.isArray(secondary) ? secondary : []).forEach(function (movie) {
    const key = String(movie && (movie.tmdbId || movie.id || movie.title) || '');
    if (key && !merged.has(key)) merged.set(key, movie);
  });

  return Array.from(merged.values());
}

function ensureSnapshotRoot() {
  if (!fs.existsSync(SNAPSHOT_ROOT)) {
    fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  }
}

function snapshotFilePath(cacheKey) {
  const safeKey = String(cacheKey || 'default').replace(/[^a-z0-9_-]+/gi, '_');
  return path.join(SNAPSHOT_ROOT, 'card-pool-' + safeKey + '.json');
}

function readPoolSnapshot(cacheKey, allowStale) {
  try {
    const filePath = snapshotFilePath(cacheKey);
    if (!fs.existsSync(filePath)) return null;

    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!payload || payload.version !== POOL_SNAPSHOT_VERSION || !Array.isArray(payload.movies) || !payload.movies.length) {
      return null;
    }

    const savedAt = Number(payload.savedAt) || 0;
    const age = Date.now() - savedAt;
    if (age <= POOL_SNAPSHOT_TTL_MS) {
      return {
        movies: payload.movies,
        expiresAt: savedAt + POOL_SNAPSHOT_TTL_MS,
        stale: false
      };
    }

    if (allowStale && age <= POOL_STALE_FALLBACK_TTL_MS) {
      return {
        movies: payload.movies,
        expiresAt: Date.now() + 1000 * 60 * 5,
        stale: true
      };
    }
  } catch (error) {
  }

  return null;
}

function writePoolSnapshot(cacheKey, movies) {
  try {
    ensureSnapshotRoot();
    fs.writeFileSync(snapshotFilePath(cacheKey), JSON.stringify({
      version: POOL_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      movies: Array.isArray(movies) ? movies : []
    }));
  } catch (error) {
  }
}

function cacheCardPool(cacheKey, movies, expiresAt) {
  const pool = Array.isArray(movies) ? movies : [];
  cache.cardPools.set(cacheKey, {
    value: pool,
    expiresAt: expiresAt || (Date.now() + CACHE_TTL_MS)
  });
  writePoolSnapshot(cacheKey, pool);
  return pool;
}

function reelCountForTheme(theme) {
  return theme && theme !== 'all' ? THEME_REEL_COUNT : BASE_REEL_COUNT;
}

function buildPoolCacheKey(limit, theme, reelIndex) {
  const normalizedTheme = String(theme || '').trim().toLowerCase();
  const baseKey = normalizedTheme ? String(limit) + ':' + normalizedTheme : String(limit);
  return baseKey + '@r' + String(Math.max(0, Number(reelIndex) || 0));
}

function nextRotationIndex(limit, theme) {
  const normalizedTheme = String(theme || '').trim().toLowerCase();
  const cursorKey = (normalizedTheme || 'all') + ':' + String(limit);
  const reelCount = reelCountForTheme(normalizedTheme);
  const nextIndex = (cache.poolRotationCursor.get(cursorKey) || 0) % reelCount;
  cache.poolRotationCursor.set(cursorKey, (nextIndex + 1) % reelCount);
  return nextIndex;
}

function sampleDistinctPageNumbers(count, maxPage) {
  const max = Math.max(1, Math.min(500, Number(maxPage) || 1));
  const target = Math.max(1, Math.min(Number(count) || 1, max));
  const picked = new Set([1]);

  while (picked.size < target) {
    picked.add(1 + Math.floor(Math.random() * max));
  }

  return Array.from(picked);
}

function buildRecipePages(recipe) {
  const pageWindow = Math.max(recipe.pages, Math.min(120, Number(recipe.pageWindow) || (recipe.pages * 10)));
  return sampleDistinctPageNumbers(recipe.pages, pageWindow);
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  });
}

function hasTmdbToken() {
  return Boolean(TMDB_BEARER_TOKEN);
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, ngrok-skip-browser-warning',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function writeText(res, statusCode, body, headers) {
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8'
  }, headers || {}));
  res.end(body);
}

function sendStatic(req, res, pathname) {
  const targetPath = pathname === '/' ? path.join(STATIC_ROOT, 'index.html') : path.join(STATIC_ROOT, pathname.replace(/^\/+/, ''));
  if (!targetPath.startsWith(STATIC_ROOT)) {
    writeText(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(targetPath, function (error, content) {
    if (error) {
      writeText(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const typeByExt = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml'
    };

    res.writeHead(200, {
      'Content-Type': typeByExt[ext] || 'application/octet-stream'
    });
    res.end(content);
  });
}

async function tmdbJson(endpoint, params) {
  if (!hasTmdbToken()) {
    throw new Error('TMDB_BEARER_TOKEN is not configured.');
  }

  const url = new URL(TMDB_API_BASE + endpoint);
  const mergedParams = Object.assign({
    language: 'en-US',
    include_adult: 'false'
  }, params || {});

  Object.keys(mergedParams).forEach(function (key) {
    if (mergedParams[key] != null && mergedParams[key] !== '') {
      url.searchParams.set(key, String(mergedParams[key]));
    }
  });

  const response = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + TMDB_BEARER_TOKEN,
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error('TMDB request failed for ' + endpoint + ' (' + response.status + '): ' + body);
  }

  return response.json();
}

async function getConfiguration() {
  if (cache.configuration.value && cache.configuration.expiresAt > Date.now()) {
    return cache.configuration.value;
  }

  const configuration = await tmdbJson('/configuration');
  cache.configuration = {
    value: configuration,
    expiresAt: Date.now() + CACHE_TTL_MS
  };
  return configuration;
}

async function getGenreMap() {
  if (cache.genres.value && cache.genres.expiresAt > Date.now()) {
    return cache.genres.value;
  }

  const payload = await tmdbJson('/genre/movie/list');
  const map = {};
  (payload.genres || []).forEach(function (genre) {
    map[genre.id] = genre.name;
  });

  cache.genres = {
    value: map,
    expiresAt: Date.now() + CACHE_TTL_MS
  };
  return map;
}

function chooseImageSize(availableSizes, preferredSizes) {
  const sizes = Array.isArray(availableSizes) ? availableSizes : [];
  const preferred = Array.isArray(preferredSizes) ? preferredSizes : [];

  for (let i = 0; i < preferred.length; i += 1) {
    if (sizes.indexOf(preferred[i]) !== -1) return preferred[i];
  }

  if (sizes.indexOf('original') !== -1) return 'original';
  return sizes.length ? sizes[sizes.length - 1] : 'original';
}

function buildImageUrl(configuration, filePath, sizeType) {
  if (!filePath) return null;
  const images = configuration && configuration.images ? configuration.images : {};
  const baseUrl = images.secure_base_url || images.base_url || 'https://image.tmdb.org/t/p/';
  const sizeKey = sizeType === 'profile'
    ? 'profile_sizes'
    : (sizeType === 'poster' ? 'poster_sizes' : 'backdrop_sizes');
  const size = chooseImageSize(
    images[sizeKey],
    sizeType === 'profile'
      ? ['h632', 'w300', 'original']
      : (sizeType === 'poster' ? ['w500', 'w342', 'original'] : ['w780', 'w1280', 'original'])
  );
  return baseUrl + size + filePath;
}

function extractYear(releaseDate) {
  const match = String(releaseDate || '').match(/^(\d{4})/);
  return match ? match[1] : null;
}

function decadeBucketForMovie(movie) {
  const year = Number(extractYear(movie && movie.release_date));
  if (!year) return 'unknown';
  return String(Math.floor(year / 10) * 10);
}

function normalizePersonName(value) {
  return String(value || '').trim().toLowerCase();
}

const PERSON_ROLE_CONFIG = [
  { key: 'director', type: 'director', label: 'Director', jobs: ['Director'] }
];

function pickPrimaryDirector(crew) {
  const directors = (Array.isArray(crew) ? crew : []).filter(function (member) {
    return member && member.job === 'Director';
  });
  if (!directors.length) return null;

  directors.sort(function (a, b) {
    return (Number(b.popularity) || 0) - (Number(a.popularity) || 0);
  });
  return directors[0];
}

function pickBestCrewMatch(crew, jobs) {
  const jobSet = new Set((Array.isArray(jobs) ? jobs : []).map(function (job) { return String(job); }));
  const matches = (Array.isArray(crew) ? crew : []).filter(function (member) {
    return member && jobSet.has(String(member.job || ''));
  });
  if (!matches.length) return null;

  matches.sort(function (a, b) {
    return (Number(b.popularity) || 0) - (Number(a.popularity) || 0);
  });
  return matches[0];
}

function normalizePersonCandidate(configuration, person, roleConfig, sourceMovieId) {
  if (!person || !person.id || !person.name) return null;

  return {
    personId: person.id,
    sourceMovieId: Number(sourceMovieId) || null,
    cardType: 'person',
    personType: roleConfig.type,
    roleKey: roleConfig.key,
    roleLabel: roleConfig.label,
    name: person.name,
    profile: buildImageUrl(configuration, person.profile_path, 'profile'),
    popularity: Number(person.popularity) || 0,
    gender: person.gender != null ? Number(person.gender) : null,
    character: person.character || '',
    department: person.known_for_department || person.department || '',
    job: person.job || '',
    linkUrl: 'https://www.themoviedb.org/person/' + person.id
  };
}

function buildPeopleCandidatesForMovie(configuration, movieId, credits) {
  const candidates = [];
  const cast = Array.isArray(credits && credits.cast) ? credits.cast : [];
  const crew = Array.isArray(credits && credits.crew) ? credits.crew : [];

  cast.filter(function (member) {
    return member && member.id && member.name && member.profile_path;
  }).sort(function (a, b) {
    return (Number(a.order) || 999) - (Number(b.order) || 999);
  }).slice(0, 5).forEach(function (actor) {
    const candidate = normalizePersonCandidate(configuration, actor, {
      key: 'actor',
      type: 'actor',
      label: 'Actor'
    }, movieId);
    if (candidate) candidates.push(candidate);
  });

  PERSON_ROLE_CONFIG.forEach(function (roleConfig) {
    const match = pickBestCrewMatch(crew, roleConfig.jobs);
    const candidate = normalizePersonCandidate(configuration, match, roleConfig, movieId);
    if (candidate) candidates.push(candidate);
  });

  return candidates;
}

async function getMoviePeople(movieIds) {
  const configuration = await getConfiguration();
  const ids = Array.isArray(movieIds) ? movieIds.map(function (id) { return Number(id) || 0; }).filter(Boolean) : [];
  const uniqueIds = Array.from(new Set(ids)).slice(0, 12);
  const byPerson = new Map();

  for (let i = 0; i < uniqueIds.length; i += 1) {
    const movieId = uniqueIds[i];
    let credits;
    try {
      credits = await getMovieCredits(movieId);
    } catch (error) {
      credits = null;
    }
    if (!credits) continue;

    buildPeopleCandidatesForMovie(configuration, movieId, credits).forEach(function (candidate) {
      const key = String(candidate.personId);
      if (!byPerson.has(key) || (Number(candidate.popularity) || 0) > (Number(byPerson.get(key).popularity) || 0)) {
        byPerson.set(key, candidate);
      }
    });
  }

  return Array.from(byPerson.values());
}

function isFemaleDirectedMovie(movie) {
  return Number(movie.directorGender) === 1 || Boolean(FEMALE_DIRECTOR_NAMES[normalizePersonName(movie.directorName)]);
}

function derivePacks(movie) {
  const tags = new Set(['all']);
  const lookup = {};
  const genreNames = Array.isArray(movie.genreNames) ? movie.genreNames : [];
  const popularity = Number(movie.popularity) || 0;
  const voteAverage = Number(movie.voteAverage != null ? movie.voteAverage : movie.vote_average) || 0;
  const voteCount = Number(movie.voteCount != null ? movie.voteCount : movie.vote_count) || 0;
  const year = Number(movie.year || extractYear(movie.release_date)) || 0;

  genreNames.forEach(function (name) {
    lookup[String(name).toLowerCase()] = true;
  });

  if (lookup.horror || lookup.thriller) tags.add('horror');
  if (lookup.crime || lookup.noir || lookup.mystery || lookup.thriller || (lookup.drama && popularity <= 30 && voteAverage >= 7)) tags.add('noir');
  if (lookup.animation || lookup.family) tags.add('animation');
  if (year >= 1980 && year <= 1989) tags.add('eighties');
  if ((lookup.romance && lookup.comedy) || (lookup.romance && lookup.drama && year >= 1980) || (lookup.comedy && popularity >= 18 && voteAverage >= 6.4)) tags.add('romcom');
  if (lookup.drama || lookup.history || lookup.music || lookup.war || (voteAverage >= 7.5 && voteCount >= 400)) tags.add('all');

  return Array.from(tags);
}

function computeScore(movie) {
  const year = Number(extractYear(movie.release_date)) || 0;
  const popularity = Number(movie.popularity) || 0;
  const voteAverage = Number(movie.vote_average) || 0;
  const voteCount = Number(movie.vote_count) || 0;
  const acclaimScore = voteAverage * 11.5;
  const footprintScore = Math.log10(voteCount + 1) * 10.5;
  const recognitionScore = Math.min(24, Math.sqrt(Math.max(popularity, 0)) * 3.6);
  const legacyScore = year ? Math.max(0, Math.min(20, (2012 - Math.min(year, 2012)) / 6)) : 0;
  const worldCinemaBonus = String(movie.original_language || '').toLowerCase() !== 'en' ? 2.5 : 0;
  const nicheLoveBonus = voteAverage >= 7.7 && voteCount >= 80 && popularity <= 18 ? 3.5 : 0;
  const obscurityPenalty = voteCount < 20 ? 20 : voteCount < 45 ? 11 : voteCount < 80 ? 5 : 0;
  const recencyPenalty = year >= 2025 ? 8 : year >= 2023 ? 4 : year >= 2020 ? 1.5 : 0;
  const blockbusterPenalty = popularity > 65 ? (popularity - 65) * 0.18 : 0;
  return acclaimScore
    + footprintScore
    + recognitionScore
    + legacyScore
    + worldCinemaBonus
    + nicheLoveBonus
    - obscurityPenalty
    - recencyPenalty
    - blockbusterPenalty;
}

function selectDiversifiedPool(movies, limit) {
  const buckets = new Map();
  const ordered = Array.isArray(movies) ? movies.slice() : [];

  ordered.forEach(function (movie) {
    const decade = decadeBucketForMovie(movie);
    if (!buckets.has(decade)) buckets.set(decade, []);
    buckets.get(decade).push(movie);
  });

  const decadeKeys = Array.from(buckets.keys()).sort();
  const selected = [];

  while (selected.length < limit) {
    let addedThisRound = false;
    for (let i = 0; i < decadeKeys.length && selected.length < limit; i += 1) {
      const bucket = buckets.get(decadeKeys[i]);
      if (bucket && bucket.length) {
        selected.push(bucket.shift());
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
  }

  return selected;
}

function assignRarity(rank, total) {
  const percentile = total ? (rank + 1) / total : 1;
  if (percentile <= 0.008) return 'Canon';
  if (percentile <= 0.04) return 'Iconic';
  if (percentile <= 0.17) return 'Awarded';
  if (percentile <= 0.5) return 'Respected';
  return 'Prolific';
}

function rarityFloorForMovie(movie) {
  const titleFloor = TITLE_RARITY_FLOORS[titleKey(movie && movie.title)];
  if (titleFloor) return normalizeRarityLabel(titleFloor);

  const year = Number(extractYear(movie && movie.release_date)) || 0;
  const voteAverage = Number(movie && movie.vote_average) || 0;
  const voteCount = Number(movie && movie.vote_count) || 0;
  const popularity = Number(movie && movie.popularity) || 0;
  const originalLanguage = String(movie && movie.original_language || '').toLowerCase();

  let floor = 'Prolific';

  if (voteAverage >= 7.3 && voteCount >= 220) {
    floor = maxRarity(floor, 'Respected');
  }

  if (year && year <= 2000 && voteAverage >= 7.1 && voteCount >= 120) {
    floor = maxRarity(floor, 'Respected');
  }

  if (originalLanguage && originalLanguage !== 'en' && voteAverage >= 7.3 && voteCount >= 60) {
    floor = maxRarity(floor, 'Respected');
  }

  if (voteAverage >= 8.4 && voteCount >= 1800) {
    floor = maxRarity(floor, 'Iconic');
  } else if (voteAverage >= 8.1 && voteCount >= 900) {
    floor = maxRarity(floor, 'Awarded');
  }

  if (year && year <= 1975 && voteAverage >= 8.2 && voteCount >= 220) {
    floor = maxRarity(floor, 'Iconic');
  } else if (year && year <= 1990 && voteAverage >= 8.0 && voteCount >= 180) {
    floor = maxRarity(floor, 'Awarded');
  }

  if (year && year <= 1985 && voteAverage >= 7.7 && voteCount >= 140) {
    floor = maxRarity(floor, 'Awarded');
  }

  if (year && year <= 1975 && voteAverage >= 7.6 && voteCount >= 90) {
    floor = maxRarity(floor, 'Awarded');
  }

  if (originalLanguage && originalLanguage !== 'en' && voteAverage >= 8.0 && voteCount >= 180) {
    floor = maxRarity(floor, year && year <= 1980 ? 'Iconic' : 'Awarded');
  } else if (originalLanguage && originalLanguage !== 'en' && year && year <= 1985 && voteAverage >= 7.7 && voteCount >= 70) {
    floor = maxRarity(floor, 'Awarded');
  }

  if (popularity >= 45 && voteAverage >= 7.8 && voteCount >= 3500) {
    floor = maxRarity(floor, 'Awarded');
  }

  return floor;
}

function rarityCeilingForMovie(movie) {
  if (TITLE_RARITY_FLOORS[titleKey(movie && movie.title)]) {
    return 'Canon';
  }

  const year = Number(extractYear(movie && movie.release_date)) || 0;
  const voteAverage = Number(movie && movie.vote_average) || 0;
  const voteCount = Number(movie && movie.vote_count) || 0;
  const popularity = Number(movie && movie.popularity) || 0;

  if (voteCount < 20 && popularity < 4) {
    return 'Respected';
  }

  if (voteCount < 60 && popularity < 8 && voteAverage < 8.4) {
    return 'Awarded';
  }

  if (voteCount < 140 && popularity < 12 && voteAverage < 8.2) {
    return 'Iconic';
  }

  if (year >= 2023 && voteCount < 350 && popularity < 18 && voteAverage < 8.4) {
    return 'Awarded';
  }

  return 'Canon';
}

function normalizeMovie(configuration, genreMap, movie) {
  const genreNames = (movie.genre_ids || []).map(function (id) { return genreMap[id]; }).filter(Boolean);
  const normalized = {
    title: movie.title,
    rarity: normalizeRarityLabel(movie.rarity),
    genre: genreNames[0] || 'Film',
    genreNames: genreNames,
    desc: movie.overview || 'No synopsis available yet.',
    packs: [],
    poster: buildImageUrl(configuration, movie.poster_path, 'poster'),
    still: buildImageUrl(configuration, movie.backdrop_path, 'backdrop'),
    tmdbId: movie.id,
    year: extractYear(movie.release_date),
    popularity: Number(movie.popularity) || 0,
    voteAverage: Number(movie.vote_average) || 0,
    voteCount: Number(movie.vote_count) || 0,
    originalLanguage: movie.original_language || null,
    directorName: movie.directorName || null,
    directorGender: movie.directorGender != null ? Number(movie.directorGender) : null
  };
  normalized.packs = derivePacks(normalized);
  return normalized;
}

async function getMovieCredits(movieId) {
  const cacheKey = String(movieId || '');
  if (!cacheKey) return null;

  const cached = cache.movieCredits.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const credits = await tmdbJson('/movie/' + movieId + '/credits');
  cache.movieCredits.set(cacheKey, {
    value: credits,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  return credits;
}

async function enrichMovieWithCredits(movie) {
  try {
    const credits = await getMovieCredits(movie.id);
    const director = pickPrimaryDirector(credits && credits.crew);
    if (!director) return movie;

    return Object.assign({}, movie, {
      directorName: director.name || null,
      directorGender: director.gender != null ? Number(director.gender) : null
    });
  } catch (error) {
    return movie;
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

async function buildCardPool(limit) {
  const configuration = await getConfiguration();
  const genreMap = await getGenreMap();
  const today = new Date().toISOString().slice(0, 10);
  const requests = [];

  DISCOVER_RECIPES.forEach(function (recipe) {
    const pages = buildRecipePages(recipe);
    for (let i = 0; i < pages.length; i += 1) {
      requests.push(tmdbJson('/discover/movie', Object.assign({
        page: pages[i],
        include_video: 'false',
        'primary_release_date.lte': today
      }, recipe.params)));
    }
  });

  const settledResponses = await Promise.allSettled(requests);
  const responses = settledResponses
    .filter(function (entry) { return entry.status === 'fulfilled' && entry.value; })
    .map(function (entry) { return entry.value; });

  if (!responses.length) {
    throw new Error('Unable to build card pool from TMDB discover results.');
  }

  const deduped = new Map();

  responses.forEach(function (payload) {
    (payload.results || []).forEach(function (movie) {
      if (!movie || movie.adult || !movie.title || !movie.poster_path) return;
      if (!extractYear(movie.release_date)) return;
      if (!movie.overview || String(movie.overview).trim().length < 24) return;
      if (!deduped.has(movie.id)) {
        deduped.set(movie.id, movie);
      } else if (!deduped.get(movie.id).backdrop_path && movie.backdrop_path) {
        deduped.set(movie.id, movie);
      }
    });
  });

  const ranked = selectDiversifiedPool(
    Array.from(deduped.values()).sort(function (a, b) { return computeScore(b) - computeScore(a); }),
    limit
  );

  ranked.forEach(function (movie, index) {
    const baseRarity = assignRarity(index, ranked.length);
    const raised = maxRarity(baseRarity, rarityFloorForMovie(movie));
    movie.rarity = minRarity(raised, rarityCeilingForMovie(movie));
  });

  const enriched = await mapWithConcurrency(ranked, 8, enrichMovieWithCredits);

  return enriched.map(function (movie) {
    return normalizeMovie(configuration, genreMap, movie);
  });
}

async function buildThemePool(limit, theme) {
  const normalizedTheme = String(theme || '').trim().toLowerCase();
  const targetLimit = Math.max(100, Math.min(1200, Number(limit) || 600));
  let themedPool = [];
  let attempts = 0;

  while (themedPool.length < Math.min(targetLimit, 880) && attempts < 8) {
    attempts += 1;
    const basePool = await buildCardPool(1200);
    themedPool = mergeUniqueMovies(themedPool, filterPoolByTheme(basePool, normalizedTheme));
  }

  return shuffledCopy(themedPool).slice(0, targetLimit);
}

async function buildPoolForRequest(limit, theme) {
  return theme && theme !== 'all'
    ? buildThemePool(limit, theme)
    : buildCardPool(limit);
}

function refreshPoolInBackground(cacheKey, limit, theme) {
  if (cache.poolBuilds.has(cacheKey)) return;

  const buildPromise = buildPoolForRequest(limit, theme)
    .then(function (pool) {
      cacheCardPool(cacheKey, pool);
      return pool;
    })
    .catch(function () {
      return null;
    })
    .finally(function () {
      cache.poolBuilds.delete(cacheKey);
    });

  cache.poolBuilds.set(cacheKey, buildPromise);
}

async function prewarmStartupPools() {
  for (let reelIndex = 0; reelIndex < BASE_REEL_COUNT; reelIndex += 1) {
    setTimeout(function () {
      refreshPoolInBackground(buildPoolCacheKey(1200, '', reelIndex), 1200, '');
    }, reelIndex * 180);
  }

  try {
    const baseBuilds = [];
    for (let reelIndex = 0; reelIndex < BASE_REEL_COUNT; reelIndex += 1) {
      const build = cache.poolBuilds.get(buildPoolCacheKey(1200, '', reelIndex));
      if (build) baseBuilds.push(build);
    }
    if (baseBuilds.length) {
      await Promise.allSettled(baseBuilds);
    }
  } catch (error) {
  }

  STARTUP_PREWARM_THEMES.forEach(function (themeKey, index) {
    for (let reelIndex = 0; reelIndex < THEME_REEL_COUNT; reelIndex += 1) {
      setTimeout(function () {
        refreshPoolInBackground(buildPoolCacheKey(1200, themeKey, reelIndex), 1200, themeKey);
      }, (index * THEME_REEL_COUNT * 250) + (reelIndex * 250));
    }
  });
}

async function getCardPool(limit, refresh, theme, rotationMode) {
  const normalizedLimit = Math.max(100, Math.min(1200, Number(limit) || 600));
  const normalizedTheme = String(theme || '').trim().toLowerCase();
  const reelCount = reelCountForTheme(normalizedTheme);
  const requestedReelIndex = rotationMode === 'auto'
    ? nextRotationIndex(normalizedLimit, normalizedTheme)
    : Math.max(0, Math.min(reelCount - 1, Number(rotationMode) || 0));
  const cacheKey = buildPoolCacheKey(normalizedLimit, normalizedTheme, requestedReelIndex);

  if (refresh) {
    const freshPool = await buildPoolForRequest(normalizedLimit, normalizedTheme);
    return cacheCardPool(cacheKey, freshPool);
  }

  const cached = cache.cardPools.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const diskSnapshot = readPoolSnapshot(cacheKey, false);
  if (diskSnapshot) {
    cache.cardPools.set(cacheKey, {
      value: diskSnapshot.movies,
      expiresAt: diskSnapshot.expiresAt
    });
    return diskSnapshot.movies;
  }

  const staleSnapshot = readPoolSnapshot(cacheKey, true);
  if (staleSnapshot) {
    cache.cardPools.set(cacheKey, {
      value: staleSnapshot.movies,
      expiresAt: staleSnapshot.expiresAt
    });
    refreshPoolInBackground(cacheKey, normalizedLimit, normalizedTheme);
    return staleSnapshot.movies;
  }

  if (cache.poolBuilds.has(cacheKey)) {
    return cache.poolBuilds.get(cacheKey);
  }

  const buildPromise = buildPoolForRequest(normalizedLimit, normalizedTheme)
    .then(function (pool) {
      return cacheCardPool(cacheKey, pool);
    })
    .finally(function () {
      cache.poolBuilds.delete(cacheKey);
    });

  cache.poolBuilds.set(cacheKey, buildPromise);
  return buildPromise;
}

function shuffledCopy(items) {
  const copy = Array.isArray(items) ? items.slice() : [];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[swapIndex];
    copy[swapIndex] = temp;
  }
  return copy;
}

async function getMovieArt(title) {
  const cacheKey = String(title || '').toLowerCase().trim();
  if (!cacheKey) return null;

  const cached = cache.movieArt.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const configuration = await getConfiguration();
  const search = await tmdbJson('/search/movie', { query: title, page: 1 });
  const match = (search.results || []).find(function (movie) {
    return (movie.poster_path || movie.backdrop_path) && movie.overview && String(movie.overview).trim().length >= 24;
  }) || (search.results || []).find(function (movie) {
    return (movie.poster_path || movie.backdrop_path);
  }) || (search.results || [])[0];
  if (!match) return null;

  const details = await tmdbJson('/movie/' + match.id);
  const credits = await getMovieCredits(match.id);
  const director = pickPrimaryDirector(credits && credits.crew);
  const genreNames = (details.genres || []).map(function (genre) { return genre.name; });
  const art = {
    tmdbId: details.id,
    title: details.title,
    poster: buildImageUrl(configuration, details.poster_path, 'poster'),
    backdrop: buildImageUrl(configuration, details.backdrop_path, 'backdrop'),
    year: extractYear(details.release_date),
    desc: details.overview || '',
    genreNames: genreNames,
    popularity: Number(details.popularity) || 0,
    voteAverage: Number(details.vote_average) || 0,
    voteCount: Number(details.vote_count) || 0,
    originalLanguage: details.original_language || null,
    directorName: director ? director.name || null : null,
    directorGender: director && director.gender != null ? Number(director.gender) : null
  };
  art.packs = derivePacks(art);

  cache.movieArt.set(cacheKey, {
    value: art,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  return art;
}

async function proxyImage(res, urlValue) {
  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch (error) {
    writeJson(res, 400, { error: 'Invalid image url.' });
    return;
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'image.tmdb.org') {
    writeJson(res, 400, { error: 'Only TMDB image urls can be proxied.' });
    return;
  }

  const response = await fetch(parsed.toString(), {
    headers: { accept: 'image/*' }
  });

  if (!response.ok) {
    writeJson(res, response.status, { error: 'Image fetch failed.' });
    return;
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();
  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(Buffer.from(arrayBuffer));
}

async function routeApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, ngrok-skip-browser-warning'
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/health') {
    writeJson(res, 200, {
      ok: true,
      tmdbConfigured: hasTmdbToken()
    });
    return;
  }

  if (!hasTmdbToken()) {
    writeJson(res, 503, {
      error: 'TMDB_BEARER_TOKEN is not configured.'
    });
    return;
  }

  if (url.pathname === '/api/card-pool') {
    const refresh = url.searchParams.get('refresh') === '1';
    const theme = String(url.searchParams.get('theme') || '').trim().toLowerCase();
    const shuffle = url.searchParams.get('shuffle') === '1';
    const requestedSampleSize = Math.max(0, Number(url.searchParams.get('sample')) || 0);
    const rotationMode = url.searchParams.get('rotate') === '1' || shuffle || requestedSampleSize
      ? 'auto'
      : url.searchParams.get('reel');
    const basePool = await getCardPool(url.searchParams.get('limit'), refresh, theme, rotationMode);
    const sampleSize = Math.max(0, Math.min(basePool.length, requestedSampleSize));
    const preparedPool = shuffle ? shuffledCopy(basePool) : basePool.slice();
    const movies = sampleSize ? preparedPool.slice(0, sampleSize) : preparedPool;
    writeJson(res, 200, {
      sourceLabel: (theme && THEME_SOURCE_LABELS[theme] ? THEME_SOURCE_LABELS[theme] + ' TMDB' : 'TMDB')
        + (rotationMode === 'auto' ? ' Rotating Reel' : '')
        + (refresh ? ' Fresh Reel' : ''),
      count: movies.length,
      movies: movies
    });
    return;
  }

  if (url.pathname === '/api/movie-art') {
    const title = url.searchParams.get('title');
    const art = await getMovieArt(title);
    if (!art) {
      writeJson(res, 404, { error: 'Movie not found.' });
      return;
    }
    writeJson(res, 200, art);
    return;
  }

  if (url.pathname === '/api/movie-people') {
    const movieIds = String(url.searchParams.get('movieIds') || '')
      .split(',')
      .map(function (value) { return Number(value.trim()) || 0; })
      .filter(Boolean);

    if (!movieIds.length) {
      writeJson(res, 400, { error: 'Missing movieIds parameter.' });
      return;
    }

    const people = await getMoviePeople(movieIds);
    writeJson(res, 200, {
      count: people.length,
      people: people
    });
    return;
  }

  if (url.pathname === '/api/image-proxy') {
    const imageUrl = url.searchParams.get('url');
    if (!imageUrl) {
      writeJson(res, 400, { error: 'Missing url parameter.' });
      return;
    }
    await proxyImage(res, imageUrl);
    return;
  }

  writeJson(res, 404, { error: 'Not found.' });
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  try {
    if (url.pathname.indexOf('/api/') === 0) {
      await routeApi(req, res, url);
      return;
    }

    sendStatic(req, res, url.pathname);
  } catch (error) {
    writeJson(res, 500, {
      error: error.message
    });
  }
});

server.listen(PORT, function () {
  console.log('filmTCG server running on http://localhost:' + PORT);
  if (!hasTmdbToken()) {
    console.log('Set TMDB_BEARER_TOKEN to enable live film data.');
    return;
  }

  prewarmStartupPools();
});
