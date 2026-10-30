// Background service worker.
// Keeps the content script registered on any custom Canvas addresses the
// teacher has added on the Options page (each one is an optional host
// permission they granted). *.instructure.com is covered by the manifest.

const SCRIPT_PREFIX = 'custom-canvas:';

async function customOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  const required = chrome.runtime.getManifest().host_permissions || [];
  return origins.filter((o) => !required.includes(o) && /^https:\/\/[^*/]+\/\*$/.test(o));
}

async function syncContentScripts() {
  const wanted = new Map((await customOrigins()).map((o) => [SCRIPT_PREFIX + new URL(o.replace('/*', '/')).host, o]));
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const stale = existing.filter((s) => s.id.startsWith(SCRIPT_PREFIX) && !wanted.has(s.id)).map((s) => s.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const have = new Set(existing.map((s) => s.id));
  const add = [...wanted].filter(([id]) => !have.has(id)).map(([id, origin]) => ({
    id,
    matches: [origin.replace(/\/\*$/, '/courses/*')],
    js: ['content.js'],
    css: ['content.css'],
    allFrames: true,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }));
  if (add.length) await chrome.scripting.registerContentScripts(add);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await syncContentScripts();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// The Options page asks for a sync right after the teacher adds/removes a site.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'sync-content-scripts') {
    syncContentScripts().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
});
