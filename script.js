require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const MAX_RETRIES = 3;
const TIMEOUT_BASE = 2000;
const TIMEOUT_PER_LEVEL = 1300;
const PORT = process.env.PORT || 3000;

const SYSTEM_PREFACE = `
【STRICT API PROTOCOL】
- If complete: Return ONLY JSON: {"state": "complete", "package": "YOUR_DATA"}
- If too complex: Return ONLY JSON: {"state": "incomplete", "package": "incomplete"}
- No conversational text or markdown. Pure JSON only.
`;

const AI_MAP = {
    1: { p: 'gemini',  m: 'gemini-2.5-flash-lite' },
    2: { p: 'groq',    m: 'llama-3.1-8b-instant' },
    3: { p: 'gemini',  m: 'gemma-3-4b-it' },
    4: { p: 'mistral', m: 'mistral-small-latest' },
    5: { p: 'groq',    m: 'llama-3.2-11b-vision' },
    6: { p: 'cerebras', m: 'qwen-3-32b' },
    7: { p: 'mistral', m: 'mistral-medium-latest' },
    8: { p: 'groq',    m: 'llama-3.3-70b-versatile' },
    9: { p: 'gemini',  m: 'gemini-2.5-flash' },
    10: { p: 'gemini', m: 'gemini-3-pro' }
};

// --- API PROVIDER HANDLERS ---
async function callAIProvider(provider, model, prompt) {
    let url, data, headers = { "Content-Type": "application/json" };
    
    // GEMINI LOGIC
    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = { 
            contents: [{ parts: [{ text: prompt }] }], 
            generationConfig: { responseMimeType: "application/json" } 
        };
    } 
    // GROQ LOGIC
    else if (provider === 'groq') {
        url = "https://api.groq.com/openai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.GROQ_KEY}`;
        data = { 
            model, 
            messages: [{ role: "user", content: prompt }], 
            temperature: 0,
            response_format: { type: "json_object" } 
        };
    }
    // MISTRAL LOGIC
    else if (provider === 'mistral') {
        url = "https://api.mistral.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.MISTRAL_KEY}`;
        data = {
            model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        };
    }
    // CEREBRAS LOGIC
    else if (provider === 'cerebras') {
        url = "https://api.cerebras.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.CEREBRAS_KEY}`;
        headers["X-Cerebras-Version-Patch"] = "2"; // Use 2026 schema validation
        data = {
            model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        };
    }

    const res = await axios.post(url, data, { headers });
    
    // Extraction (Gemini uses a different JSON structure than OpenAI-compatible ones)
    return provider === 'gemini' 
        ? res.data.candidates[0].content.parts[0].text 
        : res.data.choices[0].message.content;
}

// --- ZIG-ZAG ENGINE ---
async function executeZigZag(targetLevel, userPrompt) {
    let tried = new Set();
    let retries = 0;
    const fullPrompt = `${SYSTEM_PREFACE}\n\nTASK: ${userPrompt}`;

    const run = async (lv) => {
        if (lv < 1 || lv > 10 || tried.has(lv) || retries >= MAX_RETRIES) return null;
        tried.add(lv);
        retries++;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_BASE + (lv * TIMEOUT_PER_LEVEL));
            
            const raw = await callAIProvider(AI_MAP[lv].p, AI_MAP[lv].m, fullPrompt);
            clearTimeout(timeoutId);
            
            const parsed = JSON.parse(raw);
            if (parsed.state === "incomplete") {
                console.warn(`[Level ${lv}] Reported incomplete. Ranking up...`);
                return await run(lv + 1);
            }
            return parsed.package;

        } catch (err) {
            console.error(`[Level ${lv}] Error: ${err.name === 'AbortError' ? 'TIMEOUT' : err.message}`);
            // Rollback once if we failed at the target level, otherwise always climb
            if (lv === targetLevel && lv > 1 && !tried.has(lv - 1)) {
                return await run(lv - 1);
            }
            return await run(lv + 1);
        }
    };
    return await run(targetLevel);
}

// --- ENDPOINT ---
app.post('/ask-ai', async (req, res) => {
    const { secret, complexity, prompt } = req.body;
    if (secret !== process.env.MY_APP_SECRET) return res.status(403).json({ state: "error" });

    const result = await executeZigZag(complexity, prompt);
    if (!result) return res.status(503).json({ state: "error", content: "AI failure after retries" });

    res.json({ state: "complete", package: { package: result } });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Middleware online and listening on 0.0.0.0:${PORT}`);
});