require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- 1. DYNAMIC AI MAP ---
const getTierConfig = (lv, defaultVal) => {
    const config = process.env[`TIER_${lv}`] || defaultVal;
    const [provider, model] = config.split(':');
    return { provider, model };
};

const AI_MAP = {
    1:  getTierConfig(1,  'gemini:gemini-1.5-flash'),
    2:  getTierConfig(2,  'groq:llama-3.1-8b-instant'),
    3:  getTierConfig(3,  'gemini:gemini-1.5-flash'),
    4:  getTierConfig(4,  'mistral:mistral-small-latest'),
    5:  getTierConfig(5,  'groq:llama-3.3-70b-specdec'),
    6:  getTierConfig(6,  'cerebras:llama-3.3-70b'),
    7:  getTierConfig(7,  'mistral:mistral-large-latest'),
    8:  getTierConfig(8,  'groq:llama-3.3-70b-specdec'),
    9:  getTierConfig(9,  'gemini:gemini-1.5-pro'),
    10: getTierConfig(10, 'gemini:gemini-1.5-pro')
};

// --- 2. UTILS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getSafeTier(lv) {
    let safe = Math.abs(lv);
    if (safe === 0) return 1;
    return Math.min(Math.max(safe, 1), 10);
}

// --- 3. PROVIDER CALL ---
async function callAIProvider(lv, prompt) {
    const { provider, model } = AI_MAP[lv];
    let url, data, headers = { "Content-Type": "application/json" };

const systemPreface = `
[PROTOCOL: JSON-ONLY]
- You are Tier ${lv}/10 Intelligence.
- If the task is too complex, return exactly: {"state": "too_complex", "package": "climb"}
- Otherwise, return your response in this JSON format: {"state": "complete", "package": <AS_REQUESTED_IN_PROMPT>}
- Respond ONLY with the raw JSON.
`;

    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = { contents: [{ parts: [{ text: `${systemPreface}\n\nTask: ${prompt}` }] }] };
    } else {
        url = provider === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" : 
              provider === 'mistral' ? "https://api.mistral.ai/v1/chat/completions" :
              "https://api.cerebras.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env[`${provider.toUpperCase()}_KEY`]}`;
        data = { 
            model, 
            messages: [{ role: "user", content: `${systemPreface}\n\nTask: ${prompt}` }],
            response_format: { type: "json_object" } 
        };
    }

    const res = await axios.post(url, data, { headers, timeout: 45000 });
    const raw = provider === 'gemini' ? res.data.candidates[0].content.parts[0].text : res.data.choices[0].message.content;
    return JSON.parse(raw);
}

// --- 4. FULL SWEEP CASCADE ENGINE ---
async function executeFullSweep(initialLevel, userPrompt) {
    let currentLevel = getSafeTier(initialLevel);
    let visited = new Set();

    while (visited.size < 10) {
        currentLevel = getSafeTier(currentLevel);

        // If current is visited, find the next available tier
        if (visited.has(currentLevel)) {
            let found = false;
            // First look down, then look up
            for (let step of [-1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8, -9, 9]) {
                let check = getSafeTier(currentLevel + step);
                if (!visited.has(check)) {
                    currentLevel = check;
                    found = true;
                    break;
                }
            }
            if (!found) break; 
        }

        visited.add(currentLevel);

        try {
            console.log(`[Sweep] Attempting Tier ${currentLevel}... (${visited.size}/10)`);
            const result = await callAIProvider(currentLevel, userPrompt);
            
            if (result.state === "too_complex" && currentLevel < 10) {
                console.log(`[Upward] Tier ${currentLevel} escalating...`);
                currentLevel++;
                continue;
            }
            
            return result.package;

        } catch (err) {
            const status = err.response ? err.response.status : "No Response";
            console.error(`[Failure] Tier ${currentLevel} Status: ${status}`);
            
            if (status === 503 || status === 429) {
                console.log("⚠️ Rate limit or Busy. Cooling down 1.5s...");
                await sleep(1500);
            }
            
            // Try to move down by default on network error
            currentLevel--;
        }
    }
    return null;
}

// --- 5. APP ROUTES ---
app.get('/wake', (req, res) => res.status(200).send("Full Sweep Online"));

app.post('/ask-ai', async (req, res) => {
    const { secret, complexity, prompt } = req.body;
    if (secret !== process.env.MY_APP_SECRET) return res.status(403).send("Forbidden");

    const result = await executeFullSweep(complexity, prompt);
    
    if (result) {
        res.json({ state: "complete", package: { package: result } });
    } else {
        res.status(503).json({ state: "error", content: "All 10 tiers exhausted" });
    }
});

const server = app.listen(PORT, () => console.log(`Middleware listening on ${PORT}`));
server.keepAliveTimeout = 125000;