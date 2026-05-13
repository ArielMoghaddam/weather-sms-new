const https = require("https");
const { execSync } = require("child_process");

// Install nodemailer if not present
try { require.resolve("nodemailer"); } 
catch(e) { execSync("npm install nodemailer", { stdio: "inherit" }); }

const nodemailer = require("nodemailer");

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
  return new Promise(function(resolve, reject) {
    var params = new URLSearchParams({
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
    var url = "https://api.open-meteo.com/v1/forecast?" + params.toString();
    https.get(url, function(res) {
      var raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error("Failed to parse weather response")); }
      });
    }).on("error", reject);
  });
}

function describeWeatherCode(code) {
  var map = {
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

function hourlyIndex(times, dateStr, hour) {
  var h = hour < 10 ? "0" + hour : "" + hour;
  return times.indexOf(dateStr + "T" + h + ":00");
}

function hourlySnapshot(label, data, dateStr, hour) {
  var i = hourlyIndex(data.hourly.time, dateStr, hour);
  if (i === -1) return null;
  var temp  = Math.round(data.hourly.temperature_2m[i]);
  var feels = Math.round(data.hourly.apparent_temperature[i]);
  var rain  = data.hourly.precipitation_probability[i];
  var desc  = describeWeatherCode(data.hourly.weathercode[i]);
  var fStr  = Math.abs(temp - feels) >= 4 ? " (feels " + feels + "F)" : "";
  return label + ": " + desc + " " + temp + "F" + fStr + " Rain:" + rain + "%";
}

function rainWindow(data, dateStr) {
  var times = data.hourly.time;
  var probs = data.hourly.precipitation_probability;
  var dayHours = [];
  for (var h = 0; h <= 23; h++) {
    var hStr = h < 10 ? "0" + h : "" + h;
    var i = times.indexOf(dateStr + "T" + hStr + ":00");
    if (i !== -1) dayHours.push({ hour: h, prob: probs[i] });
  }
  function findBlocks(threshold) {
    var blocks = [], start = null;
    for (var j = 0; j < dayHours.length; j++) {
      var item = dayHours[j];
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
  var likely = findBlocks(50);
  var possible = findBlocks(30).filter(function(pb) {
    return !likely.some(function(lb) { return pb.start >= lb.start && pb.end <= lb.end; });
  });
  var lines = [];
  likely.forEach(function(b)   { lines.push("Rain likely "   + fmt(b.start) + "-" + fmt(b.end + 1)); });
  possible.forEach(function(b) { lines.push("Rain possible " + fmt(b.start) + "-" + fmt(b.end + 1)); });
  return lines.length > 0 ? lines.join(", ") : null;
}

function smartTips(feelsHi, rainPct, rainIn, uv, gusts) {
  var tips = [];
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
  var d       = data.daily;
  var idx     = 1;
  var dateStr  = d.time[idx];
  var date     = new Date(dateStr + "T12:00:00");
  var dayName  = date.toLocaleDateString("en-US", { weekday: "long" });
  var dateDisp = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  var high    = Math.round(d.temperature_2m_max[idx]);
  var low     = Math.round(d.temperature_2m_min[idx]);
  var feelsHi = Math.round(d.apparent_temperature_max[idx]);
  var feelsLo = Math.round(d.apparent_temperature_min[idx]);
  var rainPct = d.precipitation_probability_max[idx];
  var rainIn  = d.precipitation_sum[idx];
  var wind    = Math.round(d.windspeed_10m_max[idx]);
  var gusts   = Math.round(d.windgusts_10m_max[idx]);
  var uv      = d.uv_index_max[idx];
  var cond    = describeWeatherCode(d.weathercode[idx]);
  var sunrise = d.sunrise[idx].split("T")[1].replace(/:00$/, "");
  var sunset  = d.sunset[idx].split("T")[1].replace(/:00$/, "");
  var snap8   = hourlySnapshot("8AM",  data, dateStr, 8);
  var snapN   = hourlySnapshot("Noon", data, dateStr, 12);
  var snap5   = hourlySnapshot("5PM",  data, dateStr, 17);
  var snaps   = [snap8, snapN, snap5].filter(Boolean).join("\n");
  var tips    = smartTips(feelsHi, rainPct, rainIn, uv, gusts);
  var tipLine = tips.length > 0 ? "\nTips: " + tips.join(", ") : "";
  var rw      = rainWindow(data, dateStr);
  var rwLine  = rw ? "\n" + rw : "";
  return "NYC Tomorrow - " + dayName + ", " + dateDisp + "\n" +
    cond + "\n\n" +
    "High: " + high + "F / Low: " + low + "F\n" +
    "Feels: " + feelsHi + "F -> " + feelsLo + "F\n" +
    "Sunrise: " + sunrise + " / Sunset: " + sunset + "\n\n" +
    "--- Key Times ---\n" + snaps + "\n\n" +
    "--- Day Stats ---\n" +
    "Rain: " + rainPct + "% | Wind: " + wind + "mph (gusts " + gusts + ") | UV: " + uv +
    rwLine + tipLine + "\n\nHave a great day!";
}

function buildWeeklyMessage(data) {
  var d = data.daily;
  var lines = [];
  var bestIdx = 1, worstIdx = 1;
  for (var i = 1; i <= 7; i++) {
    var dateStr  = d.time[i];
    var date     = new Date(dateStr + "T12:00:00");
    var dayShort = date.toLocaleDateString("en-US", { weekday: "short" });
    var dateFmt  = date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
    var high    = Math.round(d.temperature_2m_max[i]);
    var low     = Math.round(d.temperature_2m_min[i]);
    var rainPct = d.precipitation_probability_max[i];
    var desc    = describeWeatherCode(d.weathercode[i]);
    var flag    = rainPct >= 60 ? " [umbrella]" : rainPct >= 40 ? " [possible rain]" : "";
    var rainWin = "";
    if (rainPct >= 50) {
      var rw = rainWindow(data, dateStr);
      if (rw) rainWin = " (" + rw + ")";
    }
    lines.push(dayShort + " " + dateFmt + ": " + desc + flag + " " + high + "/" + low + "F Rain:" + rainPct + "%" + rainWin);
    if (weatherScore(d.weathercode[i]) > weatherScore(d.weathercode[bestIdx]))  bestIdx  = i;
    if (weatherScore(d.weathercode[i]) < weatherScore(d.weathercode[worstIdx])) worstIdx = i;
  }
  var bestDay  = new Date(d.time[bestIdx]  + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  var worstDay = new Date(d.time[worstIdx] + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  var callouts = bestIdx !== worstIdx ? "\nBest day: " + bestDay + "\nWatch out: " + worstDay : "";
  return "NYC Week Ahead - 7-Day Outlook\n\n" + lines.join("\n") + callouts + "\n\nHave a great week!";
}

async function main() {
  console.log("Fetching weather for NYC 10065...");
  try {
    var data     = await fetchWeather();
    var isSunday = new Date().getDay() === 0;
    var message  = isSunday ? buildWeeklyMessage(data) : buildDailyMessage(data);

    console.log("--- Message Preview ---");
    console.log(message);
    console.log("----------------------");

    var allNumbers = [CONFIG.TO_NUMBER].concat(CONFIG.EXTRA_NUMBERS).filter(function(n) {
      return n && n !== "9175551234";
    });

    if (allNumbers.length === 0) {
      console.log("No phone numbers configured - preview only. Set TO_NUMBER in GitHub Secrets.");
      return;
    }

    var transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: CONFIG.GMAIL_USER,
        pass: CONFIG.GMAIL_APP_PASS,
      },
    });

    for (var k = 0; k < allNumbers.length; k++) {
      var number = allNumbers[k];
      var toAddr = number.indexOf("@") !== -1 ? number : number.replace(/\D/g, "") + "@txt.att.net";
      console.log("Sending to " + toAddr + "...");
      await transporter.sendMail({
        from: CONFIG.GMAIL_USER,
        to:   toAddr,
        subject: "NYC Weather",
        text: message,
      });
      console.log("Sent!");
    }
  } catch(err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
