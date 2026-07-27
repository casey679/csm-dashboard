# Christian's dashboard, deployment steps

Everything here is free. No servers to pay for, no hosting bill. It runs on GitHub, which is free for this kind of use.

## What this does

A script checks Slack, Notion, and YouTube every 15 minutes and writes the results to a small data file. A simple webpage reads that file and shows it to Christian. GitHub hosts both the script's schedule and the webpage, for free.

## Step 1, create the GitHub repo

Done, this is that repo.

## Step 2, turn on GitHub Pages

1. In the repo, go to Settings, then Pages
2. Under "Source", choose the `main` branch, root folder
3. Save. GitHub gives you a URL like `https://yourname.github.io/csm-dashboard/`
4. That URL is what Christian opens.

## Step 3, add your secrets

Settings, "Secrets and variables", then "Actions". Add each of these as a "New repository secret". Skip any you don't have yet, the dashboard just leaves that number as "—" until it's added later.

**Slack** (needed for calls booked and payment wins):
- `SLACK_BOT_TOKEN`
- `SLACK_BOOK_CALLS_CHANNEL_ID`, `C0BHBH3FCKE`
- `SLACK_PAYMENT_WINS_CHANNEL_ID`, `C0B9KS8DELR`

**Notion** (needed for content posted count):
- `NOTION_TOKEN`
- `NOTION_CONTENT_DATABASE_ID`
- `NOTION_STATUS_PROPERTY`
- `NOTION_POSTED_STATUS_VALUE`
- `NOTION_DATE_PROPERTY`

**YouTube** (needed for subscriber count):
- `YOUTUBE_API_KEY`
- `YOUTUBE_CHANNEL_ID`

**Instagram** (needed for real follower count):
- `IG_USER_ID`
- `IG_ACCESS_TOKEN`

## Step 4, run it once manually

1. Go to the "Actions" tab in the repo
2. Click "Update dashboard data", then "Run workflow"
3. Check `data/dashboard-data.json`, it should show real numbers

## Step 5, add it to Christian's phone

1. Open the GitHub Pages URL on his phone
2. iPhone: share icon, "Add to Home Screen"
3. Android: menu, "Add to Home Screen"

## Editing the parts that aren't pulled automatically

- **Event dates**, edit `data/events.json` directly on github.com
- **What's waiting on Christian**, edit `data/blockers.json` directly on github.com
