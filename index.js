const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional for fast testing
const API_URL = "https://aml-api-eta.vercel.app/levels/ml/page/1/f4386831-1c4a-4617-a072-b2f65c06846e";

if (!TOKEN || !CLIENT_ID) {
  console.error("You must set DISCORD_TOKEN and CLIENT_ID in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// short-lived per-user store for multi-match lists
const MULTI_MATCH_TTL_MS = 5 * 60 * 1000; // 5 minutes
const lastMultiMatch = {}; // userId -> { timestamp, matches: [{ name, top, id? }] }

// -------------------- Helpers --------------------
function normalize(str = "") {
  return String(str).toLowerCase().replace(/[^a-z0-9\.]+/g, " ").trim();
}

function extractVersion(str = "") {
  const m = String(str).match(/v?(\d+(\.\d+)*)/i);
  return m ? m[1] : null;
}

// Levenshtein similarity (0..1)
function similarity(a = "", b = "") {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  const lenA = a.length, lenB = b.length;
  if (!lenA && !lenB) return 1;
  if (!lenA || !lenB) return 0;
  const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
    }
  }
  return 1 - dp[lenA][lenB] / Math.max(lenA, lenB);
}

// Generate acronym including ALL words (keeps "no", "the", etc.)
function generateAcronym(name = "") {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase())
    .join('');
}

// Returns true if every char of query (already uppercased) appears in order in acronym
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

// Enrich raw API levels for fast repeated checks
function enrichLevels(rawLevels) {
  return rawLevels
    .filter(l => l && l.name)
    .map(l => {
      const normalizedName = normalize(l.name);
      const normalizedWords = normalizedName.split(" ").filter(Boolean);
      const acronym = generateAcronym(l.name);
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

// Matching engine: exact -> acronym -> mixed tokens -> strict multi-word -> fuzzy
function findBestMatch(enrichedLevels, rawQuery) {
  const query = String(rawQuery || "");
  const qNormalized = normalize(query);
  const qWords = qNormalized.split(" ").filter(Boolean);
  const queryNoSpacesUpper = query.replace(/\s+/g, "").toUpperCase();
  const inputVersion = extractVersion(query);

  // 1) exact normalized name
  const exact = enrichedLevels.find(l => l.normalizedName === qNormalized);
  if (exact) { exact.exactMatch = true; return exact; }

  // 2) acronym-ish: user typed continuous letters (e.g., hprvnpg)
  if (/^[A-Z]+$/i.test(queryNoSpacesUpper)) {
    const acrMatches = enrichedLevels.filter(l => matchesAcronymQuery(l.acronym, queryNoSpacesUpper));
    if (acrMatches.length === 1) { acrMatches[0].exactMatch = true; return acrMatches[0]; }
    if (acrMatches.length > 1) return null; // ambiguous
  }

  // 3) Mixed token matching (tokens can be words, versions, or small acronyms like hp, rv)
  const mixedMatches = enrichedLevels.filter(level => {
    return qWords.every(token => {
      if (!token) return true;
      // version token?
      if (/^\d+(\.\d+)*$/.test(token) || /^v?\d+(\.\d+)*$/i.test(token)) {
        const tver = extractVersion(token);
        return tver && level.version && level.version.startsWith(tver);
      }
      // acronym-like token: letters only and length >= 2
      if (/^[a-zA-Z]{2,}$/.test(token)) {
        return matchesAcronymQuery(level.acronym, token.toUpperCase()) || level.normalizedWords.includes(token);
      }
      // fallback word match
      return level.normalizedWords.includes(token);
    });
  });

  if (mixedMatches.length === 1) { mixedMatches[0].exactMatch = false; return mixedMatches[0]; }
  if (mixedMatches.length > 1) {
    if (inputVersion) {
      const vm = mixedMatches.find(l => l.version && l.version.startsWith(inputVersion));
      if (vm) { vm.exactMatch = false; return vm; }
    }
    return null; // ambiguous
  }

  // 4) Strict multi-word match (every token must be present as word or version)
  if (qWords.length > 0) {
    const strictMatches = enrichedLevels.filter(level =>
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

  // 5) Fuzzy fallback
  let best = null, bestScore = 0;
  for (const level of enrichedLevels) {
    const score = similarity(qNormalized, level.normalizedName);
    if (score > bestScore) { bestScore = score; best = level; }
  }
  if (best && bestScore >= 0.72) { best.exactMatch = false; return best; }

  return null;
}

// -------------------- Register slash command --------------------
async function registerSlashCommand() {
  const commands = [
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Get the rank of a mode (or select from a previous list with a number)')
      .addStringOption(opt =>
        opt.setName('query')
          .setDescription('Mode name, acronym, or a number to pick from a previous list')
          .setRequired(true)
      )
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    if (GUILD_ID) {
      console.log(`Registering /rank to guild ${GUILD_ID}...`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Slash command registered (guild).');
    } else {
      console.log('Registering global /rank (may take up to 1 hour)...');
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Slash command registered (global).');
    }
  } catch (err) {
    console.error('Failed registering slash command:', err);
  }
}

// Call registration once at startup
registerSlashCommand().catch(console.error);

// -------------------- Interaction handler --------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'rank') return;

  // Defer reply (ephemeral) to avoid "The application did not respond" when work takes >3s
  await interaction.deferReply({ ephemeral: true });

  const raw = interaction.options.getString('query') || "";
  const trimmed = raw.trim();

  // If user typed just a number and there's a stored list -> treat as selection
  if (/^\d+$/.test(trimmed) && lastMultiMatch[interaction.user.id]) {
    const idx = parseInt(trimmed, 10);
    const stored = lastMultiMatch[interaction.user.id];
    if (Date.now() - stored.timestamp > MULTI_MATCH_TTL_MS) {
      delete lastMultiMatch[interaction.user.id];
      return interaction.editReply("Your previous selection expired — run `/rank <name>` again.");
    }
    if (idx < 1 || idx > stored.matches.length) {
      return interaction.editReply(`Invalid selection. Choose a number between 1 and ${stored.matches.length}.`);
    }
    const chosen = stored.matches[idx - 1];
    delete lastMultiMatch[interaction.user.id];
    return interaction.editReply(`You selected: **${chosen.name}** — ranked **#${chosen.top}**`);
  }

  // Normal query flow
  const query = raw;
  if (!query) return interaction.editReply("Provide a mode name or acronym. Example: `/rank Hopeless Pursuit`");

  try {
    const resp = await axios.get(API_URL);
    const rawLevels = resp.data;
    if (!Array.isArray(rawLevels)) {
      console.error("API returned:", rawLevels);
      return interaction.editReply("API returned an unexpected result.");
    }

    const enriched = enrichLevels(rawLevels);
    const match = findBestMatch(enriched, query);

    if (!match) {
      // show multi-match list if available
      const qWords = normalize(query).split(" ").filter(Boolean);
      const collisions = enriched.filter(level =>
        qWords.every(w => {
          const ver = extractVersion(w);
          if (ver) return level.version && level.version.startsWith(ver);
          return level.normalizedWords.includes(w);
        })
      );

      if (collisions.length > 1) {
        // store small lightweight matches for selection
        lastMultiMatch[interaction.user.id] = {
          timestamp: Date.now(),
          matches: collisions.map(c => ({ name: c.name, top: c.top }))
        };
        const listText = collisions.map((c, i) => `${i+1}. ${c.name}`).join("\n");
        return interaction.editReply(
          `Multiple modes match your query:\n${listText}\n\nType \`/rank <number>\` to select (expires in 5 min).`
        );
      }

      return interaction.editReply(`I couldn't find anything close to **${query}**.`);
    }

    // Found a match
    if (match.exactMatch) {
      return interaction.editReply(`**${match.name}** is ranked **#${match.top}** on the list.`);
    } else {
      return interaction.editReply(`I assumed you meant: **${match.name}** — ranked **#${match.top}**`);
    }

  } catch (err) {
    console.error("Error during /rank:", err);
    return interaction.editReply("There was an error while contacting the API.");
  }
});

// -------------------- Start bot --------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});
client.login(TOKEN);
