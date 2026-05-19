'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

// ── Constants ──────────────────────────────────────────────────────────────

const THIS_YEAR = new Date().getFullYear();

const TMDB_GENRE_MAP = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 9648: 'Mystery',
  10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller',
};

const LANG_LABEL = { hi: 'Hindi', en: 'English', ta: 'Tamil', te: 'Telugu', gu: 'Gujarati' };
const LANGS      = ['hi', 'en', 'ta', 'te', 'gu'];
const TYPES      = ['movie', 'tv'];

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function r3(v) {
  return Math.round(v * 1000) / 1000;
}

function fetch(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const req    = mod.request(urlStr, {
      method:  opts.method  || 'GET',
      headers: opts.headers || {},
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, opts).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: () => body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Simple CSV parser that handles quoted fields and embedded commas/newlines
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findColIdx(headers, keyword) {
  return headers.findIndex(h => h.toLowerCase().includes(keyword.toLowerCase()));
}

// ── STEP A — Fetch Google Sheet CSV ───────────────────────────────────────

async function fetchRatings() {
  const url = process.env.GOOGLE_SHEET_URL;
  if (!url) {
    console.warn('GOOGLE_SHEET_URL not set — continuing with empty ratings');
    return [];
  }
  console.log('Fetching ratings CSV…');
  const res  = await fetch(url);
  const raw  = res.text().replace(/^﻿/, ''); // strip UTF-8 BOM (Google Sheets)
  const rows = parseCsv(raw);
  if (rows.length < 2) return [];

  const headers = rows[0];
  const idx = {
    yourRating:  findColIdx(headers, 'your rating'),
    title:       findColIdx(headers, 'title'),
    type:        findColIdx(headers, 'title type'),
    imdbRating:  findColIdx(headers, 'imdb rating'),
    year:        findColIdx(headers, 'year'),
    genres:      findColIdx(headers, 'genres'),
    votes:       findColIdx(headers, 'num votes'),
    directors:   findColIdx(headers, 'directors'),
  };

  return rows.slice(1).map(r => ({
    yourRating:  parseFloat(r[idx.yourRating]) || 0,
    title:       (r[idx.title] || '').trim(),
    type:        (r[idx.type]  || '').trim(),
    imdbRating:  parseFloat(r[idx.imdbRating]) || 0,
    year:        parseInt(r[idx.year]) || 0,
    genres:      (r[idx.genres] || '').split(',').map(s => s.trim()).filter(Boolean),
    votes:       parseInt((r[idx.votes] || '').replace(/,/g, '')) || 0,
    directors:   (r[idx.directors] || '').split(',').map(s => s.trim()).filter(Boolean),
  })).filter(r => r.title);
}

// ── STEP B — Build taste profile ──────────────────────────────────────────

function buildTasteProfile(ratings) {
  const liked = ratings.filter(r => r.yourRating >= 5);

  // Genre weights
  const genreWeights = {};
  for (const item of liked) {
    for (const g of item.genres) {
      genreWeights[g] = (genreWeights[g] || 0) + (item.yourRating - 5) / 5;
    }
  }
  const maxW = Math.max(...Object.values(genreWeights), 1);
  for (const g of Object.keys(genreWeights)) genreWeights[g] /= maxW;

  const topGenres = Object.entries(genreWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([genre, weight]) => ({ genre, weight: r3(weight) }));

  // Top directors
  const dirScore = {};
  for (const item of ratings.filter(r => r.yourRating >= 7)) {
    for (const d of item.directors) {
      dirScore[d] = (dirScore[d] || 0) + item.yourRating;
    }
  }
  const topDirectors = Object.entries(dirScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name]) => name);

  // Recency preference
  const recent = ratings.filter(r => r.year >= 2020);
  const older  = ratings.filter(r => r.year >= 2010 && r.year < 2020);
  const avg    = arr => arr.length ? arr.reduce((s, r) => s + r.yourRating, 0) / arr.length : 0;
  const prefersRecent = avg(recent) > avg(older);

  return { genreWeights, topGenres, topDirectors, prefersRecent, totalRatings: ratings.length };
}

// ── STEP C — Fetch TMDB candidates ────────────────────────────────────────

async function fetchTmdbPage(token, mediaType, params) {
  const base = `https://api.themoviedb.org/3/discover/${mediaType}`;
  const qs   = new URLSearchParams(params).toString();
  const res  = await fetch(`${base}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) return [];
  const data = res.json();
  return data.results || [];
}

async function fetchTmdbCandidates(token) {
  const candidates = new Map();
  const cutoff     = `${THIS_YEAR - 3}-01-01`;

  for (const lang of LANGS) {
    for (const type of TYPES) {
      const minVotes = lang === 'gu' ? 50 : 300;

      // Call 1: quality
      const q1 = await fetchTmdbPage(token, type, {
        sort_by: 'vote_average.desc',
        'vote_average.gte': '6.5',
        'vote_count.gte':   String(minVotes),
        with_original_language: lang,
        page: '1',
      });
      await sleep(200);

      // Call 2: recent
      const dateKey = type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte';
      const q2 = await fetchTmdbPage(token, type, {
        sort_by: 'popularity.desc',
        'vote_average.gte': '5.5',
        [dateKey]: cutoff,
        with_original_language: lang,
        page: '1',
      });
      await sleep(200);

      for (const item of [...q1, ...q2]) {
        const key = `${type}-${item.id}`;
        if (candidates.has(key)) continue;
        const dateStr  = item.release_date || item.first_air_date || '';
        const poster   = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '';
        candidates.set(key, {
          tmdbId:       String(item.id),
          title:        item.title || item.name || '',
          year:         dateStr.slice(0, 4),
          type:         type === 'movie' ? 'Movie' : 'TV',
          tmdbLang:     item.original_language || lang,
          language:     LANG_LABEL[item.original_language] || LANG_LABEL[lang] || '',
          tmdbScore:    item.vote_average || 0,
          tmdbVotes:    item.vote_count   || 0,
          tmdbPopularity: item.popularity || 0,
          genreIds:     item.genre_ids    || [],
          poster,
          overview:     (item.overview || '').slice(0, 200),
        });
      }

      console.log(`  ${lang}/${type}: q1=${q1.length} q2=${q2.length}`);
    }
  }

  return Array.from(candidates.values());
}

// ── STEP D — Score candidates ──────────────────────────────────────────────

function scoreCandidates(candidates, tasteProfile) {
  const maxPop = Math.max(...candidates.map(c => c.tmdbPopularity), 1);

  return candidates.map(c => {
    const yearInt = parseInt(c.year) || THIS_YEAR - 5;

    const imdbNorm   = clamp((c.tmdbScore - 5) / 5, 0, 1);
    const popNorm    = Math.log(1 + c.tmdbPopularity) / Math.log(1 + maxPop);
    const recency    = clamp(1 - (THIS_YEAR - yearInt) * 0.1, 0, 1);

    // Genre match using TMDB genre IDs
    const matchedWeights = c.genreIds
      .map(id => TMDB_GENRE_MAP[id])
      .filter(Boolean)
      .map(name => tasteProfile.genreWeights[name] || 0);
    const genreMatch = matchedWeights.length
      ? matchedWeights.reduce((s, w) => s + w, 0) / matchedWeights.length
      : 0.3;

    const personal  = (genreMatch * 0.8) + (c.tmdbScore >= 8 ? 0.2 : 0);
    const hiddenGem = (c.tmdbScore >= 7.5 && c.tmdbVotes < 15000) ? 1 : 0;

    const total = (0.35 * imdbNorm) + (0.20 * popNorm) + (0.15 * recency) +
                  (0.15 * genreMatch) + (0.10 * personal) + (0.05 * hiddenGem);

    return {
      ...c,
      score: {
        total: r3(total),
        breakdown: {
          imdb:       r3(0.35 * imdbNorm),
          popularity: r3(0.20 * popNorm),
          recency:    r3(0.15 * recency),
          genreMatch: r3(0.15 * genreMatch),
          personal:   r3(0.10 * personal),
          hiddenGem:  r3(0.05 * hiddenGem),
        },
      },
    };
  });
}

// ── STEP E — Remove watched ────────────────────────────────────────────────

function removeWatched(candidates, ratings) {
  const watched = new Set(ratings.map(r => r.title.toLowerCase()));
  return candidates.filter(c => !watched.has(c.title.toLowerCase()));
}

// ── STEP F — Claude enrichment ────────────────────────────────────────────

async function enrichWithClaude(candidates, tasteProfile, ratings) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set — skipping Claude enrichment');
    return candidates.map(c => ({ ...c, why: c.overview || '' }));
  }

  const top80    = candidates.slice(0, 80);
  const sample40 = ratings
    .filter(r => r.yourRating >= 6)
    .sort((a, b) => b.yourRating - a.yourRating)
    .slice(0, 40)
    .map(r => `${r.title} (${r.year}) [rated ${r.yourRating}/10]`)
    .join('\n');

  const genreList = tasteProfile.topGenres.map(g => `${g.genre} (${g.weight})`).join(', ');
  const dirList   = tasteProfile.topDirectors.slice(0, 5).join(', ');

  const compact = top80.map(c => ({
    tmdbId:   c.tmdbId,
    title:    c.title,
    year:     c.year,
    type:     c.type,
    language: c.language,
    score:    c.score.total,
    overview: c.overview,
  }));

  const prompt = `You are a film curator helping a couple find great movies and TV shows.

User taste profile:
- Top genres: ${genreList}
- Favourite directors: ${dirList}
- Prefers recent content: ${tasteProfile.prefersRecent}

Recently rated titles (sample):
${sample40}

Below is a JSON array of ${top80.length} candidate titles pre-scored by our algorithm. For each item return a JSON object with:
  "tmdbId": (same string as input),
  "why": (max 22 words explaining why THIS user would enjoy it based on their taste),
  "remove": false (set true only for clear mismatches with the user's taste)

Return ONLY a raw JSON array — no markdown fences, no prose.

Candidates:
${JSON.stringify(compact)}`;

  console.log('Calling Claude for enrichment…');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (res.status !== 200) {
    console.warn('Claude API error:', res.text());
    return candidates.map(c => ({ ...c, why: c.overview || '' }));
  }

  const data    = res.json();
  const text    = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const match   = text.match(/\[[\s\S]*\]/);
  if (!match) {
    console.warn('Could not extract JSON array from Claude response');
    return candidates.map(c => ({ ...c, why: c.overview || '' }));
  }

  let enrichments;
  try { enrichments = JSON.parse(match[0]); } catch {
    console.warn('Failed to parse Claude JSON');
    return candidates.map(c => ({ ...c, why: c.overview || '' }));
  }

  const whyMap    = new Map(enrichments.map(e => [String(e.tmdbId), e.why || '']));
  const removeSet = new Set(enrichments.filter(e => e.remove).map(e => String(e.tmdbId)));

  const filtered = candidates.filter(c => !removeSet.has(c.tmdbId));
  return filtered.map(c => ({ ...c, why: whyMap.get(c.tmdbId) || c.overview || '' }));
}

// ── STEP G — Write output ─────────────────────────────────────────────────

function writeOutput(pool, tasteProfile) {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const output = {
    generated_at: new Date().toISOString(),
    weights: {
      imdb: 0.35, popularity: 0.20, recency: 0.15,
      genre_match: 0.15, personal: 0.10, hidden_gem: 0.05,
    },
    taste_profile: {
      top_genres:    tasteProfile.topGenres,
      top_directors: tasteProfile.topDirectors,
      total_ratings: tasteProfile.totalRatings,
      prefers_recent: tasteProfile.prefersRecent,
    },
    pool: pool.map(c => ({
      id:      c.tmdbId,
      tmdbId:  c.tmdbId,
      tmdbLang: c.tmdbLang,
      title:   c.title,
      year:    c.year,
      type:    c.type,
      language: c.language,
      overview: c.overview,
      why:     c.why || c.overview || '',
      imdb:    String(c.tmdbScore),
      platform: '',
      poster:  c.poster,
      score:   c.score,
      genreIds: c.genreIds,
    })),
  };

  fs.writeFileSync(path.join(dataDir, 'pool.json'), JSON.stringify(output, null, 2));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const token = (process.env.TMDB_API_READ_ACCESS_TOKEN || '').trim();
  if (!token) {
    console.error('TMDB_API_READ_ACCESS_TOKEN is required');
    process.exit(1);
  }

  // A — ratings
  const ratings = await fetchRatings();
  console.log(`Loaded ${ratings.length} rated titles`);

  // B — taste profile
  const tasteProfile = buildTasteProfile(ratings);
  console.log(`Taste profile: top genres=${tasteProfile.topGenres.map(g => g.genre).join(', ')}`);

  // C — TMDB candidates
  console.log('Fetching TMDB candidates…');
  const raw = await fetchTmdbCandidates(token);
  console.log(`Total candidates fetched: ${raw.length}`);

  // D — score
  const scored = scoreCandidates(raw, tasteProfile);

  // E — remove watched
  const unwatched = removeWatched(scored, ratings);
  console.log(`After removing watched: ${unwatched.length}`);

  // sort by score
  unwatched.sort((a, b) => b.score.total - a.score.total);

  // F — Claude enrichment
  const enriched = await enrichWithClaude(unwatched, tasteProfile, ratings);
  console.log(`After Claude curation: ${enriched.length}`);

  // Final pool
  enriched.sort((a, b) => b.score.total - a.score.total);
  const pool = enriched;
  console.log(`Final pool size: ${pool.length}`);
  console.log('Top 3:');
  pool.slice(0, 3).forEach((c, i) =>
    console.log(`  ${i + 1}. ${c.title} (${c.year}) — score: ${c.score.total}`)
  );

  // G — write
  writeOutput(pool, tasteProfile);
  console.log('Written to data/pool.json');
}

main().catch(err => { console.error(err); process.exit(1); });
