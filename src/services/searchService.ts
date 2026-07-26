import Typesense from 'typesense';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { ApiError } from '../middleware/errorHandler';

const COLLECTIONS = {
  songs: 'songs',
  artists: 'artists',
  genres: 'genres'
} as const;

export type SearchType = 'song' | 'artist' | 'genre' | 'all';

interface SearchParams {
  q?: string;
  type?: SearchType;
  lang?: string;
  genre?: string;
  page?: number;
  limit?: number;
}

interface SongDocument {
  id: string;
  title: string;
  titleNormalized: string;
  artistName: string;
  artistNameNormalized: string;
  artistId: string;
  album: string;
  releaseYear: number;
  imageUrl: string;
  language: string[];
  genre: string[];
  views: number;
  popularity: number;
  hasLyrics: boolean;
  hasTranslation: boolean;
}

interface ArtistDocument {
  id: string;
  name: string;
  nameNormalized: string;
  bio: string;
  imageUrl: string;
  genres: string[];
  popularity: number;
  followers: number;
}

interface GenreDocument {
  id: string;
  name: string;
  nameNormalized: string;
  imageUrl: string;
  songCount: number;
}

interface CollectionCreateSchema {
  name: string;
  fields: Array<{
    name: string;
    type: string;
    optional?: boolean;
    facet?: boolean;
  }>;
  default_sorting_field: string;
}

interface SearchResponseHit {
  document: Record<string, unknown>;
  text_match?: number;
  highlights?: unknown[];
}

interface SearchResponse {
  found: number;
  page: number;
  hits?: SearchResponseHit[];
}

interface MultiSearchResult {
  request_params: {
    collection_name: string;
  };
  hits?: SearchResponseHit[];
}

interface MultiSearchResponse {
  results: MultiSearchResult[];
}

const client = new Typesense.Client({
  nodes: [
    {
      host: env.TYPESENSE_HOST,
      port: env.TYPESENSE_PORT,
      protocol: env.TYPESENSE_PROTOCOL
    }
  ],
  apiKey: env.TYPESENSE_API_KEY,
  connectionTimeoutSeconds: Math.ceil(env.TYPESENSE_TIMEOUT_MS / 1000)
});

let collectionsReadyPromise: Promise<void> | null = null;

const collectionSchemas: CollectionCreateSchema[] = [
  {
    name: COLLECTIONS.songs,
    fields: [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'titleNormalized', type: 'string' },
      { name: 'artistName', type: 'string' },
      { name: 'artistNameNormalized', type: 'string' },
      { name: 'artistId', type: 'string' },
      { name: 'album', type: 'string', optional: true },
      { name: 'releaseYear', type: 'int32', optional: true },
      { name: 'imageUrl', type: 'string', optional: true },
      { name: 'language', type: 'string[]', facet: true },
      { name: 'genre', type: 'string[]', facet: true },
      { name: 'views', type: 'int32' },
      { name: 'popularity', type: 'int32' },
      { name: 'hasLyrics', type: 'bool', facet: true },
      { name: 'hasTranslation', type: 'bool', facet: true }
    ],
    default_sorting_field: 'popularity'
  },
  {
    name: COLLECTIONS.artists,
    fields: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'nameNormalized', type: 'string' },
      { name: 'bio', type: 'string', optional: true },
      { name: 'imageUrl', type: 'string', optional: true },
      { name: 'genres', type: 'string[]', facet: true },
      { name: 'popularity', type: 'int32' },
      { name: 'followers', type: 'int32' }
    ],
    default_sorting_field: 'popularity'
  },
  {
    name: COLLECTIONS.genres,
    fields: [
      { name: 'id', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'nameNormalized', type: 'string' },
      { name: 'imageUrl', type: 'string', optional: true },
      { name: 'songCount', type: 'int32' }
    ],
    default_sorting_field: 'songCount'
  }
];

const EMPTY_Q = '*';
const DEFAULT_LIMIT = 12;
const notDeletedFilter = { softDeleted: false } as Record<string, unknown>;

const normalizeText = (value: string | null | undefined): string => {
  return (value ?? '').trim();
};

const foldDiacritics = (value: string): string => {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
};

const computePopularity = (views: number, requestCount: number, artistPopularity: number): number => {
  return Math.max(0, views + requestCount * 3 + artistPopularity * 10);
};

const parseTypesenseErrorCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const maybe = error as { httpStatus?: number };
  return typeof maybe.httpStatus === 'number' ? maybe.httpStatus : undefined;
};

const ensureCollections = async (): Promise<void> => {
  if (collectionsReadyPromise) {
    await collectionsReadyPromise;
    return;
  }

  collectionsReadyPromise = (async () => {
    for (const schema of collectionSchemas) {
      try {
        await client.collections(schema.name).retrieve();
      } catch (error) {
        if (parseTypesenseErrorCode(error) !== 404) {
          throw error;
        }

        await client.collections().create(schema as never);
        logger.info({ collection: schema.name }, 'Created Typesense collection');
      }
    }
  })();

  await collectionsReadyPromise;
};

const buildSongDocument = async (songId: string): Promise<SongDocument | null> => {
  const song = await prisma.song.findFirst({
    where: { id: songId, ...notDeletedFilter } as Prisma.SongWhereInput,
    include: {
      artist: {
        select: {
          id: true,
          name: true,
          popularity: true,
          suspended: true
        }
      },
      songLanguages: {
        select: {
          languageCode: true
        }
      },
      genres: {
        include: {
          genre: {
            select: {
              name: true
            }
          }
        }
      },
      _count: {
        select: {
          lyrics: true,
          translations: true
        }
      }
    }
  } as Prisma.SongFindFirstArgs) as unknown as {
    id: string;
    title: string;
    albumName: string | null;
    releaseYear: number | null;
    imageUrl: string | null;
    views: number;
    requestCount: number;
    artist: { id: string; name: string; popularity: number; suspended: boolean };
    songLanguages: Array<{ languageCode: string }>;
    genres: Array<{ genre: { name: string } }>;
    _count: { lyrics: number; translations: number };
  } | null;

  if (!song) {
    return null;
  }

  if (song.artist.suspended) {
    return null;
  }

  return {
    id: song.id,
    title: song.title,
    titleNormalized: foldDiacritics(song.title),
    artistName: song.artist.name,
    artistNameNormalized: foldDiacritics(song.artist.name),
    artistId: song.artist.id,
    album: normalizeText(song.albumName),
    releaseYear: song.releaseYear ?? 0,
    imageUrl: normalizeText(song.imageUrl),
    language: song.songLanguages.map((item) => item.languageCode),
    genre: song.genres.map((item) => item.genre.name),
    views: song.views,
    popularity: computePopularity(song.views, song.requestCount, song.artist.popularity),
    hasLyrics: song._count.lyrics > 0,
    hasTranslation: song._count.translations > 0
  };
};

const buildArtistDocument = async (artistId: string): Promise<ArtistDocument | null> => {
  const artist = await prisma.artist.findFirst({
    where: { id: artistId, ...notDeletedFilter, suspended: false } as Prisma.ArtistWhereInput,
    select: {
      id: true,
      name: true,
      bio: true,
      imageUrl: true,
      genres: true,
      popularity: true,
      followers: true
    }
  } as Prisma.ArtistFindFirstArgs);

  if (!artist) {
    return null;
  }

  return {
    id: artist.id,
    name: artist.name,
    nameNormalized: foldDiacritics(artist.name),
    bio: normalizeText(artist.bio),
    imageUrl: normalizeText(artist.imageUrl),
    genres: artist.genres,
    popularity: artist.popularity,
    followers: artist.followers
  };
};

const buildGenreDocument = async (genreId: string): Promise<GenreDocument | null> => {
  const genre = await prisma.genre.findUnique({
    where: { id: genreId },
    select: {
      id: true,
      name: true,
      imageUrl: true,
      _count: {
        select: {
          songs: true
        }
      }
    }
  });

  if (!genre) {
    return null;
  }

  return {
    id: genre.id,
    name: genre.name,
    nameNormalized: foldDiacritics(genre.name),
    imageUrl: normalizeText(genre.imageUrl),
    songCount: genre._count.songs
  };
};

const mapHit = (hit: SearchResponseHit) => {
  return {
    document: hit.document,
    textMatch: hit.text_match,
    highlights: hit.highlights ?? []
  };
};

const songSearchParams = (q: string, page: number, limit: number, lang?: string, genre?: string) => {
  const filters = [
    lang ? `language:=[${JSON.stringify(lang)}]` : '',
    genre ? `genre:=[${JSON.stringify(genre)}]` : ''
  ].filter(Boolean);

  return {
    q,
    query_by: 'title,titleNormalized,artistName,artistNameNormalized,album,genre',
    sort_by: q === EMPTY_Q ? 'popularity:desc' : '_text_match:desc,popularity:desc',
    filter_by: filters.length > 0 ? filters.join(' && ') : undefined,
    page,
    per_page: limit,
    num_typos: 2,
    typo_tokens_threshold: 1,
    prefix: true,
    highlight_full_fields: 'title,artistName,album,genre',
    include_fields: 'id,title,artistName,artistId,album,releaseYear,imageUrl,language,genre,views,popularity,hasLyrics,hasTranslation',
    exhaustive_search: true,
    search_cutoff_ms: 1000
  };
};

const artistSearchParams = (q: string, page: number, limit: number) => {
  return {
    q,
    query_by: 'name,nameNormalized,genres,bio',
    sort_by: q === EMPTY_Q ? 'popularity:desc' : '_text_match:desc,popularity:desc',
    page,
    per_page: limit,
    num_typos: 2,
    typo_tokens_threshold: 1,
    prefix: true,
    highlight_full_fields: 'name,genres,bio',
    include_fields: 'id,name,bio,imageUrl,genres,popularity,followers',
    exhaustive_search: true,
    search_cutoff_ms: 1000
  };
};

const genreSearchParams = (q: string, page: number, limit: number) => {
  return {
    q,
    query_by: 'name,nameNormalized',
    sort_by: q === EMPTY_Q ? 'songCount:desc' : '_text_match:desc,songCount:desc',
    page,
    per_page: limit,
    num_typos: 1,
    typo_tokens_threshold: 1,
    prefix: true,
    highlight_full_fields: 'name',
    include_fields: 'id,name,imageUrl,songCount',
    exhaustive_search: true,
    search_cutoff_ms: 1000
  };
};

const runCollectionSearch = async (
  collection: (typeof COLLECTIONS)[keyof typeof COLLECTIONS],
  params: Record<string, unknown>
): Promise<SearchResponse> => {
  return client.collections(collection).documents().search(params) as Promise<SearchResponse>;
};

export const searchCatalog = async (input: SearchParams) => {
  await ensureCollections();

  const start = Date.now();
  const q = input.q?.trim() ? input.q.trim() : EMPTY_Q;
  const type = input.type ?? 'all';
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), 100);
  const lang = input.lang?.trim().toLowerCase();
  const genre = input.genre?.trim();

  const response: {
    query: string;
    type: SearchType;
    page: number;
    limit: number;
    tookMs: number;
    songs?: { found: number; page: number; hits: ReturnType<typeof mapHit>[] };
    artists?: { found: number; page: number; hits: ReturnType<typeof mapHit>[] };
    genres?: { found: number; page: number; hits: ReturnType<typeof mapHit>[] };
  } = {
    query: q === EMPTY_Q ? '' : q,
    type,
    page,
    limit,
    tookMs: 0
  };

  if (type === 'song') {
    const songs = await runCollectionSearch(COLLECTIONS.songs, songSearchParams(q, page, limit, lang, genre));
    response.songs = {
      found: songs.found,
      page: songs.page,
      hits: songs.hits?.map(mapHit) ?? []
    };
  } else if (type === 'artist') {
    const artists = await runCollectionSearch(COLLECTIONS.artists, artistSearchParams(q, page, limit));
    response.artists = {
      found: artists.found,
      page: artists.page,
      hits: artists.hits?.map(mapHit) ?? []
    };
  } else if (type === 'genre') {
    const genres = await runCollectionSearch(COLLECTIONS.genres, genreSearchParams(q, page, limit));
    response.genres = {
      found: genres.found,
      page: genres.page,
      hits: genres.hits?.map(mapHit) ?? []
    };
  } else {
    const [songs, artists, genres] = await Promise.all([
      runCollectionSearch(COLLECTIONS.songs, songSearchParams(q, page, limit, lang, genre)),
      runCollectionSearch(COLLECTIONS.artists, artistSearchParams(q, page, limit)),
      runCollectionSearch(COLLECTIONS.genres, genreSearchParams(q, page, limit))
    ]);

    response.songs = {
      found: songs.found,
      page: songs.page,
      hits: songs.hits?.map(mapHit) ?? []
    };
    response.artists = {
      found: artists.found,
      page: artists.page,
      hits: artists.hits?.map(mapHit) ?? []
    };
    response.genres = {
      found: genres.found,
      page: genres.page,
      hits: genres.hits?.map(mapHit) ?? []
    };
  }

  response.tookMs = Date.now() - start;
  return response;
};

export const suggestCatalog = async (query: string) => {
  await ensureCollections();

  const start = Date.now();
  const q = query.trim();
  if (!q) {
    throw new ApiError('q is required', 'VALIDATION_ERROR', 400);
  }

  const multi = (await client.multiSearch.perform({
    searches: [
      {
        collection: COLLECTIONS.songs,
        q,
        query_by: 'title,titleNormalized,artistName,artistNameNormalized',
        include_fields: 'id,title,artistName,imageUrl,popularity',
        sort_by: '_text_match:desc,popularity:desc',
        per_page: 5,
        num_typos: 2,
        typo_tokens_threshold: 1,
        prefix: true,
        exhaustive_search: false,
        search_cutoff_ms: 90
      },
      {
        collection: COLLECTIONS.artists,
        q,
        query_by: 'name,nameNormalized',
        include_fields: 'id,name,imageUrl,popularity',
        sort_by: '_text_match:desc,popularity:desc',
        per_page: 5,
        num_typos: 2,
        typo_tokens_threshold: 1,
        prefix: true,
        exhaustive_search: false,
        search_cutoff_ms: 90
      },
      {
        collection: COLLECTIONS.genres,
        q,
        query_by: 'name,nameNormalized',
        include_fields: 'id,name,imageUrl,songCount',
        sort_by: '_text_match:desc,songCount:desc',
        per_page: 3,
        num_typos: 1,
        typo_tokens_threshold: 1,
        prefix: true,
        exhaustive_search: false,
        search_cutoff_ms: 90
      }
    ]
  })) as MultiSearchResponse;

  const mapped = multi.results.flatMap((result) => {
    const collection = result.request_params.collection_name;
    return (result.hits ?? []).map((hit) => ({
      type: collection === COLLECTIONS.songs ? 'song' : collection === COLLECTIONS.artists ? 'artist' : 'genre',
      textMatch: hit.text_match,
      highlights: hit.highlights ?? [],
      document: hit.document
    }));
  });

  mapped.sort((a, b) => {
    const diff = (b.textMatch ?? 0) - (a.textMatch ?? 0);
    if (diff !== 0) {
      return diff;
    }

    const aPopularity = Number((a.document as { popularity?: number; songCount?: number }).popularity ?? (a.document as { songCount?: number }).songCount ?? 0);
    const bPopularity = Number((b.document as { popularity?: number; songCount?: number }).popularity ?? (b.document as { songCount?: number }).songCount ?? 0);
    return bPopularity - aPopularity;
  });

  const tookMs = Date.now() - start;

  return {
    query: q,
    tookMs,
    suggestions: mapped.slice(0, 8)
  };
};

export const indexSong = async (songId: string): Promise<void> => {
  await ensureCollections();

  const document = await buildSongDocument(songId);
  if (!document) {
    await deleteSong(songId);
    return;
  }

  await client.collections(COLLECTIONS.songs).documents().upsert(document);
};

export const indexArtist = async (artistId: string): Promise<void> => {
  await ensureCollections();

  const document = await buildArtistDocument(artistId);
  if (!document) {
    try {
      await client.collections(COLLECTIONS.artists).documents(artistId).delete();
    } catch (error) {
      if (parseTypesenseErrorCode(error) !== 404) {
        throw error;
      }
    }
    return;
  }

  await client.collections(COLLECTIONS.artists).documents().upsert(document);
};

export const deleteSong = async (songId: string): Promise<void> => {
  await ensureCollections();

  try {
    await client.collections(COLLECTIONS.songs).documents(songId).delete();
  } catch (error) {
    if (parseTypesenseErrorCode(error) === 404) {
      return;
    }

    throw error;
  }
};

export const deleteArtist = async (artistId: string): Promise<void> => {
  await ensureCollections();

  try {
    await client.collections(COLLECTIONS.artists).documents(artistId).delete();
  } catch (error) {
    if (parseTypesenseErrorCode(error) === 404) {
      return;
    }

    throw error;
  }
};

export const bulkIndex = async (): Promise<void> => {
  await ensureCollections();

  const [songs, artists, genres] = await Promise.all([
    prisma.song.findMany({
      where: { ...notDeletedFilter } as Prisma.SongWhereInput,
      include: {
        artist: { select: { id: true, name: true, popularity: true } },
        songLanguages: { select: { languageCode: true } },
        genres: { include: { genre: { select: { name: true } } } },
        _count: { select: { lyrics: true, translations: true } }
      }
    }),
    prisma.artist.findMany({
      where: { ...notDeletedFilter, suspended: false } as Prisma.ArtistWhereInput,
      select: {
        id: true,
        name: true,
        bio: true,
        imageUrl: true,
        genres: true,
        popularity: true,
        followers: true
      }
    }),
    prisma.genre.findMany({
      select: {
        id: true,
        name: true,
        imageUrl: true,
        _count: {
          select: {
            songs: true
          }
        }
      }
    })
  ]);

  const songDocuments: SongDocument[] = songs.map((song) => ({
    id: song.id,
    title: song.title,
    titleNormalized: foldDiacritics(song.title),
    artistName: song.artist.name,
    artistNameNormalized: foldDiacritics(song.artist.name),
    artistId: song.artist.id,
    album: normalizeText(song.albumName),
    releaseYear: song.releaseYear ?? 0,
    imageUrl: normalizeText(song.imageUrl),
    language: song.songLanguages.map((item) => item.languageCode),
    genre: song.genres.map((item) => item.genre.name),
    views: song.views,
    popularity: computePopularity(song.views, song.requestCount, song.artist.popularity),
    hasLyrics: song._count.lyrics > 0,
    hasTranslation: song._count.translations > 0
  }));

  const artistDocuments: ArtistDocument[] = artists.map((artist) => ({
    id: artist.id,
    name: artist.name,
    nameNormalized: foldDiacritics(artist.name),
    bio: normalizeText(artist.bio),
    imageUrl: normalizeText(artist.imageUrl),
    genres: artist.genres,
    popularity: artist.popularity,
    followers: artist.followers
  }));

  const genreDocuments: GenreDocument[] = genres.map((genre) => ({
    id: genre.id,
    name: genre.name,
    nameNormalized: foldDiacritics(genre.name),
    imageUrl: normalizeText(genre.imageUrl),
    songCount: genre._count.songs
  }));

  await Promise.all([
    client.collections(COLLECTIONS.songs).documents().import(songDocuments, { action: 'upsert' }),
    client.collections(COLLECTIONS.artists).documents().import(artistDocuments, { action: 'upsert' }),
    client.collections(COLLECTIONS.genres).documents().import(genreDocuments, { action: 'upsert' })
  ]);
};

export const refreshGenre = async (genreId: string): Promise<void> => {
  await ensureCollections();

  const document = await buildGenreDocument(genreId);
  if (!document) {
    return;
  }

  await client.collections(COLLECTIONS.genres).documents().upsert(document);
};

export const searchCollections = COLLECTIONS;
