# Jira Sync GitHub Action

This automation syncs your Google Sheet to Jira, mirroring the N8N workflow functionality.

## Features
- ✅ Full CRUD (Create + Update)
- ✅ Change Detection (Hash-based)
- ✅ Hierarchy Support (JTBD → Thread → Milestone)
- ✅ Status Transitions
- ✅ State Persistence (commits sync_state.json)

## Production Schedule

| Time Range (IST) | Frequency | Description |
|------------------|-----------|-------------|
| 9 AM - 11 AM | Every 5 mins | Urgency window |
| 11 AM - 12 AM | Every 3 hours | Day schedule |
| 12 AM - 9 AM | Once at 6 AM | Night sync |

## Setup

### 1. Create GitHub Repository
Push this folder to a new private GitHub repository.

### 2. Add Secrets
Go to **Settings → Secrets and variables → Actions** and add:

| Secret Name | Value |
|-------------|-------|
| `JIRA_EMAIL` | Your Jira email (e.g., `ananya.sharma@leapfinance.com`) |
| `JIRA_TOKEN` | Your Jira API Token |
| `GOOGLE_CREDENTIALS` | Full JSON content of Google Service Account key |

### 3. Google Service Account Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a Service Account
3. Download JSON key
4. Share your Google Sheet with the service account email (as Viewer)
5. Paste JSON content into `GOOGLE_CREDENTIALS` secret

### 4. Activate
Once pushed and secrets are set, the workflow runs automatically on schedule.
You can also trigger manually from **Actions → Jira Sync Automation → Run workflow**.

## Files

| File | Purpose |
|------|---------|
| `sync_jira.js` | Main sync logic |
| `package.json` | Dependencies |
| `sync_state.json` | Tracks issue mappings and change hashes |
| `.github/workflows/jira_sync.yml` | GitHub Actions schedule |
