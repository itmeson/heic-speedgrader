// Options page: add/remove custom Canvas addresses (optional host permissions).
const $ = (id) => document.getElementById(id);
const required = chrome.runtime.getManifest().host_permissions || [];

/** Normalize what the teacher typed to a bare https host name, or explain why not. */
function toHost(input) {
  let s = input.trim();
  if (!s) return { error: 'Type your school\'s Canvas address, for example canvas.myschool.org' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) {
    return { error: 'Use a web address starting with https://, or just the site name.' };
  }
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return { error: 'That doesn\'t look like a web address. Try something like canvas.myschool.org' }; }
  if (u.username || u.password) return { error: 'Leave out any user name or password; just the site name.' };
  if (u.port) return { error: 'Canvas sites with a port number (like :8443) aren\'t supported.' };
  const host = u.hostname; // international names arrive as xn-- (punycode)
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/.test(host)) {
    return { error: 'That doesn\'t look like a web address. Try something like canvas.myschool.org' };
  }
  return { host };
}

function say(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = kind;
}

let busy = false;
async function withBusy(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    say(`Something went wrong: ${e.message}`, 'error');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

async function sync() {
  const res = await chrome.runtime.sendMessage({ type: 'sync-content-scripts' });
  if (!res?.ok) throw new Error(res?.error || 'the extension did not respond');
}

async function render() {
  const { origins = [] } = await chrome.permissions.getAll();
  const custom = origins.filter((o) => !required.includes(o) && /^https:\/\/[^*/:@]+\/\*$/.test(o));
  const list = $('list');
  list.replaceChildren();
  if (!custom.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None yet.';
    list.append(li);
  }
  for (const origin of custom) {
    const host = new URL(origin.replace(/\/\*$/, '/')).host;
    const li = document.createElement('li');
    li.append(host + ' ');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'link';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${host}`);
    rm.addEventListener('click', () => withBusy(async () => {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      if (!removed) { say(`Chrome didn't remove access to ${host}.`, 'error'); return; }
      await sync();
      say(`Removed ${host}. Reload any open tabs on that site to turn the extension off there.`, 'ok');
      await render();
    }));
    li.append(rm);
    list.append(li);
  }
}

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { host, error } = toHost($('domain').value);
  if (error) { say(error, 'error'); return; }
  if (host === 'instructure.com' || host.endsWith('.instructure.com')) {
    say(`${host} already works. No need to add it.`, 'ok');
    return;
  }
  // The permission request must start directly from the click, before any await.
  const request = chrome.permissions.request({ origins: [`https://${host}/*`] });
  withBusy(async () => {
    if (!(await request)) { say('Chrome permission was not granted, so nothing was added.', 'error'); return; }
    await sync();
    $('domain').value = '';
    say(`Added ${host}. Reload any open Canvas tabs on that site.`, 'ok');
    await render();
  });
});

render().catch((e) => say(`Couldn't read settings: ${e.message}`, 'error'));
