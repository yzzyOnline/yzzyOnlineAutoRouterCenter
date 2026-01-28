require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- DYNAMIC AI MAP (2026 Edition) ---
const getTier = (lv, defaultStr) => {
    const config = process.env[`TIER_${lv}`] || defaultStr;
    const [p, m] = config.split(':');
    return { p, m };
};

const AI_MAP = {
    1:  getTier(1,  'gemini:gemini-3-flash-preview'),  // The new "Speed King"
    2:  getTier(2,  'groq:llama-3.1-8b-instant'),      // Stable & Fast
    3:  getTier(3,  'groq:llama-3.3-70b-versatile'),   // Heavy lifter for low tiers
    4:  getTier(4,  'mistral:mistral-small-latest'),   // Mistral 3 Series
    5:  getTier(5,  'groq:llama-3.3-70b-versatile'),   // Solid middle ground
    6:  getTier(6,  'cerebras:qwen-3-32b'),            // Instant inference
    7:  getTier(7,  'mistral:mistral-medium-latest'),  // Creative & Nuanced
    8:  getTier(8,  'groq:llama-3.3-70b-versatile'),   // High reasoning
    9:  getTier(9,  'gemini:gemini-3-flash-preview'),  // High-speed fallback
    10: getTier(10, 'gemini:gemini-3-pro-preview')     // The "Genius" level
};

// --- CORE LOGIC ---
async function callAIProvider(provider, model, prompt, lv) {
    let url, data, headers = { "Content-Type": "application/json" };
    
    // Inject level into the prompt so the AI knows its "rank"
    const finalPrompt = `[System: You are Tier ${lv} Intelligence] ${prompt}`;

    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = { contents: [{ parts: [{ text: finalPrompt }] }], generationConfig: { responseMimeType: "application/json" } };
    } 
    else if (provider === 'groq') {
        url = "https://api.groq.com/openai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.GROQ_KEY}`;
        data = { model, messages: [{ role: "user", content: finalPrompt }], response_format: { type: "json_object" } };
    }
    else if (provider === 'mistral') {
        url = "https://api.mistral.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.MISTRAL_KEY}`;
        data = { model, messages: [{ role: "user", content: finalPrompt }], response_format: { type: "json_object" } };
    }
    else if (provider === 'cerebras') {
        url = "https://api.cerebras.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.CEREBRAS_KEY}`;
        data = { model, messages: [{ role: "user", content: finalPrompt }] };
    }

    const res = await axios.post(url, data, { headers, timeout: 15000 });
    
    if (provider === 'gemini') {
        const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Empty Gemini Response");
        return text;
    }
    return res.data.choices[0].message.content;
}

// Zig-Zag Logic
async function executeZigZag(targetLevel, userPrompt) {
    let tried = new Set();
    const run = async (lv) => {
        if (lv < 1 || lv > 10 || tried.has(lv)) return null;
        tried.add(lv);
        try {
            const config = AI_MAP[lv];
            console.log(`Level ${lv} | ${config.p}:${config.m}`);
            const raw = await callAIProvider(config.p, config.m, userPrompt, lv);
            return JSON.parse(raw).package;
        } catch (err) {
            console.error(`Lvl ${lv} Fail: ${err.message}`);
            return (lv === targetLevel && lv > 1) ? await run(lv - 1) : await run(lv + 1);
        }
    };
    return await run(targetLevel);
}

app.get('/wake', (req, res) => res.status(200).send("Awake"));

app.post('/ask-ai', async (req, res) => {
    const { secret, complexity, prompt } = req.body;
    if (secret !== process.env.MY_APP_SECRET) return res.status(403).json({ state: "error" });
    const result = await executeZigZag(complexity, prompt);
    res.json({ state: "complete", package: { package: result } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Middleware 2026 Online on ${PORT}`));