import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import type {
  LanguageDetectionResult,
  TranslateParams,
  TranslationProvider,
  TranslationResult,
} from '../../types/translation';

const MODEL_NAME = 'gemini-2.5-flash';
export const CURRENT_PROMPT_VERSION = 'v1.0';

// Gemini 2.5 Flash approximate pricing (USD per token, 2025)
const INPUT_COST_PER_TOKEN = 0.075 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 0.30 / 1_000_000;

export function estimateCostUsd(tokensInput: number, tokensOutput: number): number {
  return tokensInput * INPUT_COST_PER_TOKEN + tokensOutput * OUTPUT_COST_PER_TOKEN;
}

async function withExponentialBackoff<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      logger.warn({ attempt: attempt + 1, maxAttempts, err }, 'Gemini API call failed, retrying');
      if (attempt < maxAttempts - 1) {
        // 1s → 2s → 4s
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

Respond with valid JSON only. The "translatedLyrics" field must contain the complete translation of every line.`;
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

export class GeminiProvider implements TranslationProvider {
  public readonly name = 'gemini';

  private readonly genAI: GoogleGenerativeAI;

  constructor() {
    this.genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }

  async translate(params: TranslateParams): Promise<TranslationResult> {
    const { artist, title, lyrics, sourceLang, targetLang, promptVersion = CURRENT_PROMPT_VERSION } =
      params;

    const model = this.genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            translatedLyrics: {
              type: SchemaType.STRING,
              description: 'Complete translated lyrics — every line must be included',
            },
            culturalContext: {
              type: SchemaType.STRING,
              description:
                'Cultural notes explaining idioms, code-switching, proverbs, and references',
            },
          },
          required: ['translatedLyrics'],
        },
      },
    });

    const prompt = buildTranslationPrompt(artist, title, lyrics, sourceLang, targetLang);

    const geminiResult = await withExponentialBackoff(() => model.generateContent(prompt));
    const response = geminiResult.response;
    const rawText = response.text();

    let parsed: { translatedLyrics: string; culturalContext?: string };
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      throw new Error(`Gemini returned invalid JSON for translation: ${rawText.slice(0, 300)}`);
    }

    const tokensInput = response.usageMetadata?.promptTokenCount ?? 0;
    const tokensOutput = response.usageMetadata?.candidatesTokenCount ?? 0;

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
    const model = this.genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            languageCode: {
              type: SchemaType.STRING,
              description: 'ISO language code from the recognized list',
            },
            confidence: {
              type: SchemaType.NUMBER,
              description: 'Confidence score between 0.0 and 1.0',
            },
          },
          required: ['languageCode', 'confidence'],
        },
      },
    });

    const prompt = buildDetectLanguagePrompt(lyrics);
    const geminiResult = await withExponentialBackoff(() => model.generateContent(prompt));
    const response = geminiResult.response;
    const rawText = response.text();

    let parsed: { languageCode: string; confidence: number };
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      throw new Error(
        `Gemini returned invalid JSON for language detection: ${rawText.slice(0, 300)}`,
      );
    }

    const tokensInput = response.usageMetadata?.promptTokenCount ?? 0;
    const tokensOutput = response.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      languageCode: parsed.languageCode,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      tokensInput,
      tokensOutput,
      model: MODEL_NAME,
    };
  }

  async detectLanguageWithPrompt(prompt: string): Promise<{
    languageCode: string;
    languageName: string;
    confidence: 'high' | 'medium' | 'low';
    tokensInput: number;
    tokensOutput: number;
    model: string;
  }> {
    const model = this.genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            languageCode: {
              type: SchemaType.STRING,
              description: 'Primary language code',
            },
            languageName: {
              type: SchemaType.STRING,
              description: 'Human readable language name',
            },
            confidence: {
              type: SchemaType.STRING,
              description: "Confidence value: high, medium, or low",
            },
          },
          required: ['languageCode', 'languageName', 'confidence'],
        },
      },
    });

    const geminiResult = await withExponentialBackoff(() => model.generateContent(prompt));
    const response = geminiResult.response;
    const rawText = response.text();

    let parsed: { languageCode: string; languageName: string; confidence: string };
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      throw new Error(
        `Gemini returned invalid JSON for language detection prompt: ${rawText.slice(0, 300)}`,
      );
    }

    const normalizedConfidence = String(parsed.confidence).toLowerCase();
    const confidence: 'high' | 'medium' | 'low' =
      normalizedConfidence === 'high' || normalizedConfidence === 'medium' || normalizedConfidence === 'low'
        ? normalizedConfidence
        : 'low';

    const tokensInput = response.usageMetadata?.promptTokenCount ?? 0;
    const tokensOutput = response.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      languageCode: String(parsed.languageCode).trim(),
      languageName: String(parsed.languageName).trim(),
      confidence,
      tokensInput,
      tokensOutput,
      model: MODEL_NAME,
    };
  }
}
