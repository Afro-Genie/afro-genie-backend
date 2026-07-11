import { logger } from '../../lib/logger';
import type {
  LanguageDetectionResult,
  TranslateParams,
  TranslationProvider,
  TranslationResult,
} from '../../types/translation';
import { CURRENT_PROMPT_VERSION } from './geminiProvider';

const MODEL_NAME = 'gpt-4o-mini';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// OpenAI approximate pricing (USD per token, 2024-2025)
const INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000;

export function estimateOpenAICostUsd(tokensInput: number, tokensOutput: number): number {
  return tokensInput * INPUT_COST_PER_TOKEN + tokensOutput * OUTPUT_COST_PER_TOKEN;
}

async function withExponentialBackoff<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      logger.warn({ attempt: attempt + 1, maxAttempts, err }, 'OpenAI API call failed, retrying');
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

function buildTranslationPrompt(
  artist: string,
  title: string,
  lyrics: string,
  sourceLang: string,
  targetLang: string,
): string {
  return `You are an expert translator specializing in West African music and languages, with deep cultural knowledge of:
- Yoruba language, proverbs, orisha references, and Yoruba-English code-switching
- Nigerian Pidgin English (Naija Pidgin) — a distinct creole, NOT broken English; translate its meaning accurately
- Igbo language, idioms, cosmology, and cultural expressions
- Hausa language and Northern Nigerian cultural references
- How these languages fluidly mix (code-switching) in contemporary Afrobeats, Afropop, and Highlife music

Your task: Translate ALL lyrics of "${title}" by ${artist} from ${sourceLang} to ${targetLang}.

TRANSLATION GUIDELINES:
1. Translate every code-switched segment accurately (Yoruba, Pidgin, Igbo, Hausa, or English sections each get proper treatment).
2. Preserve the poetic structure, rhythm, call-and-response patterns, and emotional tone.
3. Nigerian Pidgin phrases (e.g. "e don do", "no go", "wahala") must be translated by meaning, not transliterated.
4. Preserve proper nouns (artist names, place names, deity names) but explain them in culturalContext.
5. In culturalContext, explain all: cultural idioms, proverbs, code-switching patterns, slang terms, and any reference that a non-Nigerian reader would miss.

LYRICS TO TRANSLATE:
${lyrics}

Respond with valid JSON only. Use the exact shape: {"translatedLyrics": "...", "culturalContext": "..."}
The "translatedLyrics" field must contain the complete translation of every line.`;
}

function buildDetectLanguagePrompt(lyrics: string): string {
  const sample = lyrics.substring(0, 1200);
  return `You are an expert in West African languages. Identify the primary language of the following song lyrics.

Recognized language codes:
- "yo"    — Yoruba
- "ig"    — Igbo
- "ha"    — Hausa
- "pcm"   — Nigerian Pidgin English (Naija Pidgin)
- "en"    — English
- "fr"    — French
- "mixed" — Heavy code-switching between two or more of the above

Lyrics sample:
${sample}

Return JSON with:
- languageCode: one code from the list above
- confidence: number from 0.0 (unsure) to 1.0 (certain)`;
}

interface OpenAIResponse {
  choices: { message: { content: string } }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ content: string; tokensInput: number; tokensOutput: number }> {
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content ?? '';
  const tokensInput = data.usage?.prompt_tokens ?? 0;
  const tokensOutput = data.usage?.completion_tokens ?? 0;

  return { content, tokensInput, tokensOutput };
}

export class OpenAIProvider implements TranslationProvider {
  public readonly name = 'openai';

  private readonly apiKey: string;

  constructor() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OPENAI_API_KEY is required for the OpenAI provider');
    }
    this.apiKey = key;
  }

  async translate(params: TranslateParams): Promise<TranslationResult> {
    const {
      artist,
      title,
      lyrics,
      sourceLang,
      targetLang,
      promptVersion = CURRENT_PROMPT_VERSION,
    } = params;

    const systemPrompt =
      'You are an expert translator specializing in West African music and languages. ' +
      'Always respond with valid JSON only, no markdown.';

    const userMessage = buildTranslationPrompt(artist, title, lyrics, sourceLang, targetLang);

    const { content, tokensInput, tokensOutput } = await withExponentialBackoff(() =>
      callOpenAI(this.apiKey, systemPrompt, userMessage),
    );

    let parsed: { translatedLyrics: string; culturalContext?: string };
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch {
      throw new Error(`OpenAI returned invalid JSON for translation: ${content.slice(0, 300)}`);
    }

    return {
      translatedLyrics: parsed.translatedLyrics,
      culturalContext: parsed.culturalContext,
      tokensInput,
      tokensOutput,
      tokensUsed: tokensInput + tokensOutput,
      model: MODEL_NAME,
      promptVersion,
    };
  }

  async detectLanguage(lyrics: string): Promise<LanguageDetectionResult> {
    const systemPrompt =
      'You are an expert in West African languages. Identify the primary language. ' +
      'Always respond with valid JSON only, no markdown.';

    const userMessage = buildDetectLanguagePrompt(lyrics);

    const { content, tokensInput, tokensOutput } = await withExponentialBackoff(() =>
      callOpenAI(this.apiKey, systemPrompt, userMessage),
    );

    let parsed: { languageCode: string; confidence: number };
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch {
      throw new Error(
        `OpenAI returned invalid JSON for language detection: ${content.slice(0, 300)}`,
      );
    }

    return {
      languageCode: parsed.languageCode,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      tokensInput,
      tokensOutput,
      model: MODEL_NAME,
    };
  }
}
