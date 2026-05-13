// ============================================================
// weather-sms.js — Daily Weather Text for ZIP 10065
// • Nightly (Mon–Sat): tomorrow's forecast + 8AM/Noon/5PM snapshots
// • Sunday night: full 7-day weekly outlook
// • Zero npm dependencies — pure Node.js built-ins
// ============================================================

const https = require("https");

// ─── CONFIG ────────────────────────────────────────────────
const CONFIG = {
  // Gmail credentials — set these in GitHub Secrets
  GMAIL_USER:     process.env.GMAIL_USER     || "you@gmail.com",
  GMAIL_APP_PASS: process.env.GMAIL_APP_PASS || "your_app_password_here",

  // Your AT&T number — digits only, no dashes or spaces
  TO_NUMBER: process.env.TO_NUMBER || "9175551234",

  // Add extra AT&T numbers if needed
  EXTRA_NUMBERS: [], // e.g. ["9175559999"]

  // ZIP 10065 — Upper East Side, NYC
  LATITUDE:  40.7648,
  LONGITUDE: -73.9592,
  TIMEZONE:  "America/New_York",
};
// ───────────────────────────────────────────────────────────


// ─── WEATHER FETCH ─────────────────────────────────────────
// Fetches 8 days so Sunday night has a full Mon-Sun week ahead

function fetchWeather() {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      latitude:           CONFIG.LATITUDE,
      longitude:          CONFIG.LONGITUDE,
      timezone:           CONFIG.TIMEZONE,
      daily: [
        "temperature_2m_max",
        "temperature_2m_min",
        "apparent_temperature_max",
        "apparent_temperature_min",
        "precipitation_probability_max",
        "precipitation_sum",
        "weathercode",
        "windspeed_10m_max",
        "windgusts_10m_max",
        "sunrise",
        "sunset",
        "uv_index_max",
      ].join(","),
      hourly: [
        "temperature_2m",
        "apparent_temperature",
        "precipitation_probability",
        "weathercode",
      ].join(","),
      temperature_unit:   "fahrenheit",
      windspeed_unit:     "mph",
      precipitation_unit: "inch",
      forecast_days:      8,
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params}`;

    https.get(url, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("Failed to parse weather response")); }
      });
    }).on("error", reject);
  });
}


// ─── HELPERS ───────────────────────────────────────────────

function describeWeatherCode(code) {
  const map = {
    0:  "Clear",          1:  "Mostly clear",    2:  "Partly cloudy",
    3:  "Overcast",       45: "Foggy",            48: "Icy fog",
    51: "Lt drizzle",     53: "Drizzle",          55: "Hvy drizzle",
    61: "Lt rain",        63: "Rain",             65: "Hvy rain",
    71: "Lt snow",        73: "Snow",             75: "Hvy snow",
    77: "Snow grains",    80: "Lt showers",       81: "Showers",
    82: "Hvy showers",    85: "Snow showers",     86: "Hvy snow showers",
    95: "Storms",         96: "Storms+hail",      99: "Severe storms",
  };
  return map[code] || "Unknown";
}

function weatherEmoji(code) {
  if (code === 0)                        return "☀️";
  if (code <= 2)                         return "🌤";
  if (code === 3)                        return "☁️";
  if (code <= 48)                        return "🌫";
  if (code <= 55)                        return "🌦";
  if (code <= 67)                        return "🌧";
  if (code <= 77)                        return "🌨";
  if (code <= 82)                        return "🌧";
  if (code <= 86)                        return "❄️";
  return "⛈";
}

// Returns index into hourly arrays for a given date+hour
function hourlyIndex(times, dateStr, hour) {
  const target = `${dateStr}T${String(hour).padStart(2, "0")}:00`;
  return times.indexOf(target);
}

// Build a one-line snapshot: "8AM  ·  ☀️ Clear  ·  68°  ·  💧20%"
function hourlySnapshot(label, data, dateStr, hour) {
  const i = hourlyIndex(data.hourly.time, dateStr, hour);
  if (i === -1) return null;
  const temp    = Math.round(data.hourly.temperature_2m[i]);
  const feels   = Math.round(data.hourly.apparent_temperature[i]);
  const rain    = data.hourly.precipitation_probability[i];
  const code    = data.hourly.weathercode[i];
  const emoji   = weatherEmoji(code);
  const desc    = describeWeatherCode(code);
  const feelStr = Math.abs(temp - feels) >= 4 ? ` (feels ${feels}°)` : "";
  return `${label.padEnd(4)} ${emoji} ${desc} · ${temp}°${feelStr} · 💧${rain}%`;
}

function smartTips(feelsHi, rainPct, rainIn, uv, gusts) {
  const tips = [];
  if (rainPct >= 60)      tips.push("☂️ Bring an umbrella");
  if (feelsHi <= 32)      tips.push("🧥 Bundle up — feels freezing");
  else if (feelsHi <= 45) tips.push("🧥 Heavy coat day");
  else if (feelsHi <= 58) tips.push("🧤 Light jacket");
  else if (feelsHi >= 88) tips.push("🥵 Hot one — stay hydrated");
  if (uv >= 8)            tips.push("🕶 High UV — wear sunscreen");
  if (gusts >= 35)        tips.push("💨 Gusty — hold your hat");
  if (rainIn >= 0.5)      tips.push(`🌧 ~${rainIn}" rain expected`);
  return tips;
}

// ─── RAIN WINDOW ───────────────────────────────────────────
// Scans hourly rain probability for tomorrow and returns a
// human-readable window like "Rain likely 1PM–6PM" or null if dry.
// Threshold: 50%+ = "likely", 30%+ = "possible"

function rainWindow(data, dateStr) {
  const times = data.hourly.time;
  const probs = data.hourly.precipitation_probability;

  // Collect all hours for tomorrow with their rain probability
  const dayHours = [];
  for (let h = 0; h <= 23; h++) {
    const target = `${dateStr}T${String(h).padStart(2, "0")}:00`;
    const i = times.indexOf(target);
    if (i !== -1) dayHours.push({ hour: h, prob: probs[i] });
  }

  // Find contiguous blocks above threshold
  function findBlocks(threshold) {
    const blocks = [];
    let start = null;
    for (const { hour, prob } of dayHours) {
      if (prob >= threshold) {
        if (start === null) start = hour;
      } else {
        if (start !== null) {
          blocks.push({ start, end: hour - 1 });
          start = null;
        }
      }
    }
    if (start !== null) blocks.push({ start, end: 23 });
    return blocks;
  }

  function fmt(h) {
    if (h === 0)  return "12AM";
    if (h === 12) return "Noon";
    if (h < 12)   return `${h}AM`;
    return `${h - 12}PM`;
  }

  function blocksToString(blocks, label) {
    return blocks
      .map(({ start, end }) =>
        start === end ? `${fmt(start)}` : `${fmt(start)}–${fmt(end + 1)}`
      )
      .map(w => `☂️ ${label}: ${w}`)
      .join("\n");
  }

  const likelyBlocks   = findBlocks(50);
  const possibleBlocks = findBlocks(30).filter(
    // Exclude hours already covered by "likely"
    pb => !likelyBlocks.some(lb => pb.start >= lb.start && pb.end <= lb.end)
  );

  const lines = [];
  if (likelyBlocks.length)   lines.push(blocksToString(likelyBlocks,   "Rain likely"));
  if (possibleBlocks.length) lines.push(blocksToString(possibleBlocks, "Rain possible"));

  return lines.length > 0 ? lines.join("\n") : null;
}

// Best/worst day score (higher = better weather)
function weatherScore(code) {
  if ([0, 1, 2].includes(code)) return 10;
  if (code === 3)               return 6;
  if (code >= 71 && code <= 77) return 2; // snow
  if (code >= 95)               return 1; // storms
  if (code >= 51)               return 3; // rain
  return 5;
}


// ─── DAILY MESSAGE (Mon–Sat nights) ─────────────────────────

function buildDailyMessage(data) {
  const d   = data.daily;
  const idx = 1; // tomorrow

  const dateStr  = d.time[idx];
  const date     = new Date(dateStr + "T12:00:00");
  const dayName  = date.toLocaleDateString("en-US", { weekday: "long" });
  const dateDisp = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const high    = Math.round(d.temperature_2m_max[idx]);
  const low     = Math.round(d.temperature_2m_min[idx]);
  const feelsHi = Math.round(d.apparent_temperature_max[idx]);
  const feelsLo = Math.round(d.apparent_temperature_min[idx]);
  const rainPct = d.precipitation_probability_max[idx];
  const rainIn  = d.precipitation_sum[idx];
  const wind    = Math.round(d.windspeed_10m_max[idx]);
  const gusts   = Math.round(d.windgusts_10m_max[idx]);
  const uv      = d.uv_index_max[idx];
  const emoji   = weatherEmoji(d.weathercode[idx]);
  const cond    = describeWeatherCode(d.weathercode[idx]);
  const sunrise = d.sunrise[idx].split("T")[1].replace(/:00$/, "");
  const sunset  = d.sunset[idx].split("T")[1].replace(/:00$/, "");

  // Hourly snapshots at 8AM, Noon, 5PM
  const snap8 = hourlySnapshot("8AM",  data, dateStr, 8);
  const snapN = hourlySnapshot("Noon", data, dateStr, 12);
  const snap5 = hourlySnapshot("5PM",  data, dateStr, 17);
  const snaps = [snap8, snapN, snap5].filter(Boolean).join("\n");

  const tips      = smartTips(feelsHi, rainPct, rainIn, uv, gusts);
  const tipLine   = tips.length > 0 ? `\n\n💡 ${tips.join("\n💡 ")}` : "";
  const rainWin   = rainWindow(data, dateStr);
  const rainWinLine = rainWin ? `\n\n${rainWin}` : "";

  return (
`🌆 NYC Tomorrow — ${dayName}, ${dateDisp}
${emoji} ${cond}

🌡 ${high}° high / ${low}° low
🤔 Feels ${feelsHi}° → ${feelsLo}°
🌅 ${sunrise} rise · ${sunset} set

⏱ Key Times
${snaps}

📊 Day Stats
🌧 Rain ${rainPct}% · 💨 ${wind}mph (${gusts} gusts) · ☀️ UV ${uv}${rainWinLine}${tipLine}

Have a great day! 🗽`
  );
}


// ─── WEEKLY MESSAGE (Sunday nights) ─────────────────────────

function buildWeeklyMessage(data) {
  const d = data.daily;

  // Indices 1–7 = Mon through Sun (the week ahead)
  const lines = [];
  let bestIdx = 1, worstIdx = 1;

  for (let i = 1; i <= 7; i++) {
    const dateStr  = d.time[i];
    const date     = new Date(dateStr + "T12:00:00");
    const dayShort = date.toLocaleDateString("en-US", { weekday: "short" });
    const dateFmt  = date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });

    const high    = Math.round(d.temperature_2m_max[i]);
    const low     = Math.round(d.temperature_2m_min[i]);
    const rainPct = d.precipitation_probability_max[i];
    const emoji   = weatherEmoji(d.weathercode[i]);
    const desc    = describeWeatherCode(d.weathercode[i]);

    // Rain warning flag
    const flag = rainPct >= 60 ? " ☂️" : rainPct >= 40 ? " 🌦" : "";

    // Rain window for rainy days (50%+ chance)
    let rainWin = "";
    if (rainPct >= 50) {
      const rw = rainWindow(data, dateStr);
      if (rw) rainWin = `\n   ${rw.replace(/\n/g, "\n   ")}`;
    }

    lines.push(`${dayShort} ${dateFmt}: ${emoji} ${desc}${flag} · ${high}°/${low}° · 💧${rainPct}%${rainWin}`);

    if (weatherScore(d.weathercode[i]) > weatherScore(d.weathercode[bestIdx]))  bestIdx  = i;
    if (weatherScore(d.weathercode[i]) < weatherScore(d.weathercode[worstIdx])) worstIdx = i;
  }

  const bestDay  = new Date(d.time[bestIdx]  + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const worstDay = new Date(d.time[worstIdx] + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const callouts = bestIdx !== worstIdx
    ? `\n🏆 Best day: ${bestDay}\n⚠️  Watch out: ${worstDay}`
    : "";

  return (
`🗓 NYC Week Ahead
Your 7-Day Outlook

${lines.join("\n")}
${callouts}

Nightly texts start tomorrow.
Have a great week! 🗽`
  );
}


// ─── EMAIL TO TEXT SENDER ───────────────────────────────────
// Gmail SMTP -> AT&T gateway (number@txt.att.net) -> arrives as SMS

function sendEmail(toAddress, body) {
  return new Promise((resolve, reject) => {
    const tls = require("tls");
    const CRLF = "
";

    const rawEmail = [
      "From: " + CONFIG.GMAIL_USER,
      "To: " + toAddress,
      "Subject: NYC Weather",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join(CRLF);

    const socket = tls.connect(465, "smtp.gmail.com", { rejectUnauthorized: true }, () => {
      let step = 0;
      let buffer = "";

      const send = (cmd) => socket.write(cmd + CRLF);

      socket.on("data", (data) => {
        buffer += data.toString();
        if (!buffer.endsWith("
")) return;
        const line = buffer.trim();
        buffer = "";

        if      (step === 0 && line.startsWith("220")) { step++; send("EHLO smtp.gmail.com"); }
        else if (step === 1 && line.includes("250 "))  { step++; send("AUTH LOGIN"); }
        else if (step === 2 && line.startsWith("334")) { step++; send(Buffer.from(CONFIG.GMAIL_USER).toString("base64")); }
        else if (step === 3 && line.startsWith("334")) { step++; send(Buffer.from(CONFIG.GMAIL_APP_PASS).toString("base64")); }
        else if (step === 4 && line.startsWith("235")) { step++; send("MAIL FROM:<" + CONFIG.GMAIL_USER + ">"); }
        else if (step === 5 && line.startsWith("250")) { step++; send("RCPT TO:<" + toAddress + ">"); }
        else if (step === 6 && line.startsWith("250")) { step++; send("DATA"); }
        else if (step === 7 && line.startsWith("354")) { step++; send(rawEmail + CRLF + "."); }
        else if (step === 8 && line.startsWith("250")) { send("QUIT"); socket.destroy(); resolve(); }
        else if (line.startsWith("5"))                 { reject(new Error("SMTP error: " + line)); socket.destroy(); }
      });

      socket.on("error", reject);
    });
  });
}




// ─── MAIN ───────────────────────────────────────────────────

async function main() {
  console.log("⛅ Fetching weather for NYC 10065...\n");

  try {
    const data = await fetchWeather();

    // Sunday (day 0) gets the weekly overview; all other nights get tomorrow's daily
    const isSunday = new Date().getDay() === 0;
    const message  = isSunday ? buildWeeklyMessage(data) : buildDailyMessage(data);

    const label = isSunday ? "WEEKLY OVERVIEW (Sunday night)" : "DAILY FORECAST";
    console.log(`─── ${label} ${"─".repeat(Math.max(0, 44 - label.length))}`);
    console.log(message);
    console.log("─".repeat(50) + "\n");

    const allNumbers = [CONFIG.TO_NUMBER, ...CONFIG.EXTRA_NUMBERS].filter(
      (n) => n && n !== "9175551234"
    );

    if (allNumbers.length === 0) {
      console.log("⚠️  No phone numbers configured — preview only.");
      console.log("    Set TO_NUMBER in GitHub Secrets (digits only).\n");
      return;
    }

    for (const number of allNumbers) {
      // Support full email addresses for other carriers, otherwise use AT&T gateway
      const toAddr = number.includes("@") ? number : `${number.replace(/\D/g, "")}@txt.att.net`;
      console.log(`📱 Sending to ${toAddr}...`);
      await sendEmail(toAddr, message);
      console.log("✅ Sent!");
    }

  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

main();
