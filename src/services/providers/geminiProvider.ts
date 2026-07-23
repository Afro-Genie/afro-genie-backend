import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import type {
  LanguageDetectionResult,
  TranslateParams,
  TranslationProvider,
  TranslationResult,
} from '../../types/translation';

// Model fallback chain: try primary first, then fallbacks if 503/unavailable
const MODEL_CHAIN = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const PRIMARY_MODEL = MODEL_CHAIN[0];

export const CURRENT_PROMPT_VERSION = 'v1.2';

// Gemini 3.5 Flash pricing (USD per token, 2026)
const INPUT_COST_PER_TOKEN = 1.5 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 9.0 / 1_000_000;

// Chunking threshold: lyrics longer than this get split into verse segments
const CHUNK_CHAR_THRESHOLD = 8000;
const MAX_SINGLE_PROMPT_CHARS = 12000;

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
        // 2s → 4s → 8s (longer delays for AI calls)
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

// Check if an error should trigger model fallback (503 unavailable, 404 not found, etc.)
function isUnavailableError(err: unknown): boolean {
  const msg = String((err as any)?.message || (err as any)?.error?.message || '').toLowerCase();
  const status = (err as any)?.status || (err as any)?.httpStatusCode || 0;
  return (
    status === 404 ||
    status === 503 ||
    msg.includes('404') ||
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('not found') ||
    msg.includes('no longer') ||
    msg.includes('high demand')
  );
}

// ---------------------------------------------------------------------------
// Defensive JSON extraction — strip markdown fences if present
// ---------------------------------------------------------------------------
function extractJson(text: string): string {
  const trimmed = text.trim();
  // If it looks like it's wrapped in markdown code fences, extract the content
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  // If it starts with { or [, assume it's raw JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }
  // Try to find JSON object boundaries
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Lyric chunking — split long lyrics into translatable segments
// ---------------------------------------------------------------------------
function splitLyricsIntoChunks(lyrics: string): string[] {
  if (lyrics.length <= CHUNK_CHAR_THRESHOLD) {
    return [lyrics];
  }

  // Split by double newlines (verse/stanza boundaries) first
  const stanzas = lyrics.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const stanza of stanzas) {
    // If a single stanza exceeds max, split by single newlines
    if (stanza.length > MAX_SINGLE_PROMPT_CHARS) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      const lines = stanza.split('\n');
      let lineChunk = '';
      for (const line of lines) {
        if ((lineChunk + '\n' + line).length > MAX_SINGLE_PROMPT_CHARS && lineChunk) {
          chunks.push(lineChunk.trim());
          lineChunk = line;
        } else {
          lineChunk = lineChunk ? lineChunk + '\n' + line : line;
        }
      }
      if (lineChunk.trim()) {
        chunks.push(lineChunk.trim());
      }
      continue;
    }

    if ((currentChunk + '\n\n' + stanza).length > MAX_SINGLE_PROMPT_CHARS && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = stanza;
    } else {
      currentChunk = currentChunk ? currentChunk + '\n\n' + stanza : stanza;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [lyrics];
}

function buildTranslationPrompt(
  artist: string,
  title: string,
  lyrics: string,
  sourceLang: string,
  targetLang: string,
  chunkIndex?: number,
  totalChunks?: number,
): string {
  const chunkContext =
    chunkIndex !== undefined && totalChunks !== undefined && totalChunks > 1
      ? `\nIMPORTANT: This is part ${chunkIndex + 1} of ${totalChunks} of the full lyrics. Translate ONLY this section. Do NOT add any text outside the JSON response.`
      : '';

  return `You are an expert translator specializing in West African music and languages, with deep cultural knowledge of:
- Yoruba language, proverbs, orisha references, and Yoruba-English code-switching
- Nigerian Pidgin English (Naija Pidgin) — a distinct creole, NOT broken English; translate its meaning accurately
- Igbo language, idioms, cosmology, and cultural expressions
- Hausa language and Northern Nigerian cultural references
- How these languages fluidly mix (code-switching) in contemporary Afrobeats, Afropop, and Highlife music

Your task: Translate ALL lyrics of "${title}" by ${artist} from ${sourceLang} to ${targetLang}.${chunkContext}

TRANSLATION GUIDELINES:
1. Translate every code-switched segment accurately (Yoruba, Pidgin, Igbo, Hausa, or English sections each get proper treatment).
2. Preserve the poetic structure, rhythm, call-and-response patterns, and emotional tone.
3. Nigerian Pidgin phrases (e.g. "e don do", "no go", "wahala") must be translated by meaning, not transliterated.
4. Preserve proper nouns (artist names, place names, deity names) but explain them in culturalContext.
5. In culturalContext, explain all: cultural idioms, proverbs, code-switching patterns, slang terms, and any reference that a non-Nigerian reader would miss.
6. CRITICAL: Every single line of the input lyrics must appear in the translatedLyrics output. Do NOT skip, summarize, or omit any lines.

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

function buildChunkMergePrompt(chunks: string[], sourceLang: string, targetLang: string): string {
  const numbered = chunks.map((c, i) => `--- CHUNK ${i + 1} ---\n${c}`).join('\n\n');
  return `You are an expert translator. The following are ${chunks.length} translated chunks of a single song.
Each chunk was translated from ${sourceLang} to ${targetLang} independently.
Your job is to merge them into a single coherent translation, fixing any inconsistencies between chunks.

RULES:
1. Preserve ALL translated lines from every chunk — do NOT skip or summarize.
2. Fix any formatting inconsistencies between chunks (e.g., duplicated lines, missing line breaks).
3. Ensure the culturalContext is merged into a single coherent block.
4. Preserve the original verse structure.

CHUNKS TO MERGE:
${numbered}

Respond with valid JSON: {"translatedLyrics": "...", "culturalContext": "..."}`;
}

// JSON schema used for all translation/detection calls (new SDK format)
const TRANSLATION_SCHEMA = {
  type: 'OBJECT' as const,
  properties: {
    translatedLyrics: {
      type: 'STRING' as const,
      description: 'Complete translated lyrics — every line must be included',
    },
    culturalContext: {
      type: 'STRING' as const,
      description: 'Cultural notes explaining idioms, code-switching, proverbs, and references',
    },
  },
  required: ['translatedLyrics'],
};

const MERGE_SCHEMA = {
  type: 'OBJECT' as const,
  properties: {
    translatedLyrics: { type: 'STRING' as const },
    culturalContext: { type: 'STRING' as const },
  },
  required: ['translatedLyrics', 'culturalContext'],
};

const LANGUAGE_DETECT_SCHEMA = {
  type: 'OBJECT' as const,
  properties: {
    languageCode: {
      type: 'STRING' as const,
      description: 'ISO language code from the recognized list',
    },
    confidence: {
      type: 'NUMBER' as const,
      description: 'Confidence score between 0.0 and 1.0',
    },
  },
  required: ['languageCode', 'confidence'],
};

const LANGUAGE_DETECT_PROMPT_SCHEMA = {
  type: 'OBJECT' as const,
  properties: {
    languageCode: {
      type: 'STRING' as const,
      description: 'Primary language code',
    },
    languageName: {
      type: 'STRING' as const,
      description: 'Human readable language name',
    },
    confidence: {
      type: 'STRING' as const,
      description: 'Confidence value: high, medium, or low',
    },
  },
  required: ['languageCode', 'languageName', 'confidence'],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GoogleGenAI = any;

export class GeminiProvider implements TranslationProvider {
  public readonly name = 'gemini';

  private ai: GoogleGenAI | null = null;

  private async getAi(): Promise<GoogleGenAI> {
    if (!this.ai) {
      const { GoogleGenAI } = await import('@google/genai');
      this.ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }
    return this.ai;
  }

  // Try models in fallback chain: primary → fallback1 → fallback2
  // Each model gets up to 2 retry attempts before moving to the next
  private async generateWithFallback(
    contents: string,
    config: Record<string, unknown>,
  ): Promise<{ text: string; usageMetadata?: any; model: string }> {
    const ai = await this.getAi();

    for (const model of MODEL_CHAIN) {
      try {
        const result = await withExponentialBackoff(async () =>
          ai.models.generateContent({ model, contents, config }),
        );
        return {
          text: result.text ?? '',
          usageMetadata: result.usageMetadata,
          model,
        };
      } catch (err) {
        if (isUnavailableError(err) && model !== MODEL_CHAIN[MODEL_CHAIN.length - 1]) {
          logger.warn({ failedModel: model, nextModel: MODEL_CHAIN[MODEL_CHAIN.indexOf(model) + 1] }, 'Model unavailable, falling back');
          continue;
        }
        throw err;
      }
    }

    throw new Error('All Gemini models are currently unavailable (503). Please try again later.');
  }

  async translate(params: TranslateParams): Promise<TranslationResult> {
    const { artist, title, lyrics, sourceLang, targetLang, promptVersion = CURRENT_PROMPT_VERSION } =
      params;

    const chunks = splitLyricsIntoChunks(lyrics);
    const isChunked = chunks.length > 1;

    logger.info(
      { lyricsLength: lyrics.length, chunks: chunks.length, isChunked },
      'Gemini translation started',
    );

    if (isChunked) {
      return this.translateChunked(artist, title, chunks, sourceLang, targetLang, promptVersion);
    }

    return this.translateSingle(artist, title, lyrics, sourceLang, targetLang, promptVersion);
  }

  private async translateSingle(
    artist: string,
    title: string,
    lyrics: string,
    sourceLang: string,
    targetLang: string,
    promptVersion: string,
  ): Promise<TranslationResult> {
    const prompt = buildTranslationPrompt(artist, title, lyrics, sourceLang, targetLang);

    const geminiResult = await this.generateWithFallback(prompt, {
      responseMimeType: 'application/json',
      responseSchema: TRANSLATION_SCHEMA,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 0 },
    });

    const rawText = geminiResult.text;

    let parsed: { translatedLyrics: string; culturalContext?: string };
    try {
      parsed = JSON.parse(extractJson(rawText)) as typeof parsed;
    } catch {
      throw new Error(`Gemini returned invalid JSON for translation: ${rawText.slice(0, 300)}`);
    }

    const tokensInput = geminiResult.usageMetadata?.promptTokenCount ?? 0;
    const tokensOutput = geminiResult.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      translatedLyrics: parsed.translatedLyrics,
      culturalContext: parsed.culturalContext,
      tokensInput,
      tokensOutput,
      tokensUsed: tokensInput + tokensOutput,
      model: geminiResult.model,
      promptVersion,
    };
  }

  private async translateChunked(
    artist: string,
    title: string,
    chunks: string[],
    sourceLang: string,
    targetLang: string,
    promptVersion: string,
  ): Promise<TranslationResult> {
    const translatedChunks: string[] = [];
    let totalTokensInput = 0;
    let totalTokensOutput = 0;

    for (let i = 0; i < chunks.length; i++) {
      logger.info({ chunk: i + 1, totalChunks: chunks.length, length: chunks[i].length }, 'Translating chunk');

      const result = await this.translateSingle(
        artist,
        title,
        chunks[i],
        sourceLang,
        targetLang,
        promptVersion,
      );

      translatedChunks.push(result.translatedLyrics);
      totalTokensInput += result.tokensInput;
      totalTokensOutput += result.tokensOutput;
    }

    // Merge chunks into final result
    const mergedTranslation = translatedChunks.join('\n\n');

    // For cultural context, try to merge via a lightweight API call
    let culturalContext: string | undefined;
    try {
      const mergePrompt = buildChunkMergePrompt(translatedChunks, sourceLang, targetLang);
      const mergeResult = await this.generateWithFallback(mergePrompt, {
        responseMimeType: 'application/json',
        responseSchema: MERGE_SCHEMA,
        maxOutputTokens: 16384,
        thinkingConfig: { thinkingBudget: 0 },
      });

      const mergeRaw = mergeResult.text;
      const mergeParsed = JSON.parse(extractJson(mergeRaw)) as { translatedLyrics: string; culturalContext: string };

      totalTokensInput += mergeResult.usageMetadata?.promptTokenCount ?? 0;
      totalTokensOutput += mergeResult.usageMetadata?.candidatesTokenCount ?? 0;

      return {
        translatedLyrics: mergeParsed.translatedLyrics,
        culturalContext: mergeParsed.culturalContext,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        tokensUsed: totalTokensInput + totalTokensOutput,
        model: mergeResult.model,
        promptVersion,
      };
    } catch (mergeErr) {
      // Merge failed — return the concatenated chunks as-is (still usable)
      logger.warn({ err: mergeErr }, 'Chunk merge failed, returning concatenated translation');
      return {
        translatedLyrics: mergedTranslation,
        culturalContext,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        tokensUsed: totalTokensInput + totalTokensOutput,
        model: PRIMARY_MODEL,
        promptVersion,
      };
    }
  }

  async detectLanguage(lyrics: string): Promise<LanguageDetectionResult> {
    const prompt = buildDetectLanguagePrompt(lyrics);

    const geminiResult = await this.generateWithFallback(prompt, {
      responseMimeType: 'application/json',
      responseSchema: LANGUAGE_DETECT_SCHEMA,
      maxOutputTokens: 256,
      thinkingConfig: { thinkingBudget: 0 },
    });

    const rawText = geminiResult.text;

    let parsed: { languageCode: string; confidence: number };
    try {
      parsed = JSON.parse(extractJson(rawText)) as typeof parsed;
    } catch {
      throw new Error(
        `Gemini returned invalid JSON for language detection: ${rawText.slice(0, 300)}`,
      );
    }

    const tokensInput = geminiResult.usageMetadata?.promptTokenCount ?? 0;
    const tokensOutput = geminiResult.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      languageCode: parsed.languageCode,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      tokensInput,
      tokensOutput,
      model: geminiResult.model,
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
    const geminiResult = await this.generateWithFallback(prompt, {
      responseMimeType: 'application/json',
      responseSchema: LANGUAGE_DETECT_PROMPT_SCHEMA,
      maxOutputTokens: 256,
      thinkingConfig: { thinkingBudget: 0 },
    });

    const rawText = geminiResult.text;

    let parsed: { languageCode: string; languageName: string; confidence: string };
    try {
      parsed = JSON.parse(extractJson(rawText)) as typeof parsed;
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

    const tokensInput = geminiResult.usageMetadata?.promptTokenCount ?? 0;
    const tokensOutput = geminiResult.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      languageCode: String(parsed.languageCode).trim(),
      languageName: String(parsed.languageName).trim(),
      confidence,
      tokensInput,
      tokensOutput,
      model: geminiResult.model,
    };
  }
}
