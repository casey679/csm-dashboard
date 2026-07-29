// Pulls real numbers from Slack, Google Sheets, YouTube, and Instagram, then
// writes data/dashboard-data.json. Runs on a schedule via GitHub Actions
// (see .github/workflows/update.yml), or manually with: node fetch-data.js
//
// Every value needed comes from an environment variable / GitHub secret,
// except Instagram, which reads the public profile page directly (no
// secrets needed for that one).
// Anything not configured yet is skipped gracefully, the dashboard just
// keeps showing the last good value for that field instead of breaking.

import { writeFile, readFile } from 'fs/promises';

const {
  SLACK_BOT_TOKEN,
  SLACK_BOOK_CALLS_CHANNEL_ID,
  SLACK_PAYMENT_WINS_CHANNEL_ID,
  GOOGLE_SHEETS_API_KEY,
  GOOGLE_SHEETS_ID,
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
} = process.env;

const INSTAGRAM_HANDLE = 'askschuette';

function getWeekStart() {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}
const weekStart = getWeekStart();
const weekStartUnix = (weekStart.getTime() / 1000).toFixed(6);

function formatDateRange() {
  const now = new Date();
  const opts = { month: 'short', day: 'numeric' };
  const start = weekStart.toLocaleDateString('en-US', opts);
  const end = now.toLocaleDateString('en-US', opts);
  return `${start} – ${end}`;
}

async function slackChannelHistory(channelId) {
  if (!SLACK_BOT_TOKEN || !channelId) return null;
  const url = `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${weekStartUnix}&limit=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Slack error for', channelId, data.error);
    return null;
  }
  return data.messages || [];
}

async function getCallsBookedThisWeek() {
  const messages = await slackChannelHistory(SLACK_BOOK_CALLS_CHANNEL_ID);
  if (!messages) return null;
  return messages.filter(m => (m.text || '').includes('New Booked Call')).length;
}

async function getPaymentWinsThisWeek() {
  const messages = await slackChannelHistory(SLACK_PAYMENT_WINS_CHANNEL_ID);
  if (!messages) return null;
  let total = 0;
  let count = 0;
  const products = [];
  for (const m of messages) {
    const text = m.text || '';
    if (!text.includes('New payment')) continue;
    const amountMatch = text.match(/Amount:\*\s*\n?##([\d.]+)##\s*(\w+)/);
    const productMatch = text.match(/Product:\*\s*\n?([^\n*]+)/);
    if (amountMatch) {
      total += parseFloat(amountMatch[1]);
      count += 1;
      if (productMatch) products.push(productMatch[1].trim());
    }
  }
  return { total, count, products };
}

// Reads the "Posting Tracker" tab of the Content Tracker sheet.
// Column A holds dates written like "Fri May 01" (no year).
// Column N holds the daily total across all platforms, already summed.
// This adds up every row whose date falls between this week's Monday and today.
async function getContentPostedThisWeek() {
  if (!GOOGLE_SHEETS_API_KEY || !GOOGLE_SHEETS_ID) return null;

  const range = encodeURIComponent("Posting Tracker!A5:N1000");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEETS_ID}/values/${range}?key=${GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.values) {
    console.error('Google Sheets error', data);
    return null;
  }

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  let total = 0;

  for (const row of data.values) {
    const dateStr = row[0];
    const totalStr = row[13]; // column N
    if (!dateStr || !totalStr) continue;

    // "Fri May 01" -> drop the weekday, parse "May 01 2026"
    const parts = dateStr.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const rowDate = new Date(`${parts[1]} ${parts[2]} ${currentYear}`);
    if (isNaN(rowDate)) continue;

    if (rowDate >= weekStart && rowDate <= now) {
      total += parseInt(totalStr, 10) || 0;
    }
  }

  return total;
}

async function getYouTubeStats() {
  if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) return null;
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${YOUTUBE_CHANNEL_ID}&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const stats = data.items?.[0]?.statistics;
  if (!stats) return null;
  return {
    subscribers: parseInt(stats.subscriberCount, 10),
    views: parseInt(stats.viewCount, 10),
    videos: parseInt(stats.videoCount, 10),
  };
}

// Reads the follower count straight off the public Instagram profile page,
// no app, no token, no login needed. Instagram embeds it in the page's
// meta description, something like:
// "21.6K Followers, 312 Following, 519 Posts - See Instagram photos..."
function parseFollowerString(str) {
  str = str.trim().toUpperCase();
  if (str.endsWith('K')) return Math.round(parseFloat(str) * 1000);
  if (str.endsWith('M')) return Math.round(parseFloat(str) * 1000000);
  return parseInt(str.replace(/,/g, ''), 10);
}

async function getInstagramFollowers() {
  try {
    const res = await fetch(`https://www.instagram.com/${INSTAGRAM_HANDLE}/`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) {
      console.error('Instagram fetch failed', res.status);
      return null;
    }
    const html = await res.text();
    const match = html.match(/content="([\d.,]+[KM]?) Followers/i);
    if (!match) {
      console.error('Instagram followers not found in page');
      return null;
    }
    return parseFollowerString(match[1]);
  } catch (e) {
    console.error('Instagram error', e);
    return null;
  }
}

async function getNextEvent() {
  const raw = await readFile(new URL('./data/events.json', import.meta.url), 'utf-8');
  const { events } = JSON.parse(raw);
  const now = new Date();
  const upcoming = events
    .map(e => ({ ...e, dateObj: new Date(e.date + 'T00:00:00Z') }))
    .filter(e => e.dateObj >= now)
    .sort((a, b) => a.dateObj - b.dateObj);
  if (upcoming.length === 0) return null;
  const next = upcoming[0];
  const days = Math.ceil((next.dateObj - now) / (1000 * 60 * 60 * 24));
  return { name: next.name, days };
}

async function main() {
  let previous = {};
  try {
    previous = JSON.parse(await readFile(new URL('./data/dashboard-data.json', import.meta.url), 'utf-8'));
  } catch {
    previous = {};
  }

  const [calls, payments, contentCount, youtube, igFollowers, nextEvent] = await Promise.all([
    getCallsBookedThisWeek(),
    getPaymentWinsThisWeek(),
    getContentPostedThisWeek(),
    getYouTubeStats(),
    getInstagramFollowers(),
    getNextEvent(),
  ]);

  const data = {
    dateRange: formatDateRange(),
    igCount: igFollowers !== null ? igFollowers.toLocaleString() : previous.igCount ?? '—',
    contentCount: contentCount !== null ? String(contentCount) : previous.contentCount ?? '—',
    salesCount: calls !== null ? String(calls) : previous.salesCount ?? '—',
    paymentTotal: payments ? `€${payments.total.toLocaleString()}` : previous.paymentTotal ?? '—',
    paymentNote: payments ? `${payments.count} payment${payments.count === 1 ? '' : 's'}, ${payments.products.join(', ') || 'no product data'}` : previous.paymentNote ?? '',
    youtubeSubs: youtube ? youtube.subscribers.toLocaleString() : previous.youtubeSubs ?? '—',
    youtubeVideos: youtube ? youtube.views.toLocaleString() : previous.youtubeVideos ?? '—',
    eventDays: nextEvent ? `${nextEvent.days} days` : previous.eventDays ?? '—',
    eventName: nextEvent ? nextEvent.name : previous.eventName ?? '—',
    lastUpdated: new Date().toUTCString(),
  };

  await writeFile(
    new URL('./data/dashboard-data.json', import.meta.url),
    JSON.stringify(data, null, 2)
  );

  console.log('Wrote dashboard-data.json:', data);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
