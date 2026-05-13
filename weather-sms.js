// weather-sms.js — NYC Daily Weather Text
// Mon-Sat: tomorrow's forecast + 8AM/Noon/5PM snapshots
// Sunday: 7-day weekly outlook
// Sends via Gmail SMTP to AT&T SMS gateway

const https = require("https");
const tls = require("tls");

const CONFIG = {
  GMAIL_USER:     process.env.GMAIL_USER     || "you@gmail.com",
  GMAIL_APP_PASS: process.env.GMAIL_APP_PASS || "your_app_password_here",
  TO_NUMBER:      process.env.TO_NUMBER      || "9175551234",
  EXTRA_NUMBERS:  [],
  LATITUDE:       40.7648,
  LONGITUDE:      -73.9592,
  TIMEZONE:       "America/New_York",
};

function fetchWeather() {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      latitude:           CONFIG.LATITUDE,
      longitude:          CONFIG.LONGITUDE,
      timezone:           CONFIG.TIMEZONE,
      daily:              [
        "temperature_2m_max","temperature_2m_min",
        "apparent_temperature_max","apparent_temperature_min",
        "precipitation_probability_max","precipitation_sum",
        "weathercode","windspeed_10m_max","windgusts_10m_max",
        "sunrise","sunset","uv_index_max",
      ].join(","),
      hourly:             [
        "temperature_2m","apparent_temperature",
        "precipitation_probability","weathercode",
      ].join(","),
      temperature_unit:   "fahrenheit",
      windspeed_unit:     "mph",
      precipitation_unit: "inch",
      forecast_days:      8,
    });
    const url = "https://api.open-meteo.com/v1/forecast?" + params.toString();
    https.get(url, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("Failed to parse weather response")); }
      });
    }).on("error", reject);
  });
}

function describeWeatherCode(code) {
  const map = {
    0:"Clear", 1:"Mostly clear", 2:"Partly cloudy", 3:"Overcast",
    45:"Foggy", 48:"Icy fog", 51:"Lt drizzle", 53:"Drizzle",
    55:"Hvy drizzle", 61:"Lt rain", 63:"Rain", 65:"Hvy rain",
    71:"Lt snow", 73:"Snow", 75:"Hvy snow", 77:"Snow grains",
    80:"Lt showers", 81:"Showers", 82:"Hvy showers",
    85:"Snow showers", 86:"Hvy snow showers",
    95:"Storms", 96:"Storms+hail", 99:"Severe storms",
  };
  return map[code] || "Unknown";
}

function weatherEmoji(code) {
  if (code === 0)                        return "Sunny";
  if (code <= 2)                         return "Mostly Clear";
  if (code === 3)                        return "Overcast";
  if (code <= 48)                        return "Foggy";
  if (code <= 55)                        return "Drizzle";
  if (code <= 67)                        return "Rainy";
  if (code <= 77)                        return "Snowy";
  if (code <= 82)                        return "Showers";
  if (code <= 86)                        return "Heavy Snow";
  return "Stormy";
}

function hourlyIndex(times, dateStr, hour) {
  const h = hour < 10 ? "0" + hour : "" + hour;
  const target = dateStr + "T" + h + ":00";
  return times.indexOf(target);
}

function hourlySnapshot(label, data, dateStr, hour) {
  const i = hourlyIndex(data.hourly.time, dateStr, hour);
  if (i === -1) return null;
  const temp   = Math.round(data.hourly.temperature_2m[i]);
  const feels  = Math.round(data.hourly.apparent_temperature[i]);
  const rain   = data.hourly.precipitation_probability[i];
  const desc   = describeWeatherCode(data.hourly.weathercode[i]);
  const fStr   = Math.abs(temp - feels) >= 4 ? " (feels " + feels + "deg)" : "";
  return label + ": " + desc + " " + temp + "deg" + fStr + " Rain:" + rain + "%";
}

function rainWindow(data, dateStr) {
  const times = data.hourly.time;
  const probs = data.hourly.precipitation_probability;
  const dayHours = [];
  for (let h = 0; h <= 23; h++) {
    const hStr = h < 10 ? "0" + h : "" + h;
    const target = dateStr + "T" + hStr + ":00";
    const i = times.indexOf(target);
    if (i !== -1) dayHours.push({ hour: h, prob: probs[i] });
  }

  function findBlocks(threshold) {
    const blocks = [];
    let start = null;
    for (const item of dayHours) {
      if (item.prob >= threshold) {
        if (start === null) start = item.hour;
      } else {
        if (start !== null) { blocks.push({ start: start, end: item.hour - 1 }); start = null; }
      }
    }
    if (start !== null) blocks.push({ start: start, end: 23 });
    return blocks;
  }

  function fmt(h) {
    if (h === 0) return "12AM";
    if (h === 12) return "Noon";
    if (h < 12) return h + "AM";
    return (h - 12) + "PM";
  }

  const likely   = findBlocks(50);
  const possible = findBlocks(30).filter(
    (pb) => !likely.some((lb) => pb.start >= lb.start && pb.end <= lb.end)
  );

  const lines = [];
  for (const b of likely)   lines.push("Rain likely "   + fmt(b.start) + "-" + fmt(b.end + 1));
  for (const b of possible) lines.push("Rain possible " + fmt(b.start) + "-" + fmt(b.end + 1));
  return lines.length > 0 ? lines.join(", ") : null;
}

function smartTips(feelsHi, rainPct, rainIn, uv, gusts) {
  const tips = [];
  if (rainPct >= 60)      tips.push("Bring an umbrella");
  if (feelsHi <= 32)      tips.push("Bundle up - feels freezing");
  else if (feelsHi <= 45) tips.push("Heavy coat day");
  else if (feelsHi <= 58) tips.push("Light jacket");
  else if (feelsHi >= 88) tips.push("Hot one - stay hydrated");
  if (uv >= 8)            tips.push("High UV - wear sunscreen");
  if (gusts >= 35)        tips.push("Gusty winds - hold your hat");
  if (rainIn >= 0.5)      tips.push("~" + rainIn + "in of rain expected");
  return tips;
}

function weatherScore(code) {
  if (code === 0 || code === 1 || code === 2) return 10;
  if (code === 3)               return 6;
  if (code >= 71 && code <= 77) return 2;
  if (code >= 95)               return 1;
  if (code >= 51)               return 3;
  return 5;
}

function buildDailyMessage(data) {
  const d   = data.daily;
  const idx = 1;
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
  const cond    = describeWeatherCode(d.weathercode[idx]);
  const sunrise = d.sunrise[idx].split("T")[1].replace(/:00$/, "");
  const sunset  = d.sunset[idx].split("T")[1].replace(/:00$/, "");
  const snap8   = hourlySnapshot("8AM",  data, dateStr, 8);
  const snapN   = hourlySnapshot("Noon", data, dateStr, 12);
  const snap5   = hourlySnapshot("5PM",  data, dateStr, 17);
  const snaps   = [snap8, snapN, snap5].filter(Boolean).join("\n");
  const tips    = smartTips(feelsHi, rainPct, rainIn, uv, gusts);
  const tipLine = tips.length > 0 ? "\nTips: " + tips.join(", ") : "";
  const rw      = rainWindow(data, dateStr);
  const rwLine  = rw ? "\n" + rw : "";

  return "NYC Tomorrow - " + dayName + ", " + dateDisp + "\n" +
    cond + "\n\n" +
    "High: " + high + "deg / Low: " + low + "deg\n" +
    "Feels: " + feelsHi + "deg -> " + feelsLo + "deg\n" +
    "Sunrise: " + sunrise + " / Sunset: " + sunset + "\n\n" +
    "--- Key Times ---\n" + snaps + "\n\n" +
    "--- Day Stats ---\n" +
    "Rain: " + rainPct + "% | Wind: " + wind + "mph (gusts " + gusts + ") | UV: " + uv +
    rwLine + tipLine + "\n\nHave a great day!";
}

function buildWeeklyMessage(data) {
  const d = data.daily;
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
    const desc    = describeWeatherCode(d.weathercode[i]);
    const flag    = rainPct >= 60 ? " [umbrella]" : rainPct >= 40 ? " [possible rain]" : "";
    let rainWin   = "";
    if (rainPct >= 50) {
      const rw = rainWindow(data, dateStr);
      if (rw) rainWin = " (" + rw + ")";
    }
    lines.push(dayShort + " " + dateFmt + ": " + desc + flag + " " + high + "/" + low + "deg Rain:" + rainPct + "%" + rainWin);
    if (weatherScore(d.weathercode[i]) > weatherScore(d.weathercode[bestIdx]))  bestIdx  = i;
    if (weatherScore(d.weathercode[i]) < weatherScore(d.weathercode[worstIdx])) worstIdx = i;
  }

  const bestDay  = new Date(d.time[bestIdx]  + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const worstDay = new Date(d.time[worstIdx] + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const callouts = bestIdx !== worstIdx ? "\nBest day: " + bestDay + "\nWatch out: " + worstDay : "";

  return "NYC Week Ahead - 7-Day Outlook\n\n" + lines.join("\n") + callouts + "\n\nHave a great week!";
}

function sendEmail(toAddress, body) {
  return new Promise((resolve, reject) => {
    const CR = "\r";
    const LF = "\n";
    const CRLF = CR + LF;

    const lines = [
      "From: " + CONFIG.GMAIL_USER,
      "To: " + toAddress,
      "Subject: NYC Weather",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ];
    const rawEmail = lines.join(CRLF);

    const socket = tls.connect(465, "smtp.gmail.com", { rejectUnauthorized: true }, () => {
      let step = 0;
      let buffer = "";

      const send = function(cmd) { socket.write(cmd + CRLF); };

      socket.on("data", function(data) {
        buffer += data.toString();
        if (!buffer.endsWith(LF)) return;
        const line = buffer.trim();
        buffer = "";

        if      (step === 0 && line.startsWith("220")) { step++; send("EHLO smtp.gmail.com"); }
        else if (step === 1 && line.indexOf("250 ") !== -1) { step++; send("AUTH LOGIN"); }
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

async function main() {
  console.log("Fetching weather for NYC 10065...");
  try {
    const data     = await fetchWeather();
    const isSunday = new Date().getDay() === 0;
    const message  = isSunday ? buildWeeklyMessage(data) : buildDailyMessage(data);

    console.log("--- Message Preview ---");
    console.log(message);
    console.log("----------------------");

    const allNumbers = [CONFIG.TO_NUMBER].concat(CONFIG.EXTRA_NUMBERS).filter(
      function(n) { return n && n !== "9175551234"; }
    );

    if (allNumbers.length === 0) {
      console.log("No phone numbers configured - preview only.");
      return;
    }

    for (const number of allNumbers) {
      const toAddr = number.indexOf("@") !== -1 ? number : number.replace(/\D/g, "") + "@txt.att.net";
      console.log("Sending to " + toAddr + "...");
      await sendEmail(toAddr, message);
      console.log("Sent!");
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
