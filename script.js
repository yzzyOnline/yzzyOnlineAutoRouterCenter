require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

// --- 1. CORS & ORIGIN WHITELIST ---
// List of allowed origins. If empty, all origins are accepted.
const ALLOWED_ORIGINS = [];

app.use(cors({
    origin: (origin, callback) => {
        if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// --- 2. RATE LIMITER ---
// Configurable via env vars, sensible defaults out of the box.
// RATE_LIMIT_WINDOW_MS: window in milliseconds (default: 1 minute)
// RATE_LIMIT_MAX:       max requests per window per IP (default: 30)
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { state: "error", content: "Too many requests, please slow down." }
});

app.use('/ask-ai', limiter);

const PORT = process.env.PORT || 10000;

// --- 3. KEY POOLS ---
// Multiple keys per provider separated by "|" in the env var.
// e.g. GEMINI_KEY=key1|key2|key3
// At startup, each is split into an array and tried in order on failure.
const KEY_POOLS = {};
['GEMINI', 'GROQ', 'MISTRAL', 'CEREBRAS'].forEach(provider => {
    const raw = process.env[`${provider}_KEY`] || '';
    KEY_POOLS[provider] = raw.split('|').map(k => k.trim()).filter(Boolean);
});

// --- 4. MODEL ARRAY ---
// Ordered from least to most capable (difficulty 0.0 → 1.0).
// Add, remove, or reorder freely — the cascade adapts automatically.
const MODELS = [
    { provider: 'cerebras', model: 'llama3.1-8b' },            // 0.00 — fastest, lightest
    { provider: 'groq',     model: 'llama-3.3-70b-versatile' },// 0.11 — fast, reliable
    { provider: 'cerebras', model: 'llama-3.3-70b' },          // 0.22 — cerebras 70b
    { provider: 'gemini',   model: 'gemini-2.0-flash' },       // 0.33 — gemini fast
    { provider: 'groq',     model: 'llama-3.3-70b-specdec' },  // 0.44 — groq speculative
    { provider: 'mistral',  model: 'mistral-small-latest' },   // 0.56 — mistral small
    { provider: 'groq',     model: 'llama-3.3-70b-versatile' },// 0.67 — groq fallback
    { provider: 'mistral',  model: 'mistral-large-latest' },   // 0.78 — mistral large
    { provider: 'gemini',   model: 'gemini-2.5-flash' },       // 0.89 — gemini 2.5 thinking
    { provider: 'gemini',   model: 'gemini-2.5-pro' },         // 1.00 — most capable
];

// Converts a 0.0–1.0 float to the nearest index in MODELS.
function difficultyToIndex(difficulty) {
    const clamped = Math.min(Math.max(parseFloat(difficulty) || 0, 0.0), 1.0);
    return Math.round(clamped * (MODELS.length - 1));
}

// --- 5. UTILS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Timing-safe secret comparison to prevent timing attacks
function checkSecret(provided) {
    const expected = process.env.MY_APP_SECRET || '';
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(
        Buffer.from(provided),
        Buffer.from(expected)
    );
}

// --- 6. PROVIDER CALL (with key rotation) ---
async function callAIProvider(index, prompt) {
    const { provider, model } = MODELS[index];
    const keys = KEY_POOLS[provider.toUpperCase()];

    if (!keys || keys.length === 0) {
        throw new Error(`No API keys configured for provider: ${provider}`);
    }

    let lastError;

    for (let ki = 0; ki < keys.length; ki++) {
        const key = keys[ki];
        let url, data, headers = { "Content-Type": "application/json" };

        const systemPreface = `
[PROTOCOL: JSON-ONLY]
You are a specialized AI node. You must respond ONLY with a valid JSON object.
The output MUST follow this schema:
{
  "state": "complete",
  "package": <CONTENT>
}

If the request is too difficult for your current tier (${index + 1} of ${MODELS.length}), return:
{
  "state": "too_complex",
  "package": "climb"
}

Task context:  Ensure your package matches the user's requested data structure.
`;

        if (provider === 'gemini') {
            url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
            data = {
                contents: [{ parts: [{ text: `${systemPreface}\n\nTask: ${prompt}` }] }],
                generationConfig: { responseMimeType: "application/json" }
            };
        } else {
            if (provider === 'groq')          url = "https://api.groq.com/openai/v1/chat/completions";
            else if (provider === 'mistral')  url = "https://api.mistral.ai/v1/chat/completions";
            else if (provider === 'cerebras') url = "https://api.cerebras.ai/v1/chat/completions";

            headers["Authorization"] = `Bearer ${key}`;
            data = {
                model,
                messages: [{ role: "user", content: `${systemPreface}\n\nTask: ${prompt}` }],
                response_format: { type: "json_object" }
            };
        }

        try {
            const response = await axios.post(url, data, { headers });

            let raw;
            if (provider === 'gemini') {
                raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            } else {
                raw = response.data.choices?.[0]?.message?.content;
            }

            if (!raw) throw new Error(`Empty response from index ${index} key ${ki}`);

            console.log(`[Key] ${provider} used key slot ${ki + 1}/${keys.length}`);
            return JSON.parse(raw);

        } catch (err) {
            const status = err.response ? err.response.status : 'No Response';
            console.warn(`[Key Fail] ${provider}:${model} key slot ${ki + 1}/${keys.length} — Status: ${status}`);
            lastError = err;

            // Only rotate keys on rate limit or auth errors, fail fast on others
            if (status !== 429 && status !== 401 && status !== 403) break;
        }
    }

    throw lastError;
}

// --- 7. FULL SWEEP CASCADE ENGINE ---
async function executeFullSweep(difficulty, userPrompt) {
    let currentIndex = difficultyToIndex(difficulty);
    const visited = new Set();
    const total = MODELS.length;

    function nextUnvisited(from) {
        for (let step = 1; step < total; step++) {
            const up   = from + step;
            const down = from - step;
            if (up < total && !visited.has(up))   return up;
            if (down >= 0  && !visited.has(down)) return down;
        }
        return null;
    }

    while (visited.size < total) {
        if (visited.has(currentIndex)) {
            const next = nextUnvisited(currentIndex);
            if (next === null) break;
            currentIndex = next;
        }

        visited.add(currentIndex);
        const { provider, model } = MODELS[currentIndex];

        try {
            console.log(`[Sweep] Trying index ${currentIndex} (${provider}:${model})... (${visited.size}/${total})`);
            const result = await callAIProvider(currentIndex, userPrompt);

            if (result.state === "too_complex") {
                console.log(`[Upward] ${provider}:${model} says too complex, climbing...`);
                const next = nextUnvisited(currentIndex);
                if (next === null) break;
                currentIndex = next > currentIndex ? next : total - 1;
                continue;
            }

            console.log(`[Success] Answered by index ${currentIndex} (${provider}:${model})`);
            return result.package;

        } catch (err) {
            const status = err.response ? err.response.status : "No Response";
            console.error(`[Failure] index ${currentIndex} (${provider}:${model}) — Status: ${status} (all keys exhausted)`);

            if (status === 503 || status === 429) {
                console.log("⚠️ Rate limit or busy. Cooling down 1.5s...");
                await sleep(1500);
            }

            currentIndex = Math.max(currentIndex - 1, 0);
        }
    }

    console.error(`[Exhausted] All ${total} models tried, none succeeded.`);
    return null;
}

// --- 8. APP ROUTES ---
app.get('/wake', (req, res) => res.status(200).send("Full Sweep Online"));

app.post('/ask-ai', async (req, res) => {
    const { secret, difficulty, prompt } = req.body;
    if (!secret || !checkSecret(secret)) return res.status(403).send("Forbidden");

    const result = await executeFullSweep(difficulty, prompt);

    if (result) {
        res.json({ state: "complete", package: { package: result } });
    } else {
        res.status(503).json({ state: "error", content: "All models exhausted" });
    }
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Middleware listening on port ${PORT} at 0.0.0.0`);
    Object.entries(KEY_POOLS).forEach(([provider, keys]) => {
        console.log(`[Keys] ${provider}: ${keys.length} key(s) loaded`);
    });
    console.log(`[Rate Limit] ${parseInt(process.env.RATE_LIMIT_MAX) || 30} requests / ${(parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000) / 1000}s per IP`);
});

server.keepAliveTimeout = 125000;