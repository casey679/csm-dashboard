// Pulls real numbers from Slack, Google Sheets, and YouTube, then writes
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
  GOOGLE_SHEETS_API_KEY,
  GOOGLE_SHEETS_ID,
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
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

// Reads a single column's daily totals from the "Posting Tracker" tab of
// the Content Tracker sheet and sums every row that falls within the
// current week (Monday through today).
// Column A holds dates written like "Fri May 01" (no year).
// columnIndex is zero-based: column M is index 12, column N is index 13.
let sheetRowsCache = null;
async function getSheetRows() {
  if (sheetRowsCache) return sheetRowsCache;
  if (!GOOGLE_SHEETS_API_KEY || !GOOGLE_SHEETS_ID) return null;

  const range = encodeURIComponent("Posting Tracker!A5:N1000");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEETS_ID}/values/${range}?key=${GOOGLE_SHEETS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.values) {
    console.error('Google Sheets error', data);
    return null;
  }
  sheetRowsCache = data.values;
  return sheetRowsCache;
}

async function getColumnTotalThisWeek(columnIndex) {
  const rows = await getSheetRows();
  if (!rows) return null;

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  let total = 0;

  for (const row of rows) {
    const dateStr = row[0];
    const valueStr = row[columnIndex];
    if (!dateStr || !valueStr) continue;

    // "Fri May 01" -> drop the weekday, parse "May 01 2026"
    const parts = dateStr.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const rowDate = new Date(`${parts[1]} ${parts[2]} ${currentYear}`);
    if (isNaN(rowDate)) continue;

    if (rowDate >= weekStart && rowDate <= now) {
      total += parseInt(valueStr, 10) || 0;
    }
  }

  return total;
}

async function getInstagramContentPostedThisWeek() {
  return getColumnTotalThisWeek(12); // column M
}

async function getTotalContentPostedThisWeek() {
  return getColumnTotalThisWeek(13); // column N
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

  const [calls, payments, igContentCount, totalContentCount, youtube, nextEvent] = await Promise.all([
    getCallsBookedThisWeek(),
    getPaymentWinsThisWeek(),
    getInstagramContentPostedThisWeek(),
    getTotalContentPostedThisWeek(),
    getYouTubeStats(),
    getNextEvent(),
  ]);

  const data = {
    dateRange: formatDateRange(),
    igContentCount: igContentCount !== null ? String(igContentCount) : previous.igContentCount ?? '—',
    contentCount: totalContentCount !== null ? String(totalContentCount) : previous.contentCount ?? '—',
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
