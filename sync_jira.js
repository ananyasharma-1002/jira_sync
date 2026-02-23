const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');

// ===== CONFIG =====
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'interns';
const JIRA_EMAIL = process.env.JIRA_EMAIL || 'ananya.sharma@leapfinance.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const PROJECT_KEY = 'BUS';
const JIRA_BASE = 'https://leapfinance.atlassian.net';
const STATE_FILE = path.join(__dirname, 'sync_state.json');

const ISSUE_TYPE_IDS = { 'JTBD': '10223', 'Thread': '10224' };
const CUSTOM_FIELDS = {
    'Function': 'customfield_10475',
    'Metric In Focus': 'customfield_10478',
    'Metric Target': 'customfield_10477',
    'Metric Current State': 'customfield_10511',
    'Metric Start State': 'customfield_10476',
    'Next Milestone': 'customfield_10610'
};

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const jira = axios.create({
    baseURL: JIRA_BASE,
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
});

// ===== GOOGLE SHEETS =====
async function getSheetData() {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const authClient = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_NAME });
    const rows = res.data.values;
    if (!rows || rows.length === 0) return [];
    const headers = rows[0];
    return rows.slice(1).map(row => {
        let obj = {};
        headers.forEach((h, i) => obj[h.trim()] = (row[i] || '').trim());
        return obj;
    });
}

// ===== HELPERS =====
function convertDate(d) {
    if (!d) return null;
    const str = String(d).trim();
    // Support DD/MM/YYYY format
    const match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) {
        console.warn(`⚠️ Invalid date format: '${str}' (expected DD/MM/YYYY)`);
        return null;
    }
    const [, day, month, year] = match;
    const formatted = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    return formatted;
}

function getDefaultDate() {
    const d = new Date();
    d.setDate(d.getDate() + 30); // 30 days from now
    return d.toISOString().split('T')[0];
}

function norm(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function rowHash(r) {
    return ['Summary of JTBD/Thread', 'Parent', 'Next Milestone (add only for Thread)', 'Assignee (Owner Mail ID)', 'Due Date', 'Status',
        'Function  (add only for JTBD)', 'Metric in Focus (add only for JTBD)',
        'Metric Target (add only for JTBD)', 'Metric Current State (add only for JTBD)',
        'Metric Start State (add only for JTBD)'].map(x => String(r[x] || '')).join('|');
}

// ===== STATE MANAGEMENT =====
function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { }
    }
    return { issueMapping: {}, userCache: {}, lastHashes: {} };
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ===== JIRA OPERATIONS =====
async function getUserId(email, userCache) {
    if (!email) return null;
    if (userCache[email]) return userCache[email];
    try {
        const res = await jira.get(`/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
        if (res.data && res.data.length) {
            userCache[email] = res.data[0].accountId;
            return res.data[0].accountId;
        }
    } catch (e) { console.error(`User search failed: ${email}`); }
    return null;
}

const VALID_STATUSES = [
    'On track', 'Not on track', 'Delayed', 'Done', 'Done, BAU',
    'Dependent', 'Deprioritised', 'Review Stage', 'Not picked yet'
];

async function setStatus(key, status) {
    if (!status) return true;

    // 1. Validate Status
    const validMatch = VALID_STATUSES.find(vs => vs.toLowerCase() === status.trim().toLowerCase());
    if (!validMatch) {
        console.warn(`⚠️ Warning: '${status}' is not a valid status for ${key}. Allowed: ${VALID_STATUSES.join(', ')}`);
        return false;
    }

    const s = validMatch.toLowerCase();

    // 2. Get current status first
    try {
        const issue = await jira.get(`/rest/api/3/issue/${key}?fields=status`);
        const currentStatus = issue.data.fields.status.name;

        // Already in desired status
        if (currentStatus.toLowerCase() === s) {
            console.log(`✅ ${key}: Already in '${currentStatus}' — no change needed`);
            return true;
        }

        // 3. Find and execute transition
        const t = await jira.get(`/rest/api/3/issue/${key}/transitions`);
        const transitions = t.data.transitions || [];
        const tr = transitions.find(x => x.to.name.toLowerCase() === s);

        if (tr) {
            await jira.post(`/rest/api/3/issue/${key}/transitions?notifyUsers=false`, { transition: { id: tr.id } });
            console.log(`✨ ${key}: Status changed: '${currentStatus}' → '${validMatch}'`);
            return true;
        } else {
            console.log(`ℹ️ Cannot transition ${key} from '${currentStatus}' to '${validMatch}'.`);
            console.log(`   Available transitions: ${transitions.map(x => x.to.name).join(', ') || 'None'}`);
            return false;
        }
    } catch (e) {
        console.error(`❌ Transition failed for ${key}: ${e.message}`);
        return false;
    }
}

async function getBody(row, type, parentKey, userCache) {
    const body = {
        fields: {
            summary: row['Summary of JTBD/Thread'],
            project: { key: PROJECT_KEY },
            issuetype: { id: ISSUE_TYPE_IDS[type] },
            duedate: convertDate(row['Due Date']) || getDefaultDate()
        }
    };

    if (parentKey) body.fields.parent = { key: parentKey };

    // Add assignee
    const email = row['Assignee (Owner Mail ID)'];
    if (email) {
        const aid = await getUserId(email, userCache);
        if (aid) body.fields.assignee = { accountId: aid };
    }

    // JTBD custom fields - Jira requires these, use fallbacks if blank
    if (type === 'JTBD') {
        const func = row['Function  (add only for JTBD)'];
        if (func && func.trim()) {
            body.fields[CUSTOM_FIELDS['Function']] = { value: func.trim() };
        } else {
            body.fields[CUSTOM_FIELDS['Function']] = { value: 'LS Core Business' };
        }

        const mf = row['Metric in Focus (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric In Focus']] = String(mf).trim() || 'N/A';

        const mt = row['Metric Target (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric Target']] = String(mt).trim() || 'N/A';

        const mc = row['Metric Current State (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric Current State']] = String(mc).trim() || 'N/A';

        const ms = row['Metric Start State (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric Start State']] = String(ms).trim() || 'N/A';
    }

    // Next Milestone for Thread
    if (type === 'Thread') {
        const desc = row['Next Milestone (add only for Thread)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Next Milestone']] = String(desc).trim() || 'N/A';
    }

    return body;
}

function getUpdateBody(row, parentKey) {
    const body = { fields: { summary: row['Summary of JTBD/Thread'] } };
    const d = convertDate(row['Due Date']);
    if (d) body.fields.duedate = d;

    // Update parent if provided
    if (parentKey) {
        body.fields.parent = { key: parentKey };
    }

    // Also update custom field on Thread if needed
    if (row['Issue Type'] === 'Thread') {
        const desc = row['Next Milestone (add only for Thread)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Next Milestone']] = String(desc).trim() || 'N/A';
    }

    return body;
}

async function applyCustomUpdate(body, row, userCache) {
    const email = row['Assignee (Owner Mail ID)'];
    if (email) {
        const aid = await getUserId(email, userCache);
        if (aid) body.fields.assignee = { accountId: aid };
    }
}

// ===== MAIN SYNC =====
async function sync() {
    console.log('🚀 Starting Jira Sync...');

    const state = loadState();
    const { issueMapping, userCache, lastHashes } = state;
    const results = { created: 0, updated: 0, skipped: 0, failed: 0, cascade: 0, cleaned: 0 };

    // Fetch Sheet Data
    console.log('📊 Fetching Google Sheet...');
    const allRows = await getSheetData();
    console.log(`📋 Found ${allRows.length} rows`);

    // Fetch ALL Jira Issues
    let allJiraIssues = [];
    let jiraBySummary = {};
    let jiraKeySet = new Set();
    try {
        const search = await jira.post('/rest/api/3/search/jql', {
            jql: `project = ${PROJECT_KEY}`,
            fields: ['summary', 'status', 'parent', 'issuetype'],
            maxResults: 1000
        });
        allJiraIssues = search.data.issues || [];
        for (const i of allJiraIssues) {
            jiraBySummary[norm(i.fields.summary)] = i.key;
            jiraKeySet.add(i.key);
        }
        console.log(`📂 Found ${allJiraIssues.length} existing Jira issues`);
    } catch (e) { console.error('Jira search failed:', e.message); }

    // ===== CLEANUP: Detect Deleted Issues =====
    console.log('\n🧹 Checking for deleted Jira issues...');
    for (const [csvKey, jiraKey] of Object.entries(issueMapping)) {
        if (!jiraKeySet.has(jiraKey)) {
            console.log(`🗑️ Deleted from Jira: ${csvKey} -> ${jiraKey} (removing mapping)`);
            delete issueMapping[csvKey];
            delete lastHashes[csvKey];
            results.cleaned++;
        }
    }
    if (results.cleaned > 0) {
        console.log(`🧹 Cleaned ${results.cleaned} stale mappings`);
    } else {
        console.log('✅ No deleted issues found');
    }

    // Find Changed Rows (AFTER cleanup so cleaned rows get re-processed)
    const changedRows = [];
    for (const row of allRows) {
        const key = row['Issue Key'];
        if (!key) continue;
        const hash = rowHash(row);
        if (lastHashes[key] !== hash) changedRows.push(row);
        else results.skipped++;
    }

    console.log(`🔄 ${changedRows.length} changed rows to process`);

    // Map Missing Keys
    for (const row of changedRows) {
        const key = row['Issue Key'];
        if (!issueMapping[key]) {
            const match = jiraBySummary[norm(row['Summary of JTBD/Thread'])];
            if (match) {
                issueMapping[key] = match;
                console.log(`🔗 Mapped existing: ${key} -> ${match}`);
            }
        }
    }

    // Process Rows
    async function processRow(row, type, parentKey) {
        const key = row['Issue Key'];
        let jiraKey = issueMapping[key];
        let success = true;

        // If no mapping exists, do a JQL safety search to prevent duplicates
        if (!jiraKey) {
            try {
                const summary = row['Summary of JTBD/Thread'] ? row['Summary of JTBD/Thread'].replace(/"/g, '\\"') : '';
                const searchRes = await jira.post('/rest/api/3/search/jql', {
                    jql: `project = ${PROJECT_KEY} AND summary ~ "\\"${summary}\\""`,
                    fields: ['summary'],
                    maxResults: 5
                });
                const found = (searchRes.data.issues || []).find(
                    i => norm(i.fields.summary) === norm(row['Summary of JTBD/Thread'])
                );
                if (found) {
                    issueMapping[key] = found.key;
                    jiraKey = found.key;
                    console.log(`🔗 Found existing issue by search: ${key} -> ${found.key} (preventing duplicate)`);
                }
            } catch (e) {
                console.warn(`⚠️ Duplicate check search failed for ${key}: ${e.message}`);
            }
        }

        if (!jiraKey) {
            // Create - ONLY if absolutely no existing issue found
            try {
                const body = await getBody(row, type, parentKey, userCache);
                console.log(`📤 Creating ${key}...`);
                const res = await jira.post('/rest/api/3/issue?notifyUsers=false', body);
                issueMapping[key] = res.data.key;
                console.log(`✅ Created: ${key} -> ${res.data.key}`);

                // Default to 'Not picked yet' if empty
                const statusToSet = row['Status'] ? row['Status'].trim() : 'Not picked yet';
                const statusOk = await setStatus(res.data.key, statusToSet);
                if (!statusOk) success = false;

                if (success) {
                    lastHashes[key] = rowHash(row);
                    results.created++;
                } else {
                    results.failed++; // Count as failed so user knows something is wrong
                }
            } catch (e) {
                const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                console.error(`❌ Failed: ${key} - ${errMsg}`);
                results.failed++;
            }
        } else {
            // Update
            try {
                const body = getUpdateBody(row, parentKey);
                await applyCustomUpdate(body, row, userCache);
                await jira.put(`/rest/api/3/issue/${jiraKey}?notifyUsers=false`, body);

                // Default to 'Not picked yet' if empty
                const statusToSet = row['Status'] ? row['Status'].trim() : 'Not picked yet';
                const statusOk = await setStatus(jiraKey, statusToSet);
                if (!statusOk) success = false;

                if (success) {
                    console.log(`🔄 Updated: ${key} -> ${jiraKey}`);
                    lastHashes[key] = rowHash(row);
                    results.updated++;
                } else {
                    results.failed++;
                }
            } catch (e) {
                const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                console.error(`❌ Update failed: ${key} - ${errMsg}`);
                results.failed++;
            }
        }
    }

    // Process in Order: JTBD -> Thread
    if (changedRows.length > 0) {
        const jtbds = changedRows.filter(r => r['Issue Type'] === 'JTBD');
        const threads = changedRows.filter(r => r['Issue Type'] === 'Thread');

        console.log(`\n📋 Processing ${jtbds.length} JTBDs...`);
        for (const r of jtbds) await processRow(r, 'JTBD', null);

        console.log(`\n📋 Processing ${threads.length} Threads...`);
        for (const r of threads) {
            const parentKey = issueMapping[r['Parent']];
            if (parentKey) {
                await processRow(r, 'Thread', parentKey);
            } else {
                console.error(`❌ Thread ${r['Issue Key']} has no valid Parent mapping (${r['Parent']}). Skipping it.`);
                results.failed++;
            }
        }
    }



    // Save State
    saveState({ issueMapping, userCache, lastHashes });

    console.log('\n📊 Sync Complete:');
    console.log(`   Created: ${results.created}`);
    console.log(`   Updated: ${results.updated}`);
    console.log(`   Skipped: ${results.skipped}`);
    console.log(`   Cleaned: ${results.cleaned}`);
    console.log(`   Failed: ${results.failed}`);

    return results;
}

sync().catch(console.error);
