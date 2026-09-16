// fetch-episodes.js
//
// Pulls the channel's full upload history via the YouTube Data API and
// writes a clean JSON file the website reads — long-form episodes only.
//
// WHY THIS VERSION EXISTS: the previous version used YouTube's free public
// RSS feed, which has two hard limitations that eventually broke things:
//   1. It mixes Shorts and long-form videos together with no way to tell
//      them apart (no duration field at all).
//   2. It hard-caps at the 15 most recent uploads of ANY type, so once
//      Shorts volume increased, older full episodes silently fell out of
//      the feed — and out of episodes.json — entirely.
//
// This version uses the real YouTube Data API instead, which provides
// exact video duration (so Shorts can be reliably excluded) and supports
// full pagination (so there's no cap and nothing gets silently dropped).
//
// SETUP REQUIRED: this needs a free YouTube Data API v3 key.
//   1. Go to https://console.cloud.google.com/apis/credentials
//   2. Create a project (or use an existing one), enable "YouTube Data API v3"
//   3. Create an API key
//   4. In your GitHub repo: Settings -> Secrets and variables -> Actions ->
//      New repository secret, name it YOUTUBE_API_KEY, paste the key
//   5. That's it — the workflow file already passes it through as an
//      environment variable.
// This is free for a channel this size — quota usage here is a tiny
// fraction of the free daily allowance.

const fs = require('fs');
const https = require('https');

const CHANNEL_ID = 'UC4Qxe6b5MNhX1GcOzvYVClg';
const API_KEY = process.env.YOUTUBE_API_KEY;
const OUTPUT_PATH = 'episodes.json';
const SHORTS_MAX_SECONDS = 180; // YouTube's own Shorts length threshold

if (!API_KEY) {
  console.error('Missing YOUTUBE_API_KEY environment variable. See setup instructions at the top of this file.');
  process.exit(1);
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.slice(0, 500)}`));
        }
      });
    }).on('error', reject);
  });
}

function cleanTitle(title) {
  return (title || '').replace(/\s*\|\s*Episode\s*#?\d+\s*of\s*Contact High\s*$/i, '').trim();
}

const BLURB_TARGET_LENGTH = 90;

function makeBlurb(rawDescription) {
  const firstLine = (rawDescription || '').split('\n')[0].trim();
  if (!firstLine) return 'New episode of Contact High.';
  if (firstLine.length <= BLURB_TARGET_LENGTH) return firstLine;
  const cut = firstLine.slice(0, BLURB_TARGET_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  const safeCut = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return safeCut.trim() + '…';
}

function loadExistingDescriptions() {
  try {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    const map = {};
    for (const ep of existing.episodes || []) {
      if (ep.videoId && ep.description) map[ep.videoId] = ep.description;
    }
    return map;
  } catch {
    return {};
  }
}

// Parses ISO 8601 durations like "PT1M40S" or "PT45S" or "PT1H2M3S" into seconds.
function parseDurationToSeconds(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

async function getUploadsPlaylistId() {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${CHANNEL_ID}&key=${API_KEY}`;
  const data = await httpsGetJson(url);
  const playlistId = data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error('Could not find uploads playlist for channel.');
  return playlistId;
}

async function getAllUploads(playlistId) {
  let items = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50&pageToken=${pageToken}&key=${API_KEY}`;
    const data = await httpsGetJson(url);
    items = items.concat(data.items || []);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return items;
}

async function getDurations(videoIds) {
  const durations = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(',')}&key=${API_KEY}`;
    const data = await httpsGetJson(url);
    for (const item of data.items || []) {
      durations[item.id] = parseDurationToSeconds(item.contentDetails.duration);
    }
  }
  return durations;
}

async function main() {
  const existingDescriptions = loadExistingDescriptions();

  const playlistId = await getUploadsPlaylistId();
  const uploads = await getAllUploads(playlistId); // full history, no 15-item cap
  const videoIds = uploads.map((item) => item.snippet.resourceId.videoId);
  const durations = await getDurations(videoIds);

  const longFormOnly = uploads.filter((item) => {
    const id = item.snippet.resourceId.videoId;
    return (durations[id] || 0) > SHORTS_MAX_SECONDS; // excludes Shorts
  });

  const episodes = longFormOnly.map((item) => {
    const id = item.snippet.resourceId.videoId;
    return {
      videoId: id,
      title: cleanTitle(item.snippet.title),
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      publishedAt: item.snippet.publishedAt || null,
      description: existingDescriptions[id] || makeBlurb(item.snippet.description),
    };
  });

  // Newest first
  episodes.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), episodes }, null, 2));
  console.log(`Wrote ${episodes.length} long-form episodes to ${OUTPUT_PATH} (excluded Shorts using a ${SHORTS_MAX_SECONDS}s threshold).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
