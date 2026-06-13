export interface TranslateParams {
  artist: string;
  title: string;
  lyrics: string;
  sourceLang: string;
  targetLang: string;
  promptVersion?: string;
}

export interface TranslationResult {
  translatedLyrics: string;
  culturalContext?: string;
  /** Input tokens consumed (for cost calculation) */
  tokensInput: number;
  /** Output tokens consumed (for cost calculation) */
  tokensOutput: number;
  /** Total tokens used */
  tokensUsed: number;
  model: string;
  promptVersion: string;
}

export interface LanguageDetectionResult {
  languageCode: string;
  confidence: number;
  /** Input tokens consumed */
  tokensInput: number;
  /** Output tokens consumed */
  tokensOutput: number;
  model: string;
}

export interface TranslationProvider {
  translate(params: TranslateParams): Promise<TranslationResult>;
  detectLanguage(lyrics: string): Promise<LanguageDetectionResult>;
  readonly name: string;
}

export interface TranslationJobData {
  songId: string;
  userId: string;
  sourceLang: string;
  targetLang: string;
  promptVersion: string;
}
