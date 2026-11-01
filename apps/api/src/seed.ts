import { TRUST, cellAt, legacyDoc, type CreateStoryInput } from '@hexstory/shared';
import { cellToParent, gridDisk } from 'h3-js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
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
  VALUES ('seed:archivist', NULL, 'Hexstory Archivist', ${TRUST.MEMBER}, now())
  RETURNING id, created_at`;
const author = { ...user!, email: null, displayName: 'Hexstory Archivist', trustLevel: TRUST.MEMBER, termsAcceptedAt: new Date(), bannedAt: null };

const wiki = (title: string, page: string) => ({ title: `${title} (Wikipedia)`, url: `https://en.wikipedia.org/wiki/${page}` });
const at = (lat: number, lng: number) => [cellAt(lat, lng, 5)];

const stories: (Pick<CreateStoryInput, 'title' | 'cells' | 'start' | 'sources'> & Partial<CreateStoryInput> & { body: string })[] = [
  {
    title: 'The storming of the Bastille',
    body: 'On the morning of 14 July 1789 a crowd of Parisians, many of them artisans from the Faubourg Saint-Antoine, gathered outside the Bastille fortress looking for gunpowder.\n\nAfter hours of fighting the garrison surrendered. The fall of a symbol of royal authority became the defining image of the French Revolution, and the date is still France\'s national day.',
    cells: at(48.8532, 2.3692),
    start: { year: 1789, month: 7, day: 14 },
    sources: [wiki('Storming of the Bastille', 'Storming_of_the_Bastille'), { title: 'Simon Schama, Citizens: A Chronicle of the French Revolution (1989)', url: null }],
  },
  {
    title: 'The Berlin Wall opens',
    body: 'On the evening of 9 November 1989 an East German spokesman mistakenly announced that new travel rules took effect "immediately". Thousands of East Berliners went to the border crossings, and late that night guards at Bornholmer Straße opened the gates.\n\nPeople climbed onto the Wall at the Brandenburg Gate the same night. Germany was reunified less than a year later.',
    cells: at(52.5163, 13.3777),
    start: { year: 1989, month: 11, day: 9 },
    sources: [wiki('Fall of the Berlin Wall', 'Fall_of_the_Berlin_Wall'), { title: 'Mary Elise Sarotte, The Collapse (2014)', url: null }, wiki('Bornholmer Straße border crossing', 'Bornholmer_Stra%C3%9Fe_border_crossing')],
  },
  {
    title: 'The Salt March',
    body: 'Mohandas Gandhi and 78 companions set out from Sabarmati Ashram near Ahmedabad on 12 March 1930 and walked about 390 km to the coastal village of Dandi to make salt from seawater, defying the British salt tax.\n\nThe march drew international attention and sparked mass civil disobedience across India.',
    cells: [...gridDisk(cellAt(22.6, 72.75, 4), 1), ...gridDisk(cellAt(21.6, 72.8, 4), 1)],
    start: { year: 1930, month: 3, day: 12 },
    end: { year: 1930, month: 4, day: 6 },
    sources: [wiki('Salt March', 'Salt_March'), { title: 'Thomas Weber, On the Salt March (1997)', url: null }],
  },
  {
    title: 'Assassination of Julius Caesar',
    body: 'On the Ides of March a group of senators led by Brutus and Cassius stabbed Julius Caesar to death during a meeting of the Senate at the Curia of Pompey.\n\nInstead of restoring the Republic, the killing led to years of civil war and, eventually, the rule of Augustus.',
    cells: at(41.8955, 12.4768),
    start: { year: -44, month: 3, day: 15 },
    sources: [wiki('Assassination of Julius Caesar', 'Assassination_of_Julius_Caesar'), { title: 'Suetonius, The Twelve Caesars', url: null }],
  },
  {
    title: 'The Great Fire of London',
    body: 'A fire that started in a bakery on Pudding Lane in the early hours of 2 September 1666 spread across the medieval City of London for four days, destroying some 13,000 houses and St Paul\'s Cathedral.\n\nSamuel Pepys described it in his diary. The rebuilding gave London Christopher Wren\'s new St Paul\'s.',
    cells: at(51.5101, -0.0858),
    start: { year: 1666, month: 9, day: 2 },
    end: { year: 1666, month: 9, day: 6 },
    sources: [wiki('Great Fire of London', 'Great_Fire_of_London'), { title: 'The Diary of Samuel Pepys, September 1666', url: 'https://www.pepysdiary.com/diary/1666/09/' }],
  },
  {
    title: 'The Battle of Stalingrad',
    body: 'From August 1942 to February 1943 German and Soviet forces fought for the city on the Volga in one of the largest and bloodiest battles in history.\n\nThe encirclement and surrender of the German 6th Army marked a turning point on the Eastern Front. Opinions differ on how much the battle decided the war, but few doubt its symbolic weight.',
    cells: [cellToParent(cellAt(48.708, 44.513, 5), 3)],
    start: { year: 1942, month: 8, day: 23 },
    end: { year: 1943, month: 2, day: 2 },
    sources: [wiki('Battle of Stalingrad', 'Battle_of_Stalingrad'), { title: 'Antony Beevor, Stalingrad (1998)', url: null }, { title: 'Vasily Grossman, A Writer at War', url: null }, wiki('Operation Uranus', 'Operation_Uranus')],
  },
  {
    title: 'Crowds fill Tahrir Square',
    body: 'On 25 January 2011 tens of thousands of Egyptians marched to Tahrir Square in Cairo to protest police brutality, poverty and the 30-year rule of Hosni Mubarak.\n\nThe square stayed occupied for eighteen days until Mubarak resigned on 11 February.',
    cells: at(30.0444, 31.2357),
    start: { year: 2011, month: 1, day: 25 },
    end: { year: 2011, month: 2, day: 11 },
    sources: [wiki('Egyptian revolution of 2011', 'Egyptian_revolution_of_2011')],
  },
  {
    title: 'The Montgomery bus boycott',
    body: 'After Rosa Parks was arrested on 5 December 1955 for refusing to give up her seat, Black residents of Montgomery, Alabama stopped riding the city buses.\n\nThe boycott lasted 381 days, made Martin Luther King Jr. a national figure, and ended after the Supreme Court ruled bus segregation unconstitutional.',
    cells: at(32.3792, -86.3077),
    start: { year: 1955, month: 12, day: 5 },
    end: { year: 1956, month: 12, day: 20 },
    sources: [wiki('Montgomery bus boycott', 'Montgomery_bus_boycott'), { title: 'Martin Luther King Jr., Stride Toward Freedom (1958)', url: null }],
  },
  {
    title: 'The fall of Constantinople',
    body: 'After a siege of almost two months, Ottoman forces under Sultan Mehmed II broke through the Theodosian Walls on 29 May 1453. The last Byzantine emperor, Constantine XI, died in the fighting.\n\nThe city became the Ottoman capital, and the date is often used to mark the end of the Middle Ages.',
    cells: at(41.0122, 28.9760),
    start: { year: 1453, month: 5, day: 29 },
    sources: [wiki('Fall of Constantinople', 'Fall_of_Constantinople'), { title: 'Roger Crowley, 1453 (2005)', url: null }],
  },
  {
    title: 'Building the pyramids at Giza',
    body: 'The Great Pyramid was built for the pharaoh Khufu during Egypt\'s Fourth Dynasty. It was the tallest human-made structure in the world for nearly 4,000 years.\n\nEvidence from workers\' villages nearby suggests it was built by paid, organised labour rather than slaves, though this is still debated.',
    cells: at(29.9792, 31.1342),
    start: { year: -2560 },
    isApprox: true,
    sources: [wiki('Great Pyramid of Giza', 'Great_Pyramid_of_Giza')],
  },
];

const storage = createLocalStorage(config.UPLOAD_DIR);
for (const { body, ...s } of stories) {
  await createStory({ sql, storage }, author, {
    end: null, isOngoing: false, isApprox: false, content: legacyDoc(body, null, null), ...s,
  } as CreateStoryInput);
}
console.log(`Seeded ${stories.length} stories.`);
await sql.end();
