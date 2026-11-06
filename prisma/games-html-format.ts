const wiki = (title: string) => `https://en.wikipedia.org/wiki/${title}`;

export const SONGS = [
  {
    title: "Essence",
    artist: "Wizkid ft. Tems",
    clues: [
      "A 2020 song by two Nigerian singers",
      "It was released as a single from Made in Lagos",
      "It features Nigerian singer Tems",
      "A remix features Justin Bieber",
      "Its title is a single word",
      "The title begins with E",
    ],
  },
  {
    title: "Last Last",
    artist: "Burna Boy",
    clues: [
      "A 2022 single by a Nigerian singer",
      "It was released from Love, Damini",
      "It samples Toni Braxton’s He Wasn’t Man Enough",
      "It was released in May 2022",
      "Its title repeats the same word",
      "The artist’s first name is Damini",
    ],
  },
  {
    title: "Calm Down",
    artist: "Rema",
    clues: [
      "A song by Nigerian singer Rema",
      "It appears on Rave & Roses",
      "It was released in February 2022",
      "A remix features Selena Gomez",
      "The remix reached the US Billboard Hot 100 top three",
      "Its title has two words",
    ],
  },
  {
    title: "Jerusalema",
    artist: "Master KG ft. Nomcebo Zikode",
    clues: [
      "A song by South African producer Master KG",
      "It features vocalist Nomcebo Zikode",
      "Its lyrics are in isiZulu",
      "It was initially released in November 2019",
      "A dance challenge helped it gain international attention",
      "The title is one word",
    ],
  },
  {
    title: "Water",
    artist: "Tyla",
    clues: [
      "A song by South African singer Tyla",
      "It was released in July 2023",
      "It is included on Tyla’s debut album",
      "It blends amapiano with pop and R&B",
      "It won the inaugural Grammy for Best African Music Performance",
      "The title is one word",
    ],
  },
  {
    title: "Love Nwantiti",
    artist: "CKay",
    clues: [
      "A song by Nigerian singer CKay",
      "It appeared on Ckay the First",
      "It was released in 2019",
      "It gained international chart success in 2021",
      "A remix features Joeboy and Kuami Eugene",
      "Its title has two words",
    ],
  },
  {
    title: "Pata Pata",
    artist: "Miriam Makeba",
    clues: [
      "An Afro-pop dance song popularized by a South African singer",
      "It is associated with Miriam Makeba",
      "Her best-known recording was released in the United States in 1967",
      "The composition is credited to Makeba and Jerry Ragovoy",
      "The title repeats the same word",
      "The artist was widely known as Mama Africa",
    ],
  },
  {
    title: "Duduke",
    artist: "Simi",
    clues: [
      "A song by Nigerian singer Simi",
      "It was released in April 2020",
      "The song was produced by Oscar",
      "The artist is a Nigerian singer-songwriter",
      "The title is one word",
      "The title begins with D",
    ],
  },
  {
    title: "Fall",
    artist: "Davido",
    clues: [
      "A 2017 song by Nigerian singer Davido",
      "It was released as a single in June 2017",
      "The song was produced by Kiddominant",
      "Davido was born in Atlanta and raised in Lagos",
      "The title is one word",
      "The title begins with F",
    ],
  },
  {
    title: "Rush",
    artist: "Ayra Starr",
    clues: [
      "A song by Nigerian singer Ayra Starr",
      "It was released in September 2022",
      "It was nominated for the Grammy for Best African Music Performance",
      "Ayra Starr was born in Cotonou, Benin",
      "The title is one word",
      "The title begins with R",
    ],
  },
] as const;

export const ARTISTS = [
  {
    name: "Burna Boy",
    country: "Nigeria",
    region: "West",
    genre: "Afro-fusion",
    debut: 2013,
    gender: "Male",
    size: 1,
  },
  {
    name: "Wizkid",
    country: "Nigeria",
    region: "West",
    genre: "Afrobeats",
    debut: 2011,
    gender: "Male",
    size: 1,
  },
  {
    name: "Davido",
    country: "Nigeria",
    region: "West",
    genre: "Afrobeats",
    debut: 2012,
    gender: "Male",
    size: 1,
  },
  {
    name: "Tems",
    country: "Nigeria",
    region: "West",
    genre: "Alté",
    debut: 2018,
    gender: "Female",
    size: 1,
  },
  {
    name: "Rema",
    country: "Nigeria",
    region: "West",
    genre: "Afrobeats",
    debut: 2019,
    gender: "Male",
    size: 1,
  },
  {
    name: "Ayra Starr",
    country: "Nigeria",
    region: "West",
    genre: "Afropop",
    debut: 2021,
    gender: "Female",
    size: 1,
  },
  {
    name: "Asake",
    country: "Nigeria",
    region: "West",
    genre: "Afrobeats",
    debut: 2022,
    gender: "Male",
    size: 1,
  },
  {
    name: "Tiwa Savage",
    country: "Nigeria",
    region: "West",
    genre: "Afrobeats",
    debut: 2010,
    gender: "Female",
    size: 1,
  },
  {
    name: "Yemi Alade",
    country: "Nigeria",
    region: "West",
    genre: "Afropop",
    debut: 2014,
    gender: "Female",
    size: 1,
  },
  {
    name: "Kizz Daniel",
    country: "Nigeria",
    region: "West",
    genre: "Afrobeats",
    debut: 2016,
    gender: "Male",
    size: 1,
  },
] as const;

export const ARTIST_HINTS = {
  "Burna Boy": [
    "English, Yoruba and Nigerian Pidgin",
    "A Nigerian singer-songwriter and record producer",
    "Last Last",
  ],
  Wizkid: [
    "Yoruba, English and Nigerian Pidgin",
    "A Nigerian singer whose album Made in Lagos includes Essence",
    "Essence",
  ],
  Davido: ["English and Yoruba", "Born in Atlanta and raised in Lagos", "Fall"],
  Tems: [
    "English and Nigerian Pidgin",
    "A Nigerian singer who featured on Wizkid’s Essence",
    "Free Mind",
  ],
  Rema: [
    "English and Nigerian Pidgin",
    "A Nigerian singer from Benin City",
    "Calm Down",
  ],
  "Ayra Starr": [
    "English, Yoruba and Nigerian Pidgin",
    "A Nigerian singer born in Cotonou",
    "Rush",
  ],
  Asake: [
    "Yoruba and Nigerian Pidgin",
    "A Nigerian singer who rose to prominence in 2022",
    "Omo Ope",
  ],
  "Tiwa Savage": [
    "English and Yoruba",
    "A Nigerian singer-songwriter",
    "Somebody’s Son",
  ],
  "Yemi Alade": [
    "English, Yoruba and Igbo",
    "A Nigerian singer known for the song Johnny",
    "Johnny",
  ],
  "Kizz Daniel": [
    "English, Yoruba and Nigerian Pidgin",
    "A Nigerian singer whose 2022 single Buga features Tekno",
    "Buga",
  ],
} as const;

export const BOARDS = [
  [
    {
      name: "Nigerian artists",
      items: ["Burna Boy", "Wizkid", "Davido", "Rema"],
    },
    {
      name: "Songs by Rema",
      items: ["Calm Down", "Dumebi", "Soundgasm", "Iron Man"],
    },
    {
      name: "Women of Nigerian pop",
      items: ["Tems", "Ayra Starr", "Tiwa Savage", "Yemi Alade"],
    },
    {
      name: "Nigerian singers",
      items: ["Asake", "Kizz Daniel", "Simi", "CKay"],
    },
  ],
  [
    {
      name: "Artists from Ghana",
      items: ["Sarkodie", "Stonebwoy", "Black Sherif", "Amaarae"],
    },
    {
      name: "Artists from South Africa",
      items: ["Tyla", "Miriam Makeba", "Master KG", "Nomcebo Zikode"],
    },
    {
      name: "Artists from East Africa",
      items: ["Diamond Platnumz", "Sauti Sol", "Harmonize", "Rayvanny"],
    },
    {
      name: "Artists from Nigeria",
      items: ["Wizkid", "Davido", "Burna Boy", "Tems"],
    },
  ],
  [
    {
      name: "Songs with Selena Gomez features",
      items: ["Taki Taki", "It Ain’t Me", "Wolves", "Calm Down (Remix)"],
    },
    {
      name: "Nigerian songs released in 2022",
      items: ["Last Last", "Terminator", "Buga", "Rush"],
    },
    {
      name: "Songs with one-word titles",
      items: ["Water", "Duduke", "Fall", "Dumebi"],
    },
    {
      name: "Nigerian artists",
      items: ["Simi", "Ayra Starr", "Davido", "Rema"],
    },
  ],
  [
    {
      name: "Songs by Burna Boy",
      items: ["Ye", "Anybody", "Onyeka", "Last Last"],
    },
    {
      name: "Songs by Wizkid",
      items: ["Essence", "Joro", "Ojuelegba", "Fever"],
    },
    { name: "Songs by Davido", items: ["Fall", "If", "Aye", "FIA"] },
    {
      name: "Songs by Tiwa Savage",
      items: ["All Over", "Ma Lo", "Koroba", "Somebody’s Son"],
    },
  ],
  [
    {
      name: "Nigerian female singers",
      items: ["Simi", "Tems", "Tiwa Savage", "Yemi Alade"],
    },
    {
      name: "Nigerian male singers",
      items: ["Wizkid", "Davido", "Kizz Daniel", "Asake"],
    },
    {
      name: "Songs released in 2020",
      items: ["Essence", "Duduke", "Way Too Big", "Ginger"],
    },
    {
      name: "Songs released in 2023",
      items: ["Water", "Unavailable", "Amapiano", "Lonely At The Top"],
    },
  ],
  [
    {
      name: "Songs from Made in Lagos",
      items: ["Essence", "Ginger", "No Stress", "Smile"],
    },
    {
      name: "Songs from Love, Damini",
      items: ["Last Last", "For My Hand", "Kilometre", "It’s Plenty"],
    },
    {
      name: "Songs from Rave & Roses",
      items: ["Calm Down", "Soundgasm", "Dumebi", "Time N Affection"],
    },
    {
      name: "Songs from 19 & Dangerous",
      items: [
        "Bloody Samaritan",
        "Beggie Beggie",
        "Lagos Love Story",
        "Last Heartbreak Song",
      ],
    },
  ],
  [
    {
      name: "Nigerian collaboration tracks",
      items: ["Essence", "Peru", "Buga", "For My Hand"],
    },
    {
      name: "Songs with dance challenges",
      items: ["Jerusalema", "Love Nwantiti", "Calm Down", "Water"],
    },
    {
      name: "South African performers",
      items: ["Tyla", "Master KG", "Nomcebo Zikode", "Black Coffee"],
    },
    {
      name: "Songs by Ghanaian artists",
      items: [
        "Kwaku the Traveller",
        "Second Sermon",
        "Adonai",
        "Sad Girlz Luv Money",
      ],
    },
  ],
  [
    {
      name: "Nigerian music groups",
      items: ["P-Square", "Bracket", "Plantashun Boiz", "Styl-Plus"],
    },
    {
      name: "Nigerian solo artists",
      items: ["Burna Boy", "Wizkid", "Davido", "Asake"],
    },
    {
      name: "Ghanaian solo artists",
      items: ["Sarkodie", "Stonebwoy", "Black Sherif", "King Promise"],
    },
    {
      name: "Kenyan music groups",
      items: [
        "Sauti Sol",
        "Necessary Noize",
        "Gidi Gidi Maji Maji",
        "Them Mushrooms",
      ],
    },
  ],
  [
    {
      name: "Afrobeats artists from Nigeria",
      items: ["Wizkid", "Davido", "Asake", "Kizz Daniel"],
    },
    {
      name: "Amapiano performers",
      items: ["Kabza De Small", "DJ Maphorisa", "Uncle Waffles", "Focalistic"],
    },
    {
      name: "Bongo Flava performers",
      items: ["Diamond Platnumz", "Ali Kiba", "Harmonize", "Rayvanny"],
    },
    {
      name: "Ghanaian hip-hop artists",
      items: ["Sarkodie", "Black Sherif", "Medikal", "M.anifest"],
    },
  ],
  [
    {
      name: "Songs by Ayra Starr",
      items: ["Rush", "Beggie Beggie", "Bloody Samaritan", "Lagos Love Story"],
    },
    { name: "Songs by Kizz Daniel", items: ["Buga", "Cough", "Lie", "Woju"] },
    {
      name: "Songs by Simi",
      items: ["Duduke", "Joromi", "Jericho", "Love Don’t Care"],
    },
    {
      name: "Songs by Yemi Alade",
      items: ["Johnny", "Tangerine", "Na Gode", "Tumbum"],
    },
  ],
] as const;

// Each trivia question carries its own source URL so the questions and sources can never fall out of step.
interface TriviaSeed {
  q: string;
  a: [string, string, string, string];
  c: number;
  f: string;
  s: string;
}

const TRIVIA_SEEDS: TriviaSeed[][] = [
  [
    {
      q: "Which song won the first Grammy for Best African Music Performance?",
      a: [
        "Water — Tyla",
        "Essence — Wizkid ft. Tems",
        "Calm Down — Rema",
        "Last Last — Burna Boy",
      ],
      c: 0,
      f: "Tyla’s Water received the inaugural award in the category.",
      s: wiki("Water_(Tyla_song)"),
    },
    {
      q: "Which country is amapiano associated with?",
      a: ["Nigeria", "Ghana", "South Africa", "Kenya"],
      c: 2,
      f: "Amapiano developed in South Africa.",
      s: wiki("Amapiano"),
    },
    {
      q: "Who released the album Love, Damini?",
      a: ["Wizkid", "Davido", "Rema", "Burna Boy"],
      c: 3,
      f: "Love, Damini is an album by Burna Boy.",
      s: wiki("Love,_Damini"),
    },
    {
      q: "Who features on the remix of Rema’s Calm Down?",
      a: ["Dua Lipa", "Selena Gomez", "Rihanna", "Doja Cat"],
      c: 1,
      f: "The remix features American singer Selena Gomez.",
      s: wiki("Calm_Down_(Rema_song)"),
    },
    {
      q: "What language are Jerusalema’s lyrics in?",
      a: ["Yoruba", "Swahili", "isiZulu", "Twi"],
      c: 2,
      f: "The song’s lyrics are in isiZulu.",
      s: wiki("Jerusalema"),
    },
  ],
  [
    {
      q: "Which Nigerian artist released Essence?",
      a: ["Davido", "Wizkid", "Asake", "Burna Boy"],
      c: 1,
      f: "Essence was released by Wizkid and features Tems.",
      s: wiki("Essence_(Wizkid_song)"),
    },
    {
      q: "Which album includes Rema’s Calm Down?",
      a: ["Rave & Roses", "Made in Lagos", "19 & Dangerous", "A Good Time"],
      c: 0,
      f: "Calm Down appears on Rema’s debut album Rave & Roses.",
      s: wiki("Rave_%26_Roses"),
    },
    {
      q: "Which song samples Toni Braxton’s He Wasn’t Man Enough?",
      a: ["Fall", "Duduke", "Last Last", "Rush"],
      c: 2,
      f: "Burna Boy’s Last Last samples the song.",
      s: wiki("Last_Last"),
    },
    {
      q: "Who performed Pata Pata?",
      a: ["Miriam Makeba", "Simi", "Tems", "Yemi Alade"],
      c: 0,
      f: "Miriam Makeba popularized the Afro-pop dance song.",
      s: wiki("Pata_Pata"),
    },
    {
      q: "Who produced Simi’s song Duduke?",
      a: ["Kiddominant", "Oscar", "P2J", "Reward Beatz"],
      c: 1,
      f: "Duduke was produced by Oscar.",
      s: wiki("Simi_(singer)"),
    },
  ],
  [
    {
      q: "Which singer released Water in 2023?",
      a: ["Tyla", "Tems", "Amaarae", "Ayra Starr"],
      c: 0,
      f: "Water is a 2023 single by South African singer Tyla.",
      s: wiki("Water_(Tyla_song)"),
    },
    {
      q: "Who is the featured singer on Jerusalema?",
      a: ["Tiwa Savage", "Nomcebo Zikode", "Tems", "Yemi Alade"],
      c: 1,
      f: "Jerusalema features South African vocalist Nomcebo Zikode.",
      s: wiki("Jerusalema"),
    },
    {
      q: "Which artist released Fall in 2017?",
      a: ["Davido", "Wizkid", "Rema", "Kizz Daniel"],
      c: 0,
      f: "Fall is a 2017 single by Davido.",
      s: wiki("Fall_(Davido_song)"),
    },
    {
      q: "Who is the lead artist on Rush?",
      a: ["Simi", "Ayra Starr", "Tiwa Savage", "Tems"],
      c: 1,
      f: "Rush is a song by Nigerian singer Ayra Starr.",
      s: wiki("Ayra_Starr"),
    },
    {
      q: "Which artist released the album Made in Lagos?",
      a: ["Davido", "Wizkid", "Burna Boy", "Asake"],
      c: 1,
      f: "Made in Lagos is Wizkid’s fourth studio album.",
      s: wiki("Made_in_Lagos"),
    },
  ],
  [
    {
      q: "What is the title of Ayra Starr’s 2021 debut album?",
      a: ["Rave & Roses", "19 & Dangerous", "A Good Time", "Love, Damini"],
      c: 1,
      f: "19 & Dangerous is Ayra Starr’s debut studio album.",
      s: wiki("19_%26_Dangerous"),
    },
    {
      q: "Who collaborated with Wizkid on Essence?",
      a: ["Simi", "Tems", "Tyla", "Amaarae"],
      c: 1,
      f: "Essence features fellow Nigerian singer Tems.",
      s: wiki("Essence_(Wizkid_song)"),
    },
    {
      q: "Which artist performs Kwaku the Traveller?",
      a: ["Sarkodie", "Black Sherif", "Stonebwoy", "King Promise"],
      c: 1,
      f: "Kwaku the Traveller is a song by Ghanaian musician Black Sherif.",
      s: wiki("Kwaku_the_Traveller"),
    },
    {
      q: "Which pair is credited with the composition of Pata Pata?",
      a: [
        "Makeba and Jerry Ragovoy",
        "Makeba and Hugh Masekela",
        "Makeba and Fela Kuti",
        "Makeba and Miriam Tlali",
      ],
      c: 0,
      f: "The composition is credited to Miriam Makeba and Jerry Ragovoy.",
      s: wiki("Pata_Pata"),
    },
    {
      q: "Which producer made Jerusalema?",
      a: ["Master KG", "Kabza De Small", "DJ Maphorisa", "Black Coffee"],
      c: 0,
      f: "Jerusalema is by South African DJ and producer Master KG.",
      s: wiki("Jerusalema"),
    },
  ],
  [
    {
      q: "Which Nigerian singer released Love Nwantiti?",
      a: ["CKay", "Davido", "Wizkid", "Rema"],
      c: 0,
      f: "Love Nwantiti is a song by Nigerian singer CKay.",
      s: wiki("Love_Nwantiti"),
    },
    {
      q: "Which artist released Duduke in 2020?",
      a: ["Simi", "Tems", "Tiwa Savage", "Yemi Alade"],
      c: 0,
      f: "Duduke is a 2020 song by Nigerian singer Simi.",
      s: wiki("Simi_(singer)"),
    },
    {
      q: "Which artist released Buga with Tekno?",
      a: ["Kizz Daniel", "Asake", "Wizkid", "Davido"],
      c: 0,
      f: "Buga is a Kizz Daniel song featuring Tekno.",
      s: wiki("Kizz_Daniel"),
    },
    {
      q: "Which Nigerian singer released the album A Good Time?",
      a: ["Davido", "Wizkid", "Rema", "Burna Boy"],
      c: 0,
      f: "A Good Time is a 2019 album by Davido.",
      s: wiki("Davido"),
    },
    {
      q: "What is Burna Boy’s first name?",
      a: ["Damini", "David", "Ahmed", "Ayodeji"],
      c: 0,
      f: "Burna Boy’s birth name is Damini Ebunoluwa Ogulu.",
      s: wiki("Burna_Boy"),
    },
  ],
  [
    {
      q: "Which artist features alongside Joeboy on the first Love Nwantiti remix?",
      a: ["Kuami Eugene", "Tekno", "Selena Gomez", "Justin Bieber"],
      c: 0,
      f: "The remix features Joeboy and Ghanaian singer Kuami Eugene.",
      s: wiki("Love_Nwantiti"),
    },
    {
      q: "Who produced Davido’s Fall?",
      a: ["Kiddominant", "Oscar", "P2J", "Joker Nharnah"],
      c: 0,
      f: "Fall was produced by Nigerian record producer Kiddominant.",
      s: wiki("Fall_(Davido_song)"),
    },
    {
      q: "Which artist released the song Calm Down?",
      a: ["Rema", "Asake", "Black Sherif", "Wizkid"],
      c: 0,
      f: "Calm Down is a song by Nigerian singer Rema.",
      s: wiki("Calm_Down_(Rema_song)"),
    },
    {
      q: "Which album includes Burna Boy’s Last Last?",
      a: ["Love, Damini", "Made in Lagos", "Rave & Roses", "A Good Time"],
      c: 0,
      f: "Last Last is a single from Burna Boy’s album Love, Damini.",
      s: wiki("Last_Last"),
    },
    {
      q: "Which award did Water win in 2024?",
      a: [
        "Best African Music Performance Grammy",
        "Best New Artist Grammy",
        "Album of the Year Grammy",
        "Best Global Music Album Grammy",
      ],
      c: 0,
      f: "Water won the inaugural Grammy for Best African Music Performance.",
      s: wiki("Water_(Tyla_song)"),
    },
  ],
  [
    {
      q: "Which country is Burna Boy from?",
      a: ["Nigeria", "Ghana", "Kenya", "Tanzania"],
      c: 0,
      f: "Burna Boy is a Nigerian singer, songwriter and record producer.",
      s: wiki("Burna_Boy"),
    },
    {
      q: "Which country is Black Sherif from?",
      a: ["Ghana", "Nigeria", "Benin", "South Africa"],
      c: 0,
      f: "Black Sherif is a Ghanaian singer and rapper.",
      s: wiki("Black_Sherif"),
    },
    {
      q: "Which country is Tyla from?",
      a: ["South Africa", "Nigeria", "Ghana", "Kenya"],
      c: 0,
      f: "Tyla is a South African singer.",
      s: wiki("Tyla"),
    },
    {
      q: "Which song was released by Ayra Starr in September 2022?",
      a: ["Rush", "Water", "Duduke", "Fall"],
      c: 0,
      f: "Rush was released in September 2022.",
      s: wiki("Ayra_Starr"),
    },
    {
      q: "Which record label released Jerusalema?",
      a: [
        "Open Mic Productions",
        "Mavin Records",
        "Chocolate City",
        "Flyboy I.N.C",
      ],
      c: 0,
      f: "Jerusalema was released by Open Mic Productions.",
      s: wiki("Jerusalema"),
    },
  ],
  [
    {
      q: "Which Nigerian singer was born in Cotonou, Benin?",
      a: ["Ayra Starr", "Tems", "Asake", "Rema"],
      c: 0,
      f: "Ayra Starr was born in Cotonou, Benin.",
      s: wiki("Ayra_Starr"),
    },
    {
      q: "Which song features Justin Bieber on a remix?",
      a: ["Essence", "Calm Down", "Love Nwantiti", "Jerusalema"],
      c: 0,
      f: "A remix of Wizkid and Tems’ Essence featured Justin Bieber.",
      s: wiki("Essence_(Wizkid_song)"),
    },
    {
      q: "Which artist is the lead performer on Last Last?",
      a: ["Burna Boy", "Wizkid", "Davido", "Asake"],
      c: 0,
      f: "Last Last is a song by Nigerian singer Burna Boy.",
      s: wiki("Last_Last"),
    },
    {
      q: "Which artist’s album is titled Rave & Roses?",
      a: ["Rema", "Wizkid", "Davido", "Burna Boy"],
      c: 0,
      f: "Rave & Roses is Rema’s debut studio album.",
      s: wiki("Rave_%26_Roses"),
    },
    {
      q: "Which song by Simi was produced by Oscar?",
      a: ["Duduke", "Fall", "Water", "Rush"],
      c: 0,
      f: "Simi’s Duduke was produced by Oscar.",
      s: wiki("Simi_(singer)"),
    },
  ],
  [
    {
      q: "Which country is Master KG from?",
      a: ["South Africa", "Nigeria", "Ghana", "Kenya"],
      c: 0,
      f: "Master KG is a South African DJ and producer.",
      s: wiki("Master_KG"),
    },
    {
      q: "What is the title of the 2019 CKay EP that first included Love Nwantiti?",
      a: ["Ckay the First", "Rave & Roses", "A Good Time", "19 & Dangerous"],
      c: 0,
      f: "Love Nwantiti was released on the EP Ckay the First.",
      s: wiki("Love_Nwantiti"),
    },
    {
      q: "Which artists released the song Jerusalema?",
      a: [
        "Master KG featuring Nomcebo Zikode",
        "Wizkid featuring Tems",
        "Rema featuring Selena Gomez",
        "Kizz Daniel featuring Tekno",
      ],
      c: 0,
      f: "Jerusalema is by Master KG and features Nomcebo Zikode.",
      s: wiki("Jerusalema"),
    },
    {
      q: "Which artist’s song became their first US Billboard Hot 100 top-ten hit with a remix?",
      a: ["Rema", "Davido", "Asake", "Kizz Daniel"],
      c: 0,
      f: "Calm Down became Rema’s first top-ten hit on the Hot 100.",
      s: wiki("Calm_Down_(Rema_song)"),
    },
    {
      q: "Which song was released by Davido in June 2017?",
      a: ["Fall", "Aye", "Buga", "Duduke"],
      c: 0,
      f: "Fall was released on 2 June 2017.",
      s: wiki("Fall_(Davido_song)"),
    },
  ],
  [
    {
      q: "Which artist is nicknamed Starboy?",
      a: ["Wizkid", "Davido", "Rema", "Asake"],
      c: 0,
      f: "Wizkid is nicknamed Starboy.",
      s: wiki("Wizkid"),
    },
    {
      q: "Which album is the source of the single Water?",
      a: ["Tyla", "Made in Lagos", "A Good Time", "19 & Dangerous"],
      c: 0,
      f: "Water is from Tyla’s self-titled debut album.",
      s: wiki("Water_(Tyla_song)"),
    },
    {
      q: "Which artist recorded the best-known 1967 US release of Pata Pata?",
      a: ["Miriam Makeba", "Simi", "Tems", "Ayra Starr"],
      c: 0,
      f: "Miriam Makeba’s recording was released in the United States in 1967.",
      s: wiki("Pata_Pata"),
    },
    {
      q: "Which Ghanaian rapper released Adonai?",
      a: ["Sarkodie", "Stonebwoy", "Black Sherif", "King Promise"],
      c: 0,
      f: "Adonai is a song by Ghanaian rapper Sarkodie.",
      s: wiki("Sarkodie"),
    },
    {
      q: "Which Nigerian singer features CKay on Beggie Beggie?",
      a: ["Ayra Starr", "Tems", "Tiwa Savage", "Yemi Alade"],
      c: 0,
      f: "Beggie Beggie is by Ayra Starr and features CKay.",
      s: wiki("Ayra_Starr"),
    },
  ],
];

export const TRIVIA = TRIVIA_SEEDS.map((set) =>
  set.map(({ q, a, c, f }) => ({ q, a, c, f })),
);

// Direct article links where the title is known; otherwise a section/overview page.
export const HTML_FORMAT_SOURCES = {
  songs: [
    wiki("Essence_(Wizkid_song)"),
    wiki("Last_Last"),
    wiki("Calm_Down_(Rema_song)"),
    wiki("Jerusalema"),
    wiki("Water_(Tyla_song)"),
    wiki("Love_Nwantiti"),
    wiki("Pata_Pata"),
    wiki("Simi_(singer)"),
    wiki("Fall_(Davido_song)"),
    wiki("Ayra_Starr"),
  ],
  artists: ARTISTS.map(({ name }) =>
    wiki(encodeURIComponent(name.replace(/ /g, "_"))),
  ),
  boards: [
    [wiki("Afrobeats"), wiki("Music_of_Nigeria")],
    [
      wiki("Music_of_Ghana"),
      wiki("Music_of_South_Africa"),
      wiki("Music_of_Kenya"),
    ],
    [wiki("Calm_Down_(Rema_song)"), wiki("Water_(Tyla_song)")],
    [wiki("Burna_Boy"), wiki("Wizkid"), wiki("Davido"), wiki("Tiwa_Savage")],
    [wiki("Afrobeats"), wiki("Amapiano")],
    [
      wiki("Made_in_Lagos"),
      wiki("Love,_Damini"),
      wiki("Rave_%26_Roses"),
      wiki("19_%26_Dangerous"),
    ],
    [
      wiki("Jerusalema"),
      wiki("Love_Nwantiti"),
      wiki("Calm_Down_(Rema_song)"),
      wiki("Water_(Tyla_song)"),
    ],
    [wiki("Music_of_Nigeria"), wiki("Music_of_Ghana"), wiki("Music_of_Kenya")],
    [wiki("Afrobeats"), wiki("Amapiano"), wiki("Bongo_Flava"), wiki("Hiplife")],
    [
      wiki("Ayra_Starr"),
      wiki("Kizz_Daniel"),
      wiki("Simi_(singer)"),
      wiki("Yemi_Alade"),
    ],
  ],
  trivia: TRIVIA_SEEDS.map((set) => set.map(({ s }) => s)),
} as const;
