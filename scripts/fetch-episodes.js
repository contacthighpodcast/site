// fetch-episodes.js
// Pulls the channel's YouTube RSS feed, strips the "| Episode # of Contact High"
// suffix from titles, and writes a clean JSON file the website reads.
//
// No API key needed — YouTube's RSS feed is public.

const fs = require('fs');
const https = require('https');

const CHANNEL_ID = 'UC4Qxe6b5MNhX1GcOzvYVClg';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const OUTPUT_PATH = 'episodes.json';

function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractAll(regex, xml) {
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) matches.push(m[1]);
  return matches;
}

function cleanTitle(title) {
  // Removes "| Episode 17 of Contact High" (or similar) from the end of a title
  return title.replace(/\s*\|\s*Episode\s*#?\d+\s*of\s*Contact High\s*$/i, '').trim();
}

const BLURB_TARGET_LENGTH = 90; // roughly how long each card's description should read

function makeBlurb(rawDescription) {
  // Takes the first line of the YouTube description, then trims to a
  // consistent length at a word boundary (never mid-word) so every card
  // reads as roughly the same size instead of some being one line and
  // others running long.
  const firstLine = (rawDescription || '').split('\n')[0].trim();
  if (!firstLine) return 'New episode of Contact High.';
  if (firstLine.length <= BLURB_TARGET_LENGTH) return firstLine;

  const cut = firstLine.slice(0, BLURB_TARGET_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  const safeCut = lastSpace > 40 ? cut.slice(0, lastSpace) : cut; // avoid cutting too early on a long first word
  return safeCut.trim() + '…';
}

async function main() {
  const xml = await fetchFeed(FEED_URL);

  const videoIds = extractAll(/<yt:videoId>(.*?)<\/yt:videoId>/g, xml);
  const rawTitles = extractAll(/<media:title>(.*?)<\/media:title>/g, xml);
  const publishedDates = extractAll(/<published>(.*?)<\/published>/g, xml);
  const descriptions = extractAll(/<media:description>([\s\S]*?)<\/media:description>/g, xml);

  const episodes = videoIds.map((id, i) => ({
    videoId: id,
    title: cleanTitle(rawTitles[i] || ''),
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    publishedAt: publishedDates[i] || null,
    description: makeBlurb(descriptions[i]),
  }));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), episodes }, null, 2));
  console.log(`Wrote ${episodes.length} episodes to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
