const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const API_URL = "https://aml-api-eta.vercel.app/levels/ml/page/1/f4386831-1c4a-4617-a072-b2f65c06846e";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// in-memory per-user storage for multi-match lists
const lastMultiMatch = {}; // { userId: { timestamp, matches } }

// ---------- helpers ----------
function normalize(str = "") {
  return String(str).toLowerCase().replace(/[^a-z0-9\.]+/g, " ").trim();
}

function extractVersion(str = "") {
  const m = String(str).match(/v?(\d+(\.\d+)*)/i);
  return m ? m[1] : null;
}

function similarity(a = "", b = "") {
  a = String(a).toLowerCase();
  b = String(b).toLowerCase();
  const lenA = a.length, lenB = b.length;
  if (!lenA && !lenB) return 1;
  if (!lenA || !lenB) return 0;

  const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return 1 - dp[lenA][lenB] / Math.max(lenA, lenB);
}

function generateAcronym(name = "") {
  return String(name)
    .split(/\s+/)
    .filter(w => w)
    .map(w => w[0].toUpperCase())
    .join('');
}

// returns true if every character of query (already uppercased) appears in order in acronym
function matchesAcronymQuery(acronym = "", query = "") {
  if (!query) return false;
  acronym = String(acronym).toUpperCase();
  query = String(query).toUpperCase();
  let i = 0;
  for (const ch of acronym) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return false;
}

// Precompute useful fields for each level object (skip entries without name)
function enrichLevels(rawLevels) {
  return rawLevels
    .filter(l => l && l.name)
    .map(l => {
      const normalizedName = normalize(l.name);
      const normalizedWords = normalizedName.split(" ").filter(Boolean);
      const acronym = generateAcronym(l.name); // full acronym, keep all words
      const version = extractVersion(l.name) || null;
      return {
        original: l,
        name: l.name,
        top: l.top,
        normalizedName,
        normalizedWords,
        acronym,
        version
      };
    });
}

// ---------- matching engine ----------
function findBestMatch(enrichedLevels, rawQuery) {
  const query = String(rawQuery || "");
  const qNormalized = normalize(query);
  const qWords = qNormalized.split(" ").filter(Boolean);
  const queryNoSpacesUpper = query.replace(/\s+/g, "").toUpperCase();
  const inputVersion = extractVersion(query);

  // 1) exact normalized name
  const exact = enrichedLevels.find(l => l.normalizedName === qNormalized);
  if (exact) { exact.exactMatch = true; return exact; }

  // 2) full-acronym / partial-acronym match (query as continuous letters)
  if (queryNoSpacesUpper && /^[A-Z]+$/.test(queryNoSpacesUpper)) {
    // treat as acronym letters; allow matching by "letters in order" across acronym
    const acrMatches = enrichedLevels.filter(l => matchesAcronymQuery(l.acronym, queryNoSpacesUpper));
    if (acrMatches.length === 1) { acrMatches[0].exactMatch = true; return acrMatches[0]; }
    if (acrMatches.length > 1) return null; // ambiguous acronym
  }

  // 3) Mixed query support: tokens may be words or small acronym fragments (e.g., "hp", "rv")
  // We interpret a token as acronym-like if it's only letters and length >= 2
  const mixedMatches = enrichedLevels.filter(level => {
    // all tokens must match either a word in normalizedWords OR be an acronym fragment present in acronym
    return qWords.every(token => {
      if (!token) return true;
      // if token looks like a version (has digits or dots), match version separately
      if (/^\d+(\.\d+)*$/.test(token) || /^v?\d+(\.\d+)*$/i.test(token)) {
        const tver = extractVersion(token);
        return tver && level.version && level.version.startsWith(tver);
      }
      // acronym-like token: only letters, length >=2
      if (/^[a-zA-Z]{2,}$/.test(token)) {
        // match as acronym fragment (letters in order)
        return matchesAcronymQuery(level.acronym, token.toUpperCase()) || level.normalizedWords.includes(token);
      }
      // fallback: normal word match against normalizedWords
      return level.normalizedWords.includes(token);
    });
  });

  if (mixedMatches.length === 1) { mixedMatches[0].exactMatch = false; return mixedMatches[0]; }
  if (mixedMatches.length > 1) {
    // if version provided, try prefer one that matches version
    if (inputVersion) {
      const vm = mixedMatches.find(l => l.version && l.version.startsWith(inputVersion));
      if (vm) { vm.exactMatch = false; return vm; }
    }
    return null; // ambiguous
  }

  // 4) Strict multi-word match: every query word must appear in the level name words (useful for "generator v1.6.5")
  if (qWords.length > 0) {
    const strictMatches = enrichedLevels.filter(level =>
      qWords.every(w => level.normalizedWords.includes(w) || (extractVersion(w) && level.version && level.version.startsWith(extractVersion(w))))
    );
    if (strictMatches.length === 1) { strictMatches[0].exactMatch = false; return strictMatches[0]; }
    if (strictMatches.length > 1) {
      if (inputVersion) {
        const vm = strictMatches.find(l => l.version && l.version.startsWith(inputVersion));
        if (vm) { vm.exactMatch = false; return vm; }
      }
      return null;
    }
  }

  // 5) Fuzzy fallback (last resort)
  let best = null, bestScore = 0;
  for (const level of enrichedLevels) {
    const score = similarity(qNormalized, level.normalizedName);
    if (score > bestScore) { bestScore = score; best = level; }
  }
  if (best && bestScore >= 0.72) { best.exactMatch = false; return best; }

  return null;
}

// ---------- command handler ----------
client.on("messageCreate", async msg => {
  try {
    if (msg.author.bot) return;
    const raw = String(msg.content || "").trim();
    if (!raw.toLowerCase().startsWith("!rank")) return;

    const args = raw.slice("!rank".length).trim();
    // handle number selection: must be pure integer (no text) and user must have stored multi-match
    if (/^\d+$/.test(args) && lastMultiMatch[msg.author.id]) {
      const idx = parseInt(args, 10);
      const stored = lastMultiMatch[msg.author.id];
      // optional expiry: 5 minutes (300000 ms)
      if (Date.now() - stored.timestamp > 300000) {
        delete lastMultiMatch[msg.author.id];
        return msg.reply("Your previous selection expired. Please run `!rank` again.");
      }
      if (idx < 1 || idx > stored.matches.length) {
        return msg.reply(`Invalid selection. Choose a number between 1 and ${stored.matches.length}.`);
      }
      const chosen = stored.matches[idx - 1];
      delete lastMultiMatch[msg.author.id];
      return msg.reply(`You selected: **${chosen.name}** — ranked **#${chosen.top}**`);
    }

    const query = args;
    if (!query) return msg.reply("Tell me a mode name. Example: `!rank Hopeless Pursuit`");

    // fetch levels and enrich
    const response = await axios.get(API_URL);
    const rawLevels = response.data;
    if (!Array.isArray(rawLevels)) {
      console.error("API returned unexpected:", rawLevels);
      return msg.reply("API returned an unexpected result.");
    }
    const enriched = enrichLevels(rawLevels);

    // find best match
    const match = findBestMatch(enriched, query);

    if (!match) {
      // attempt to find strict multi-word collisions to show to user
      const qWords = normalize(query).split(" ").filter(Boolean);
      const collisions = enriched.filter(level =>
        qWords.every(w => level.normalizedWords.includes(w) || (extractVersion(w) && level.version && level.version.startsWith(extractVersion(w))))
      );
      if (collisions.length > 1) {
        // store short-lived selection list
        lastMultiMatch[msg.author.id] = { timestamp: Date.now(), matches: collisions.map(c => ({ name: c.name, top: c.top })) };
        return msg.reply(
          `Multiple modes match your query:\n` +
          collisions.map((c, i) => `${i + 1}. ${c.name}`).join("\n") +
          `\nType \`!rank <number>\` to select the correct mode (list expires in 5 minutes).`
        );
      }
      return msg.reply(`I couldn't find anything close to **${query}**.`);
    }

    // reply with result
    return msg.reply(`${match.exactMatch ? "**" + match.name + "**" : "I assumed you meant: **" + match.name + "**"} — ranked **#${match.top}**`);

  } catch (err) {
    console.error("Handler error:", err);
    return msg.reply("There was an error while contacting the API.");
  }
});

client.login(TOKEN);
