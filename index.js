const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

// -------------------------------
// BOT & API
// -------------------------------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_URL = "https://aml-api-eta.vercel.app/levels/ml/page/1/f4386831-1c4a-4617-a072-b2f65c06846e";

// -------------------------------
// Create Discord client
// -------------------------------
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// -------------------------------
// In-memory store for multi-match selection
// -------------------------------
const lastMultiMatch = {}; // key: userId

// -------------------------------
// HELPER: Normalize string
// -------------------------------
function normalize(str = "") {
    return str.toLowerCase().replace(/[^a-z0-9\.]+/g, " ").trim();
}

// -------------------------------
// HELPER: Extract version number
// -------------------------------
function extractVersion(str = "") {
    const match = str.match(/v?(\d+(\.\d+)*)/i);
    return match ? match[1] : null;
}

// -------------------------------
// HELPER: Levenshtein similarity
// -------------------------------
function similarity(a = "", b = "") {
    a = a.toLowerCase(); b = b.toLowerCase();
    const lenA = a.length, lenB = b.length;
    if (lenA === 0 && lenB === 0) return 1;
    if (lenA === 0 || lenB === 0) return 0;
    const dp = Array.from({ length: lenA + 1 }, () => Array(lenB + 1).fill(0));
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

// -------------------------------
// HELPER: Generate acronym
// -------------------------------
function generateAcronym(name = "") {
    return name.split(/\s+/).filter(Boolean).map(word => word[0].toUpperCase()).join('');
}

// -------------------------------
// HELPER: Find best match
// -------------------------------
function findBestMatch(levels, query) {
    const q = normalize(query);
    const qWords = q.split(" ");

    // Exact match
    let exact = levels.find(l => l.name && normalize(l.name) === q);
    if (exact) { exact.exactMatch = true; return exact; }

    // Acronym match
    const acronymMap = {};
    levels.forEach(l => {
        if (!l.name) return;
        const acr = generateAcronym(l.name);
        if (!acronymMap[acr]) acronymMap[acr] = [];
        acronymMap[acr].push(l);
    });
    const upperQuery = query.replace(/\s+/g, '').toUpperCase();
    if (acronymMap[upperQuery]) {
        if (acronymMap[upperQuery].length === 1) {
            const level = acronymMap[upperQuery][0];
            level.exactMatch = true;
            return level;
        } else {
            return null; // ambiguous acronym
        }
    }

    // Multi-word match
    let multiWordMatches = levels.filter(l => {
        if (!l.name) return false;
        const words = normalize(l.name).split(" ");
        return qWords.every(w => words.includes(w));
    });

    // Version-aware disambiguation
    const inputVersion = extractVersion(q);
    if (inputVersion && multiWordMatches.length > 1) {
        const versionMatch = multiWordMatches.find(l => {
            const lv = extractVersion(l.name);
            return lv && lv.startsWith(inputVersion);
        });
        if (versionMatch) { versionMatch.exactMatch = false; return versionMatch; }
    }

    if (multiWordMatches.length === 1) {
        multiWordMatches[0].exactMatch = false;
        return multiWordMatches[0];
    } else if (multiWordMatches.length > 1) {
        return null;
    }

    // Fuzzy match
    let bestScore = 0, bestMatch = null;
    levels.forEach(l => {
        if (!l.name) return;
        const score = similarity(q, normalize(l.name));
        if (score > bestScore) { bestScore = score; bestMatch = l; }
    });
    if (bestScore >= 0.7) {
        bestMatch.exactMatch = false;
        return bestMatch;
    }

    return null;
}

// -------------------------------
// Register slash command
// -------------------------------
const commands = [
    new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Get the rank of a mode')
        .addStringOption(option =>
            option.setName('mode')
                  .setDescription('Mode name or acronym')
                  .setRequired(true)
        )
        .toJSON()
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log('Slash command /rank registered.');
    } catch (err) {
        console.error(err);
    }
})();

// -------------------------------
// Slash command handler
// -------------------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'rank') return;

    // 🔥 MUST be first, no async or function calls before
    try {
        await interaction.deferReply({ flags: 64 });
    } catch (err) {
        console.error("Failed to defer:", err);
        return;
    }

    try {
        // Add a timeout so axios doesn't hang for 5s+
        const response = await axios.get(API_URL, { timeout: 2000 });
        const levels = response.data;

        if (!Array.isArray(levels))
            throw new Error('Invalid API response');

        const bestMatch = findBestMatch(levels, interaction.options.getString('mode'));

        if (!bestMatch) {
            return interaction.editReply("No results.");
        }

        return interaction.editReply(
            `**${bestMatch.name}** is ranked **#${bestMatch.top}**.`
        );

    } catch (err) {
        console.error("Handler error:", err);

        // Ensure safe fallback
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply("API timeout or error.");
        } else {
            return interaction.reply({ content: "Could not reply.", flags: 64 });
        }
    }
});

// -------------------------------
// Start bot
// -------------------------------
client.login(TOKEN);


