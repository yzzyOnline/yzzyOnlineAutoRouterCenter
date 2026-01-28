require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- DYNAMIC AI MAP (2026 STABLE STRINGS) ---
const getTier = (lv, defaultStr) => {
    const config = process.env[`TIER_${lv}`] || defaultStr;
    const [p, m] = config.split(':');
    return { p, m };
};

const AI_MAP = {
    1:  getTier(1,  'gemini:gemini-3-flash-preview'),
    2:  getTier(2,  'groq:llama-3.3-70b-versatile'), 
    3:  getTier(3,  'groq:llama-3.1-8b-instant'),
    4:  getTier(4,  'mistral:mistral-small-latest'),
    5:  getTier(5,  'groq:llama-3.3-70b-versatile'),
    6:  getTier(6,  'cerebras:qwen-3-32b'),
    7:  getTier(7,  'mistral:mistral-large-latest'),
    8:  getTier(8,  'groq:llama-3.3-70b-versatile'),
    9:  getTier(9,  'gemini:gemini-3-flash-preview'),
    10: getTier(10, 'gemini:gemini-3-pro-preview')
};

// --- API PROVIDER HANDLERS ---
async function callAIProvider(provider, model, prompt, lv) {
    let url, data, headers = { "Content-Type": "application/json" };
    
    // The "Humility" Preface
    const systemPreface = `
[IDENTITY: Tier ${lv}/10 Intelligence]
[PROTOCOL: JSON-ONLY]
- If you can handle this task, return: {"state": "complete", "package": "YOUR_RESPONSE"}
- If this task requires higher intelligence, return: {"state": "error", "package": "need higher level"}
- Respond ONLY with raw JSON. No markdown formatting.
`;

    const finalPrompt = `${systemPreface}\n\nUSER_TASK: ${prompt}`;

    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = { 
            contents: [{ parts: [{ text: finalPrompt }] }], 
            generationConfig: { responseMimeType: "application/json" } 
        };
    } 
    else if (provider === 'groq') {
        url = "https://api.groq.com/openai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.GROQ_KEY}`;
        data = { 
            model, 
            messages: [{ role: "user", content: finalPrompt }], 
            response_format: { type: "json_object" } 
        };
    }
    else if (provider === 'mistral') {
        url = "https://api.mistral.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.MISTRAL_KEY}`;
        data = { 
            model, 
            messages: [{ role: "user", content: finalPrompt }], 
            response_format: { type: "json_object" } 
        };
    }
    else if (provider === 'cerebras') {
        url = "https://api.cerebras.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.CEREBRAS_KEY}`;
        data = { 
            model, 
            messages: [{ role: "user", content: finalPrompt }] 
        };
    }

    const res = await axios.post(url, data, { headers, timeout: 15000 });
    
    let rawText = provider === 'gemini' 
        ? res.data.candidates?.[0]?.content?.parts?.[0]?.text 
        : res.data.choices[0].message.content;

    if (!rawText) throw new Error("Empty Response from Provider");
    return rawText;
}

// --- ZIG-ZAG ENGINE ---
async function executeZigZag(targetLevel, userPrompt) {
    let tried = new Set();

    const run = async (lv) => {
        if (lv < 1 || lv > 10 || tried.has(lv)) return null;
        tried.add(lv);

        try {
            const config = AI_MAP[lv];
            console.log(`[Tier ${lv}] Trying ${config.p}:${config.m}...`);
            
            const raw = await callAIProvider(config.p, config.m, userPrompt, lv);
            const parsed = JSON.parse(raw);
            
            // Check for the "Humility" opt-out
            if (parsed.package === "need higher level" || parsed.state === "error") {
                console.log(`[Tier ${lv}] Deferred. Climbing to ${lv + 1}...`);
                return await run(lv + 1);
            }
            
            return parsed.package;
        } catch (err) {
            console.error(`[Tier ${lv}] Failed: ${err.message}`);
            // Fallback strategy: if the target fails, try one step down, else keep climbing
            if (lv === targetLevel && lv > 1) return await run(lv - 1);
            return await run(lv + 1);
        }
    };
    return await run(targetLevel);
}

// --- ENDPOINTS ---
app.get('/wake', (req, res) => res.status(200).send("Middleware v2026.1 Active"));

app.post('/ask-ai', async (req, res) => {
    const { secret, complexity, prompt } = req.body;
    
    if (secret !== process.env.MY_APP_SECRET) {
        return res.status(403).json({ state: "error", content: "Unauthorized" });
    }

    const result = await executeZigZag(parseInt(complexity), prompt);
    
    if (!result) {
        return res.status(503).json({ state: "error", content: "All tiers failed" });
    }

    res.json({ state: "complete", package: { package: result } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Middleware online on port ${PORT}`));