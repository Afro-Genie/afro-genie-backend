const wiki = (title: string) => `https://en.wikipedia.org/wiki/${title}`;
// Used where the exact article title is uncertain; jumps to the best-matching article.
const wikiSearch = (query: string) =>
  `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}&go=Go`;

const COUNTRY_ARTISTS_EXTRA = [
  {
    name: "Nigerian artists",
    artists: [
      { name: "Fela Kuti", source: wiki("Fela_Kuti") },
      { name: "King Sunny Adé", source: wiki("King_Sunny_Ad%C3%A9") },
      { name: "Femi Kuti", source: wiki("Femi_Kuti") },
      { name: "Seun Kuti", source: wiki("Seun_Kuti") },
    ],
  },
  {
    name: "Ghanaian artists",
    artists: [
      { name: "Ebo Taylor", source: wiki("Ebo_Taylor") },
      { name: "Reggie Rockstone", source: wiki("Reggie_Rockstone") },
      { name: "Rocky Dawuni", source: wiki("Rocky_Dawuni") },
      { name: "Gyakie", source: wiki("Gyakie") },
    ],
  },
  {
    name: "South African artists",
    artists: [
      { name: "Hugh Masekela", source: wiki("Hugh_Masekela") },
      { name: "Brenda Fassie", source: wiki("Brenda_Fassie") },
      { name: "Sho Madjozi", source: wiki("Sho_Madjozi") },
      { name: "Yvonne Chaka Chaka", source: wiki("Yvonne_Chaka_Chaka") },
    ],
  },
  {
    name: "Kenyan artists",
    artists: [
      { name: "Eric Wainaina", source: wiki("Eric_Wainaina") },
      { name: "Suzanna Owiyo", source: wiki("Suzanna_Owiyo") },
      { name: "Khaligraph Jones", source: wiki("Khaligraph_Jones") },
      { name: "Nyashinski", source: wiki("Nyashinski") },
    ],
  },
  {
    name: "Tanzanian artists",
    artists: [
      { name: "Nandy", source: wikiSearch("Nandy Tanzanian singer") },
      { name: "Zuchu", source: wiki("Zuchu") },
      { name: "Lady Jaydee", source: wiki("Lady_Jaydee") },
      { name: "Professor Jay", source: wiki("Professor_Jay") },
    ],
  },
  {
    name: "Ugandan artists",
    artists: [
      { name: "Eddy Kenzo", source: wiki("Eddy_Kenzo") },
      { name: "Jose Chameleone", source: wiki("Jose_Chameleone") },
      { name: "Bebe Cool", source: wiki("Bebe_Cool") },
      { name: "Geoffrey Oryema", source: wiki("Geoffrey_Oryema") },
    ],
  },
  {
    name: "Senegalese artists",
    artists: [
      { name: "Youssou N’Dour", source: wiki("Youssou_N'Dour") },
      { name: "Baaba Maal", source: wiki("Baaba_Maal") },
      { name: "Ismaël Lô", source: wiki("Isma%C3%ABl_L%C3%B4") },
      { name: "Cheikh Lô", source: wiki("Cheikh_L%C3%B4") },
    ],
  },
  {
    name: "Ivorian artists",
    artists: [
      { name: "Alpha Blondy", source: wiki("Alpha_Blondy") },
      { name: "Tiken Jah Fakoly", source: wiki("Tiken_Jah_Fakoly") },
      { name: "Dobet Gnahoré", source: wiki("Dobet_Gnahor%C3%A9") },
      { name: "Magic System", source: wiki("Magic_System") },
    ],
  },
  {
    name: "Algerian artists",
    artists: [
      { name: "Cheb Khaled", source: wiki("Khaled_(musician)") },
      { name: "Rachid Taha", source: wiki("Rachid_Taha") },
      { name: "Cheb Mami", source: wiki("Cheb_Mami") },
      { name: "Souad Massi", source: wiki("Souad_Massi") },
    ],
  },
  {
    name: "Moroccan artists",
    artists: [
      { name: "Saad Lamjarred", source: wiki("Saad_Lamjarred") },
      { name: "Hindi Zahra", source: wiki("Hindi_Zahra") },
      { name: "Oum", source: wikiSearch("Oum Moroccan singer") },
      {
        name: "Manal Benchlikha",
        source: wikiSearch("Manal Benchlikha Moroccan singer"),
      },
    ],
  },
] as const;

const BOARD_COUNT = 90;

// Small seeded PRNG so the board set is varied but identical on every run.
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every possible group of four countries (C(10, 4) = 210 combinations).
const ALL_GROUP_COMBINATIONS: number[][] = [];
for (let first = 0; first < COUNTRY_ARTISTS_EXTRA.length - 3; first += 1) {
  for (
    let second = first + 1;
    second < COUNTRY_ARTISTS_EXTRA.length - 2;
    second += 1
  ) {
    for (
      let third = second + 1;
      third < COUNTRY_ARTISTS_EXTRA.length - 1;
      third += 1
    ) {
      for (
        let fourth = third + 1;
        fourth < COUNTRY_ARTISTS_EXTRA.length;
        fourth += 1
      ) {
        ALL_GROUP_COMBINATIONS.push([first, second, third, fourth]);
      }
    }
  }
}

// Shuffle all combinations (Fisher-Yates, seeded) and take the first BOARD_COUNT,
// so every country appears about equally often instead of the first few dominating.
const random = mulberry32(20260604);
const shuffled = [...ALL_GROUP_COMBINATIONS];
for (let i = shuffled.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const EXTRA_BOARD_GROUPS: number[][] = shuffled.slice(0, BOARD_COUNT);

export const BOARDS_EXTRA = EXTRA_BOARD_GROUPS.map((groupIndexes) =>
  groupIndexes.map((groupIndex) => {
    const group = COUNTRY_ARTISTS_EXTRA[groupIndex];
    return { name: group.name, items: group.artists.map(({ name }) => name) };
  }),
);

export const BOARD_SOURCES_EXTRA = EXTRA_BOARD_GROUPS.map((groupIndexes) =>
  groupIndexes.flatMap((groupIndex) =>
    COUNTRY_ARTISTS_EXTRA[groupIndex].artists.map(({ source }) => source),
  ),
);
