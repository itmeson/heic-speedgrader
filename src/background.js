// Background service worker.
//
// 1. File tickets: the content script asks here before opening the viewer.
//    We check that the request comes from a Canvas page this extension runs
//    on and that the file address is a Canvas file download on that same
//    site, then hand back a one-time ticket. The viewer redeems the ticket
//    (same tab only) to learn which file to show. Web pages can't mint
//    tickets, so embedding the viewer elsewhere gets them nothing.
// 2. Custom Canvas addresses: keeps the content script registered on sites
//    the teacher added on the Options page (each an optional permission).

import { checkFileUrl, isInstructureOrigin } from './url-policy.js';

const SCRIPT_PREFIX = 'custom-canvas:';
const TICKET_TTL_MS = 60_000;
const VIEWER_URL = chrome.runtime.getURL('viewer.html');

// ---------------------------------------------------------------------------
// File tickets
// ---------------------------------------------------------------------------
const tickets = new Map(); // ticket -> { url, name, tabId, pageOrigin, expires }

function sweepTickets() {
  const now = Date.now();
  for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t);
}

async function isCanvasPage(origin) {
  if (isInstructureOrigin(origin)) return true;
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] }) &&
      (await customOrigins()).includes(`${origin}/*`);
  } catch {
    return false;
  }
}

async function registerFile(msg, sender) {
  // Must come from our own content script running in a tab.
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.url?.startsWith('chrome-extension:')) {
    return { error: 'not allowed' };
  }
  const pageOrigin = sender.origin || new URL(sender.url).origin;
  if (!(await isCanvasPage(pageOrigin))) return { error: 'not a Canvas page this extension runs on' };
  const checked = checkFileUrl(msg.url, pageOrigin);
  if (checked.error) return { error: checked.error };
  sweepTickets();
  const ticket = crypto.randomUUID();
  tickets.set(ticket, {
    url: checked.url,
    name: String(msg.name || '').slice(0, 200),
    tabId: sender.tab.id,
    pageOrigin,
    expires: Date.now() + TICKET_TTL_MS,
  });
  return { ticket };
}

function redeemTicket(msg, sender) {
  sweepTickets();
  const entry = tickets.get(msg.ticket);
  // Only our viewer page, in the same tab the ticket was issued for, once.
  if (!entry || sender.id !== chrome.runtime.id || !sender.url?.startsWith(VIEWER_URL) ||
      sender.tab?.id !== entry.tabId) {
    return { error: 'This preview link is no longer valid. Close it and open the file again.' };
  }
  tickets.delete(msg.ticket);
  return { url: entry.url, name: entry.name, pageOrigin: entry.pageOrigin };
}

// ---------------------------------------------------------------------------
// Custom Canvas addresses
// ---------------------------------------------------------------------------
async function customOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  const required = chrome.runtime.getManifest().host_permissions || [];
  return origins.filter((o) => !required.includes(o) && /^https:\/\/[^*/:@]+\/\*$/.test(o));
}

async function reconcileContentScripts() {
  const wanted = new Map();
  for (const o of await customOrigins()) {
    const host = new URL(o.replace(/\/\*$/, '/')).host;
    wanted.set(SCRIPT_PREFIX + host, o.replace(/\/\*$/, '/courses/*'));
  }
  const existing = (await chrome.scripting.getRegisteredContentScripts())
    .filter((s) => s.id.startsWith(SCRIPT_PREFIX));
  // Remove scripts no longer wanted, or whose settings differ from what we'd register.
  const stale = existing.filter((s) => wanted.get(s.id) !== s.matches?.[0] || s.allFrames).map((s) => s.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const keep = new Set(existing.map((s) => s.id).filter((id) => !stale.includes(id)));
  const add = [...wanted].filter(([id]) => !keep.has(id)).map(([id, match]) => ({
    id,
    matches: [match],
    js: ['content.js'],
    css: ['content.css'],
    allFrames: false,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }));
  if (add.length) await chrome.scripting.registerContentScripts(add);
}

// One reconciliation at a time; concurrent requests share the next run.
let syncChain = Promise.resolve();
function syncContentScripts() {
  const run = syncChain.then(reconcileContentScripts, reconcileContentScripts);
  syncChain = run.catch((e) => console.warn('[HEIC Viewer] content-script sync failed:', e.message));
  return run;
}

// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await syncContentScripts().catch(() => {});
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => { syncContentScripts().catch(() => {}); });
chrome.permissions.onAdded.addListener(() => { syncContentScripts().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { syncContentScripts().catch(() => {}); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const respond = (p) => { p.then(reply, (e) => reply({ ok: false, error: e.message })); return true; };
  switch (msg?.type) {
    case 'register-file': return respond(registerFile(msg, sender));
    case 'redeem-ticket': reply(redeemTicket(msg, sender)); return false;
    case 'sync-content-scripts':
      // Only our own Options page may ask.
      if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('options.html'))) return false;
      return respond(syncContentScripts().then(() => ({ ok: true })));
    default: return false;
  }
});
