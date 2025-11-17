const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");

// -------------------------------
// BOT TOKEN — PUT YOUR TOKEN HERE
// -------------------------------
const TOKEN = "censored";

// -------------------------------
// API URL — THIS PAGE RETURNS A LIST OF LEVELS
// -------------------------------
const API_URL = "https://aml-api-eta.vercel.app/levels/ml/page/1/f4386831-1c4a-4617-a072-b2f65c06846e";


// Create Discord client with required intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});


// ------------------------------------------------------
// HELPER: Levenshtein similarity (0 to 1)
// ------------------------------------------------------
function similarity(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();

    const lenA = a.length;
    const lenB = b.length;

    if (lenA === 0 && lenB === 0) return 1;
    if (lenA === 0 || lenB === 0) return 0;

    const dp = Array.from({ length: lenA + 1 }, () =>
        new Array(lenB + 1).fill(0)
    );

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

    const distance = dp[lenA][lenB];
    const maxLen = Math.max(lenA, lenB);
    return 1 - distance / maxLen;
}


// ------------------------------------------------------
// HELPER: Find best match (exact → substring → fuzzy)
// ------------------------------------------------------
function findBestMatch(levels, query) {
    const q = query.toLowerCase();

    // 1) Exact match
    let exact = levels.find(
        (level) => level.name && level.name.toLowerCase() === q
    );
    if (exact) {
        exact.exactMatch = true;
        return exact;
    }

    // 2) Substring match (autofill)
    const substringCandidates = levels.filter(
        (level) =>
            level.name && level.name.toLowerCase().includes(q)
    );

    if (substringCandidates.length > 0) {
        let best = substringCandidates[0];
        let bestExtra = best.name.length - q.length;

        for (const level of substringCandidates) {
            const extra = level.name.length - q.length;
            if (extra >= 0 && extra < bestExtra) {
                best = level;
                bestExtra = extra;
            }
        }

        best.exactMatch = false;
        return best;
    }

    // 3) Fuzzy match (typos)
    let bestMatch = null;
    let bestScore = 0;

    for (const level of levels) {
        if (!level.name) continue;
        const score = similarity(q, level.name);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = level;
        }
    }

    const THRESHOLD = 0.4;
    if (!bestMatch || bestScore < THRESHOLD) return null;

    bestMatch.exactMatch = false;
    return bestMatch;
}


// ------------------------------------------------------
// COMMAND HANDLING: !rank <name>
// ------------------------------------------------------
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

        const bestMatch = findBestMatch(levels, query);

        if (!bestMatch) {
            return msg.reply(`I couldn't find anything close to **${query}**.`);
        }

        // PERFECT MATCH → clean reply
        if (bestMatch.exactMatch === true) {
            return msg.reply(
                `**${bestMatch.name}** is ranked **#${bestMatch.top}** on the list.`
            );
        }

        // PARTIAL OR FUZZY MATCH → suggestion
        return msg.reply(
            `I assumed you meant: **${bestMatch.name}**\n` +
            `It is ranked **#${bestMatch.top}** on the list.`
        );

    } catch (error) {
        console.error(error);
        msg.reply("There was an error while contacting the API.");
    }
});


// Start the bot
client.login(TOKEN);
