require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const MAX_RETRIES = 3;
const PORT = process.env.PORT || 10000;

const SYSTEM_PREFACE = `
【STRICT API PROTOCOL】
- You must respond with a valid JSON object.
- If complete: Return JSON: {"state": "complete", "package": "YOUR_DATA"}
- If too complex: Return JSON: {"state": "incomplete", "package": "incomplete"}
- Do not include markdown formatting like \`\`\`json.
`;

// --- SMART HOT-SWAP MAP ---
// Format: getModelConfig(LevelNumber, "provider:model_name")
const getModelConfig = (lv, defaultStr) => {
    const config = process.env[`TIER_${lv}`] || defaultStr;
    const [p, m] = config.split(':');
    return { p, m };
};

const AI_MAP = {
    1:  getModelConfig(1,  'gemini:gemini-3-flash'),
    2:  getModelConfig(2,  'groq:llama-3.1-8b-instant'),
    3:  getModelConfig(3,  'groq:llama-3.3-70b-versatile'), 
    4:  getModelConfig(4,  'mistral:mistral-small-latest'),
    5:  getModelConfig(5,  'groq:llama-3.2-11b-vision'),
    6:  getModelConfig(6,  'cerebras:qwen-3-32b'),
    7:  getModelConfig(7,  'mistral:mistral-medium-latest'),
    8:  getModelConfig(8,  'groq:llama-3.3-70b-versatile'),
    9:  getModelConfig(9,  'gemini:gemini-3-flash'),
    10: getModelConfig(10, 'gemini:gemini-3-pro')
};

// --- API PROVIDER HANDLERS ---
async function callAIProvider(provider, model, prompt) {
    let url, data, headers = { "Content-Type": "application/json" };
    
    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } };
    } 
    else if (provider === 'groq') {
        url = "https://api.groq.com/openai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.GROQ_KEY}`;
        data = { model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } };
    }
    else if (provider === 'mistral') {
        url = "https://api.mistral.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.MISTRAL_KEY}`;
        data = { model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } };
    }
    else if (provider === 'cerebras') {
        url = "https://api.cerebras.ai/v1/chat/completions";
        headers["Authorization"] = `Bearer ${process.env.CEREBRAS_KEY}`;
        data = { model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } };
    }

    const res = await axios.post(url, data, { headers, timeout: 15000 });
    
    // Smart Extraction
    if (provider === 'gemini') {
        const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Gemini Empty Response");
        return text;
    }
    return res.data.choices[0].message.content;
}

// --- ZIG-ZAG ENGINE ---
async function executeZigZag(targetLevel, userPrompt) {
    let tried = new Set();
    const fullPrompt = `${SYSTEM_PREFACE}\n\nTASK: ${userPrompt}`;

    const run = async (lv) => {
        if (lv < 1 || lv > 10 || tried.has(lv)) return null;
        tried.add(lv);

        try {
            const config = AI_MAP[lv];
            console.log(`Attempting Level ${lv} with ${config.p}:${config.m}`);
            const raw = await callAIProvider(config.p, config.m, fullPrompt);
            const parsed = JSON.parse(raw);
            
            if (parsed.state === "incomplete" && lv < 10) return await run(lv + 1);
            return parsed.package;
        } catch (err) {
            console.error(`[Level ${lv}] Error: ${err.message}`);
            // If the target level fails, try one step down, then climb up
            if (lv === targetLevel && lv > 1) return await run(lv - 1);
            return await run(lv + 1);
        }
    };
    return await run(targetLevel);
}

// --- ENDPOINTS ---
app.get('/wake', (req, res) => res.status(200).send("Awake"));

app.post('/ask-ai', async (req, res) => {
    const { secret, complexity, prompt } = req.body;
    if (secret !== process.env.MY_APP_SECRET) return res.status(403).json({ state: "error" });

    const result = await executeZigZag(complexity, prompt);
    if (!result) return res.status(503).json({ state: "error", content: "AI failure" });

    res.json({ state: "complete", package: { package: result } });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Middleware online on port ${PORT}`));