require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- 1. ORIGIN WHITELIST ---
// List of allowed origins. If empty, all origins are accepted.
const ALLOWED_ORIGINS = [
];

function checkOrigin(req, res) {
    if (ALLOWED_ORIGINS.length === 0) return true;
    const origin = req.headers['origin'];
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        res.status(403).json({ state: "error", content: "Origin not allowed" });
        return false;
    }
    return true;
}

// --- 2. MODEL ARRAY ---
// Ordered from least to most capable (difficulty 0.0 → 1.0).
// Add, remove, or reorder freely — the cascade adapts automatically.
const MODELS = [
    { provider: 'gemini',   model: 'gemini-2.0-flash' },
    { provider: 'groq',     model: 'llama-3.3-70b-versatile' },
    { provider: 'gemini',   model: 'gemini-2.0-flash' },
    { provider: 'mistral',  model: 'mistral-small-latest' },
    { provider: 'groq',     model: 'llama-3.3-70b-specdec' },
    { provider: 'cerebras', model: 'llama-3.3-70b' },
    { provider: 'mistral',  model: 'mistral-large-latest' },
    { provider: 'groq',     model: 'llama-3.3-70b-versatile' },
    { provider: 'gemini',   model: 'gemini-2.0-pro-exp' },
    { provider: 'gemini',   model: 'gemini-2.0-pro-exp' },
];

// Converts a 0.0–1.0 float to the nearest index in MODELS.
function difficultyToIndex(difficulty) {
    const clamped = Math.min(Math.max(parseFloat(difficulty) || 0, 0.0), 1.0);
    return Math.round(clamped * (MODELS.length - 1));
}

// --- 3. UTILS ---
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

// --- 4. PROVIDER CALL ---
async function callAIProvider(index, prompt) {
    const { provider, model } = MODELS[index];
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

Task context: The word 'json' is required for validation. Ensure your package matches the user's requested data structure.
`;

    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = {
            contents: [{ parts: [{ text: `${systemPreface}\n\nTask: ${prompt}` }] }],
            generationConfig: { responseMimeType: "application/json" }
        };
    } else {
        if (provider === 'groq')          url = "https://api.groq.com/openai/v1/chat/completions";
        else if (provider === 'mistral')  url = "https://api.mistral.ai/v1/chat/completions";
        else if (provider === 'cerebras') url = "https://api.cerebras.ai/v1/chat/completions";

        headers["Authorization"] = `Bearer ${process.env[`${provider.toUpperCase()}_KEY`]}`;
        data = {
            model,
            messages: [{ role: "user", content: `${systemPreface}\n\nTask: ${prompt}` }],
            response_format: { type: "json_object" }
        };
    }

    const response = await axios.post(url, data, { headers });

    let raw;
    if (provider === 'gemini') {
        raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    } else {
        raw = response.data.choices?.[0]?.message?.content;
    }

    if (!raw) throw new Error(`Empty response from index ${index}`);

    return JSON.parse(raw);
}

// --- 5. FULL SWEEP CASCADE ENGINE ---
async function executeFullSweep(difficulty, userPrompt) {
    let currentIndex = difficultyToIndex(difficulty);
    const visited = new Set();
    const total = MODELS.length;

    // Finds the next unvisited index, preferring upward (more capable) first,
    // then downward — guarantees every model is tried before giving up.
    function nextUnvisited(from) {
        for (let step = 1; step < total; step++) {
            const up   = from + step;
            const down = from - step;
            if (up < total && !visited.has(up))   return up;
            if (down >= 0  && !visited.has(down)) return down;
        }
        return null; // all visited
    }

    while (visited.size < total) {
        // If already visited, find the next unvisited one
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
                // Prefer climbing toward most capable end
                const next = nextUnvisited(currentIndex);
                if (next === null) break;
                currentIndex = next > currentIndex ? next : total - 1;
                continue;
            }

            console.log(`[Success] Answered by index ${currentIndex} (${provider}:${model})`);
            return result.package;

        } catch (err) {
            const status = err.response ? err.response.status : "No Response";
            console.error(`[Failure] index ${currentIndex} (${provider}:${model}) — Status: ${status}`);

            if (status === 503 || status === 429) {
                console.log("⚠️ Rate limit or busy. Cooling down 1.5s...");
                await sleep(1500);
            }

            // Fall back toward least capable end on error
            currentIndex = Math.max(currentIndex - 1, 0);
        }
    }

    console.error(`[Exhausted] All ${total} models tried, none succeeded.`);
    return null;
}

// --- 6. APP ROUTES ---
app.get('/wake', (req, res) => res.status(200).send("Full Sweep Online"));

app.post('/ask-ai', async (req, res) => {
    if (!checkOrigin(req, res)) return;

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
});

server.keepAliveTimeout = 125000;