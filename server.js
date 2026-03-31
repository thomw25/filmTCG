const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

loadEnvFile();

const PORT = Number(process.env.PORT || 3001);
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN || process.env.TMDB_API_READ_ACCESS_TOKEN || '';
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const STATIC_ROOT = __dirname;
const IS_VERCEL = Boolean(process.env.VERCEL);
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const POOL_SNAPSHOT_TTL_MS = CACHE_TTL_MS;
const POOL_STALE_FALLBACK_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const LOGIC_VERSION = 'logic-2026-03-31-2';
const POOL_SNAPSHOT_VERSION = 'server-rotation-20';
const SNAPSHOT_ROOT = IS_VERCEL ? path.join('/tmp', 'filmtcg-cache') : path.join(STATIC_ROOT, '.cache');
const STARTUP_PREWARM_THEMES = ['horror', 'animation', 'eighties', 'noir', 'romcom', 'docs', 'actors'];
const BASE_REEL_COUNT = 3;
const THEME_REEL_COUNT = 2;
const MAX_REQUEST_POOL_LIMIT = 1000;
const BASE_PREWARM_LIMIT = 900;
const THEME_PREWARM_LIMIT = 540;
const MAX_HOT_CARD_POOLS = 5;
const MAX_MOVIE_ART_CACHE = 120;
const MAX_MOVIE_CREDITS_CACHE = 180;
const MAX_PERSON_CREDITS_CACHE = 120;
const MAX_PERSON_DETAILS_CACHE = 120;
const TV_MOVIE_GENRE_ID = 10770;
const GENRE_NAME_BY_ID = {
  12: ['adventure'],
  14: ['fantasy'],
  16: ['animation'],
  18: ['drama'],
  27: ['horror'],
  28: ['action'],
  35: ['comedy'],
  36: ['history'],
  53: ['thriller'],
  80: ['crime', 'noir'],
  99: ['documentary'],
  878: ['sci-fi', 'science fiction'],
  9648: ['mystery', 'noir'],
  10402: ['music', 'musical'],
  10749: ['romance'],
  10751: ['family'],
  10752: ['war']
};

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
  movieCredits: new Map(),
  personMovieCredits: new Map(),
  personCombinedCredits: new Map(),
  personDetails: new Map()
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
  { key: 'documentary', pages: 6, params: { sort_by: 'vote_count.desc', with_genres: '99', 'vote_count.gte': '40', 'primary_release_date.lte': '2021-12-31' } },
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

const UNDERAPPRECIATED_BLACK_DIRECTOR_NAMES = {
  'bill gunn': true,
  'charles burnett': true,
  'cheryl dunye': true,
  'euzhan palcy': true,
  'gordon parks': true,
  'haile gerima': true,
  'jamaa fanaka': true,
  'julie dash': true,
  'kasi lemmons': true,
  'marlon riggs': true,
  'melvin van peebles': true,
  'nia dacosta': true,
  'radha blank': true,
  'rick famuyiwa': true,
  'shaka king': true
};

const RARITY_ORDER = {
  Prolific: 1,
  Base: 1,
  Common: 1,
  Respected: 2,
  Select: 2,
  Uncommon: 2,
  Rare: 2,
  Awarded: 2,
  Epic: 3,
  Iconic: 3,
  Legendary: 4,
  Canon: 4
};

const TITLE_RARITY_FLOORS = {
  '2001: a space odyssey': 'Legendary',
  '8 1/2': 'Epic',
  '8½': 'Epic',
  '12 angry men': 'Legendary',
  'a matter of loaf and death': 'Select',
  'a close shave': 'Epic',
  'a grand day out': 'Select',
  'a brighter summer day': 'Epic',
  'all that jazz': 'Epic',
  'andrei rublev': 'Epic',
  'apocalypse now': 'Legendary',
  'badlands': 'Epic',
  'boogie nights': 'Epic',
  'barry lyndon': 'Epic',
  'beau travail': 'Epic',
  'bicycle thieves': 'Epic',
  'black hawk down': 'Select',
  'coming to america': 'Select',
  'chungking express': 'Epic',
  'citizen kane': 'Legendary',
  'city of god': 'Epic',
  'cleo from 5 to 7': 'Epic',
  'black panther': 'Epic',
  'candyman': 'Select',
  'close-up': 'Epic',
  'come and see': 'Legendary',
  'dazed and confused': 'Epic',
  'do the right thing': 'Legendary',
  'dumbo': 'Select',
  'easy rider': 'Select',
  'election': 'Epic',
  'e.t. the extra-terrestrial': 'Epic',
  'et the extra-terrestrial': 'Epic',
  'friday the 13th': 'Select',
  'goodfellas': 'Legendary',
  'grey gardens': 'Epic',
  'grave of the fireflies': 'Epic',
  'halloween': 'Epic',
  'hereditary': 'Epic',
  'hard boiled': 'Epic',
  'his girl friday': 'Epic',
  'little shop of horrors': 'Select',
  'sleeping beauty': 'Select',
  'harakiri': 'Legendary',
  'high and low': 'Epic',
  'ikiru': 'Legendary',
  'in the mood for love': 'Legendary',
  'jeanne dielman, 23, quai du commerce, 1080 bruxelles': 'Legendary',
  'karate kid': 'Select',
  'the karate kid': 'Select',
  'la haine': 'Epic',
  'la la land': 'Epic',
  'oklahoma': 'Select',
  'oklahoma!': 'Select',
  'late spring': 'Epic',
  'le cercle rouge': 'Epic',
  'le trou': 'Epic',
  'lost in translation': 'Epic',
  'mirror': 'Epic',
  'mulholland drive': 'Legendary',
  'moonlight': 'Epic',
  'nights of cabiria': 'Epic',
  'police story': 'Epic',
  'paper moon': 'Select',
  'parasite': 'Epic',
  'paris, texas': 'Epic',
  'paris is burning': 'Epic',
  'persona': 'Legendary',
  'phantom thread': 'Epic',
  'playtime': 'Epic',
  'rashomon': 'Legendary',
  'robocop': 'Epic',
  'roman holiday': 'Epic',
  'seven samurai': 'Legendary',
  'singin\' in the rain': 'Legendary',
  'stalker': 'Legendary',
  'sunrise: a song of two humans': 'Epic',
  'taste of cherry': 'Epic',
  'the favourite': 'Epic',
  'the 400 blows': 'Epic',
  'the battle of algiers': 'Epic',
  'the birds': 'Epic',
  'the color of pomegranates': 'Epic',
  'the french connection': 'Select',
  'the godfather': 'Legendary',
  'the godfather part ii': 'Legendary',
  'the long goodbye': 'Epic',
  'the night of the hunter': 'Epic',
  'the passion of joan of arc': 'Legendary',
  'the red shoes': 'Epic',
  'the rules of the game': 'Legendary',
  'the sandlot': 'Epic',
  'some like it hot': 'Epic',
  'sunset boulevard': 'Epic',
  'the swimmer': 'Select',
  'the terminator': 'Epic',
  'the third man': 'Epic',
  'the umbrellas of cherbourg': 'Epic',
  'the wrong trousers': 'Epic',
  'the wizard of oz': 'Epic',
  'there will be blood': 'Legendary',
  'tokyo story': 'Legendary',
  'vertigo': 'Legendary',
  'west side story': 'Epic',
  'when harry met sally...': 'Epic',
  'woman in the dunes': 'Epic',
  'apollo 13': 'Epic',
  'yi yi': 'Legendary',
  'alien': 'Epic',
  'the thing': 'Epic',
  'suspiria': 'Epic',
  'escape from l.a.': 'Select',
  'escape from la': 'Select',
  'julien donkey-boy': 'Select',
  'pineapple express': 'Select'
  ,
  'the little mermaid': 'Epic',
  'little mermaid': 'Epic'
};

const CANON_SHORT_TITLES = [
  'A Grand Day Out',
  'The Wrong Trousers',
  'A Close Shave',
  'A Matter of Loaf and Death'
];

const EPIC_PROMOTION_TITLES = new Set([
  'finding nemo',
  'thief',
  'paper moon',
  'the french connection',
  'spider-man',
  'spiderman',
  'spider-man 2',
  'spider-man 2002'
]);

const THEME_SOURCE_LABELS = {
  all: 'All Cinema',
  horror: 'Scary Movie Night',
  animation: 'Animation',
  eighties: '80s',
  noir: 'Film Noir',
  romcom: 'Rom Com',
  docs: 'Documentary',
  actors: 'Actors'
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
    1: 'Base',
    2: 'Select',
    3: 'Epic',
    4: 'Legendary'
  }[Math.max(1, Math.min(4, Number(rank) || 1))] || 'Base';
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
  if (selectedTheme === 'actors') return Array.isArray(pool) ? pool.slice() : [];

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

function normalizeThemeKey(theme) {
  const normalized = String(theme || '').trim().toLowerCase();
  return normalized || 'all';
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
        stale: false,
        themeKey: normalizeThemeKey(payload.themeKey)
      };
    }

    if (allowStale && age <= POOL_STALE_FALLBACK_TTL_MS) {
      return {
        movies: payload.movies,
        expiresAt: Date.now() + 1000 * 60 * 5,
        stale: true,
        themeKey: normalizeThemeKey(payload.themeKey)
      };
    }
  } catch (error) {
  }

  return null;
}

function writePoolSnapshot(cacheKey, movies, themeKey) {
  try {
    ensureSnapshotRoot();
    fs.writeFileSync(snapshotFilePath(cacheKey), JSON.stringify({
      version: POOL_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      themeKey: normalizeThemeKey(themeKey),
      movies: Array.isArray(movies) ? movies : []
    }));
  } catch (error) {
  }
}

function touchMapEntry(map, key, value) {
  if (!map || !key) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
}

function trimMapBySize(map, maxSize) {
  if (!map || !maxSize || map.size <= maxSize) return;
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey == null) break;
    map.delete(oldestKey);
  }
}

function movieIdentityKey(movie) {
  return String(movie && (movie.tmdbId || movie.id || movie.title) || '').trim().toLowerCase();
}

function loadSnapshotRepeatCounts(theme) {
  const counts = new Map();
  const normalizedTheme = normalizeThemeKey(theme);

  try {
    if (!fs.existsSync(SNAPSHOT_ROOT)) return counts;
    const files = fs.readdirSync(SNAPSHOT_ROOT).filter(function (name) {
      return /^card-pool-.*\.json$/i.test(String(name || ''));
    });

    files.forEach(function (fileName) {
      try {
        const payload = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_ROOT, fileName), 'utf8'));
        if (!payload || payload.version !== POOL_SNAPSHOT_VERSION) return;
        if (normalizeThemeKey(payload.themeKey) !== normalizedTheme) return;
        const seenInSnapshot = new Set();
        (Array.isArray(payload.movies) ? payload.movies : []).forEach(function (movie) {
          const key = movieIdentityKey(movie);
          if (!key || seenInSnapshot.has(key)) return;
          seenInSnapshot.add(key);
          counts.set(key, (counts.get(key) || 0) + 1);
        });
      } catch (error) {
      }
    });
  } catch (error) {
  }

  return counts;
}

function titleRepeatPenalty(movie, repeatCounts) {
  const key = movieIdentityKey(movie);
  if (!key || !repeatCounts || !repeatCounts.has(key)) return 0;
  const count = Number(repeatCounts.get(key)) || 0;
  if (count <= 0) return 0;
  if (count >= 6) return 340;
  if (count >= 5) return 280;
  if (count >= 4) return 220;
  if (count >= 3) return 150;
  if (count >= 2) return 95;
  return 45;
}

function isTvMovieLike(movie) {
  if (movieHasGenreId(movie, TV_MOVIE_GENRE_ID)) return true;
  const genreNames = Array.isArray(movie && movie.genreNames) ? movie.genreNames : [];
  return genreNames.some(function (name) {
    return titleKey(name) === 'tv movie';
  });
}

function computeDiversifiedPoolScore(movie, theme, repeatCounts) {
  const normalizedTheme = normalizeThemeKey(theme);
  let score = computePoolSelectionScore(movie);
  const signals = computeMovieSignals(movie);

  score -= titleRepeatPenalty(movie, repeatCounts);
  if (repeatCounts && repeatCounts.has(movieIdentityKey(movie))) {
    const repeatCount = Number(repeatCounts.get(movieIdentityKey(movie))) || 0;
    if (!signals.majorPromotionProxy) score -= 20;
    if (signals.lowSignalObscurityProxy || signals.microObscureOverperformerProxy) score -= 28;
    if (signals.voteCount < 240 && signals.popularity < 10) score -= 18;
    if (repeatCount >= 3) score -= 28;
    if (repeatCount >= 5) score -= 44;
  }

  if (isTvMovieLike(movie)) score -= 26;

  if (normalizedTheme === 'docs' || normalizedTheme === 'all') {
    if (signals.celebrityEventDocProxy) score -= 14;
    if (signals.concertFandomDocProxy) score -= 12;
    if (signals.voteCount < 180 && !signals.documentaryLandmarkProxy) score -= 8;
  }

  return score;
}

function cacheCardPool(cacheKey, movies, expiresAt, themeKey) {
  const pool = applyCurrentRarityToPool(movies);
  touchMapEntry(cache.cardPools, cacheKey, {
    value: pool,
    expiresAt: expiresAt || (Date.now() + CACHE_TTL_MS)
  });
  trimMapBySize(cache.cardPools, MAX_HOT_CARD_POOLS);
  writePoolSnapshot(cacheKey, pool, themeKey);
  return pool;
}

function weightedChoice(entries) {
  const source = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const total = source.reduce(function (sum, entry) {
    return sum + Math.max(0, Number(entry.weight) || 0);
  }, 0);
  if (!source.length) return null;
  if (!total) return source[source.length - 1];
  let roll = Math.random() * total;
  for (let i = 0; i < source.length; i += 1) {
    roll -= Math.max(0, Number(source[i].weight) || 0);
    if (roll <= 0) return source[i];
  }
  return source[source.length - 1];
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
  const previousIndex = cache.poolRotationCursor.get(cursorKey);
  let nextIndex = Math.floor(Math.random() * reelCount);

  if (reelCount > 1 && previousIndex != null && nextIndex === previousIndex) {
    nextIndex = (nextIndex + 1 + Math.floor(Math.random() * Math.max(1, reelCount - 1))) % reelCount;
  }

  cache.poolRotationCursor.set(cursorKey, nextIndex);
  return nextIndex;
}

function sampleDistinctPageNumbers(count, maxPage) {
  const max = Math.max(1, Math.min(500, Number(maxPage) || 1));
  const target = Math.max(1, Math.min(Number(count) || 1, max));
  const picked = new Set();

  if (Math.random() < 0.28) {
    picked.add(1);
  }

  while (picked.size < target) {
    picked.add(1 + Math.floor(Math.random() * max));
  }

  return Array.from(picked);
}

function buildRecipePages(recipe) {
  const pageWindow = Math.max(recipe.pages, Math.min(120, Number(recipe.pageWindow) || (recipe.pages * 10)));
  return sampleDistinctPageNumbers(recipe.pages, pageWindow);
}

async function fetchCanonShorts() {
  const searches = await Promise.allSettled(CANON_SHORT_TITLES.map(function (title) {
    return tmdbJson('/search/movie', { query: title, page: 1 });
  }));

  return searches.map(function (entry, index) {
    if (entry.status !== 'fulfilled' || !entry.value) return null;
    const wantedKey = titleKey(CANON_SHORT_TITLES[index]);
    return (entry.value.results || []).find(function (movie) {
      return movie
        && !movie.adult
        && movie.poster_path
        && extractYear(movie.release_date)
        && titleKey(movie.title) === wantedKey;
    }) || null;
  }).filter(Boolean);
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
    sourceMovieIds: sourceMovieId ? [Number(sourceMovieId)] : [],
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
    linkUrl: 'https://www.themoviedb.org/person/' + person.id,
    knownForTitles: [],
    knownForPeakRank: 0,
    knownForDepth: 0
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
      if (!byPerson.has(key)) {
        byPerson.set(key, candidate);
        return;
      }
      const existing = byPerson.get(key);
      const mergedSourceMovieIds = Array.from(new Set(
        (Array.isArray(existing.sourceMovieIds) ? existing.sourceMovieIds : [])
          .concat(Array.isArray(candidate.sourceMovieIds) ? candidate.sourceMovieIds : [])
          .filter(Boolean)
      ));
      if ((Number(candidate.popularity) || 0) > (Number(existing.popularity) || 0)) {
        byPerson.set(key, Object.assign({}, candidate, {
          sourceMovieIds: mergedSourceMovieIds
        }));
      } else {
        existing.sourceMovieIds = mergedSourceMovieIds;
        byPerson.set(key, existing);
      }
    });
  }

  const candidates = Array.from(byPerson.values()).sort(function (a, b) {
    return (Number(b.popularity) || 0) - (Number(a.popularity) || 0);
  }).slice(0, 18);

  if (!candidates.length) return [];

  const enriched = await mapWithConcurrency(candidates, 3, async function (candidate) {
    try {
      const knownFor = await getPersonKnownFor(candidate.personId, candidate.roleKey, candidate.name);
      return Object.assign({}, candidate, knownFor);
    } catch (error) {
      return candidate;
    }
  });

  return enriched.sort(function (a, b) {
    const aTitles = Array.isArray(a && a.knownForTitles) ? a.knownForTitles.length : 0;
    const bTitles = Array.isArray(b && b.knownForTitles) ? b.knownForTitles.length : 0;
    const aPeak = Number(a && a.knownForPeakRank) || 0;
    const bPeak = Number(b && b.knownForPeakRank) || 0;
    const aDepth = Number(a && a.knownForDepth) || 0;
    const bDepth = Number(b && b.knownForDepth) || 0;
    const aPopularity = Number(a && a.popularity) || 0;
    const bPopularity = Number(b && b.popularity) || 0;
    return ((bTitles * 100) + (bPeak * 20) + (bDepth * 4) + bPopularity)
      - ((aTitles * 100) + (aPeak * 20) + (aDepth * 4) + aPopularity);
  });
}

async function getPersonMovieCredits(personId) {
  const cacheKey = String(personId || '');
  if (!cacheKey) return null;

  const cached = cache.personMovieCredits.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    touchMapEntry(cache.personMovieCredits, cacheKey, cached);
    return cached.value;
  }

  const credits = await tmdbJson('/person/' + personId + '/movie_credits');
  touchMapEntry(cache.personMovieCredits, cacheKey, {
    value: credits,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  trimMapBySize(cache.personMovieCredits, MAX_PERSON_CREDITS_CACHE);
  return credits;
}

async function getPersonCombinedCredits(personId) {
  const cacheKey = String(personId || '');
  if (!cacheKey) return null;

  const cached = cache.personCombinedCredits.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    touchMapEntry(cache.personCombinedCredits, cacheKey, cached);
    return cached.value;
  }

  const credits = await tmdbJson('/person/' + personId + '/combined_credits');
  touchMapEntry(cache.personCombinedCredits, cacheKey, {
    value: credits,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  trimMapBySize(cache.personCombinedCredits, MAX_PERSON_CREDITS_CACHE);
  return credits;
}

async function getPersonDetails(personId) {
  const cacheKey = String(personId || '');
  if (!cacheKey) return null;

  const cached = cache.personDetails.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    touchMapEntry(cache.personDetails, cacheKey, cached);
    return cached.value;
  }

  const details = await tmdbJson('/person/' + personId);
  touchMapEntry(cache.personDetails, cacheKey, {
    value: details,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  trimMapBySize(cache.personDetails, MAX_PERSON_DETAILS_CACHE);
  return details;
}

async function searchPersonKnownFor(personId, nameQuery, roleKey) {
  const query = String(nameQuery || '').trim();
  if (!query) return [];

  try {
    const payload = await tmdbJson('/search/person', { query: query, page: 1, include_adult: 'false' });
    const results = Array.isArray(payload && payload.results) ? payload.results : [];
    const exact = results.find(function (person) {
      return Number(person && person.id) === Number(personId);
    }) || results.find(function (person) {
      return titleKey(person && person.name) === titleKey(query);
    }) || results[0];
    const knownFor = Array.isArray(exact && exact.known_for) ? exact.known_for : [];
    const entries = knownFor.filter(function (item) {
      if (!item || !item.title) return false;
      if (item.media_type && item.media_type !== 'movie') return false;
      return roleKey === 'director'
        ? (item.department === 'Directing' || item.job === 'Director' || item.known_for_department === 'Directing' || !item.media_type)
        : true;
    });
    return entries.slice(0, 6).map(function (movie, index) {
      return Object.assign({}, movie, {
        __knownForSourceBoost: 1,
        __knownForSearchIndex: index
      });
    });
  } catch (error) {
    return [];
  }
}

function buildKnownForMovieRecord(movie, roleKey) {
  if (!movie || !movie.id || !movie.title) return null;
  return {
    id: movie.id,
    title: movie.title,
    release_date: movie.release_date || movie.releaseDate || '',
    popularity: Number(movie.popularity) || 0,
    vote_average: Number(movie.vote_average != null ? movie.vote_average : movie.voteAverage) || 0,
    vote_count: Number(movie.vote_count != null ? movie.vote_count : movie.voteCount) || 0,
    original_language: movie.original_language || movie.originalLanguage || '',
    genre_ids: Array.isArray(movie.genre_ids) ? movie.genre_ids.slice() : [],
    genreNames: Array.isArray(movie.genreNames) ? movie.genreNames.slice() : [],
    genre: movie.genre || '',
    department: roleKey === 'director' ? 'Directing' : 'Acting',
    sourceBoost: Number(movie.__knownForSourceBoost) || 0,
    searchIndex: Number(movie.__knownForSearchIndex) || 0
  };
}

function getRelevantKnownForCredits(credits, roleKey) {
  const isCombined = Array.isArray(credits && credits.cast) && credits.cast.some(function (item) {
    return item && item.media_type;
  });
  if (roleKey === 'director') {
    return (Array.isArray(credits && credits.crew) ? credits.crew : []).filter(function (movie) {
      if (!movie || movie.job !== 'Director') return false;
      return !isCombined || movie.media_type === 'movie';
    });
  }
  return (Array.isArray(credits && credits.cast) ? credits.cast : []).filter(function (movie) {
    if (isCombined && movie.media_type !== 'movie') return false;
    const order = Number(movie && movie.order);
    if (Number.isFinite(order) && order > 20) return false;
    return true;
  });
}

function summarizeKnownForEntries(entries, roleKey) {
  const seen = new Set();
  const normalized = (Array.isArray(entries) ? entries : []).map(function (movie) {
    return buildKnownForMovieRecord(movie, roleKey);
  }).filter(function (movie) {
    if (!movie || !movie.title) return false;
    const key = String(movie.id || movie.title).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ranked = normalized.map(function (movie) {
    const assignedRarity = assignRarity(movie);
    const flooredRarity = rarityFloorForMovie(movie);
    const ceiling = rarityCeilingForMovie(movie);
    let rarity = assignedRarity;
    if (flooredRarity && rarityRank(flooredRarity) > rarityRank(rarity)) rarity = flooredRarity;
    if (ceiling && rarityRank(ceiling) < rarityRank(rarity)) rarity = ceiling;

    const score = computeRarityScore(movie);
    const voteCount = Number(movie.vote_count) || 0;
    const popularity = Number(movie.popularity) || 0;
    const voteAverage = Number(movie.vote_average) || 0;
    const sourceBoost = Number(movie.sourceBoost) || 0;
    const searchIndex = Number(movie.searchIndex) || 0;
    const castOrder = Number(movie && movie.order);
    const leadBillingBonus = roleKey === 'actor' && Number.isFinite(castOrder) && castOrder >= 0 && castOrder <= 8
      ? 700000
      : 0;
    const crowdPriority = Math.min(20000, voteCount) * 220 + Math.round(popularity * 9000);
    const staturePriority = rarityRank(rarity) * 12000000 + score * 140000 + Math.round(voteAverage * 9000);
    const sourcePriority = sourceBoost * 900000 - (searchIndex * 140000);
    const thinPenalty = voteCount < 30 && popularity < 5 && rarityRank(rarity) < 3 ? 3500000 : 0;

    const priority = (
      staturePriority
      + crowdPriority
      + sourcePriority
      + leadBillingBonus
      - thinPenalty
    );

    return {
      title: movie.title,
      rarity: rarity,
      priority: priority,
      voteCount: voteCount,
      popularity: popularity
    };
  }).sort(function (a, b) {
    return b.priority - a.priority;
  });

  const preferred = ranked.filter(function (movie) {
    return movie && (movie.priority >= 14000000 || rarityRank(movie.rarity) >= 2);
  });
  const highSignal = ranked.filter(function (movie) {
    return movie && (
      movie.voteCount >= 60
      || movie.popularity >= 4
      || rarityRank(movie.rarity) >= 2
    );
  });
  const source = preferred.length >= 3
    ? preferred
    : (highSignal.length >= 3 ? highSignal : ranked);

  return {
    knownForTitles: source.slice(0, 3).map(function (movie) { return movie.title; }),
    knownForPeakRank: ranked.length ? rarityRank(ranked[0].rarity) : 0,
    knownForDepth: ranked.filter(function (movie) { return rarityRank(movie.rarity) >= 2; }).length
  };
}

function summarizeKnownForMovies(credits, roleKey) {
  return summarizeKnownForEntries(getRelevantKnownForCredits(credits, roleKey), roleKey);
}

async function getPersonKnownFor(personId, roleKey, nameQuery) {
  if (!personId) {
    return { knownForTitles: [], knownForPeakRank: 0, knownForDepth: 0 };
  }

  const settled = await Promise.allSettled([
    getPersonMovieCredits(personId),
    getPersonCombinedCredits(personId),
    searchPersonKnownFor(personId, nameQuery, roleKey)
  ]);

  const credits = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const combinedCredits = settled[1].status === 'fulfilled' ? settled[1].value : null;
  const searchedEntries = settled[2].status === 'fulfilled' ? settled[2].value : [];
  const mergedEntries = []
    .concat(Array.isArray(searchedEntries) ? searchedEntries : [])
    .concat(getRelevantKnownForCredits(credits, roleKey) || [])
    .concat(getRelevantKnownForCredits(combinedCredits, roleKey) || []);

  return summarizeKnownForEntries(mergedEntries, roleKey);
}

function isFemaleDirectedMovie(movie) {
  return Number(movie.directorGender) === 1 || Boolean(FEMALE_DIRECTOR_NAMES[normalizePersonName(movie.directorName)]);
}

function isUnderappreciatedBlackDirectorMovie(movie) {
  return Boolean(UNDERAPPRECIATED_BLACK_DIRECTOR_NAMES[normalizePersonName(movie && movie.directorName)]);
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
  if (lookup.documentary) tags.add('docs');
  if (year >= 1980 && year <= 1989) tags.add('eighties');
  if ((lookup.romance && lookup.comedy) || (lookup.romance && lookup.drama && year >= 1980) || (lookup.comedy && popularity >= 18 && voteAverage >= 6.4)) tags.add('romcom');
  if (lookup.drama || lookup.history || lookup.music || lookup.war || (voteAverage >= 7.5 && voteCount >= 400)) tags.add('all');

  return Array.from(tags);
}

function movieHasGenreId(movie, ids) {
  const genreIds = Array.isArray(movie && movie.genre_ids) ? movie.genre_ids : [];
  const genreNameSet = new Set();
  const genreNames = Array.isArray(movie && movie.genreNames) ? movie.genreNames : [];
  genreNames.forEach(function (name) {
    const normalized = String(name || '').trim().toLowerCase();
    if (normalized) genreNameSet.add(normalized);
  });
  if (movie && movie.genre) {
    const normalizedGenre = String(movie.genre).trim().toLowerCase();
    if (normalizedGenre) genreNameSet.add(normalizedGenre);
  }
  genreIds.forEach(function (id) {
    const aliases = GENRE_NAME_BY_ID[Number(id)] || [];
    aliases.forEach(function (alias) {
      genreNameSet.add(alias);
    });
  });
  const wanted = Array.isArray(ids) ? ids : [ids];
  return wanted.some(function (id) {
    const numericId = Number(id);
    if (genreIds.indexOf(numericId) !== -1) return true;
    const aliases = GENRE_NAME_BY_ID[numericId] || [];
    return aliases.some(function (alias) {
      return genreNameSet.has(alias);
    });
  });
}

function computeMovieSignals(movie) {
  const year = Number(
    (movie && movie.year)
    || extractYear(movie && (movie.releaseDate || movie.release_date))
  ) || 0;
  const popularity = Number(movie && movie.popularity) || 0;
  const voteAverage = Number(movie && (movie.voteAverage != null ? movie.voteAverage : movie.vote_average)) || 0;
  const voteCount = Number(movie && (movie.voteCount != null ? movie.voteCount : movie.vote_count)) || 0;
  const originalLanguage = String(movie && (movie.originalLanguage || movie.original_language) || '').toLowerCase();
  const isInternational = originalLanguage && originalLanguage !== 'en';
  const isCultFriendlyGenre = movieHasGenreId(movie, [27, 53, 9648, 80, 35, 14, 878, 16, 10402, 10749]);
  const isPrestigeGenre = movieHasGenreId(movie, [18, 36, 10402, 10752]);
  const isIconicAnimation = movieHasGenreId(movie, 16);
  const isGenreLandmarkLane = movieHasGenreId(movie, [80, 27, 53, 9648, 878, 28]);
  const isFamilyLane = movieHasGenreId(movie, [16, 10751, 12, 14]);
  const isCrowdPleaserLane = movieHasGenreId(movie, [35, 12, 10749, 10402, 10751]);
  const isDocumentary = movieHasGenreId(movie, 99);
  const isMusicalLane = movieHasGenreId(movie, 10402);
  const isMusicDocumentary = isDocumentary && isMusicalLane;
  const isHorrorThrillerLane = movieHasGenreId(movie, [27, 53, 9648]);
  const isComedyLane = movieHasGenreId(movie, 35);
  const isActionCrimeLane = movieHasGenreId(movie, [28, 80, 53]);
  const isHongKongLanguage = ['cn', 'zh'].indexOf(originalLanguage) !== -1;
  const underappreciatedBlackDirectorProxy = isUnderappreciatedBlackDirectorMovie(movie);

  let recognition = 0;
  if (popularity >= 12) recognition += 1;
  if (popularity >= 25) recognition += 1;
  if (popularity >= 45) recognition += 1;
  if (voteCount >= 250) recognition += 1;
  if (voteCount >= 1500) recognition += 1;
  if (voteCount >= 7000) recognition += 1;
  if (isDocumentary && voteCount >= 120) recognition += 1;
  if (isDocumentary && voteCount >= 900) recognition += 1;

  let respect = 0;
  if (voteAverage >= 7.0 && voteCount >= 70) respect += 1;
  if (voteAverage >= 7.5 && voteCount >= 220) respect += 1;
  if (voteAverage >= 7.9 && voteCount >= 700) respect += 1;
  if (voteAverage >= 8.2 && voteCount >= 1800) respect += 1;
  if (year && year <= 2000 && voteAverage >= 7.7 && voteCount >= 120) respect += 1;
  if (isInternational && voteAverage >= 7.7 && voteCount >= 80) respect += 1;
  if (isDocumentary && voteAverage >= 7.5 && voteCount >= 90) respect += 1;
  if (isDocumentary && voteAverage >= 8.0 && voteCount >= 260) respect += 1;

  let cult = 0;
  if (voteAverage >= 7.1 && voteCount >= 40 && voteCount <= 1800 && popularity >= 3 && popularity <= 36) cult += 1;
  if (year && year <= 2010 && voteAverage >= 7.0 && voteCount >= 70 && popularity <= 28) cult += 1;
  if (isCultFriendlyGenre && voteAverage >= 6.8 && voteCount >= 60) cult += 1;
  if (isInternational && voteAverage >= 7.3 && voteCount >= 45 && popularity <= 26) cult += 1;
  if (isDocumentary && voteAverage >= 7.6 && voteCount >= 60 && popularity <= 18) cult += 1;
  if (isDocumentary && year && year <= 2012 && voteAverage >= 7.4 && voteCount >= 45) cult += 1;

  let canon = 0;
  if (year && year <= 1985 && voteAverage >= 8.0 && voteCount >= 120) canon += 1;
  if (year && year <= 2005 && voteAverage >= 8.1 && voteCount >= 420) canon += 1;
  if (isInternational && year && year <= 2005 && voteAverage >= 7.9 && voteCount >= 100) canon += 1;
  if (voteAverage >= 8.4 && voteCount >= 2200) canon += 2;

  const prestigeProxy = isPrestigeGenre && recognition >= 3 && respect >= 3;
  const iconicAnimationProxy = isIconicAnimation && recognition >= 4 && respect >= 2;
  const genreLandmarkProxy = isGenreLandmarkLane && (cult >= 3 || (respect >= 3 && recognition >= 2));
  const recognitionEvent = recognition >= 5 && respect >= 2;
  const broadCulturalStapleProxy = isCrowdPleaserLane && recognition >= 4 && (respect >= 1 || cult >= 1);
  const prestigeCrowdPleaserProxy = isPrestigeGenre && recognition >= 3 && respect >= 2 && voteCount >= 900;
  const familyAnimationStapleProxy = isFamilyLane && recognition >= 3 && respect >= 2;
  const blockbusterRespectProxy = recognition >= 5 && respect >= 3 && voteAverage >= 7.0;
  const legacyStudioStapleProxy = year >= 1960 && year <= 2010 && voteCount >= 180 && popularity >= 7 && (respect >= 1 || cult >= 1);
  const classicHorrorLandmarkProxy = isHorrorThrillerLane && year >= 1960 && year <= 1999 && voteCount >= 120 && (cult >= 2 || respect >= 2);
  const classicFamilyMusicalProxy = year && year <= 1989 && (isFamilyLane || isMusicalLane) && recognition >= 2 && respect >= 2;
  const newHollywoodStapleProxy = year >= 1967 && year <= 1985 && voteCount >= 140 && recognition >= 2 && (respect >= 2 || cult >= 2);
  const prestigeRomanticDramaProxy = year >= 1980 && year <= 2015 && movieHasGenreId(movie, [18, 10749]) && voteCount >= 220 && popularity >= 7 && (respect >= 1 || cult >= 1);
  const modernPrestigeLandmarkProxy = year >= 2000 && year <= 2022 && isPrestigeGenre && voteCount >= 2500 && popularity >= 10 && (voteAverage >= 7.2 || respect >= 2);
  const documentaryLandmarkProxy = isDocumentary && (
    respect >= 4 ||
    (recognition >= 3 && respect >= 3) ||
    (cult >= 3 && respect >= 2)
  ) && (
    !isMusicDocumentary ||
    respect >= 5 ||
    canon >= 2
  );
  const celebrityEventDocProxy = isDocumentary && year >= 2015 && popularity >= 8 && voteCount >= 300 && voteAverage < 8.0 && respect <= 3 && canon < 2;
  const classicComedyLandmarkProxy = isComedyLane && year >= 1930 && year <= 2005 && recognition >= 2 && (respect >= 3 || cult >= 3);
  const musicalLandmarkProxy = isMusicalLane && recognition >= 2 && (respect >= 3 || cult >= 2);
  const hongKongActionProxy = isHongKongLanguage && isActionCrimeLane && year >= 1970 && year <= 2005 && (cult >= 2 || (recognition >= 2 && respect >= 2));
  const comedyCrowdMemoryProxy = isComedyLane && recognition >= 4 && (respect >= 1 || cult >= 1);
  const iconicFamilyAnimationProxy = isFamilyLane && isIconicAnimation && recognition >= 4 && (respect >= 2 || cult >= 1);
  const modernAuteurLandmarkProxy = year >= 1990 && year <= 2015 && respect >= 3 && (cult >= 2 || (recognition >= 2 && popularity <= 32));
  const mainstreamRecognitionProxy = voteCount >= 220 && popularity >= 7 && year >= 1970 && year <= 2022;
  const recognizableCatalogProxy = year >= 1960 && year <= 2022 && voteCount >= 400 && popularity >= 8;
  const acclaimedModernGenreProxy = year >= 1990 && isGenreLandmarkLane && recognition >= 3 && respect >= 3;
  const belovedStudioClassicProxy = year >= 1970 && year <= 2015 && voteCount >= 300 && (recognition >= 2 || popularity >= 10) && (respect >= 1 || cult >= 1);
  const catalogStapleProxy = year >= 1950 && year <= 2015 && voteCount >= 120 && popularity >= 5 && (respect >= 1 || cult >= 1);
  const recognizableMidCatalogProxy = year >= 1970 && year <= 2015 && voteCount >= 140 && popularity >= 5 && (recognition >= 2 || respect >= 1 || cult >= 1);
  const cultThrillerMysteryProxy = year >= 1975 && year <= 2005 && movieHasGenreId(movie, [53, 9648, 80, 27]) && voteCount >= 80 && (cult >= 2 || (respect >= 2 && popularity >= 5));
  const crowdMemoryComedyRomanceProxy = year >= 1975 && year <= 2015 && movieHasGenreId(movie, [35, 10749]) && voteCount >= 450 && popularity >= 8;
  const horrorFranchiseStapleProxy = year >= 1970 && year <= 2015 && movieHasGenreId(movie, [27, 53]) && voteCount >= 300 && popularity >= 8;
  const concertFandomDocProxy = isMusicDocumentary && popularity >= 10 && canon < 2 && respect < 5;
  const lowSignalObscurityProxy = voteCount < 90 && popularity < 7 && recognition < 3 && canon < 2;
  const microObscureOverperformerProxy = voteAverage >= 7.7 && voteCount < 50 && popularity < 5 && canon < 2;
  const majorPromotionProxy = Boolean(
    prestigeProxy
    || iconicAnimationProxy
    || genreLandmarkProxy
    || recognitionEvent
    || broadCulturalStapleProxy
    || prestigeCrowdPleaserProxy
    || familyAnimationStapleProxy
    || blockbusterRespectProxy
    || classicHorrorLandmarkProxy
    || prestigeRomanticDramaProxy
    || modernPrestigeLandmarkProxy
    || documentaryLandmarkProxy
    || classicComedyLandmarkProxy
    || musicalLandmarkProxy
    || hongKongActionProxy
    || comedyCrowdMemoryProxy
    || iconicFamilyAnimationProxy
    || modernAuteurLandmarkProxy
    || mainstreamRecognitionProxy
    || recognizableCatalogProxy
    || acclaimedModernGenreProxy
    || belovedStudioClassicProxy
    || recognizableMidCatalogProxy
    || crowdMemoryComedyRomanceProxy
    || horrorFranchiseStapleProxy
    || underappreciatedBlackDirectorProxy
  );
  const titlePromotion = EPIC_PROMOTION_TITLES.has(titleKey(movie && movie.title));

  return {
    recognition: recognition,
    respect: respect,
    cult: cult,
    canon: canon,
    prestigeProxy: prestigeProxy,
    iconicAnimationProxy: iconicAnimationProxy,
    genreLandmarkProxy: genreLandmarkProxy,
    recognitionEvent: recognitionEvent,
    broadCulturalStapleProxy: broadCulturalStapleProxy,
    prestigeCrowdPleaserProxy: prestigeCrowdPleaserProxy,
    familyAnimationStapleProxy: familyAnimationStapleProxy,
    blockbusterRespectProxy: blockbusterRespectProxy,
    legacyStudioStapleProxy: legacyStudioStapleProxy,
    classicHorrorLandmarkProxy: classicHorrorLandmarkProxy,
    classicFamilyMusicalProxy: classicFamilyMusicalProxy,
    newHollywoodStapleProxy: newHollywoodStapleProxy,
    prestigeRomanticDramaProxy: prestigeRomanticDramaProxy,
    modernPrestigeLandmarkProxy: modernPrestigeLandmarkProxy,
    documentaryLandmarkProxy: documentaryLandmarkProxy,
    celebrityEventDocProxy: celebrityEventDocProxy,
    classicComedyLandmarkProxy: classicComedyLandmarkProxy,
    musicalLandmarkProxy: musicalLandmarkProxy,
    hongKongActionProxy: hongKongActionProxy,
    comedyCrowdMemoryProxy: comedyCrowdMemoryProxy,
    iconicFamilyAnimationProxy: iconicFamilyAnimationProxy,
    modernAuteurLandmarkProxy: modernAuteurLandmarkProxy,
    mainstreamRecognitionProxy: mainstreamRecognitionProxy,
    recognizableCatalogProxy: recognizableCatalogProxy,
    acclaimedModernGenreProxy: acclaimedModernGenreProxy,
    belovedStudioClassicProxy: belovedStudioClassicProxy,
    recognizableMidCatalogProxy: recognizableMidCatalogProxy,
    catalogStapleProxy: catalogStapleProxy,
    cultThrillerMysteryProxy: cultThrillerMysteryProxy,
    crowdMemoryComedyRomanceProxy: crowdMemoryComedyRomanceProxy,
    horrorFranchiseStapleProxy: horrorFranchiseStapleProxy,
    underappreciatedBlackDirectorProxy: underappreciatedBlackDirectorProxy,
    concertFandomDocProxy: concertFandomDocProxy,
    lowSignalObscurityProxy: lowSignalObscurityProxy,
    microObscureOverperformerProxy: microObscureOverperformerProxy,
    majorPromotionProxy: majorPromotionProxy,
    titlePromotion: titlePromotion,
    year: year,
    popularity: popularity,
    voteAverage: voteAverage,
    voteCount: voteCount,
    isInternational: isInternational
  };
}

function computeScore(movie) {
  const signals = computeMovieSignals(movie);
  const legacyScore = signals.year ? Math.max(0, Math.min(18, (2010 - Math.min(signals.year, 2010)) / 7)) : 0;
  const acclaimScore = signals.voteAverage * 10.5;
  const footprintScore = Math.log10(signals.voteCount + 1) * 9.8;
  const blockbusterPenalty = signals.popularity > 78 && signals.voteAverage < 7.5 ? (signals.popularity - 78) * 0.22 : 0;
  const recencyPenalty = signals.year >= 2025 ? 7 : signals.year >= 2023 ? 3.5 : signals.year >= 2020 ? 1.2 : 0;
  const obscurityPenalty = signals.voteCount < 18 ? 18 : signals.voteCount < 40 ? 10 : 0;

  return acclaimScore
    + footprintScore
    + (signals.recognition * 11)
    + (signals.respect * 15)
    + (signals.cult * 9)
    + (signals.canon * 18)
    + legacyScore
    - blockbusterPenalty
    - recencyPenalty
    - obscurityPenalty;
}

function computePoolSelectionScore(movie) {
  const signals = computeMovieSignals(movie);
  let score = computeScore(movie);

  if (signals.year && signals.year <= 1929) score -= 14;
  else if (signals.year && signals.year <= 1949) score -= 8;

  if (signals.voteCount < 20) score -= 14;
  else if (signals.voteCount < 60) score -= 8;
  else if (signals.voteCount < 140) score -= 3;

  if (signals.mainstreamRecognitionProxy || signals.belovedStudioClassicProxy) score += 4;
  if (signals.recognizableMidCatalogProxy) score += 3;
  if (signals.acclaimedModernGenreProxy || signals.modernAuteurLandmarkProxy) score += 3;
  if (signals.underappreciatedBlackDirectorProxy) score += 2;
  if (signals.year >= 1980 && signals.year <= 2012 && signals.recognition >= 2) score += 1;
  if (signals.year >= 2018) score -= 2;
  if (signals.year >= 2022) score -= 2;
  if (signals.popularity >= 28 && signals.voteCount >= 4500 && !signals.majorPromotionProxy) score -= 4;
  if (signals.popularity >= 42 && !signals.blockbusterRespectProxy && !signals.modernPrestigeLandmarkProxy) score -= 4;

  const jitter = signals.voteCount < 120
    ? (Math.random() * 18)
    : (Math.random() * 7);

  return score + jitter;
}

function computeRarityScore(movie) {
  const signals = computeMovieSignals(movie);
  const recognitionPoints = [0, 6, 11, 16, 21, 25, 28, 30][Math.max(0, Math.min(7, signals.recognition || 0))] || 0;
  const respectPoints = [0, 7, 13, 19, 24, 28, 30, 30][Math.max(0, Math.min(7, signals.respect || 0))] || 0;
  const cultPoints = [0, 4, 8, 12, 15, 18, 20, 20][Math.max(0, Math.min(7, signals.cult || 0))] || 0;
  const canonPoints = [0, 7, 12, 17, 22, 25][Math.max(0, Math.min(5, signals.canon || 0))] || 0;

  let bonus = 0;
  if (signals.recognition >= 5 && signals.respect >= 2) bonus += 8;
  if (signals.prestigeProxy) bonus += 5;
  if (signals.iconicAnimationProxy) bonus += 5;
  if (signals.genreLandmarkProxy) bonus += 5;
  if (signals.recognitionEvent) bonus += 4;
  if (signals.broadCulturalStapleProxy) bonus += 4;
  if (signals.prestigeCrowdPleaserProxy) bonus += 4;
  if (signals.familyAnimationStapleProxy) bonus += 4;
  if (signals.blockbusterRespectProxy) bonus += 4;
  if (signals.legacyStudioStapleProxy) bonus += 3;
  if (signals.classicHorrorLandmarkProxy) bonus += 4;
  if (signals.classicFamilyMusicalProxy) bonus += 3;
  if (signals.newHollywoodStapleProxy) bonus += 3;
  if (signals.prestigeRomanticDramaProxy) bonus += 3;
  if (signals.modernPrestigeLandmarkProxy) bonus += 5;
  if (signals.documentaryLandmarkProxy) bonus += 5;
  if (signals.classicComedyLandmarkProxy) bonus += 4;
  if (signals.musicalLandmarkProxy) bonus += 4;
  if (signals.hongKongActionProxy) bonus += 4;
  if (signals.comedyCrowdMemoryProxy) bonus += 3;
  if (signals.iconicFamilyAnimationProxy) bonus += 5;
  if (signals.modernAuteurLandmarkProxy) bonus += 4;
  if (signals.mainstreamRecognitionProxy) bonus += 3;
  if (signals.recognizableCatalogProxy) bonus += 3;
  if (signals.recognizableMidCatalogProxy) bonus += 2;
  if (signals.acclaimedModernGenreProxy) bonus += 4;
  if (signals.belovedStudioClassicProxy) bonus += 3;
  if (signals.catalogStapleProxy) bonus += 3;
  if (signals.cultThrillerMysteryProxy) bonus += 4;
  if (signals.crowdMemoryComedyRomanceProxy) bonus += 3;
  if (signals.horrorFranchiseStapleProxy) bonus += 3;
  if (signals.underappreciatedBlackDirectorProxy) bonus += 3;
  if (signals.titlePromotion) bonus += 5;

  let penalty = 0;
  if (signals.voteCount < 18) penalty += 10;
  else if (signals.voteCount < 40) penalty += 5;
  if (signals.popularity < 2.5 && signals.respect < 4) penalty += 4;
  if (signals.lowSignalObscurityProxy) penalty += 6;
  if (signals.microObscureOverperformerProxy) penalty += 6;
  if (signals.concertFandomDocProxy) penalty += 7;
  if (signals.celebrityEventDocProxy) penalty += 6;

  return Math.max(0, Math.min(100, recognitionPoints + respectPoints + cultPoints + canonPoints + bonus - penalty));
}

function decadeSelectionChance(decade) {
  const numericDecade = Number(decade) || 0;
  if (numericDecade <= 1929) return 0.22;
  if (numericDecade <= 1949) return 0.4;
  if (numericDecade <= 1969) return 0.62;
  if (numericDecade <= 1979) return 0.75;
  if (numericDecade <= 1999) return 0.9;
  return 1;
}

function pickFrontierMovie(bucket, decade, repeatCounts) {
  if (!bucket || !bucket.length) return null;
  const numericDecade = Number(decade) || 0;
  const baseFrontierSize = Math.max(1, Math.min(
    bucket.length,
    numericDecade <= 1929 ? 14 : (numericDecade <= 1949 ? 22 : 38)
  ));

  let frontierSize = baseFrontierSize;
  let byRepeat = [];
  let minRepeat = 0;
  const maxFrontierSize = Math.min(bucket.length, Math.max(baseFrontierSize, 220));

  while (frontierSize <= maxFrontierSize) {
    const frontier = bucket.slice(0, frontierSize);
    byRepeat = frontier.map(function (movie, index) {
      const key = movieIdentityKey(movie);
      const repeatCount = Number(repeatCounts && key ? repeatCounts.get(key) : 0) || 0;
      return {
        movie: movie,
        index: index,
        repeatCount: repeatCount
      };
    });
    minRepeat = byRepeat.reduce(function (minValue, entry) {
      return Math.min(minValue, entry.repeatCount);
    }, Number.POSITIVE_INFINITY);
    if (minRepeat === 0 || frontierSize === maxFrontierSize) break;
    frontierSize = Math.min(maxFrontierSize, frontierSize + Math.max(12, Math.floor(frontierSize * 0.55)));
  }

  const candidateFrontier = byRepeat.filter(function (entry) {
    return entry.repeatCount === minRepeat;
  });

  const deepCutChance = minRepeat >= 3
    ? 0.62
    : (minRepeat >= 2 ? 0.45 : (minRepeat >= 1 ? 0.22 : 0.08));
  if (bucket.length > frontierSize + 24 && Math.random() < deepCutChance) {
    const deepStart = Math.min(bucket.length - 1, frontierSize + 6);
    const deepEnd = Math.min(bucket.length, deepStart + Math.max(24, Math.floor(bucket.length * 0.35)));
    const deepRange = bucket.slice(deepStart, deepEnd).map(function (movie, offset) {
      const key = movieIdentityKey(movie);
      return {
        movie: movie,
        index: deepStart + offset,
        repeatCount: Number(repeatCounts && key ? repeatCounts.get(key) : 0) || 0
      };
    });
    if (deepRange.length) {
      const deepMinRepeat = deepRange.reduce(function (minValue, entry) {
        return Math.min(minValue, entry.repeatCount);
      }, Number.POSITIVE_INFINITY);
      const deepCandidates = deepRange.filter(function (entry) {
        return entry.repeatCount === deepMinRepeat;
      });
      const deepWeighted = deepCandidates.map(function (entry) {
        return {
          movie: entry.movie,
          weight: 1 / Math.pow((entry.index - deepStart) + 1, 0.24)
        };
      });
      const deepPicked = weightedChoice(deepWeighted).movie;
      const deepPickedIndex = bucket.indexOf(deepPicked);
      if (deepPickedIndex !== -1) {
        bucket.splice(deepPickedIndex, 1);
      }
      return deepPicked;
    }
  }

  const weighted = candidateFrontier.map(function (entry) {
    const repeatPenalty = entry.repeatCount > 0 ? (1 / (1 + (entry.repeatCount * 0.9))) : 1;
    return {
      movie: entry.movie,
      weight: (1 / Math.pow(entry.index + 1, 0.28)) * repeatPenalty
    };
  });
  const picked = weightedChoice(weighted).movie;
  const pickedIndex = bucket.indexOf(picked);
  if (pickedIndex !== -1) {
    bucket.splice(pickedIndex, 1);
  }
  return picked;
}

function selectDiversifiedPool(movies, limit, repeatCounts) {
  const buckets = new Map();
  const ordered = Array.isArray(movies) ? movies.slice() : [];

  ordered.forEach(function (movie) {
    const decade = decadeBucketForMovie(movie);
    if (!buckets.has(decade)) buckets.set(decade, []);
    buckets.get(decade).push(movie);
  });

  const decadeKeys = Array.from(buckets.keys()).sort();
  const modernDecadeKeys = decadeKeys.filter(function (decade) {
    const numeric = Number(decade) || 0;
    return numeric >= 1980 && numeric <= 2019;
  });
  const selected = [];
  let round = 0;

  while (selected.length < limit) {
    let addedThisRound = false;
    const decadeOrder = shuffledCopy(decadeKeys);
    for (let i = 0; i < decadeOrder.length && selected.length < limit; i += 1) {
      const decade = decadeOrder[i];
      const bucket = buckets.get(decade);
      if (bucket && bucket.length) {
        const chance = decadeSelectionChance(decade);
        const shouldTake = round < 2
          ? (Math.random() < Math.min(1, chance + 0.12))
          : (Math.random() < chance);
        if (!shouldTake) continue;
        const picked = pickFrontierMovie(bucket, decade, repeatCounts);
        if (picked) {
          selected.push(picked);
          addedThisRound = true;
        }
      }
    }
    const modernCandidates = modernDecadeKeys.filter(function (decade) {
      const bucket = buckets.get(decade);
      return bucket && bucket.length;
    });
    if (modernCandidates.length && selected.length < limit && Math.random() < 0.58) {
      const chosenDecade = modernCandidates[Math.floor(Math.random() * modernCandidates.length)];
      const bucket = buckets.get(chosenDecade);
      if (bucket && bucket.length) {
        const picked = pickFrontierMovie(bucket, chosenDecade, repeatCounts);
        if (picked) {
          selected.push(picked);
          addedThisRound = true;
        }
      }
    }
    if (!addedThisRound) {
      const fallbackDecade = decadeKeys
        .map(function (decade) {
          return { decade: decade, size: (buckets.get(decade) || []).length };
        })
        .filter(function (entry) { return entry.size > 0; })
        .sort(function (a, b) { return b.size - a.size; })[0];
      if (!fallbackDecade) break;
      const picked = pickFrontierMovie(buckets.get(fallbackDecade.decade), fallbackDecade.decade, repeatCounts);
      if (!picked) break;
      selected.push(picked);
    }
    round += 1;
  }

  return selected;
}

function assignRarity(movie) {
  const score = computeRarityScore(movie);
  if (score >= 78) return 'Legendary';
  if (score >= 54) return 'Epic';
  if (score >= 29) return 'Select';
  return 'Base';
}

function rarityFloorForMovie(movie) {
  const titleFloor = TITLE_RARITY_FLOORS[titleKey(movie && movie.title)];
  if (titleFloor) return normalizeRarityLabel(titleFloor);
  const signals = computeMovieSignals(movie);
  let floor = 'Base';

  if (signals.recognition >= 3) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.respect >= 2) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.cult >= 2) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.recognitionEvent) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.broadCulturalStapleProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.legacyStudioStapleProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.mainstreamRecognitionProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.recognizableCatalogProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.recognizableMidCatalogProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.belovedStudioClassicProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.catalogStapleProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.classicFamilyMusicalProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.newHollywoodStapleProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.prestigeRomanticDramaProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.crowdMemoryComedyRomanceProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.horrorFranchiseStapleProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.underappreciatedBlackDirectorProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.modernPrestigeLandmarkProxy) {
    floor = maxRarity(floor, 'Epic');
  }

  if (signals.comedyCrowdMemoryProxy) {
    floor = maxRarity(floor, 'Select');
  }

  if (signals.recognition >= 5 && signals.respect >= 3) {
    floor = maxRarity(floor, 'Epic');
  }

  if (signals.recognition >= 4 && signals.respect >= 2 && (signals.cult >= 2 || signals.mainstreamRecognitionProxy)) {
    floor = maxRarity(floor, 'Epic');
  }

  if (signals.respect >= 4 || signals.canon >= 2) {
    floor = maxRarity(floor, 'Epic');
  }

  if (signals.cult >= 4 && signals.respect >= 3) {
    floor = maxRarity(floor, 'Epic');
  }

  if (signals.underappreciatedBlackDirectorProxy && (signals.respect >= 3 || signals.cult >= 3)) {
    floor = maxRarity(floor, 'Epic');
  }

  if (
    signals.prestigeProxy ||
    signals.iconicAnimationProxy ||
    signals.iconicFamilyAnimationProxy ||
    signals.genreLandmarkProxy ||
    signals.prestigeCrowdPleaserProxy ||
    signals.familyAnimationStapleProxy ||
    signals.blockbusterRespectProxy ||
    signals.classicHorrorLandmarkProxy ||
    signals.prestigeRomanticDramaProxy ||
    signals.modernPrestigeLandmarkProxy ||
    signals.documentaryLandmarkProxy ||
    signals.classicComedyLandmarkProxy ||
    signals.musicalLandmarkProxy ||
    signals.hongKongActionProxy ||
    signals.cultThrillerMysteryProxy ||
    signals.modernAuteurLandmarkProxy ||
    signals.acclaimedModernGenreProxy ||
    signals.titlePromotion
  ) {
    floor = maxRarity(floor, 'Epic');
  }

  if (signals.canon >= 4 || signals.respect >= 5) {
    floor = maxRarity(floor, 'Legendary');
  }

  if (signals.recognition >= 6 && signals.respect >= 4) {
    floor = maxRarity(floor, 'Legendary');
  }

  return floor;
}

function rarityCeilingForMovie(movie) {
  if (TITLE_RARITY_FLOORS[titleKey(movie && movie.title)]) {
    return 'Legendary';
  }
  const signals = computeMovieSignals(movie);

  if (signals.voteCount < 12 && signals.popularity < 2.5 && signals.respect < 4) {
    return 'Base';
  }

  if (signals.voteCount < 35 && signals.popularity < 6 && signals.respect < 3 && signals.cult < 2) {
    return 'Base';
  }

  if (signals.voteCount < 80 && signals.popularity < 10 && signals.respect < 4) {
    return 'Select';
  }

  if (
    signals.celebrityEventDocProxy
    && !TITLE_RARITY_FLOORS[titleKey(movie && movie.title)]
  ) {
    return 'Select';
  }

  if (
    signals.concertFandomDocProxy
    && signals.canon < 2
    && signals.respect < 5
  ) {
    return 'Epic';
  }

  if (
    signals.microObscureOverperformerProxy
    && !signals.majorPromotionProxy
    && !signals.titlePromotion
    && signals.respect < 4
  ) {
    return 'Select';
  }

  if (
    signals.lowSignalObscurityProxy
    && !signals.majorPromotionProxy
    && !signals.titlePromotion
    && signals.respect < 5
    && signals.canon < 3
  ) {
    return 'Select';
  }

  if (signals.year >= 2023 && signals.voteCount < 180 && signals.popularity < 12 && signals.respect < 4) {
    return 'Select';
  }

  if (signals.canon < 4 && signals.respect < 5 && !(signals.recognition >= 6 && signals.respect >= 4)) {
    return 'Epic';
  }

  return 'Legendary';
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

function applyCurrentRarityToMovie(movie) {
  if (!movie || !movie.title) return movie;
  const assigned = assignRarity(movie);
  const floored = maxRarity(assigned, rarityFloorForMovie(movie));
  const rarity = minRarity(floored, rarityCeilingForMovie(movie));
  return Object.assign({}, movie, {
    rarity: normalizeRarityLabel(rarity)
  });
}

function explainMovieRarity(movie) {
  const signals = computeMovieSignals(movie);
  const score = computeRarityScore(movie);
  const assigned = assignRarity(movie);
  const floor = rarityFloorForMovie(movie);
  const ceiling = rarityCeilingForMovie(movie);
  const final = applyCurrentRarityToMovie(movie).rarity;
  return {
    logicVersion: LOGIC_VERSION,
    snapshotVersion: POOL_SNAPSHOT_VERSION,
    title: movie && movie.title ? movie.title : '',
    year: Number((movie && movie.year) || extractYear(movie && (movie.releaseDate || movie.release_date))) || 0,
    score: score,
    assigned: assigned,
    floor: floor,
    ceiling: ceiling,
    final: final,
    signals: signals
  };
}

async function findDebugMovie(title, year) {
  const query = String(title || '').trim();
  if (!query) return null;
  const payload = await tmdbJson('/search/movie', {
    query: query,
    page: 1,
    include_adult: 'false'
  });
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  if (!results.length) return null;

  const numericYear = Number(year) || 0;
  const normalizedQuery = titleKey(query);
  const scored = results.map(function (movie, index) {
    const movieYear = Number(extractYear(movie && movie.release_date)) || 0;
    let priority = 0;
    if (titleKey(movie && movie.title) === normalizedQuery) priority += 12;
    if (numericYear && movieYear === numericYear) priority += 10;
    if (numericYear && Math.abs(movieYear - numericYear) <= 1) priority += 4;
    priority += Math.min(8, (Number(movie && movie.popularity) || 0) / 8);
    priority += Math.min(8, Math.log10((Number(movie && movie.vote_count) || 0) + 1) * 2);
    priority -= index * 0.25;
    return {
      movie: movie,
      priority: priority
    };
  }).sort(function (a, b) {
    return b.priority - a.priority;
  });

  return scored[0] ? scored[0].movie : null;
}

function applyCurrentRarityToPool(movies) {
  return (Array.isArray(movies) ? movies : []).map(function (movie) {
    return applyCurrentRarityToMovie(movie);
  });
}

async function getMovieCredits(movieId) {
  const cacheKey = String(movieId || '');
  if (!cacheKey) return null;

  const cached = cache.movieCredits.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    touchMapEntry(cache.movieCredits, cacheKey, cached);
    return cached.value;
  }

  const credits = await tmdbJson('/movie/' + movieId + '/credits');
  touchMapEntry(cache.movieCredits, cacheKey, {
    value: credits,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  trimMapBySize(cache.movieCredits, MAX_MOVIE_CREDITS_CACHE);
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

async function buildCardPool(limit, themeContext) {
  const configuration = await getConfiguration();
  const genreMap = await getGenreMap();
  const today = new Date().toISOString().slice(0, 10);
  const repeatCounts = loadSnapshotRepeatCounts(themeContext);
  const requests = [];

  DISCOVER_RECIPES.forEach(function (recipe) {
    const pages = buildRecipePages(recipe);
    for (let i = 0; i < pages.length; i += 1) {
      requests.push(tmdbJson('/discover/movie', Object.assign({
        page: pages[i],
        include_video: 'false',
        'with_runtime.gte': '30',
        'primary_release_date.lte': today
      }, recipe.params)));
    }
  });

  const settledResponses = await Promise.allSettled(requests);
  const responses = settledResponses
    .filter(function (entry) { return entry.status === 'fulfilled' && entry.value; })
    .map(function (entry) { return entry.value; });
  const canonShorts = await fetchCanonShorts();

  if (!responses.length && !canonShorts.length) {
    throw new Error('Unable to build card pool from TMDB discover results.');
  }

  const deduped = new Map();

  responses.forEach(function (payload) {
    (payload.results || []).forEach(function (movie) {
      if (!movie || movie.adult || !movie.title || !movie.poster_path) return;
      if (movieHasGenreId(movie, TV_MOVIE_GENRE_ID)) return;
      if (!extractYear(movie.release_date)) return;
      if (!movie.overview || String(movie.overview).trim().length < 24) return;
      if (!deduped.has(movie.id)) {
        deduped.set(movie.id, movie);
      } else if (!deduped.get(movie.id).backdrop_path && movie.backdrop_path) {
        deduped.set(movie.id, movie);
      }
    });
  });

  canonShorts.forEach(function (movie) {
    if (!movie || !movie.id || !movie.title) return;
    if (movieHasGenreId(movie, TV_MOVIE_GENRE_ID)) return;
    if (!deduped.has(movie.id)) {
      deduped.set(movie.id, movie);
    }
  });

  const ranked = selectDiversifiedPool(
    Array.from(deduped.values()).sort(function (a, b) {
      return computeDiversifiedPoolScore(b, themeContext, repeatCounts) - computeDiversifiedPoolScore(a, themeContext, repeatCounts);
    }),
    limit,
    repeatCounts
  );

  const enriched = await mapWithConcurrency(ranked, 8, enrichMovieWithCredits);

  enriched.forEach(function (movie) {
    const baseRarity = assignRarity(movie);
    const raised = maxRarity(baseRarity, rarityFloorForMovie(movie));
    movie.rarity = minRarity(raised, rarityCeilingForMovie(movie));
  });

  return enriched.map(function (movie) {
    return normalizeMovie(configuration, genreMap, movie);
  });
}

async function buildThemePool(limit, theme) {
  const normalizedTheme = String(theme || '').trim().toLowerCase();
  const targetLimit = Math.max(100, Math.min(MAX_REQUEST_POOL_LIMIT, Number(limit) || 600));
  let themedPool = [];
  let attempts = 0;
  const minTarget = normalizedTheme === 'docs' ? Math.min(targetLimit, 880) : Math.min(targetLimit, 720);
  const maxAttempts = normalizedTheme === 'docs' ? 8 : 6;
  const repeatCounts = loadSnapshotRepeatCounts(normalizedTheme);

  while (themedPool.length < minTarget && attempts < maxAttempts) {
    attempts += 1;
    const basePool = await buildCardPool(BASE_PREWARM_LIMIT, normalizedTheme);
    themedPool = mergeUniqueMovies(themedPool, filterPoolByTheme(basePool, normalizedTheme));
  }

  const scoredThemePool = themedPool.sort(function (a, b) {
    return computeDiversifiedPoolScore(b, normalizedTheme, repeatCounts) - computeDiversifiedPoolScore(a, normalizedTheme, repeatCounts);
  });

  return shuffledCopy(selectDiversifiedPool(scoredThemePool, targetLimit, repeatCounts)).slice(0, targetLimit);
}

async function buildPoolForRequest(limit, theme) {
  return theme && theme !== 'all'
    ? buildThemePool(limit, theme)
    : buildCardPool(limit, '');
}

function refreshPoolInBackground(cacheKey, limit, theme) {
  if (cache.poolBuilds.has(cacheKey)) return;

  const buildPromise = buildPoolForRequest(limit, theme)
    .then(function (pool) {
      cacheCardPool(cacheKey, pool, null, theme);
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
      refreshPoolInBackground(buildPoolCacheKey(BASE_PREWARM_LIMIT, '', reelIndex), BASE_PREWARM_LIMIT, '');
    }, reelIndex * 180);
  }

  try {
    const baseBuilds = [];
    for (let reelIndex = 0; reelIndex < BASE_REEL_COUNT; reelIndex += 1) {
      const build = cache.poolBuilds.get(buildPoolCacheKey(BASE_PREWARM_LIMIT, '', reelIndex));
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
        refreshPoolInBackground(buildPoolCacheKey(THEME_PREWARM_LIMIT, themeKey, reelIndex), THEME_PREWARM_LIMIT, themeKey);
      }, (index * THEME_REEL_COUNT * 250) + (reelIndex * 250));
    }
  });
}

async function getCardPool(limit, refresh, theme, rotationMode) {
  const normalizedLimit = Math.max(100, Math.min(MAX_REQUEST_POOL_LIMIT, Number(limit) || 600));
  const normalizedTheme = String(theme || '').trim().toLowerCase();
  const reelCount = reelCountForTheme(normalizedTheme);
  const requestedReelIndex = rotationMode === 'auto'
    ? nextRotationIndex(normalizedLimit, normalizedTheme)
    : Math.max(0, Math.min(reelCount - 1, Number(rotationMode) || 0));
  const cacheKey = buildPoolCacheKey(normalizedLimit, normalizedTheme, requestedReelIndex);

  if (refresh) {
    const freshPool = await buildPoolForRequest(normalizedLimit, normalizedTheme);
    return cacheCardPool(cacheKey, freshPool, null, normalizedTheme);
  }

  const cached = cache.cardPools.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const normalizedPool = applyCurrentRarityToPool(cached.value);
    touchMapEntry(cache.cardPools, cacheKey, {
      value: normalizedPool,
      expiresAt: cached.expiresAt
    });
    return normalizedPool;
  }

  const diskSnapshot = readPoolSnapshot(cacheKey, false);
  if (diskSnapshot) {
    const normalizedPool = applyCurrentRarityToPool(diskSnapshot.movies);
    touchMapEntry(cache.cardPools, cacheKey, {
      value: normalizedPool,
      expiresAt: diskSnapshot.expiresAt
    });
    trimMapBySize(cache.cardPools, MAX_HOT_CARD_POOLS);
    return normalizedPool;
  }

  const staleSnapshot = readPoolSnapshot(cacheKey, true);
  if (staleSnapshot) {
    const normalizedPool = applyCurrentRarityToPool(staleSnapshot.movies);
    touchMapEntry(cache.cardPools, cacheKey, {
      value: normalizedPool,
      expiresAt: staleSnapshot.expiresAt
    });
    trimMapBySize(cache.cardPools, MAX_HOT_CARD_POOLS);
    refreshPoolInBackground(cacheKey, normalizedLimit, normalizedTheme);
    return normalizedPool;
  }

  if (cache.poolBuilds.has(cacheKey)) {
    return cache.poolBuilds.get(cacheKey);
  }

  const buildPromise = buildPoolForRequest(normalizedLimit, normalizedTheme)
    .then(function (pool) {
      return cacheCardPool(cacheKey, pool, null, normalizedTheme);
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
    touchMapEntry(cache.movieArt, cacheKey, cached);
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

  touchMapEntry(cache.movieArt, cacheKey, {
    value: art,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  trimMapBySize(cache.movieArt, MAX_MOVIE_ART_CACHE);

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
      tmdbConfigured: hasTmdbToken(),
      logicVersion: LOGIC_VERSION,
      snapshotVersion: POOL_SNAPSHOT_VERSION
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
      logicVersion: LOGIC_VERSION,
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

  if (url.pathname === '/api/debug-title') {
    const title = String(url.searchParams.get('title') || '').trim();
    const year = Number(url.searchParams.get('year') || 0);
    if (!title) {
      writeJson(res, 400, { error: 'Missing title parameter.' });
      return;
    }

    const matched = await findDebugMovie(title, year);
    if (!matched) {
      writeJson(res, 404, { error: 'Movie not found.' });
      return;
    }

    const matchedWithCredits = await enrichMovieWithCredits(matched);

    writeJson(res, 200, {
      match: {
        title: matchedWithCredits.title || title,
        year: extractYear(matchedWithCredits.release_date),
        tmdbId: matchedWithCredits.id || null,
        popularity: Number(matchedWithCredits.popularity) || 0,
        voteAverage: Number(matchedWithCredits.vote_average) || 0,
        voteCount: Number(matchedWithCredits.vote_count) || 0,
        genreIds: Array.isArray(matchedWithCredits.genre_ids) ? matchedWithCredits.genre_ids : [],
        directorName: matchedWithCredits.directorName || null
      },
      debug: explainMovieRarity(matchedWithCredits)
    });
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

  if (url.pathname === '/api/person-known-for') {
    const personId = Number(url.searchParams.get('personId') || 0);
    const nameQuery = String(url.searchParams.get('name') || '');
    const roleKey = String(url.searchParams.get('role') || 'actor').toLowerCase() === 'director'
      ? 'director'
      : 'actor';

    if (!personId) {
      writeJson(res, 400, { error: 'Missing personId parameter.' });
      return;
    }

    const knownFor = await getPersonKnownFor(personId, roleKey, nameQuery);
    writeJson(res, 200, Object.assign({
      logicVersion: LOGIC_VERSION
    }, knownFor));
    return;
  }

  if (url.pathname === '/api/person-profile') {
    const personId = Number(url.searchParams.get('personId') || 0);

    if (!personId) {
      writeJson(res, 400, { error: 'Missing personId parameter.' });
      return;
    }

    const details = await getPersonDetails(personId).catch(function () { return null; });
    writeJson(res, 200, {
      logicVersion: LOGIC_VERSION,
      biography: String(details && details.biography || '').trim()
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

async function handleRequest(req, res) {
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
}

if (require.main === module) {
  const server = http.createServer(handleRequest);

  server.listen(PORT, function () {
    console.log('filmTCG server running on http://localhost:' + PORT);
    if (!hasTmdbToken()) {
      console.log('Set TMDB_BEARER_TOKEN to enable live film data.');
      return;
    }

    prewarmStartupPools();
  });
} else {
  module.exports = handleRequest;
}
