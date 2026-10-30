// HEIC Viewer for Canvas SpeedGrader — content script.
//
// Runs on Canvas course pages. It never reads grades, names, or comments and
// stores nothing. It only looks for links to files named *.heic / *.heif and,
// when one is selected, shows the extension's local viewer in place of
// Canvas's "no preview available" area.

(() => {
  const HEIC_NAME = /\.(heic|heif)\s*$/i;
  const VIEWER_URL = chrome.runtime.getURL('viewer.html');
  const MARK = 'heicViewer'; // data-heic-viewer on links we've handled

  const isSpeedGrader = /\/gradebook\/speed_grader/.test(location.pathname);
  const EXT_ORIGIN = new URL(VIEWER_URL).origin;

  // ---------------------------------------------------------------------
  // Decoder host: one invisible extension frame per tab that keeps a warm
  // pool of decoder workers, so switching students doesn't restart them.
  // Created the first time a HEIC file is seen on the page.
  // ---------------------------------------------------------------------
  let hostPromise = null;
  function ensureHost() {
    return (hostPromise ??= new Promise((resolve) => {
      const host = document.createElement('iframe');
      host.src = chrome.runtime.getURL('decoder-host.html');
      host.className = 'heic-decoder-host';
      host.setAttribute('aria-hidden', 'true');
      host.tabIndex = -1;
      host.addEventListener('load', () => resolve(host), { once: true });
      document.documentElement.append(host);
    }));
  }

  /** Give a freshly loaded viewer frame a direct channel to the decoder host. */
  async function connectViewer(frame) {
    const host = await ensureHost();
    if (!frame.isConnected || !frame.contentWindow) return;
    const { port1, port2 } = new MessageChannel();
    host.contentWindow.postMessage({ type: 'heic-decoder-port' }, EXT_ORIGIN, [port2]);
    frame.contentWindow.postMessage({ type: 'heic-decoder-port' }, EXT_ORIGIN, [port1]);
  }

  /** Build the viewer iframe for a given file URL. */
  function makeViewerFrame(href, name) {
    const src = new URL(href, location.href).href;
    const frame = document.createElement('iframe');
    frame.className = 'heic-viewer-frame';
    frame.title = `HEIC preview: ${name}`;
    frame.src = `${VIEWER_URL}#${new URLSearchParams({ src, name })}`;
    frame.setAttribute('allow', 'fullscreen');
    frame.addEventListener('load', () => connectViewer(frame), { once: true });
    return frame;
  }

  // ---------------------------------------------------------------------
  // Classic SpeedGrader: render into #iframe_holder, like Canvas does for
  // JPG/PNG submissions.
  // ---------------------------------------------------------------------
  let shownHref = null;

  function showInSpeedGrader(link) {
    const holder = document.getElementById('iframe_holder');
    if (!holder) return false;
    const href = link.getAttribute('href');
    holder.replaceChildren(makeViewerFrame(href, link.textContent.trim()));
    holder.style.display = '';
    holder.dataset[MARK] = '1';
    shownHref = href;
    // Canvas shows a "no preview" notice for files it can't render; hide it
    // while our viewer is up (it comes back on the next student).
    document.querySelectorAll('#this_student_has_a_submission .no-preview, #no_annotation_warning')
      .forEach((el) => { el.style.display = 'none'; });
    return true;
  }

  function speedGraderLinks() {
    return [...document.querySelectorAll('#submission_files_list a.display_name')]
      .filter((a) => HEIC_NAME.test(a.textContent));
  }

  function holderIsEmptyOrBroken(holder) {
    if (!holder) return false;
    if (holder.dataset[MARK] && holder.querySelector('.heic-viewer-frame')) return false;
    const visible = holder.style.display !== 'none' && holder.childElementCount > 0;
    if (!visible) return true;
    // Canvas may try <img src=...heic>, which Chrome can't draw.
    const img = holder.querySelector(':scope > img');
    return !!img && speedGraderLinks().some((a) => img.getAttribute('src') === a.getAttribute('href'));
  }

  function scanSpeedGrader() {
    const holder = document.getElementById('iframe_holder');
    if (holder && holder.dataset[MARK] && !holder.querySelector('.heic-viewer-frame')) {
      delete holder.dataset[MARK]; // Canvas replaced our viewer (new student/file)
      shownHref = null;
    }

    const links = speedGraderLinks();
    if (links.length) ensureHost();
    for (const link of links) {
      if (link.dataset[MARK]) continue;
      link.dataset[MARK] = '1';
      const badge = document.createElement('span');
      badge.className = 'heic-viewer-badge';
      badge.textContent = 'HEIC';
      badge.title = 'Displayed by the HEIC Viewer extension';
      link.after(badge);
      // Let Canvas run its own click handler first, then take over the preview.
      link.addEventListener('click', () => setTimeout(() => showInSpeedGrader(link), 0));
    }

    // Auto-show when Canvas has nothing (or a broken image) to display.
    if (links.length && holderIsEmptyOrBroken(holder)) {
      showInSpeedGrader(links[0]);
    }
  }

  // ---------------------------------------------------------------------
  // Fallback for any other Canvas page (submission details, new SpeedGrader
  // UI, etc.): add a "View HEIC" button that opens the viewer in an overlay.
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

  function openOverlay(href, name) {
    closeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'heic-viewer-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay(); });
    const close = document.createElement('button');
    close.className = 'heic-viewer-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close HEIC preview');
    close.addEventListener('click', closeOverlay);
    overlay.append(makeViewerFrame(href, name), close);
    document.body.append(overlay);
    document.addEventListener('keydown', escClose);
  }
  function escClose(e) { if (e.key === 'Escape') closeOverlay(); }
  function closeOverlay() {
    document.querySelectorAll('.heic-viewer-overlay').forEach((el) => el.remove());
    document.removeEventListener('keydown', escClose);
  }

  function scanGeneric() {
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.dataset[MARK]) continue;
      if (a.closest('#submission_files_list, .heic-viewer-overlay')) continue;
      const name = linkName(a);
      if (!name) continue;
      a.dataset[MARK] = '1';
      ensureHost();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'heic-viewer-button';
      btn.textContent = 'View HEIC';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openOverlay(a.getAttribute('href'), name);
      });
      a.after(btn);
    }
  }


  // ---------------------------------------------------------------------
  // Layout-independent path (works in the new SpeedGrader too): read the
  // current assignment/student from the URL, ask Canvas for that submission's
  // attachments using your existing session (no API token), and show a
  // floating "View HEIC" panel when any are HEIC/HEIF.
  // ---------------------------------------------------------------------
  const log = (...a) => console.info('[HEIC Viewer]', ...a);

  function currentIds() {
    const course = location.pathname.match(/\/courses\/(\d+)/)?.[1];
    const q = new URLSearchParams(location.search);
    let assignment = q.get('assignment_id');
    let student = q.get('student_id');
    let anon = q.get('anonymous_id');
    // Older SpeedGrader keeps the student in the hash: #{"student_id":"123"}
    try {
      const h = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
      student = student || h.student_id;
      anon = anon || h.anonymous_id;
    } catch { /* not JSON */ }
    return { course, assignment, student, anon };
  }

  async function canvasJson(path) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} for ${path}`);
    const text = await res.text();
    return JSON.parse(text.replace(/^while\(1\);/, ''));
  }

  function heicAttachments(sub) {
    const all = [sub, ...(sub.submission_history || [])]
      .flatMap((s) => s?.attachments || []);
    const seen = new Set();
    return all.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return HEIC_NAME.test(a.display_name || a.filename || '') ||
        /image\/hei[cf]/i.test(a['content-type'] || a.content_type || '');
    });
  }

  let lastKey = null;
  let panel = null;

  function renderPanel(files) {
    panel?.remove();
    panel = null;
    if (!files.length) return;
    ensureHost();
    panel = document.createElement('div');
    panel.className = 'heic-viewer-panel';
    const label = document.createElement('span');
    label.textContent = files.length === 1 ? 'HEIC image:' : `${files.length} HEIC images:`;
    panel.append(label);
    for (const f of files) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'heic-viewer-button';
      b.textContent = f.display_name || f.filename || `file ${f.id}`;
      b.addEventListener('click', () => openOverlay(f.url, b.textContent));
      panel.append(b);
    }
    document.body.append(panel);
  }

  async function checkSubmission() {
    const { course, assignment, student, anon } = currentIds();
    const key = `${course}|${assignment}|${student}|${anon}`;
    if (key === lastKey) return;
    lastKey = key;
    if (!course || !assignment || !(student || anon)) {
      log('waiting for a student to be selected', { course, assignment, student, anon });
      renderPanel([]);
      return;
    }
    const path = anon
      ? `/api/v1/courses/${course}/assignments/${assignment}/anonymous_submissions/${anon}?include[]=submission_history`
      : `/api/v1/courses/${course}/assignments/${assignment}/submissions/${student}?include[]=submission_history`;
    try {
      const sub = await canvasJson(path);
      if (key !== lastKey) return; // moved on to another student meanwhile
      const files = heicAttachments(sub);
      log(`submission has ${(sub.attachments || []).length} attachment(s), ${files.length} HEIC`);
      renderPanel(files);
    } catch (err) {
      log('could not read submission attachments:', err.message);
      renderPanel([]);
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
    log('active on SpeedGrader', {
      frame: window === top ? 'top' : 'iframe',
      classicLayout: !!document.getElementById('submission_files_list'),
    });
    checkSubmission();
    // SpeedGrader changes students without reloading the page.
    setInterval(checkSubmission, 700);
  }
})();
