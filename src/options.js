// Options page: add/remove custom Canvas addresses (optional host permissions).
const $ = (id) => document.getElementById(id);
const required = chrome.runtime.getManifest().host_permissions || [];

function toHost(input) {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s;
  try {
    const host = new URL(s).hostname;
    return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) ? host : null;
  } catch { return null; }
}

function say(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = kind;
}

async function render() {
  const { origins = [] } = await chrome.permissions.getAll();
  const custom = origins.filter((o) => !required.includes(o) && /^https:\/\/[^*/]+\/\*$/.test(o));
  const list = $('list');
  list.replaceChildren();
  if (!custom.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None yet.';
    list.append(li);
  }
  for (const origin of custom) {
    const host = new URL(origin.replace('/*', '/')).host;
    const li = document.createElement('li');
    li.append(host + ' ');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'link';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      await chrome.permissions.remove({ origins: [origin] });
      await chrome.runtime.sendMessage({ type: 'sync-content-scripts' });
      say(`Removed ${host}.`, 'ok');
      render();
    });
    li.append(rm);
    list.append(li);
  }
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = toHost($('domain').value);
  if (!host) return say('That doesn\'t look like a web address. Try something like canvas.myschool.org', 'error');
  if (host === 'instructure.com' || host.endsWith('.instructure.com')) {
    return say(`${host} already works. No need to add it.`, 'ok');
  }
  // Must be called directly from the click/submit so Chrome shows its prompt.
  const granted = await chrome.permissions.request({ origins: [`https://${host}/*`] });
  if (!granted) return say('Chrome permission was not granted, so nothing was added.', 'error');
  const res = await chrome.runtime.sendMessage({ type: 'sync-content-scripts' });
  if (res && !res.ok) return say(`Added, but setup failed: ${res.error}`, 'error');
  $('domain').value = '';
  say(`Added ${host}. Reload any open Canvas tabs on that site.`, 'ok');
  render();
});

render();
