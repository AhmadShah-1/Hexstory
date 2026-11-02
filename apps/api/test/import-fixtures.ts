/** A valid import record; override fields per test. */
export const event = (over: Record<string, unknown> = {}) => ({
  key: 'tahrir-square-2011',
  title: 'Crowds fill Tahrir Square',
  summary: 'Eighteen days of protest in Cairo forced Hosni Mubarak from power.',
  body: 'On 25 January 2011 tens of thousands of Egyptians marched to Tahrir Square.\n\nThe square stayed occupied for eighteen days.',
  start: '2011-01-25',
  end: '2011-02-11',
  location: { lat: 30.0444, lng: 31.2357, place: 'Tahrir Square, Cairo' },
  categories: ['protest', 'politics'],
  sources: [{ title: 'Egyptian revolution of 2011 (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Egyptian_revolution_of_2011' }],
  ...over,
});

