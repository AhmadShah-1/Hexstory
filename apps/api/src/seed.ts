import { TRUST, cellAt, collectionSchema, createDevelopmentSchema, createStorySchema, legacyDoc, type CreateStoryInput, type LinkRelation } from '@hexstory/shared';
import { cellToParent, gridDisk } from 'h3-js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { createCollection } from './services/collections.js';
import { addDevelopment } from './services/developments.js';
import { createStory } from './services/stories.js';
import { createLocalStorage } from './storage/index.js';

/** Development-only sample content so a fresh database has something on the map. */
const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');

const sql = createDb(config.DATABASE_URL);
await migrate(sql, { environment: config.DEPLOY_ENV });

const [existing] = await sql`SELECT 1 FROM stories LIMIT 1`;
if (existing) {
  console.log('Database already has stories; skipping seed.');
  await sql.end();
  process.exit(0);
}

const [user] = await sql<{ id: string; createdAt: Date }[]>`
  INSERT INTO users (google_sub, email, display_name, trust_level, terms_accepted_at)
  VALUES ('seed:archivist', NULL, 'Hexstory Archivist', ${TRUST.REVIEWER}, now())
  RETURNING id, created_at`;
const author = { ...user!, email: null, displayName: 'Hexstory Archivist', trustLevel: TRUST.REVIEWER, termsAcceptedAt: new Date(), bannedAt: null };

const wiki = (title: string, page: string) => ({ title: `${title} (Wikipedia)`, url: `https://en.wikipedia.org/wiki/${page}` });
const at = (lat: number, lng: number, placeName: string) => ({ location: { lat, lng, placeName } });

type Seed = Pick<CreateStoryInput, 'title' | 'summary' | 'categories' | 'location' | 'start' | 'sources'> & Partial<CreateStoryInput> & {
  body: string;
  /** Links to earlier seeds, by title. */
  connect?: [string, LinkRelation][];
};

const stories: Seed[] = [
  {
    title: 'The storming of the Bastille',
    body: 'On the morning of 14 July 1789 a crowd of Parisians, many of them artisans from the Faubourg Saint-Antoine, gathered outside the Bastille fortress looking for gunpowder.\n\nAfter hours of fighting the garrison surrendered. The fall of a symbol of royal authority became the defining image of the French Revolution, and the date is still France\'s national day.',
    ...at(48.8532, 2.3692, 'Bastille, Paris'),
    summary: 'A Paris crowd seized the royal fortress-prison of the Bastille, the opening act of the French Revolution.',
    categories: ['protest', 'politics'],
    people: ['Bernard-René de Launay'],
    start: { year: 1789, month: 7, day: 14 },
    sources: [wiki('Storming of the Bastille', 'Storming_of_the_Bastille'), { title: 'Simon Schama, Citizens: A Chronicle of the French Revolution (1989)', url: null }],
  },
  {
    title: 'The Berlin Wall opens',
    body: 'On the evening of 9 November 1989 an East German spokesman mistakenly announced that new travel rules took effect "immediately". Thousands of East Berliners went to the border crossings, and late that night guards at Bornholmer Straße opened the gates.\n\nPeople climbed onto the Wall at the Brandenburg Gate the same night. Germany was reunified less than a year later.',
    ...at(52.5163, 13.3777, 'Brandenburg Gate, Berlin'),
    summary: 'A botched announcement led East German guards to open the border, and the Berlin Wall fell overnight.',
    categories: ['politics', 'protest'],
    people: ['Günter Schabowski'],
    start: { year: 1989, month: 11, day: 9 },
    sources: [wiki('Fall of the Berlin Wall', 'Fall_of_the_Berlin_Wall'), { title: 'Mary Elise Sarotte, The Collapse (2014)', url: null }, wiki('Bornholmer Straße border crossing', 'Bornholmer_Stra%C3%9Fe_border_crossing')],
  },
  {
    title: 'The Salt March',
    body: 'Mohandas Gandhi and 78 companions set out from Sabarmati Ashram near Ahmedabad on 12 March 1930 and walked about 390 km to the coastal village of Dandi to make salt from seawater, defying the British salt tax.\n\nThe march drew international attention and sparked mass civil disobedience across India.',
    ...at(21.1667, 72.8, 'Dandi, Gujarat'),
    cells: [...gridDisk(cellAt(22.6, 72.75, 4), 1), ...gridDisk(cellAt(21.6, 72.8, 4), 1)],
    summary: 'Gandhi led a 24-day march to the sea to make salt in defiance of British law, igniting mass civil disobedience.',
    categories: ['protest'],
    people: ['Mohandas Gandhi'],
    start: { year: 1930, month: 3, day: 12 },
    end: { year: 1930, month: 4, day: 6 },
    sources: [wiki('Salt March', 'Salt_March'), { title: 'Thomas Weber, On the Salt March (1997)', url: null }],
  },
  {
    title: 'Assassination of Julius Caesar',
    body: 'On the Ides of March a group of senators led by Brutus and Cassius stabbed Julius Caesar to death during a meeting of the Senate at the Curia of Pompey.\n\nInstead of restoring the Republic, the killing led to years of civil war and, eventually, the rule of Augustus.',
    ...at(41.8955, 12.4768, 'Curia of Pompey, Rome'),
    summary: 'Senators stabbed Julius Caesar to death, setting off the civil wars that ended the Roman Republic.',
    categories: ['politics', 'landmark'],
    people: ['Julius Caesar', 'Marcus Junius Brutus', 'Gaius Cassius Longinus'],
    start: { year: -44, month: 3, day: 15 },
    sources: [wiki('Assassination of Julius Caesar', 'Assassination_of_Julius_Caesar'), { title: 'Suetonius, The Twelve Caesars', url: null }],
  },
  {
    title: 'The Great Fire of London',
    body: 'A fire that started in a bakery on Pudding Lane in the early hours of 2 September 1666 spread across the medieval City of London for four days, destroying some 13,000 houses and St Paul\'s Cathedral.\n\nSamuel Pepys described it in his diary. The rebuilding gave London Christopher Wren\'s new St Paul\'s.',
    ...at(51.5101, -0.0858, 'Pudding Lane, London'),
    summary: 'A bakery fire burned for four days and destroyed most of the medieval City of London.',
    categories: ['disaster'],
    people: ['Samuel Pepys', 'Christopher Wren'],
    start: { year: 1666, month: 9, day: 2 },
    end: { year: 1666, month: 9, day: 6 },
    sources: [wiki('Great Fire of London', 'Great_Fire_of_London'), { title: 'The Diary of Samuel Pepys, September 1666', url: 'https://www.pepysdiary.com/diary/1666/09/' }],
  },
  {
    title: 'The Battle of Stalingrad',
    body: 'From August 1942 to February 1943 German and Soviet forces fought for the city on the Volga in one of the largest and bloodiest battles in history.\n\nThe encirclement and surrender of the German 6th Army marked a turning point on the Eastern Front. Opinions differ on how much the battle decided the war, but few doubt its symbolic weight.',
    ...at(48.708, 44.513, 'Stalingrad (Volgograd)'),
    cells: [cellToParent(cellAt(48.708, 44.513, 5), 3)],
    summary: 'Five months of fighting for the city on the Volga ended with the surrender of the German 6th Army.',
    categories: ['war'],
    start: { year: 1942, month: 8, day: 23 },
    end: { year: 1943, month: 2, day: 2 },
    sources: [wiki('Battle of Stalingrad', 'Battle_of_Stalingrad'), { title: 'Antony Beevor, Stalingrad (1998)', url: null }, { title: 'Vasily Grossman, A Writer at War', url: null }, wiki('Operation Uranus', 'Operation_Uranus')],
  },
  {
    title: 'Crowds fill Tahrir Square',
    body: 'On 25 January 2011 tens of thousands of Egyptians marched to Tahrir Square in Cairo to protest police brutality, poverty and the 30-year rule of Hosni Mubarak.\n\nThe square stayed occupied for eighteen days until Mubarak resigned on 11 February.',
    ...at(30.0444, 31.2357, 'Tahrir Square, Cairo'),
    summary: "Eighteen days of mass protest in Cairo's central square forced Hosni Mubarak from power.",
    categories: ['protest', 'politics'],
    people: ['Hosni Mubarak'],
    connect: [['The Berlin Wall opens', 'related']],
    start: { year: 2011, month: 1, day: 25 },
    end: { year: 2011, month: 2, day: 11 },
    sources: [wiki('Egyptian revolution of 2011', 'Egyptian_revolution_of_2011')],
  },
  {
    title: 'The Montgomery bus boycott',
    body: 'After Rosa Parks was arrested on 5 December 1955 for refusing to give up her seat, Black residents of Montgomery, Alabama stopped riding the city buses.\n\nThe boycott lasted 381 days, made Martin Luther King Jr. a national figure, and ended after the Supreme Court ruled bus segregation unconstitutional.',
    ...at(32.3792, -86.3077, 'Montgomery, Alabama'),
    summary: 'Black residents of Montgomery refused to ride segregated buses for 381 days until segregation was struck down.',
    categories: ['protest', 'local'],
    people: ['Rosa Parks', 'Martin Luther King Jr.'],
    connect: [['The Salt March', 'preceded-by']],
    start: { year: 1955, month: 12, day: 5 },
    end: { year: 1956, month: 12, day: 20 },
    sources: [wiki('Montgomery bus boycott', 'Montgomery_bus_boycott'), { title: 'Martin Luther King Jr., Stride Toward Freedom (1958)', url: null }],
  },
  {
    title: 'The fall of Constantinople',
    body: 'After a siege of almost two months, Ottoman forces under Sultan Mehmed II broke through the Theodosian Walls on 29 May 1453. The last Byzantine emperor, Constantine XI, died in the fighting.\n\nThe city became the Ottoman capital, and the date is often used to mark the end of the Middle Ages.',
    ...at(41.0122, 28.9760, 'Constantinople (Istanbul)'),
    summary: 'Ottoman forces breached the Theodosian Walls and ended the Byzantine Empire after almost two months of siege.',
    categories: ['war'],
    people: ['Mehmed II', 'Constantine XI'],
    start: { year: 1453, month: 5, day: 29 },
    sources: [wiki('Fall of Constantinople', 'Fall_of_Constantinople'), { title: 'Roger Crowley, 1453 (2005)', url: null }],
  },
  {
    title: 'Building the pyramids at Giza',
    body: 'The Great Pyramid was built for the pharaoh Khufu during Egypt\'s Fourth Dynasty. It was the tallest human-made structure in the world for nearly 4,000 years.\n\nEvidence from workers\' villages nearby suggests it was built by paid, organised labour rather than slaves, though this is still debated.',
    ...at(29.9792, 31.1342, 'Giza'),
    summary: 'The Great Pyramid of Khufu, the tallest structure on Earth for nearly 4,000 years, was built by organised labour.',
    categories: ['landmark', 'culture'],
    people: ['Khufu'],
    start: { year: -2560 },
    isApprox: true,
    sources: [wiki('Great Pyramid of Giza', 'Great_Pyramid_of_Giza')],
  },
];

stories.push({
  title: 'War in Sudan',
  body: 'Fighting broke out in Khartoum on 15 April 2023 between the Sudanese Armed Forces and the paramilitary Rapid Support Forces, former allies who had shared power since a 2021 coup.\n\nThe war spread to Darfur and Gezira, displaced millions of people and caused one of the worst humanitarian crises in the world.',
  ...at(15.5007, 32.5599, 'Khartoum'),
  summary: 'A war between Sudan’s army and the Rapid Support Forces that began in Khartoum in April 2023 and spread across the country.',
  categories: ['war'],
  start: { year: 2023, month: 4, day: 15 },
  isOngoing: true,
  sources: [wiki('War in Sudan (2023–present)', 'War_in_Sudan_(2023%E2%80%93present)')],
});

const deps = { sql, storage: createLocalStorage(config.UPLOAD_DIR) };
const ids = new Map<string, string>();
for (const { body, connect, ...s } of stories) {
  const links = (connect ?? []).flatMap(([title, relation]) => (ids.has(title) ? [{ storyId: ids.get(title)!, relation }] : []));
  const input = createStorySchema.parse({ content: legacyDoc(body, null, null), links, ...s });
  const { storyId } = await createStory(deps, author, input);
  ids.set(s.title, storyId);
}

const sudan = ids.get('War in Sudan')!;
for (const dev of [
  { date: { year: 2023, month: 12, day: 18 }, title: 'RSF enter Wad Madani', location: { lat: 14.4012, lng: 33.5199, placeName: 'Wad Madani' } },
  { date: { year: 2025, month: 3, day: 21 }, title: 'The army retakes the Republican Palace in Khartoum', location: { lat: 15.6127, lng: 32.5315, placeName: 'Khartoum' } },
]) {
  await addDevelopment(deps, author, sudan, createDevelopmentSchema.parse({ ...dev, sources: [wiki('War in Sudan (2023–present)', 'War_in_Sudan_(2023%E2%80%93present)')] }));
}

await createCollection(sql, author, collectionSchema.parse({
  title: 'People against power',
  description: 'Protests and civil disobedience that changed what governments could do, gathered from every story tagged as a protest.',
  kind: 'theme',
  categories: ['protest'],
}));
await createCollection(sql, author, collectionSchema.parse({
  title: 'The end of empires',
  description: 'Moments when an empire or regime fell, picked by hand and read in order.',
  kind: 'theme',
  items: ['The fall of Constantinople', 'Assassination of Julius Caesar', 'The Berlin Wall opens'].map((t) => ({ storyId: ids.get(t)! })),
}));
await createCollection(sql, author, collectionSchema.parse({
  title: 'The history of London',
  description: 'Everything that happened in and around London, found automatically from the stories placed there.',
  kind: 'place',
  cells: gridDisk(cellAt(51.5074, -0.1278, 4), 1),
}));

console.log(`Seeded ${stories.length} stories, 2 developments and 3 collections.`);
await sql.end();
