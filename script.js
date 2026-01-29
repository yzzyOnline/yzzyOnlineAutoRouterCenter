require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- 1. DYNAMIC AI MAP CONFIG ---
const getTierConfig = (lv, defaultVal) => {
    const config = process.env[`TIER_${lv}`] || defaultVal;
    const [provider, model] = config.split(':');
    return { provider, model };
};

const AI_MAP = {
    1:  getTierConfig(1,  'gemini:gemini-3-flash-preview'),
    2:  getTierConfig(2,  'groq:llama-3.1-8b-instant'),
    3:  getTierConfig(3,  'gemini:gemini-3-flash-preview'),
    4:  getTierConfig(4,  'mistral:mistral-small-latest'),
    5:  getTierConfig(5,  'groq:llama-3.3-70b-specdec'),
    6:  getTierConfig(6,  'cerebras:llama-3.3-70b'),
    7:  getTierConfig(7,  'mistral:mistral-large-latest'),
    8:  getTierConfig(8,  'groq:llama-3.3-70b-specdec'),
    9:  getTierConfig(9,  'gemini:gemini-3-pro-preview'),
    10: getTierConfig(10, 'gemini:gemini-3-pro')
};

// --- 2. THE GUARDRAIL (BOUNCE LOGIC) ---
function getSafeTier(lv) {
    let safe = Math.abs(lv); // Handles negative numbers
    if (safe === 0) return 1;
    return Math.min(Math.max(safe, 1), 10); // Clamps between 1 and 10
}

// --- 3. PROVIDER HANDLER ---
async function callAIProvider(lv, prompt) {
    const { provider, model } = AI_MAP[lv];
    let url, data, headers = { "Content-Type": "application/json" };

    const systemPreface = `
[PROTOCOL: JSON-ONLY]
- Task difficulty: Tier ${lv}/10
- If too complex, return: {"state": "too_complex", "package": "climb"}
- Otherwise, return: {"state": "complete", "package": {"clue": "...", "answer": "..."}}
`;

    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = { contents: [{ parts: [{ text: `${systemPreface}\n\nTask: ${prompt}` }] }] };
    } else {
        url = provider === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : "https://api.mistral.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env[`${provider.toUpperCase()}_KEY`]}`;
        data = { model, messages: [{ role: "user", content: `${systemPreface}\n\nTask: ${prompt}` }], response_format: { type: "json_object" } };
    }

    const res = await axios.post(url, data, { headers, timeout: 40000 });
    const raw = provider === 'gemini' ? res.data.candidates[0].content.parts[0].text : res.data.choices[0].message.content;
    return JSON.parse(raw);
}

// --- 4. THE HYBRID CASCADE ENGINE ---
async function executeHybridCascade(initialLevel, userPrompt) {
    let currentLevel = getSafeTier(initialLevel);
    let visited = new Set();

    // Loop until we find a result or exhaust all 10 tiers
    while (visited.size < 10) {
        currentLevel = getSafeTier(currentLevel);

        if (visited.has(currentLevel)) {
            // Memory Bank: We already tried this tier for this prompt
            currentLevel--; 
            continue;
        }
        visited.add(currentLevel);

        try {
            console.log(`[Hybrid] Trying Tier ${currentLevel}...`);
            const result = await callAIProvider(currentLevel, userPrompt);
            
            // COMPLEXITY CLIMB
            if (result.state === "too_complex") {
                console.log(`[Upward] Tier ${currentLevel} failed complexity. Climbing...`);
                currentLevel++;
                continue;
            }
            
            return result.package; // SUCCESS

        } catch (err) {
            // INFRASTRUCTURE FALLBACK
            console.error(`[Downward] Tier ${currentLevel} Network/503 Error. Stepping down...`);
            currentLevel--; 
            
            if (currentLevel < 1 && visited.has(1)) break;
        }
    }
    return null;
}

// --- 5. ENDPOINTS ---
app.get('/wake', (req, res) => res.status(200).send("Hybrid Server Online"));

app.post('/ask-ai', async (req, res) => {
    const { secret, complexity, prompt } = req.body;
    
    if (secret !== process.env.MY_APP_SECRET) return res.status(403).send("Unauthorized");

    const finalResult = await executeHybridCascade(complexity, prompt);
    
    if (finalResult) {
        res.json({ state: "complete", package: { package: finalResult } });
    } else {
        res.status(503).json({ state: "error", content: "All tiers failed" });
    }
});

const server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
server.keepAliveTimeout = 120000;