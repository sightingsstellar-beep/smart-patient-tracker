/**
 * parser.js — OpenAI NLP parser for Telegram messages
 *
 * Takes a freeform text message and returns a structured array of log actions.
 * Uses gpt-4o-mini for cost efficiency.
 */

'use strict';

const OpenAI = require('openai');

let client;
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a medical logging assistant for a critically ill child named Elina.
Your job is to parse freeform caregiver messages into structured log entries.

Return ONLY a valid JSON object with this structure:
{
  "actions": [
    {
      "type": "input",
      "fluid_type": "<one of: water, juice, vitamin_water, milk, pediasure, yogurt_drink>",
      "amount_ml": <number or null>
    },
    {
      "type": "output",
      "fluid_type": "<one of: urine, poop, vomit>",
      "amount_ml": <number or null>
    },
    {
      "type": "wellness",
      "check_time": "<5pm or 10pm>",
      "appetite": <1-10 or null>,
      "energy": <1-10 or null>,
      "mood": <1-10 or null>,
      "cyanosis": <1-10 or null>
    },
    {
      "type": "gag",
      "count": <integer, minimum 1>
    },
    {
      "type": "weight",
      "weight_kg": <number>
    }
  ],
  "date_offset": 0,
  "unparseable": false,
  "raw_message": "<echo the original>"
}

Rules:
- A single message can produce multiple actions (e.g., "89ml urine and 100ml water" → one output + one input).
- For inputs: map common synonyms: "pee" / "peed" / "wet diaper" → urine (output), "pediasure" / "pedi" → pediasure, "vitamin water" → vitamin_water, "yogurt drink" / "drinkable yogurt" → yogurt_drink, "formula" → pediasure.
- "poop" / "pooped" / "BM" / "bowel movement" / "stool" → output type "poop". Amount is usually null unless stated.
- Gag: "gagged" / "gag x2" / "she gagged once" / "gagging episode" → type "gag" with count.
- Wellness check: extract appetite, energy, mood, cyanosis scores (1-10). "cyan" = cyanosis. Infer check_time from context or default to "5pm".
- Amounts: "about", "roughly", "approximately", "~" are fine — use the number.
- amount_ml is REQUIRED for every input and every output. If no amount is stated or inferable, do NOT include that action — set "unparseable": true instead.
- Weight: "weight 14.2" / "weight is 14.3 kg" / "she weighs 14.2" / "14.2 kg weight" → type "weight" with weight_kg as a positive number in kg. If given in lbs, convert to kg (divide by 2.205) and round to 2 decimal places. weight_kg is REQUIRED — if no number given, set unparseable: true.
- If the message contains NO recognizable entries, set "unparseable": true and actions: [].
- Do NOT include any explanation or markdown — return raw JSON only.
- Clamp wellness scores to 1–10.
- All amounts must be positive numbers.
- Yesterday date offset: if the message starts with "yesterday:", contains "yesterday she had", "log for yesterday", "for yesterday", or otherwise clearly refers to an entry that happened yesterday (not today), set "date_offset": -1. Otherwise set "date_offset": 0.`;

// ---------------------------------------------------------------------------
// Parse function
// ---------------------------------------------------------------------------

/**
 * Parse a freeform caregiver message into structured actions.
 * @param {string} message
 * @returns {Promise<{ actions: Array, unparseable: boolean, raw_message: string }>}
 */
async function parseMessage(message) {
  const openai = getClient();

  let responseText;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    });

    responseText = completion.choices[0]?.message?.content;
  } catch (err) {
    console.error('[parser] OpenAI API error:', err.message);
    throw new Error('Failed to contact OpenAI API: ' + err.message);
  }

  // Parse the JSON response
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    console.error('[parser] Failed to parse OpenAI response as JSON:', responseText);
    return { actions: [], unparseable: true, raw_message: message };
  }

  // Validate and sanitize the response
  if (!parsed || !Array.isArray(parsed.actions)) {
    return { actions: [], unparseable: true, raw_message: message };
  }

  // Sanitize each action
  const validInputTypes = ['water', 'juice', 'vitamin_water', 'milk', 'pediasure', 'yogurt_drink'];
  const validOutputTypes = ['urine', 'poop', 'vomit'];

  const sanitized = [];
  for (const action of parsed.actions) {
    if (!action || typeof action.type !== 'string') continue;

    if (action.type === 'input') {
      if (!validInputTypes.includes(action.fluid_type)) continue;
      sanitized.push({
        type: 'input',
        fluid_type: action.fluid_type,
        amount_ml: typeof action.amount_ml === 'number' && action.amount_ml > 0
          ? Math.round(action.amount_ml * 10) / 10
          : null,
      });
    } else if (action.type === 'output') {
      if (!validOutputTypes.includes(action.fluid_type)) continue;
      sanitized.push({
        type: 'output',
        fluid_type: action.fluid_type,
        amount_ml: typeof action.amount_ml === 'number' && action.amount_ml > 0
          ? Math.round(action.amount_ml * 10) / 10
          : null,
      });
    } else if (action.type === 'wellness') {
      const clamp = (v) => (typeof v === 'number' ? Math.min(10, Math.max(1, Math.round(v))) : null);
      sanitized.push({
        type: 'wellness',
        check_time: ['5pm', '10pm'].includes(action.check_time) ? action.check_time : '5pm',
        appetite: clamp(action.appetite),
        energy: clamp(action.energy),
        mood: clamp(action.mood),
        cyanosis: clamp(action.cyanosis),
      });
    } else if (action.type === 'gag') {
      const count = typeof action.count === 'number' && action.count > 0
        ? Math.round(action.count)
        : 1;
      sanitized.push({ type: 'gag', count });
    } else if (action.type === 'weight') {
      if (typeof action.weight_kg === 'number' && action.weight_kg > 0) {
        sanitized.push({
          type: 'weight',
          weight_kg: Math.round(action.weight_kg * 100) / 100,
        });
      }
    }
  }

  const dateOffset = parsed.date_offset === -1 ? -1 : 0;

  return {
    actions: sanitized,
    date_offset: dateOffset,
    unparseable: sanitized.length === 0 && (parsed.unparseable !== false),
    raw_message: message,
  };
}

module.exports = { parseMessage };
