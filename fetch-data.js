// Pulls real numbers from Slack, Notion, and YouTube, then writes
// data/dashboard-data.json. Runs on a schedule via GitHub Actions
// (see .github/workflows/update.yml), or manually with: node fetch-data.js
//
// Every value needed comes from an environment variable / GitHub secret.
// Anything not configured yet is skipped gracefully, the dashboard just
// keeps showing the last good value for that field instead of breaking.

import { writeFile, readFile } from 'fs/promises';

const {
  SLACK_BOT_TOKEN,
  SLACK_BOOK_CALLS_CHANNEL_ID,
  SLACK_PAYMENT_WINS_CHANNEL_ID,
  NOTION_TOKEN,
  NOTION_CONTENT_DATABASE_ID,
  NOTION_STATUS_PROPERTY,
  NOTION_POSTED_STATUS_VALUE,
  NOTION_DATE_PROPERTY,
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
  IG_USER_ID,
  IG_ACCESS_TOKEN,
} = process.env;

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

async function getContentPostedThisWeek() {
  if (!NOTION_TOKEN || !NOTION_CONTENT_DATABASE_ID || !NOTION_STATUS_PROPERTY || !NOTION_DATE_PROPERTY) {
    return null;
  }
  const isoWeekStart = weekStart.toISOString().slice(0, 10);
  const body = {
    filter: {
      and: [
        { property: NOTION_STATUS_PROPERTY, status: { equals: NOTION_POSTED_STATUS_VALUE } },
        { property: NOTION_DATE_PROPERTY, date: { on_or_after: isoWeekStart } },
      ],
    },
    page_size: 100,
  };
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_CONTENT_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.results) {
    console.error('Notion error', data);
    return null;
  }
  return data.results.length;
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

async function getInstagramFollowers() {
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) return null;
  const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}?fields=followers_count&access_token=${IG_ACCESS_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.followers_count) {
    console.error('Instagram error', data);
    return null;
  }
  return data.followers_count;
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
    youtubeVideos: youtube ? String(youtube.videos) : previous.youtubeVideos ?? '—',
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
