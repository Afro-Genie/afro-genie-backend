export interface LyricsSearchResult {
  trackId: string;
  title: string;
  artist: string;
}

export interface LyricsProvider {
  name: string;
  search(artist: string, title: string): Promise<LyricsSearchResult[] | null>;
  fetchLyrics(trackId: string): Promise<string | null>;
}
