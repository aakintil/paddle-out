#!/usr/bin/env node
// Pulls real swell/wind/tide/rain data and writes data/forecast.json.
// Run on a schedule by .github/workflows/update-forecast.yml — see the plan
// this implements for the full source list and reasoning:
//   Open-Meteo Marine   -> swell height/period/direction (free, no key)
//   Open-Meteo Weather  -> wind, rain, air temp (free, no key, full 7 days —
//                          switched from OpenWeatherMap, whose free tier
//                          only covers ~5 days and left the last 2 days blank)
//   WorldTides          -> high/low tide extremes (key required, cached ~daily
//                          since tide extremes don't change within a day)

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const TARKWA_BAY = { lat: 6.406, lon: 3.383 };
const IKOYI = { lat: 6.4474, lon: 3.4334 };
const LAGOS_OFFSET_SECONDS = 3600; // WAT, UTC+1, no DST
const SCORE_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const TIDE_CACHE_HOURS = 20; // re-fetch tide extremes at most once per ~day
// Requested from Open-Meteo, which fetches this many days without erroring —
// but its marine model's real skillful range turned out to be ~10 days
// (confirmed via a live 14-day test run: days 11-14 came back null). 7 stays
// safely inside that window; buildDay() drops any day with no real data
// regardless, so this is a soft ceiling, not a promise every day is real.
const FORECAST_DAYS = 7;

const OUT_PATH = new URL('../data/forecast.json', import.meta.url);

const WORLDTIDES_API_KEY = process.env.WORLDTIDES_API_KEY;

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split('?')[0]} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/* ============================= time helpers ============================= */
// Both OpenWeatherMap and WorldTides return UTC unix timestamps; shifting by
// the fixed Lagos offset then reading the fields back out as if they were
// UTC is a standard trick for getting local wall-clock date/hour without a
// timezone library.
function localDate(unixSeconds) {
  return new Date((unixSeconds + LAGOS_OFFSET_SECONDS) * 1000);
}
function ymd(date) {
  return date.toISOString().slice(0, 10);
}
function decimalHour(date) {
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}
function hhmm(decHour) {
  const dh = ((decHour % 24) + 24) % 24;
  const h = Math.floor(dh);
  const m = Math.round((dh - h) * 60);
  const period = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}
function fmtDate(date, opts) {
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}

/* ============================= sources ============================= */
async function fetchMarine() {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${TARKWA_BAY.lat}&longitude=${TARKWA_BAY.lon}&hourly=wave_height,wave_period,wave_direction&timezone=Africa%2FLagos&forecast_days=${FORECAST_DAYS}`;
  const data = await fetchJSON(url);
  // Map: 'YYYY-MM-DD' -> Map<hour, {height, period, direction}>
  const byDay = new Map();
  data.hourly.time.forEach((iso, i) => {
    const [date, time] = iso.split('T');
    const hour = Number(time.slice(0, 2));
    if (!byDay.has(date)) byDay.set(date, new Map());
    byDay.get(date).set(hour, {
      height: data.hourly.wave_height[i],
      period: data.hourly.wave_period[i],
      direction: data.hourly.wave_direction[i],
    });
  });
  return byDay;
}

async function fetchOpenMeteoWeather(loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,precipitation&timezone=Africa%2FLagos&forecast_days=${FORECAST_DAYS}`;
  const data = await fetchJSON(url);
  // Local-time-labeled hourly array (same convention as the marine endpoint)
  // Map: 'YYYY-MM-DD' -> array of {hour, temp, windKmh, windDeg, pop, rainMm}
  const byDay = new Map();
  data.hourly.time.forEach((iso, i) => {
    const [date, time] = iso.split('T');
    const hour = Number(time.slice(0, 2));
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({
      hour,
      temp: data.hourly.temperature_2m[i],
      windKmh: data.hourly.wind_speed_10m[i],
      windDeg: data.hourly.wind_direction_10m[i],
      pop: data.hourly.precipitation_probability[i] ?? 0, // 0-100
      rainMm: data.hourly.precipitation[i] ?? 0,
    });
  });
  return byDay;
}

async function fetchTideExtremes() {
  if (!WORLDTIDES_API_KEY) return null;
  const url = `https://www.worldtides.info/api/v3?extremes&lat=${TARKWA_BAY.lat}&lon=${TARKWA_BAY.lon}&days=${FORECAST_DAYS}&key=${WORLDTIDES_API_KEY}`;
  const data = await fetchJSON(url);
  // Map: 'YYYY-MM-DD' -> array of {decHour, type, heightM}
  const byDay = new Map();
  for (const ext of data.extremes) {
    const local = localDate(ext.dt);
    const date = ymd(local);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({ decHour: decimalHour(local), type: ext.type, heightM: ext.height });
  }
  return byDay;
}

/* ============================= scoring (mirrors surf-prototype.html) ============================= */
function computeHourScore(period, height, windKmh) {
  const periodScore = Math.min(1, Math.max(0, (period - 6) / 10)) * 40;
  const heightScore = Math.min(1, Math.max(0, height / 1.5)) * 35;
  const windPenalty = Math.min(1, Math.max(0, windKmh / 30)) * 35;
  return Math.round(Math.max(0, Math.min(100, periodScore + heightScore - windPenalty + 30)));
}

const TOO_BIG_M = 1.6;   // outer/headline height above this = unrideable at this small bay, regardless of score
const TOO_SMALL_M = 0.35; // below this there's no wave to speak of, regardless of score
const MORNING_HOURS = [7, 8, 9, 10, 11];
const AFTERNOON_HOURS = [14, 15, 16, 17, 18];

// score-only thresholds; height/wind/time-of-day overrides are applied by
// the caller (see buildDay) since they need context this function doesn't have
function deriveCall(score) {
  if (score >= 60) return 'GO NOW';
  if (score >= 45) return 'WORTH PLANNING';
  if (score >= 30) return 'MARGINAL';
  return 'SKIP';
}

function avgOf(scores, hours) {
  const vals = hours.map((h) => scores[h]).filter((v) => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Full 7-category classification: starts from the score-based call, then
// applies overrides that the plain avg can't express on its own — a big
// clean swell and a big dangerous swell can score the same avg, but only
// one is "great," the other is "too big to paddle out here."
// `avg` is the already-computed tide-window score (see computeWindowScore).
function classifyDay({ avg, scores, outerHeightM, windKmh, rain }) {
  if (outerHeightM > TOO_BIG_M) return 'TOO BIG';
  if (outerHeightM < TOO_SMALL_M) return 'TOO SMALL';

  const morningAvg = avgOf(scores, MORNING_HOURS);
  const afternoonAvg = avgOf(scores, AFTERNOON_HOURS);
  if (morningAvg !== null && afternoonAvg !== null && morningAvg >= 45 && morningAvg - afternoonAvg >= 15 && afternoonAvg < 35) {
    return 'DAWN PATROL';
  }

  const call = deriveCall(avg);
  if (call === 'SKIP') {
    // two skip "reasons," same grade — distinguishes the two Skip illustrations
    const stormy = windKmh >= 25 || rain === 'Heavy';
    return stormy ? 'SKIP: STORMY' : 'SKIP: FLAT';
  }
  return call;
}

function computeWindowScore(scores, start, end) {
  const hours = Object.keys(scores).map(Number);
  const inWindow = hours.filter((h) => h + 1 > start && h < end && scores[h] != null);
  if (inWindow.length === 0) return 0;
  return inWindow.reduce((sum, h) => sum + scores[h], 0) / inWindow.length;
}

function waveLabel(m) {
  if (m < 0.35) return 'Ankle';
  if (m < 0.55) return 'Knee';
  if (m < 0.85) return 'Waist';
  if (m < 1.15) return 'Chest';
  return 'Head';
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function degToCompass(deg) {
  return COMPASS[Math.round(deg / 22.5) % 16];
}

function formatMeters(m) {
  const rounded = Math.round(m * 100) / 100;
  return `${rounded % 1 === 0 ? rounded.toFixed(1) : rounded}m`;
}

function nearestBy(entries, hour, key) {
  if (!entries || entries.length === 0) return null;
  return entries.reduce((best, e) =>
    Math.abs(e[key] - hour) < Math.abs(best[key] - hour) ? e : best
  );
}

function classifyRain(entry) {
  if (!entry) return 'Dry';
  if (entry.rainMm >= 2 || entry.pop >= 60) return 'Heavy';
  if (entry.rainMm > 0 || entry.pop >= 20) return 'Light';
  return 'Dry';
}

/* ============================= assemble ============================= */
function buildDay({ dateObj, marineHours, tideExtremes, beachWeather, homeWeather, isLast, nowHour }) {
  const dateStr = ymd(dateObj);
  const dayAbbr = fmtDate(dateObj, { weekday: 'short' });
  const monthDay = fmtDate(dateObj, { day: 'numeric', month: 'short' });

  // Pick the high tide (of up to 2/day) whose ±90/+30min window best overlaps
  // the hours we actually have quality data for (07:00-19:00) — see the
  // grading-rubric comment in surf-prototype.html for why this matters.
  const highs = (tideExtremes || []).filter((e) => e.type === 'High');
  let best = null;
  let bestOverlap = -1;
  for (const h of highs) {
    const start = h.decHour - 1.5;
    const end = h.decHour + 0.5;
    const overlap = Math.max(0, Math.min(end, 19) - Math.max(start, 7));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = h;
    }
  }

  // Open-Meteo's marine model accepts forecast_days up to 14 without erroring,
  // but its actual skillful range is shorter — beyond it, hours come back as
  // literal `null`, and JS's `null * x = 0` arithmetic would silently turn
  // "no data" into a fake "flat" reading. Use `null` as an explicit
  // no-data sentinel here instead, so it can't be mistaken for a real 0.
  const scores = {};
  for (const hour of SCORE_HOURS) {
    const wave = marineHours?.get(hour);
    const wind = nearestBy(beachWeather, hour, 'hour');
    scores[hour] = (wave && wave.height != null && wave.period != null)
      ? computeHourScore(wave.period, wave.height, wind?.windKmh ?? 15)
      : null;
  }
  const hasAnyData = Object.values(scores).some((s) => s !== null);
  if (!hasAnyData) return null; // no real forecast for this day yet — drop it rather than fabricate one

  // No High tide left to recommend (common for "today" once its tide has
  // already passed — WorldTides only returns future extremes) doesn't mean
  // "nothing is surfable" — fall back to whatever scored hours remain today
  // instead of forcing avg to 0 and misreporting a hard SKIP.
  const fallbackStart = isLast === 'today' ? Math.max(SCORE_HOURS[0], Math.ceil(nowHour)) : SCORE_HOURS[0];
  const fallbackEnd = SCORE_HOURS[SCORE_HOURS.length - 1] + 1;
  const tideStart = best ? best.decHour - 1.5 : fallbackStart;
  const tideEnd = best ? best.decHour + 0.5 : fallbackEnd;
  const avg = Math.round(computeWindowScore(scores, tideStart, tideEnd));

  const headlineHour = best ? Math.round(best.decHour) : 12;
  // Prefer the exact hour, but fall back to the nearest hour that actually
  // has real (non-null) marine data rather than defaulting to a fake 0.
  const validHours = [...(marineHours?.entries() ?? [])].filter(([, v]) => v.height != null && v.period != null);
  const exact = marineHours?.get(Math.min(23, Math.max(0, headlineHour)));
  const headlineWave = (exact && exact.height != null && exact.period != null)
    ? exact
    : (validHours.sort((a, b) => Math.abs(a[0] - headlineHour) - Math.abs(b[0] - headlineHour))[0]?.[1] ?? { height: 0, period: 0, direction: 0 });
  const headlineWind = nearestBy(beachWeather, headlineHour, 'hour');
  const windKmh = Math.round(headlineWind?.windKmh ?? 0);

  const outerM = Math.round(headlineWave.height * 10) / 10;
  const midM = Math.round(outerM * 0.7 * 100) / 100;
  const nearM = Math.round(outerM * 0.4 * 100) / 100;

  const middayBeach = nearestBy(beachWeather, 12, 'hour');
  const middayHome = nearestBy(homeWeather, 12, 'hour');

  const call = classifyDay({ avg, scores, outerHeightM: outerM, windKmh, rain: classifyRain(middayBeach) });

  // null was only an internal "no data for this hour" sentinel — the shipped
  // JSON's `scores` should stay a plain hour->number map for the frontend's
  // conditions-strip rendering, which doesn't know about nulls.
  const cleanScores = Object.fromEntries(Object.entries(scores).map(([h, v]) => [h, v ?? 0]));

  return {
    date: `${dayAbbr} ${monthDay}`,
    label: isLast === 'today' ? 'Today' : isLast === 'tomorrow' ? 'Tomorrow' : fmtDate(dateObj, { weekday: 'long' }),
    day: dayAbbr,
    call,
    avg,
    swell: {
      type: headlineWave.period >= 8 ? 'Groundswell' : 'Wind chop',
      period: Math.round(headlineWave.period * 10) / 10,
      height: outerM,
      wind: windKmh,
      condition: windKmh >= 18 ? 'Choppy' : 'Clean',
    },
    tide: best
      ? { ht: hhmm(best.decHour), window: `${hhmm(tideStart)} – ${hhmm(tideEnd)}`, start: Math.round(tideStart * 100) / 100, end: Math.round(tideEnd * 100) / 100 }
      : { ht: '—', window: fallbackStart >= fallbackEnd ? 'No more session today' : 'No tide-timed window — general conditions shown', start: Math.round(tideStart * 100) / 100, end: Math.round(tideEnd * 100) / 100 },
    wave: outerM < 0.15 ? null : {
      near: { label: waveLabel(nearM), m: formatMeters(nearM), h: Math.round(nearM * 68) },
      mid: { label: waveLabel(midM), m: formatMeters(midM), h: Math.round(midM * 68) },
      outer: { label: waveLabel(outerM), m: formatMeters(outerM), h: Math.round(outerM * 68) },
    },
    scores: cleanScores,
    detail: {
      dir: degToCompass(headlineWave.direction),
      score: `${avg}/100`,
      temp: middayBeach ? `${Math.round(middayBeach.temp)}°C` : '—',
      // not sourced from any API — same heuristic as before (weekends busier)
      crowd: ['Sat', 'Sun'].includes(dayAbbr) ? 'High' : dayAbbr === 'Fri' ? 'Medium' : 'Low',
    },
    rain: {
      beach: classifyRain(middayBeach),
      home: classifyRain(middayHome),
    },
  };
}

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

async function main() {
  const previous = await loadPrevious();

  const [marineByDay, beachByDay, homeByDay] = await Promise.all([
    fetchMarine(),
    fetchOpenMeteoWeather(TARKWA_BAY),
    fetchOpenMeteoWeather(IKOYI),
  ]);

  let tideByDay = null;
  let tideFreshlyFetched = false;
  const needsTide = hoursSince(previous?.tideFetchedAt) > TIDE_CACHE_HOURS;
  let tideFetchedAt = previous?.tideFetchedAt ?? null;
  if (needsTide) {
    try {
      tideByDay = await fetchTideExtremes();
      if (tideByDay) {
        tideFetchedAt = new Date().toISOString();
        tideFreshlyFetched = true;
      }
    } catch (err) {
      console.warn(`Tide fetch failed (${err.message}), falling back to cached tide data if any.`);
    }
  }
  if (!tideByDay) {
    const cached = previous?._tideCache;
    if (cached) {
      tideByDay = new Map(Object.entries(cached).map(([k, v]) => [k, v]));
    }
  }
  if (!tideByDay) {
    console.error('No tide data available (no fresh fetch and no cache). Refusing to publish a forecast with no tide info — set WORLDTIDES_API_KEY.');
    process.exit(1);
  }

  const todayLagos = localDate(Math.floor(Date.now() / 1000));
  const nowHour = decimalHour(todayLagos);
  const days = [];
  for (let i = 0; i < FORECAST_DAYS; i++) {
    const dateObj = new Date(todayLagos);
    dateObj.setUTCDate(dateObj.getUTCDate() + i);
    const dateStr = ymd(dateObj);
    days.push(buildDay({
      dateObj,
      marineHours: marineByDay.get(dateStr),
      tideExtremes: tideByDay.get(dateStr),
      beachWeather: beachByDay.get(dateStr),
      homeWeather: homeByDay.get(dateStr),
      isLast: i === 0 ? 'today' : i === 1 ? 'tomorrow' : null,
      nowHour,
    }));
  }
  const realDays = days.filter((d) => d !== null); // buildDay returns null for days with no real marine data at all

  const output = {
    generatedAt: new Date().toISOString(),
    tideFetchedAt,
    _tideCache: Object.fromEntries(tideByDay),
    forecast: realDays,
  };

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${realDays.length} days to data/forecast.json (tide ${tideFreshlyFetched ? 'freshly fetched' : 'from cache'})`);
}

main().catch((err) => {
  console.error('fetch-forecast failed:', err);
  process.exit(1);
});
