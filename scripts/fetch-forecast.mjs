#!/usr/bin/env node
// Pulls real swell/wind/tide/rain data and writes data/forecast.json.
// Run on a schedule by .github/workflows/update-forecast.yml — see the plan
// this implements for the full source list and reasoning:
//   Open-Meteo Marine  -> swell height/period/direction (free, no key)
//   OpenWeatherMap      -> wind, rain, air temp, sunrise/sunset (key required)
//   WorldTides          -> high/low tide extremes (key required, cached ~daily
//                          since tide extremes don't change within a day)

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const TARKWA_BAY = { lat: 6.406, lon: 3.383 };
const IKOYI = { lat: 6.4474, lon: 3.4334 };
const LAGOS_OFFSET_SECONDS = 3600; // WAT, UTC+1, no DST
const SCORE_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const TIDE_CACHE_HOURS = 20; // re-fetch tide extremes at most once per ~day
const FORECAST_DAYS = 7;

const OUT_PATH = new URL('../data/forecast.json', import.meta.url);

const OPENWEATHERMAP_API_KEY = process.env.OPENWEATHERMAP_API_KEY;
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
  const h = Math.floor(decHour);
  const m = Math.round((decHour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

async function fetchWeather(loc) {
  if (!OPENWEATHERMAP_API_KEY) throw new Error('Missing OPENWEATHERMAP_API_KEY');
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${loc.lat}&lon=${loc.lon}&appid=${OPENWEATHERMAP_API_KEY}&units=metric`;
  const data = await fetchJSON(url);
  const offset = data.city.timezone;
  // Map: 'YYYY-MM-DD' -> array of {hour, temp, windKmh, pop, rainMm}
  const byDay = new Map();
  for (const entry of data.list) {
    const local = new Date((entry.dt + offset) * 1000);
    const date = ymd(local);
    const hour = local.getUTCHours();
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({
      hour,
      temp: entry.main.temp,
      windKmh: entry.wind.speed * 3.6,
      windDeg: entry.wind.deg,
      pop: entry.pop ?? 0,
      rainMm: entry.rain?.['3h'] ?? 0,
    });
  }
  return { byDay, sunrise: localDate(data.city.sunrise), sunset: localDate(data.city.sunset) };
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

function deriveCall(score) {
  if (score >= 60) return 'GO NOW';
  if (score >= 45) return 'WORTH PLANNING';
  if (score >= 30) return 'MARGINAL';
  return 'SKIP';
}

function computeWindowScore(scores, start, end) {
  const hours = Object.keys(scores).map(Number);
  const inWindow = hours.filter((h) => h + 1 > start && h < end);
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
  if (entry.rainMm >= 2 || entry.pop >= 0.6) return 'Heavy';
  if (entry.rainMm > 0 || entry.pop >= 0.2) return 'Light';
  return 'Dry';
}

/* ============================= assemble ============================= */
function buildDay({ dateObj, marineHours, tideExtremes, beachWeather, homeWeather, isLast }) {
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

  const scores = {};
  for (const hour of SCORE_HOURS) {
    const wave = marineHours?.get(hour);
    const wind = nearestBy(beachWeather, hour, 'hour');
    scores[hour] = wave ? computeHourScore(wave.period, wave.height, wind?.windKmh ?? 15) : 0;
  }

  const tideStart = best ? best.decHour - 1.5 : 0;
  const tideEnd = best ? best.decHour + 0.5 : 0;
  const avg = Math.round(computeWindowScore(scores, tideStart, tideEnd));
  const call = deriveCall(avg);

  const headlineHour = best ? Math.round(best.decHour) : 12;
  const headlineWave = marineHours?.get(Math.min(23, Math.max(0, headlineHour))) ?? { height: 0, period: 0, direction: 0 };
  const headlineWind = nearestBy(beachWeather, headlineHour, 'hour');
  const windKmh = Math.round(headlineWind?.windKmh ?? 0);

  const outerM = Math.round(headlineWave.height * 10) / 10;
  const midM = Math.round(outerM * 0.7 * 100) / 100;
  const nearM = Math.round(outerM * 0.4 * 100) / 100;

  const middayBeach = nearestBy(beachWeather, 12, 'hour');
  const middayHome = nearestBy(homeWeather, 12, 'hour');

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
      ? { ht: hhmm(best.decHour), window: `${hhmm(tideStart)}–${hhmm(tideEnd)}`, start: Math.round(tideStart * 100) / 100, end: Math.round(tideEnd * 100) / 100 }
      : { ht: '—', window: 'No tide data', start: 0, end: 0 },
    wave: outerM < 0.15 ? null : {
      near: { label: waveLabel(nearM), m: formatMeters(nearM), h: Math.round(nearM * 68) },
      mid: { label: waveLabel(midM), m: formatMeters(midM), h: Math.round(midM * 68) },
      outer: { label: waveLabel(outerM), m: formatMeters(outerM), h: Math.round(outerM * 68) },
    },
    scores,
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

  const [marineByDay, beach, home] = await Promise.all([
    fetchMarine(),
    fetchWeather(TARKWA_BAY),
    fetchWeather(IKOYI),
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
  const days = [];
  for (let i = 0; i < FORECAST_DAYS; i++) {
    const dateObj = new Date(todayLagos);
    dateObj.setUTCDate(dateObj.getUTCDate() + i);
    const dateStr = ymd(dateObj);
    days.push(buildDay({
      dateObj,
      marineHours: marineByDay.get(dateStr),
      tideExtremes: tideByDay.get(dateStr),
      beachWeather: beach.byDay.get(dateStr),
      homeWeather: home.byDay.get(dateStr),
      isLast: i === 0 ? 'today' : i === 1 ? 'tomorrow' : null,
    }));
  }

  const output = {
    generatedAt: new Date().toISOString(),
    tideFetchedAt,
    _tideCache: Object.fromEntries(tideByDay),
    forecast: days,
  };

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${days.length} days to data/forecast.json (tide ${tideFreshlyFetched ? 'freshly fetched' : 'from cache'})`);
}

main().catch((err) => {
  console.error('fetch-forecast failed:', err);
  process.exit(1);
});
