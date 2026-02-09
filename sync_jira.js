const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');

// ===== CONFIG =====
const SHEET_ID = '1BEFNLeuVQ8HdpsKD5_KB4gtXHgpMInm9pFKM8yvKVXk';
const SHEET_NAME = 'JIRA format';
const JIRA_EMAIL = process.env.JIRA_EMAIL || 'ananya.sharma@leapfinance.com';
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const PROJECT_KEY = 'BUS';
const JIRA_BASE = 'https://leapfinance.atlassian.net';
const STATE_FILE = path.join(__dirname, 'sync_state.json');

const ISSUE_TYPE_IDS = { 'JTBD': '10223', 'Thread': '10224', 'Milestone': '10225' };
const CUSTOM_FIELDS = {
    'Function': 'customfield_10475',
    'Metric In Focus': 'customfield_10478',
    'Metric Target': 'customfield_10477',
    'Metric Current State': 'customfield_10511',
    'Metric Start State': 'customfield_10476'
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
    if (!d || !String(d).includes('/')) return null;
    const p = String(d).split('/');
    return p.length === 3 ? `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}` : null;
}

function getDefaultDate() {
    const d = new Date();
    d.setDate(d.getDate() + 30); // 30 days from now
    return d.toISOString().split('T')[0];
}

function norm(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function rowHash(r) {
    return ['Summary', 'Parent', 'Assignee (Owner Mail ID)', 'Due Date', 'Status',
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

async function setStatus(key, status) {
    if (!status) return;
    const s = status.trim().toLowerCase();
    if (['to do', 'not picked yet'].includes(s)) return;
    try {
        const t = await jira.get(`/rest/api/3/issue/${key}/transitions`);
        const tr = (t.data.transitions || []).find(x =>
            x.to.name.toLowerCase() === s || x.to.name.toLowerCase().includes(s));
        if (tr) await jira.post(`/rest/api/3/issue/${key}/transitions`, { transition: { id: tr.id } });
    } catch (e) { console.error(`Transition failed for ${key}: ${e.message}`); }
}

async function getBody(row, type, parentKey, userCache) {
    const body = {
        fields: {
            summary: row['Summary'],
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

    // JTBD requires custom fields
    if (type === 'JTBD') {
        const func = row['Function  (add only for JTBD)'] || 'Growth';
        body.fields[CUSTOM_FIELDS['Function']] = { value: func.trim() };

        const mf = row['Metric in Focus (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric In Focus']] = String(mf).trim();

        const mt = row['Metric Target (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric Target']] = String(mt).trim();

        const mc = row['Metric Current State (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric Current State']] = String(mc).trim();

        const ms = row['Metric Start State (add only for JTBD)'] || 'N/A';
        body.fields[CUSTOM_FIELDS['Metric Start State']] = String(ms).trim();
    }

    return body;
}

function getUpdateBody(row) {
    const body = { fields: { summary: row['Summary'] } };
    const d = convertDate(row['Due Date']);
    if (d) body.fields.duedate = d;
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
    const results = { created: 0, updated: 0, skipped: 0, failed: 0, cascade: 0 };

    // Fetch Sheet Data
    console.log('📊 Fetching Google Sheet...');
    const allRows = await getSheetData();
    console.log(`📋 Found ${allRows.length} rows`);

    // Find Changed Rows
    const changedRows = [];
    for (const row of allRows) {
        const key = row['Issue Key'];
        if (!key) continue;
        const hash = rowHash(row);
        if (lastHashes[key] !== hash) changedRows.push(row);
        else results.skipped++;
    }

    console.log(`🔄 ${changedRows.length} changed rows to process`);

    // Fetch ALL Jira Issues
    let allJiraIssues = [];
    let jiraBySummary = {};
    try {
        const search = await jira.post('/rest/api/3/search/jql', {
            jql: `project = ${PROJECT_KEY}`,
            fields: ['summary', 'status', 'parent', 'issuetype'],
            maxResults: 1000
        });
        allJiraIssues = search.data.issues || [];
        for (const i of allJiraIssues) {
            jiraBySummary[norm(i.fields.summary)] = i.key;
        }
        console.log(`📂 Found ${allJiraIssues.length} existing Jira issues`);
    } catch (e) { console.error('Jira search failed:', e.message); }

    // Map Missing Keys
    for (const row of changedRows) {
        const key = row['Issue Key'];
        if (!issueMapping[key]) {
            const match = jiraBySummary[norm(row['Summary'])];
            if (match) {
                issueMapping[key] = match;
                console.log(`🔗 Mapped existing: ${key} -> ${match}`);
            }
        }
    }

    // Process Rows
    async function processRow(row, type, parentKey) {
        const key = row['Issue Key'];
        const jiraKey = issueMapping[key];

        if (!jiraKey) {
            // Create
            try {
                const body = await getBody(row, type, parentKey, userCache);
                console.log(`📤 Creating ${key}...`);
                const res = await jira.post('/rest/api/3/issue', body);
                issueMapping[key] = res.data.key;
                console.log(`✅ Created: ${key} -> ${res.data.key}`);
                if (row['Status']) await setStatus(res.data.key, row['Status']);
                lastHashes[key] = rowHash(row);
                results.created++;
            } catch (e) {
                const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                console.error(`❌ Failed: ${key} - ${errMsg}`);
                results.failed++;
            }
        } else {
            // Update
            try {
                const body = getUpdateBody(row);
                await applyCustomUpdate(body, row, userCache);
                await jira.put(`/rest/api/3/issue/${jiraKey}`, body);
                if (row['Status']) await setStatus(jiraKey, row['Status']);
                console.log(`🔄 Updated: ${key} -> ${jiraKey}`);
                lastHashes[key] = rowHash(row);
                results.updated++;
            } catch (e) {
                const errMsg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
                console.error(`❌ Update failed: ${key} - ${errMsg}`);
                results.failed++;
            }
        }
    }

    // Process in Order: JTBD -> Thread -> Milestone
    if (changedRows.length > 0) {
        const jtbds = changedRows.filter(r => r['Issue Type'] === 'JTBD');
        const threads = changedRows.filter(r => r['Issue Type'] === 'Thread');
        const milestones = changedRows.filter(r => r['Issue Type'] === 'Milestone');

        console.log(`\n📋 Processing ${jtbds.length} JTBDs...`);
        for (const r of jtbds) await processRow(r, 'JTBD', null);

        console.log(`\n📋 Processing ${threads.length} Threads...`);
        for (const r of threads) await processRow(r, 'Thread', issueMapping[r['Parent']]);

        console.log(`\n📋 Processing ${milestones.length} Milestones...`);
        for (const r of milestones) {
            if (issueMapping[r['Parent']]) await processRow(r, 'Milestone', issueMapping[r['Parent']]);
            else { console.error(`❌ No parent for: ${r['Issue Key']}`); results.failed++; }
        }
    }

    // ===== STATUS CASCADE =====
    console.log('\n🔗 Running Cascade Logic...');

    // Refresh Jira issues for cascade
    try {
        const search = await jira.post('/rest/api/3/search/jql', {
            jql: `project = ${PROJECT_KEY}`,
            fields: ['summary', 'status', 'parent', 'issuetype'],
            maxResults: 1000
        });
        allJiraIssues = search.data.issues || [];
    } catch (e) { }

    const jiraThreads = allJiraIssues.filter(i => i.fields.issuetype.name === 'Thread');
    const jiraMilestones = allJiraIssues.filter(i => i.fields.issuetype.name === 'Milestone');
    const jiraJtbds = allJiraIssues.filter(i => i.fields.issuetype.name === 'JTBD');

    // Thread <- Milestone
    for (const thread of jiraThreads) {
        const children = jiraMilestones.filter(m => m.fields.parent && m.fields.parent.key === thread.key);
        if (children.length === 0) continue;
        const allDone = children.every(c => c.fields.status.name === 'Done');
        const anyStarted = children.some(c => ['Done', 'On track', 'In Progress'].includes(c.fields.status.name));
        const current = thread.fields.status.name;
        if (allDone && current !== 'Done') {
            await setStatus(thread.key, 'Done');
            console.log(`🔗 Cascade: ${thread.key} -> Done`);
            results.cascade++;
        } else if (anyStarted && ['To Do', 'Not picked yet'].includes(current)) {
            await setStatus(thread.key, 'On track');
            console.log(`🔗 Cascade: ${thread.key} -> On track`);
            results.cascade++;
        }
    }

    // JTBD <- Thread
    for (const jtbd of jiraJtbds) {
        const children = jiraThreads.filter(t => t.fields.parent && t.fields.parent.key === jtbd.key);
        if (children.length === 0) continue;
        const allDone = children.every(c => c.fields.status.name === 'Done');
        const anyStarted = children.some(c => ['Done', 'On track', 'In Progress'].includes(c.fields.status.name));
        const current = jtbd.fields.status.name;
        if (allDone && current !== 'Done') {
            await setStatus(jtbd.key, 'Done');
            console.log(`🔗 Cascade: ${jtbd.key} -> Done`);
            results.cascade++;
        } else if (anyStarted && ['To Do', 'Not picked yet'].includes(current)) {
            await setStatus(jtbd.key, 'On track');
            console.log(`🔗 Cascade: ${jtbd.key} -> On track`);
            results.cascade++;
        }
    }

    // Save State
    saveState({ issueMapping, userCache, lastHashes });

    console.log('\n📊 Sync Complete:');
    console.log(`   Created: ${results.created}`);
    console.log(`   Updated: ${results.updated}`);
    console.log(`   Skipped: ${results.skipped}`);
    console.log(`   Cascade: ${results.cascade}`);
    console.log(`   Failed: ${results.failed}`);

    return results;
}

sync().catch(console.error);
