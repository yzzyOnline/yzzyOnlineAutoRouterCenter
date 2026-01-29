require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- DYNAMIC AI MAP (2026 STABLE) ---
const getTier = (lv, defaultStr) => {
    const config = process.env[`TIER_${lv}`] || defaultStr;
    const [p, m] = config.split(':');
    return { p, m };
};

const AI_MAP = {
    1:  getTier(1,  'gemini:gemini-3-flash-preview'),
    2:  getTier(2,  'groq:llama-3.1-8b-instant'),
    3:  getTier(3,  'gemini:gemini-3-flash-preview'),
    4:  getTier(4,  'mistral:mistral-small-latest'),
    5:  getTier(5,  'groq:llama-3.3-70b-specdec'),
    6:  getTier(6,  'cerebras:llama-3.3-70b'),
    7:  getTier(7,  'mistral:mistral-large-latest'),
    8:  getTier(8,  'groq:llama-3.3-70b-specdec'),
    9:  getTier(9,  'gemini:gemini-3-pro-preview'),
    10: getTier(10, 'gemini:gemini-3-pro') // The heavyweight
};

// --- CORE PROVIDER CALL ---
async function callAIProvider(lv, prompt) {
    const { p: provider, m: model } = AI_MAP[lv];
    let url, data, headers = { "Content-Type": "application/json" };

    const systemPreface = `
[IDENTITY: Tier ${lv}/10 Intelligence]
[PROTOCOL: JSON-ONLY]
- If task is too hard, return: {"state": "too_complex", "package": "need higher level"}
- Otherwise, return: {"state": "complete", "package": "YOUR_RESPONSE"}
- Respond ONLY with raw JSON.
`;

    const finalPrompt = `${systemPreface}\n\nUSER_TASK: ${prompt}`;

    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = { 
            contents: [{ parts: [{ text: finalPrompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        };
    } else if (provider === 'groq' || provider === 'mistral' || provider === 'cerebras') {
        url = provider === 'groq' ? "https://api.groq.com/openai/v1/chat/completions" :
              provider === 'mistral' ? "https://api.mistral.ai/v1/chat/completions" :
              "https://api.cerebras.ai/v1/chat/completions";
        
        headers["Authorization"] = `Bearer ${process.env[`${provider.toUpperCase()}_KEY`]}`;
        data = { 
            model, 
            messages: [{ role: "user", content: finalPrompt }],
            response_format: { type: "json_object" }
        };
    }

    // Increased timeout to 45s for Tier 10 thinking time
    const res = await axios.post(url, data, { headers, timeout: 45000 });
    
    let rawText = provider === 'gemini' 
        ? res.data.candidates?.[0]?.content?.parts?.[0]?.text 
        : res.data.choices[0].message.content;

    return JSON.parse(rawText);
}

// --- THE HYBRID CASCADE ENGINE ---
async function executeHybridCascade(initialLevel, userPrompt) {
    let currentLevel = initialLevel;
    let attempted = new Set();

    while (currentLevel >= 1 && currentLevel <= 10) {
        if (attempted.has(currentLevel)) {
            // If we've already tried this level and failed, step down further
            currentLevel--;
            continue;
        }
        attempted.add(currentLevel);

        try {
            console.log(`[Hybrid] Attempting Tier ${currentLevel}...`);
            const result = await callAIProvider(currentLevel, userPrompt);
            
            // UPWARD Path: AI says it's not smart enough
            if (result.state === "too_complex" && currentLevel < 10) {
                console.log(`[Hybrid] Tier ${currentLevel} too low. Climbing up...`);
                currentLevel++;
                continue;
            }
            
            return result.package; // Success!

        } catch (err) {
            // DOWNWARD Path: Infrastructure/Connection/Rate-Limit Failure
            console.error(`[Hybrid] Tier ${currentLevel} Infrasturcture Error: ${err.message}`);
            
            if (currentLevel > 1) {
                console.log(`[Hybrid] Dropping down to Tier ${currentLevel - 1} for reliability...`);
                currentLevel--;
            } else {
                return null; // Bottom of the stack reached
            }
        }
    }
    return null;
}

// --- ENDPOINTS ---
app.get('/wake', (req, res) => res.status(200).send("Hybrid Cascade v2.0 Active"));

app.post('/ask-ai', async (req, res) => {
    const { secret, complexity, prompt } = req.body;
    
    if (secret !== process.env.MY_APP_SECRET) {
        return res.status(403).json({ state: "error", package: { package: "Unauthorized" } });
    }

    const finalAnswer = await executeHybridCascade(parseInt(complexity), prompt);
    
    if (!finalAnswer) {
        return res.status(503).json({ state: "error", content: "All tiers failed" });
    }

    // Wrap in the format Godot expects
    res.json({ state: "complete", package: { package: finalAnswer } });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`Middleware online on port ${PORT}`));
server.keepAliveTimeout = 120000; // 2 minute keep-alive for heavy models