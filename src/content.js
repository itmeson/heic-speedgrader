// HEIC Viewer for Canvas SpeedGrader — content script (top frame of Canvas
// course pages).
//
// Finds HEIC/HEIF submission files and shows them in the extension's viewer.
// In SpeedGrader it reads the current course/assignment/student IDs from the
// page address and asks Canvas (with the teacher's existing login) for that
// submission's attachment list; only file names, types and download
// addresses are kept from the reply. Nothing is stored or sent elsewhere.

(() => {
  const HEIC_NAME = /\.(heic|heif)\s*$/i;
  const VIEWER_URL = chrome.runtime.getURL('viewer.html');
  const EXT_ORIGIN = new URL(VIEWER_URL).origin;
  const MARK = 'heicViewer'; // data-heic-viewer on links we've handled
  const isSpeedGrader = /\/gradebook\/speed_grader/.test(location.pathname);
  const log = (...a) => console.info('[HEIC Viewer]', ...a);

  // ---------------------------------------------------------------------
  // Decoder host: one invisible extension frame per tab that keeps a warm
  // pool of decoder workers. Viewers connect to it themselves (checking
  // that they're talking to an extension frame); nothing passes through here.
  // ---------------------------------------------------------------------
  let host = null;
  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('iframe');
    host.src = chrome.runtime.getURL('decoder-host.html');
    host.className = 'heic-decoder-host';
    host.setAttribute('aria-hidden', 'true');
    host.tabIndex = -1;
    document.documentElement.append(host);
  }

  // ---------------------------------------------------------------------
  // Viewer frames get a one-time ticket from the background script, which
  // checks the file address; the address itself never goes in the frame URL.
  // ---------------------------------------------------------------------
  // Canvas download links on the page need the teacher's login cookie,
  // which the viewer frame can't rely on. So we ask Canvas's API (from this
  // page, with the teacher's session) for the file's own download address,
  // which carries a per-file access token ("verifier").
  async function canvasJson(path, signal) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      const err = new Error(`Canvas replied ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
  }

  async function resolveDownloadUrl(href) {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) throw new Error('file is not on this Canvas site');
    if (u.searchParams.get('verifier') && /\/files\/\d+\/download$/.test(u.pathname)) return u.href;
    // Classic SpeedGrader: /courses/C/assignments/A/(anonymous_)submissions/S?download=ATT
    let m = u.pathname.match(/^\/courses\/(\d+)\/assignments\/(\d+)\/(submissions|anonymous_submissions)\/([A-Za-z0-9]+)$/);
    const att = u.searchParams.get('download');
    if (m && /^\d+$/.test(att || '')) {
      const [, c, a, kind, s] = m;
      const sub = await canvasJson(`/api/v1/courses/${c}/assignments/${a}/${kind}/${encodeURIComponent(s)}?include[]=submission_history`);
      const found = [sub, ...(sub.submission_history || [])]
        .flatMap((x) => x?.attachments || []).find((x) => String(x.id) === att);
      if (!found?.url) throw new Error('Canvas did not list this file');
      return found.url;
    }
    // Course/user/group file links: /courses/C/files/F, /files/F/download, …
    m = u.pathname.match(/^(?:\/(?:courses|users|groups)\/\d+)?\/files\/(\d+)(?:\/download|\/preview)?$/);
    if (m) {
      const file = await canvasJson(`/api/v1/files/${m[1]}`);
      if (!file?.url) throw new Error('Canvas did not provide a download address');
      return file.url;
    }
    throw new Error('not a Canvas file link');
  }

  async function makeViewerFrame(href, name) {
    const frame = document.createElement('iframe');
    frame.className = 'heic-viewer-frame';
    frame.title = `HEIC preview: ${name}`;
    frame.setAttribute('allow', 'fullscreen');
    let res;
    try {
      const url = await resolveDownloadUrl(href);
      res = await chrome.runtime.sendMessage({ type: 'register-file', url, name });
    } catch (e) {
      res = { error: e.status === 401 ? 'your Canvas login has expired; reload the page' : e.message };
    }
    frame.src = res?.ticket
      ? `${VIEWER_URL}#t=${encodeURIComponent(res.ticket)}`
      : `${VIEWER_URL}#error=${encodeURIComponent(res?.error || 'could not open this file')}`;
    if (res?.error) log('could not open file:', res.error);
    return frame;
  }

  // Messages from our own viewer frames (e.g. Escape pressed inside it).
  window.addEventListener('message', (e) => {
    if (e.origin !== EXT_ORIGIN || e.data?.type !== 'heic-viewer-close') return;
    if (document.querySelector('.heic-viewer-overlay iframe')?.contentWindow === e.source) closeOverlay();
  });

  // ---------------------------------------------------------------------
  // Classic SpeedGrader: render into #iframe_holder, like Canvas does for
  // JPG/PNG submissions. Canvas's file list already reflects the selected
  // student and attempt.
  // ---------------------------------------------------------------------
  let showToken = 0;
  async function showInSpeedGrader(link) {
    const holder = document.getElementById('iframe_holder');
    if (!holder) return;
    const mine = ++showToken;
    holder.dataset[MARK] = 'pending';
    const frame = await makeViewerFrame(link.getAttribute('href'), link.textContent.trim());
    // Canvas may have moved on (another file/student) while we waited.
    if (mine !== showToken || !link.isConnected) return;
    holder.replaceChildren(frame);
    holder.style.display = '';
    holder.dataset[MARK] = '1';
    document.querySelectorAll('#no_annotation_warning').forEach((el) => { el.style.display = 'none'; });
  }

  function speedGraderLinks() {
    return [...document.querySelectorAll('#submission_files_list a.display_name')]
      .filter((a) => HEIC_NAME.test(a.textContent));
  }

  function holderIsEmptyOrBroken(holder) {
    if (!holder || holder.dataset[MARK] === 'pending') return false;
    if (holder.dataset[MARK] && holder.querySelector('.heic-viewer-frame')) return false;
    const visible = holder.style.display !== 'none' && holder.childElementCount > 0;
    if (!visible) return true;
    // Canvas may try <img src=...heic>, which Chrome can't draw.
    const img = holder.querySelector(':scope > img');
    return !!img && speedGraderLinks().some((a) => img.getAttribute('src') === a.getAttribute('href'));
  }

  function scanSpeedGrader() {
    const holder = document.getElementById('iframe_holder');
    if (holder && holder.dataset[MARK] === '1' && !holder.querySelector('.heic-viewer-frame')) {
      delete holder.dataset[MARK]; // Canvas replaced our viewer (new student/file)
    }
    const links = speedGraderLinks();
    if (links.length) ensureHost();
    for (const link of links) {
      if (link.dataset[MARK] === link.getAttribute('href')) continue;
      const fresh = !link.dataset[MARK];
      link.dataset[MARK] = link.getAttribute('href'); // re-checked if Canvas reuses the element
      if (!fresh) continue;
      const badge = document.createElement('span');
      badge.className = 'heic-viewer-badge';
      badge.textContent = 'HEIC';
      badge.title = 'Displayed by the HEIC Viewer extension';
      link.after(badge);
      // Let Canvas run its own click handler first, then take over the preview.
      link.addEventListener('click', () => setTimeout(() => showInSpeedGrader(link), 0));
    }
    if (links.length && holderIsEmptyOrBroken(holder)) showInSpeedGrader(links[0]);
  }

  // ---------------------------------------------------------------------
  // Overlay viewer (new SpeedGrader panel, other Canvas pages).
  // ---------------------------------------------------------------------
  let overlayToken = 0;
  let overlayOpener = null;

  async function openOverlay(href, name, opener) {
    closeOverlay();
    const mine = ++overlayToken;
    overlayOpener = opener || document.activeElement;
    const frame = await makeViewerFrame(href, name);
    if (mine !== overlayToken) return; // closed or replaced meanwhile
    const overlay = document.createElement('div');
    overlay.className = 'heic-viewer-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `HEIC preview: ${name}`);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    const close = document.createElement('button');
    close.className = 'heic-viewer-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close HEIC preview');
    close.addEventListener('click', closeOverlay);
    overlay.append(close, frame);
    // Make the rest of the page inert while the dialog is open: it can't be
    // focused, clicked, or reached by screen readers.
    for (const el of document.body.children) {
      if (el !== overlay && !el.inert) { el.inert = true; inerted.push(el); }
    }
    document.body.append(overlay);
    frame.addEventListener('load', () => frame.focus(), { once: true });
    close.focus();
    document.addEventListener('keydown', overlayKeys, true);
  }

  const inerted = [];

  function overlayKeys(e) {
    if (e.key === 'Escape' && document.querySelector('.heic-viewer-overlay')) {
      e.preventDefault();
      closeOverlay();
    }
  }

  function closeOverlay() {
    overlayToken++;
    const had = document.querySelector('.heic-viewer-overlay');
    document.querySelectorAll('.heic-viewer-overlay').forEach((el) => el.remove());
    document.removeEventListener('keydown', overlayKeys, true);
    for (const el of inerted.splice(0)) el.inert = false;
    if (had && overlayOpener?.isConnected) overlayOpener.focus();
    if (had) overlayOpener = null;
  }

  // ---------------------------------------------------------------------
  // Other Canvas course pages: "View HEIC" button next to HEIC file links.
  // ---------------------------------------------------------------------
  function linkName(a) {
    const text = a.textContent.trim();
    if (HEIC_NAME.test(text)) return text;
    const title = a.getAttribute('title') || a.getAttribute('aria-label') || '';
    if (HEIC_NAME.test(title)) return title;
    try {
      const path = decodeURIComponent(new URL(a.href, location.href).pathname);
      if (HEIC_NAME.test(path)) return path.split('/').pop();
    } catch { /* ignore */ }
    return null;
  }

  function scanGeneric() {
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.dataset[MARK]) continue;
      if (a.closest('#submission_files_list, .heic-viewer-overlay, .heic-viewer-panel')) continue;
      const name = linkName(a);
      if (!name) continue;
      a.dataset[MARK] = '1';
      ensureHost();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'heic-viewer-button';
      btn.textContent = 'View HEIC';
      btn.setAttribute('aria-label', `View ${name}`);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Read the link at click time, in case Canvas reused the element.
        openOverlay(a.getAttribute('href'), linkName(a) || name, btn);
      });
      a.after(btn);
    }
  }

  // ---------------------------------------------------------------------
  // New SpeedGrader (any layout without the classic file list): ask Canvas
  // for the current student's current attempt and offer its HEIC files in
  // a small floating panel.
  // ---------------------------------------------------------------------
  const ID = /^\d{1,20}$/;
  const ANON_ID = /^[A-Za-z0-9]{1,40}$/;

  function currentSelection() {
    const course = location.pathname.match(/\/courses\/(\d+)/)?.[1];
    const q = new URLSearchParams(location.search);
    let assignment = q.get('assignment_id');
    let student = q.get('student_id');
    let anon = q.get('anonymous_id');
    let attempt = q.get('attempt');
    // Older SpeedGrader keeps the student in the hash: #{"student_id":"123"}
    try {
      const h = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
      student = student || h.student_id;
      anon = anon || h.anonymous_id;
      attempt = attempt || h.attempt;
    } catch { /* not JSON */ }
    const ok = ID.test(course || '') && ID.test(assignment || '') &&
      (ID.test(student || '') || ANON_ID.test(anon || ''));
    return ok ? { course, assignment, student: ID.test(student || '') ? student : null,
      anon: student ? null : anon, attempt: ID.test(String(attempt || '')) ? Number(attempt) : null } : null;
  }

  const isHeicFile = (a) => HEIC_NAME.test(a.display_name || a.filename || '') ||
    /image\/hei[cf]/i.test(a['content-type'] || a.content_type || '');

  /** Keep only what we need from the reply: name and download address. */
  const minimal = (a) => ({ name: String(a.display_name || a.filename || 'image.heic'), url: String(a.url || '') });

  let lastKey = null;
  let generation = 0;
  let inflight = null;
  let panel = null;

  function clearPanel() {
    panel?.remove();
    panel = null;
  }

  function showPanel(build) {
    clearPanel();
    panel = document.createElement('div');
    panel.className = 'heic-viewer-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'HEIC Viewer');
    build(panel);
    document.body.append(panel);
  }

  function renderFiles(files) {
    if (!files.length) return clearPanel();
    ensureHost();
    showPanel((p) => {
      const label = document.createElement('span');
      label.textContent = files.length === 1 ? 'HEIC image:' : `${files.length} HEIC images:`;
      p.append(label);
      for (const f of files) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'heic-viewer-button';
        b.textContent = f.name;
        b.addEventListener('click', () => openOverlay(f.url, f.name, b));
        p.append(b);
      }
    });
  }

  function renderRetry(message) {
    showPanel((p) => {
      const label = document.createElement('span');
      label.textContent = message;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'heic-viewer-button';
      b.textContent = 'Retry';
      b.addEventListener('click', () => { lastKey = null; checkSubmission(); });
      p.append(label, b);
    });
  }

  async function checkSubmission() {
    if (document.getElementById('submission_files_list')) return; // classic layout handles it
    const sel = currentSelection();
    const key = sel ? JSON.stringify(sel) : 'none';
    if (key === lastKey) return;
    lastKey = key;

    // New selection: drop everything belonging to the previous one at once.
    const mine = ++generation;
    inflight?.abort();
    inflight = null;
    clearPanel();
    closeOverlay();
    if (!sel) return;

    const base = `/api/v1/courses/${sel.course}/assignments/${sel.assignment}/` +
      (sel.anon ? `anonymous_submissions/${encodeURIComponent(sel.anon)}` : `submissions/${sel.student}`);
    const ctrl = new AbortController();
    inflight = ctrl;
    try {
      let sub = await canvasJson(base, ctrl.signal);
      // A specific earlier attempt selected: look it up in the history.
      if (sel.attempt && sub.attempt !== sel.attempt) {
        const full = await canvasJson(`${base}?include[]=submission_history`, ctrl.signal);
        sub = (full.submission_history || []).find((s) => s.attempt === sel.attempt) || { attachments: [] };
      }
      if (mine !== generation) return;
      const files = (sub.attachments || []).filter(isHeicFile).map(minimal).filter((f) => f.url);
      log(`current attempt has ${(sub.attachments || []).length} attachment(s), ${files.length} HEIC`);
      renderFiles(files);
    } catch (err) {
      if (mine !== generation || err.name === 'AbortError') return;
      if (err.status === 404) return; // no submission yet
      log('could not check this submission:', err.message);
      renderRetry(err.status === 401
        ? 'Canvas login expired. Reload the page, then'
        : 'Couldn\'t check this submission for HEIC files.');
    } finally {
      if (inflight === ctrl) inflight = null;
    }
  }

  // ---------------------------------------------------------------------
  let queued = false;
  function scan() {
    queued = false;
    if (isSpeedGrader) scanSpeedGrader();
    scanGeneric();
  }
  function queueScan() {
    if (!queued) { queued = true; requestAnimationFrame(scan); }
  }

  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  scan();

  if (isSpeedGrader) {
    log('active on SpeedGrader', { classicLayout: !!document.getElementById('submission_files_list') });
    checkSubmission();
    // SpeedGrader changes students without reloading the page.
    window.addEventListener('popstate', checkSubmission);
    window.addEventListener('hashchange', checkSubmission);
    setInterval(checkSubmission, 500);
  }
})();
