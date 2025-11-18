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

// per-user short-lived store for multi-match lists
const lastMultiMatch = {}; // { userId: { timestamp, matches: [ { name, top, id? } ] } }
const MULTI_MATCH_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

// create acronym by taking first letter of every word (keep 'no')
function generateAcronym(name = "") {
  return String(name)
    .split(/\s+/)
    .filter(w => w)
    .map(w => w[0].toUpperCase())
    .join('');
}

// returns true if every character of "query" appears in order inside "acronym"
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

// convert raw API list into enriched items that are cheap to check repeatedly
function enrichLevels(rawLevels) {
  return rawLevels
    .filter(l => l && l.name) // skip malformed entries
    .map(l => {
      const normalizedName = normalize(l.name);
      const normalizedWords = normalizedName.split(" ").filter(Boolean);
      const acronym = generateAcronym(l.name); // full acronym
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
function findBestMatch(enriched, rawQuery) {
  const query = String(rawQuery || "");
  const qNormalized = normalize(query);
  const qWords = qNormalized.split(" ").filter(Boolean);
  const queryNoSpacesUpper = query.replace(/\s+/g, "").toUpperCase();
  const inputVersion = extractVersion(query);

  // 1) exact normalized name
  const exact = enriched.find(l => l.normalizedName === qNormalized);
  if (exact) { exact.exactMatch = true; return exact; }

  // 2) If the user typed only letters (no spaces) treat as acronym-ish query
  if (/^[A-Z]+$/i.test(queryNoSpacesUpper)) {
    const acrMatches = enriched.filter(l => matchesAcronymQuery(l.acronym, queryNoSpacesUpper));
    if (acrMatches.length === 1) { acrMatches[0].exactMatch = true; return acrMatches[0]; }
    if (acrMatches.length > 1) return null; // ambiguous acronym
  }

  // 3) Mixed token matching - tokens can be words, versions, or small acronyms
  const mixedMatches = enriched.filter(level => {
    return qWords.every(token => {
      if (!token) return true;
      // version-like token?
      if (/^\d+(\.\d+)*$/.test(token) || /^v?\d+(\.\d+)*$/i.test(token)) {
        const tver = extractVersion(token);
        return tver && level.version && level.version.startsWith(tver);
      }
      // acronym-like token: letters only and length >= 2 (e.g., hp, rv, hprvnpg)
      if (/^[a-zA-Z]{2,}$/.test(token)) {
        // accept if token appears as letters-in-order in the level acronym OR token is a normal word in the name
        return matchesAcronymQuery(level.acronym, token.toUpperCase()) || level.normalizedWords.includes(token);
      }
      // fallback: plain word match
      return level.normalizedWords.includes(token);
    });
  });

  if (mixedMatches.length === 1) { mixedMatches[0].exactMatch = false; return mixedMatches[0]; }
  if (mixedMatches.length > 1) {
    // try to disambiguate by version if present
    if (inputVersion) {
      const vm = mixedMatches.find(l => l.version && l.version.startsWith(inputVersion));
      if (vm) { vm.exactMatch = false; return vm; }
    }
    return null;
  }

  // 4) Strict multi-word match (every query word must be present, useful for "generator v1.6.5")
  if (qWords.length > 0) {
    const strictMatches = enriched.filter(level =>
      qWords.every(w => {
        const ver = extractVersion(w);
        if (ver) return level.version && level.version.startsWith(ver);
        return level.normalizedWords.includes(w);
      })
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
  for (const level of enriched) {
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

    // 1) If args is a plain integer and user has a stored multi-match -> select it
    if (/^\d+$/.test(args) && lastMultiMatch[msg.author.id]) {
      const idx = parseInt(args, 10);
      const stored = lastMultiMatch[msg.author.id];
      // expiry
      if (Date.now() - stored.timestamp > MULTI_MATCH_TTL_MS) {
        delete lastMultiMatch[msg.author.id];
        return msg.reply("Your previous selection expired — please run `!rank` again.");
      }
      if (idx < 1 || idx > stored.matches.length) {
        return msg.reply(`Invalid selection. Choose a number between 1 and ${stored.matches.length}.`);
      }
      const chosen = stored.matches[idx - 1];
      delete lastMultiMatch[msg.author.id];
      return msg.reply(`You selected: **${chosen.name}** — ranked **#${chosen.top}**`);
    }

    // normal query
    const query = args;
    if (!query) return msg.reply("Tell me a mode name. Example: `!rank Hopeless Pursuit`");

    // fetch and enrich
    const response = await axios.get(API_URL);
    const rawLevels = response.data;
    if (!Array.isArray(rawLevels)) {
      console.error("API returned unexpected:", rawLevels);
      return msg.reply("API returned an unexpected result.");
    }
    const enriched = enrichLevels(rawLevels);

    // match
    const match = findBestMatch(enriched, query);

    if (!match) {
      // find strict collisions to show list
      const qWords = normalize(query).split(" ").filter(Boolean);
      const collisions = enriched.filter(level =>
        qWords.every(w => {
          const ver = extractVersion(w);
          if (ver) return level.version && level.version.startsWith(ver);
          return level.normalizedWords.includes(w);
        })
      );
      if (collisions.length > 1) {
        // store for selection (only store the small info array to avoid heavy objects)
        lastMultiMatch[msg.author.id] = { timestamp: Date.now(), matches: collisions.map(c => ({ name: c.name, top: c.top })) };
        return msg.reply(
          `Multiple modes match your query:\n` +
          collisions.map((c, i) => `${i + 1}. ${c.name}`).join("\n") +
          `\nType \`!rank <number>\` to select the correct mode (list expires in 5 minutes).`
        );
      }
      return msg.reply(`I couldn't find anything close to **${query}**.`);
    }

    // reply
    if (match.exactMatch) {
      return msg.reply(`**${match.name}** is ranked **#${match.top}** on the list.`);
    } else {
      return msg.reply(`I assumed you meant: **${match.name}** — ranked **#${match.top}**`);
    }

  } catch (err) {
    console.error("Handler error:", err);
    return msg.reply("There was an error while contacting the API.");
  }
});

// ---------- start ----------
client.login(TOKEN);
