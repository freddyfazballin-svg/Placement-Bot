const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");
require('dotenv').config();

// -------------------------------
// BOT TOKEN
// -------------------------------
const TOKEN = process.env.DISCORD_TOKEN;

// -------------------------------
// API URL — RETURNS LIST OF LEVELS
// -------------------------------
const API_URL = "https://aml-api-eta.vercel.app/levels/ml/page/1/f4386831-1c4a-4617-a072-b2f65c06846e";

// -------------------------------
// Create Discord client
// -------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

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
    a = a.toLowerCase();
    b = b.toLowerCase();

    const lenA = a.length;
    const lenB = b.length;
    if (lenA === 0 && lenB === 0) return 1;
    if (lenA === 0 || lenB === 0) return 0;

    const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
    for (let i = 0; i <= lenA; i++) dp[i][0] = i;
    for (let j = 0; j <= lenB; j++) dp[0][j] = j;

    for (let i = 1; i <= lenA; i++) {
        for (let j = 1; j <= lenB; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }

    return 1 - dp[lenA][lenB] / Math.max(lenA, lenB);
}

// -------------------------------
// HELPER: Generate acronym
// -------------------------------
function generateAcronym(name = "") {
    return name
        .split(/\s+/)
        .filter(word => word && !["a","the","of","no","on","in"].includes(word.toLowerCase()))
        .map(word => word[0].toUpperCase())
        .join('');
}

// -------------------------------
// HELPER: Find best match
// -------------------------------
function findBestMatch(levels, query) {
    const q = normalize(query);
    const qWords = q.split(" ");

    // 1) Exact match
    let exact = levels.find(level => level.name && normalize(level.name) === q);
    if (exact) {
        exact.exactMatch = true;
        return exact;
    }

    // 2) Acronym match
    const acronymMap = {};
    levels.forEach(level => {
    if (!level.name) return; // skip missing names
    const acr = generateAcronym(level.name); // safe now
    if (!acronymMap[acr]) acronymMap[acr] = [];
    acronymMap[acr].push(level);
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

    // 3) Multi-word match
    const multiWordMatches = levels.filter(level => {
        if (!level.name) return false;
        const modeWords = normalize(level.name).split(" ");
        return qWords.every(word => modeWords.includes(word));
    });

    if (multiWordMatches.length === 1) {
        multiWordMatches[0].exactMatch = false;
        return multiWordMatches[0];
    } else if (multiWordMatches.length > 1) {
        const inputVersion = extractVersion(q);
        if (inputVersion) {
            const versionMatch = multiWordMatches.find(level => {
                const levelVersion = extractVersion(level.name);
                return levelVersion && levelVersion.startsWith(inputVersion);
            });
            if (versionMatch) {
                versionMatch.exactMatch = false;
                return versionMatch;
            }
        }
        return null; // multiple matches, ask user
    }

    // 4) Fuzzy match
    let bestScore = 0;
    let bestMatch = null;
    for (const level of levels) {
        if (!level.name) continue;
        const score = similarity(q, normalize(level.name));
        if (score > bestScore) {
            bestScore = score;
            bestMatch = level;
        }
    }
    if (bestScore >= 0.7) {
        bestMatch.exactMatch = false;
        return bestMatch;
    }

    return null;
}

// -------------------------------
// COMMAND HANDLER: !rank <name>
// -------------------------------
client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content.toLowerCase().startsWith("!rank")) return;

    const query = msg.content.slice("!rank".length).trim();
    if (!query) {
        return msg.reply("Tell me a mode name. Example: `!rank Hopeless Pursuit`");
    }

    try {
        const response = await axios.get(API_URL);
        const levels = response.data;

        if (!Array.isArray(levels)) {
            console.error("API returned:", levels);
            return msg.reply("API returned an unexpected result.");
        }

        let bestMatch = findBestMatch(levels, query);

        if (!bestMatch) {
            // check multi-word collision
            const qWords = normalize(query).split(" ");
            const multiWordMatches = levels.filter(level => {
                if (!level.name) return false;
                const modeWords = normalize(level.name).split(" ");
                return qWords.every(word => modeWords.includes(word));
            });

            if (multiWordMatches.length > 1) {
                return msg.reply(
                    `Multiple modes match your query:\n` +
                    multiWordMatches.map((l, i) => `${i+1}. ${l.name}`).join("\n") +
                    `\nPlease specify which one you mean.`
                );
            }

            return msg.reply(`I couldn't find anything close to **${query}**.`);
        }

        if (bestMatch.exactMatch) {
            return msg.reply(`**${bestMatch.name}** is ranked **#${bestMatch.top}** on the list.`);
        } else {
            return msg.reply(`I assumed you meant: **${bestMatch.name}**\nIt is ranked **#${bestMatch.top}** on the list.`);
        }

    } catch (error) {
        console.error(error);
        msg.reply("There was an error while contacting the API.");
    }
});

// -------------------------------
// Start bot
// -------------------------------
client.login(TOKEN);

