// scripts/generate.js
// Runs every morning in GitHub Actions:
//   1) fetches weather for Devín & Láb from Open-Meteo
//   2) scores fish activity (same logic as the dashboard's client-side JS — keep both in sync if you tune weights)
//   3) bakes the data into index.html between the MORNING_DATA markers
//   4) sends a push notification via ntfy.sh, but only if a location looks promising or changed a lot

const fs = require('fs');

/* ---------- scoring engine (kept identical to the dashboard's <script>) ---------- */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function scoreHour(hours, idx) {
  const h = hours[idx];
  const reasons = [];
  let score = 50;
  const at = (offset) => hours[idx - offset] || null;

  const p3 = at(3), p24 = at(24);
  if (p3) {
    const d3 = h.pressure - p3.pressure;
    if (d3 <= -1.5) { score += 25; reasons.push('Tlak prudko klesá — blíži sa front, zvýšená šanca na žer'); }
    else if (d3 <= -0.5) { score += 15; reasons.push('Tlak mierne klesá — dobré podmienky'); }
    else if (d3 < 0.5) { score += 8; reasons.push('Tlak stabilný'); }
    else if (d3 < 1.5) { reasons.push('Tlak mierne stúpa'); }
    else { score -= 15; reasons.push('Tlak rýchlo stúpa — front prešiel, útlm'); }
  }
  if (p24) {
    const d24 = h.pressure - p24.pressure;
    if (d24 <= -4) { score -= 5; reasons.push('Veľký pokles tlaku za 24h — žravá špička môže byť už za nami'); }
    if (Math.abs(d24) < 1) { score += 5; }
  }
  if (p24) {
    const dT24 = h.temp - p24.temp;
    if (dT24 <= -3) { score -= 15; reasons.push('Prudké ochladenie za 24h — útlm'); }
    else if (dT24 >= 0 && dT24 <= 3) { score += 8; reasons.push('Mierne otepľovanie — podporuje žer'); }
    else if (dT24 > 5) { score -= 8; reasons.push('Veľmi rýchle otepľovanie — stres pre ryby'); }
  }
  if (h.precip > 0.1 && h.precip <= 2) { score += 10; reasons.push('Mierny dážď — okysličuje vodu'); }
  else if (h.precip > 5) { score -= 15; reasons.push('Silný dážď — zákal a zvýšený prietok'); }
  let precip24 = 0;
  for (let i = Math.max(0, idx - 24); i <= idx; i++) precip24 += (hours[i].precip || 0);
  if (precip24 > 15) { score -= 10; reasons.push('Vyšší prietok po daždi — skús zátišia, nie hlavný prúd'); }

  if (h.wind >= 5 && h.wind <= 20) { score += 5; reasons.push('Mierny vietor čerí hladinu — priaznivé'); }
  else if (h.wind > 35) { score -= 10; reasons.push('Silný vietor — sťažené podmienky'); }

  const hourOfDay = parseInt(h.time.slice(11, 13), 10);
  if ((hourOfDay >= 5 && hourOfDay <= 8) || (hourOfDay >= 19 && hourOfDay <= 22)) {
    score += 15; reasons.push('Ranné/večerné svetlo — prirodzene aktívny čas');
  } else if (hourOfDay >= 11 && hourOfDay <= 15) {
    score -= 8; reasons.push('Poludňajší čas — ryby bývajú pasívnejšie');
  }

  score = clamp(Math.round(score), 0, 100);
  let label, color;
  if (score >= 75) { label = 'Výborný čas'; color = 'good'; }
  else if (score >= 55) { label = 'Dobrá šanca'; color = 'ok'; }
  else if (score >= 35) { label = 'Priemerné'; color = 'meh'; }
  else { label = 'Slabé'; color = 'bad'; }
  return { score, label, color, reasons };
}

function findBestWindows(hours, scores, daysAhead) {
  const todayStr = hours[0].time.slice(0, 10);
  const today = new Date(todayStr + 'T00:00:00');
  const out = [];
  for (let d = 0; d < daysAhead; d++) {
    const targetStr = new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
    let best = null;
    for (let i = 0; i < hours.length; i++) {
      const dateStr = hours[i].time.slice(0, 10);
      const hod = parseInt(hours[i].time.slice(11, 13), 10);
      if (dateStr === targetStr && hod >= 4 && hod <= 22) {
        if (!best || scores[i].score > best.score.score) best = { time: hours[i].time, score: scores[i] };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

function findNowIndexBratislava(hours) {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hour12:false });
  const parts = fmt.formatToParts(new Date()).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const nowStr = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < hours.length; i++) {
    const diff = Math.abs(new Date(hours[i].time) - new Date(nowStr));
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

/* ---------- locations & fetching ---------- */
const LOCATIONS = {
  devin: { name: 'Devín', lat: 48.1769, lon: 17.0747, shmuId: 5127 },
  lab:   { name: 'Láb/Centnúz', lat: 48.3704, lon: 17.0454, shmuId: null },
  vysoka:{ name: 'Vysoká pri Morave', lat: 48.4110, lon: 16.9890, shmuId: 5087 }
};

function buildUrl(lat, lon) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
         `&hourly=temperature_2m,pressure_msl,precipitation,wind_speed_10m` +
         `&past_days=2&forecast_days=4&timezone=Europe%2FBratislava`;
}

function parseOpenMeteo(json) {
  const t = json.hourly.time;
  return t.map((time, i) => ({
    time,
    temp: json.hourly.temperature_2m[i],
    pressure: json.hourly.pressure_msl[i],
    precip: json.hourly.precipitation[i] ?? 0,
    wind: json.hourly.wind_speed_10m[i]
  }));
}

/* ---------- SHMU water level + water temperature scraping ---------- */
// SHMU provides data in HTML tables — we parse the most recent row.
// Station IDs: 5087 = Vysoká pri Morave (Morava), 5127 = Devín (Dunaj)
async function fetchShmu(stationId){
  const url = `https://www.shmu.sk/sk/?page=765&station_id=${stationId}`;
  try{
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RybarskeOkno/1.0)' }
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Parse the most recent measurement row:
    // pattern: <td>DD.M.YYYY HH:MM</td> <td>NUMBER</td> <td>NUMBER</td>
    const rows = [...html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi)];
    for(const row of rows){
      const cells = [...row[0].matchAll(/<td[^>]*>([\d\s.:,]+)<\/td>/gi)].map(m=>m[1].trim());
      if(cells.length>=3){
        const levelCm = parseInt(cells[1]);
        const waterTemp = parseFloat(cells[2].replace(',','.'));
        if(!isNaN(levelCm) && !isNaN(waterTemp) && levelCm>0 && waterTemp>0){
          console.log(`  SHMU ${stationId}: ${levelCm} cm, ${waterTemp}°C`);
          return { levelCm, waterTemp, fetchedAt: new Date().toISOString() };
        }
      }
    }
    console.warn(`  SHMU ${stationId}: nenašiel som platný riadok`);
    return null;
  }catch(err){
    console.warn(`  SHMU ${stationId} fetch zlyhal:`, err.message);
    return null;
  }
}

async function notify(title, message) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { console.log('NTFY_TOPIC nie je nastavený, notifikáciu preskakujem.'); return; }
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Title': title, 'Tags': 'fish' },
      body: message
    });
    console.log('ntfy odpoveď:', res.status);
  } catch (err) {
    console.error('Odoslanie notifikácie zlyhalo:', err.message);
  }
}

/* ---------- main ---------- */
async function main() {
  const payload = { generatedAt: new Date().toISOString() };
  const summaryParts = [];
  let maxScore = -1, maxLabel = '';

  for (const key of Object.keys(LOCATIONS)) {
    const loc = LOCATIONS[key];
    const res = await fetch(buildUrl(loc.lat, loc.lon));
    if (!res.ok) throw new Error(`Fetch zlyhal pre ${key}: HTTP ${res.status}`);
    const json = await res.json();
    const hours = parseOpenMeteo(json);
    payload[key] = { hours };

    // SHMU real water data (river stations only)
    if(loc.shmuId){
      console.log(`Sťahujem SHMU stanicu ${loc.shmuId} (${loc.name})...`);
      const shmuData = await fetchShmu(loc.shmuId);
      if(shmuData) payload[key].shmu = shmuData;
    }

    const scores = hours.map((_, i) => scoreHour(hours, i));
    const nowIdx = findNowIndexBratislava(hours);
    const cur = scores[nowIdx];
    const windows = findBestWindows(hours, scores, 1); // dnešok
    const todayBest = windows[0];

    summaryParts.push(`${loc.name}: ${cur.score}/100 (${cur.label})` +
      (todayBest ? ` · top dnes ${todayBest.time.slice(11,16)} (${todayBest.score.score})` : ''));

    if (cur.score > maxScore) { maxScore = cur.score; maxLabel = cur.label; }
  }

  // bake data into index.html
  const html = fs.readFileSync('index.html', 'utf8');
  const marker = /\/\* === MORNING_DATA_START === \*\/[\s\S]*?\/\* === MORNING_DATA_END === \*\//;
  if (!marker.test(html)) {
    throw new Error('Nenašiel som MORNING_DATA_START/END markery v index.html — skontroluj súbor.');
  }
  const replacement =
    `/* === MORNING_DATA_START === */\nconst PRELOADED = ${JSON.stringify(payload)};\n/* === MORNING_DATA_END === */`;
  fs.writeFileSync('index.html', html.replace(marker, replacement));
  console.log('index.html aktualizovaný,', payload.generatedAt);

  // notify only if something is worth checking — keeps it from being noisy every single morning
  const NOTIFY_THRESHOLD = parseInt(process.env.NOTIFY_THRESHOLD || '65', 10);
  if (maxScore >= NOTIFY_THRESHOLD) {
    await notify('🎣 Rybárske okno', `${summaryParts.join(' | ')}`);
  } else {
    console.log(`Najlepšie skóre dnes je ${maxScore} (< ${NOTIFY_THRESHOLD}), notifikáciu neposielam.`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
