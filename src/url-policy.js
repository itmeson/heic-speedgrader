// Which addresses the extension will fetch, with the teacher's Canvas login.
// Shared by the background script (before issuing a ticket) and the viewer
// (to check where a download actually ended up after Canvas's redirects).

const INSTRUCTURE = /^https:\/\/([a-z0-9-]+\.)*instructure\.com$/;

export function isInstructureOrigin(origin) {
  return INSTRUCTURE.test(origin);
}

// Canvas file-download paths on the Canvas site itself (as returned by the
// Canvas API, with a per-file access token).
const FILE_PATHS = [
  /^\/files\/\d+\/download$/,
  /^\/(courses|users|groups)\/\d+\/files\/\d+\/download$/,
];

/**
 * Validate a file address requested from a Canvas page.
 * @returns {{url: string} | {error: string}}
 */
export function checkFileUrl(raw, pageOrigin) {
  let u;
  try { u = new URL(raw); } catch { return { error: 'not a valid address' }; }
  if (u.protocol !== 'https:') return { error: 'only https addresses are allowed' };
  if (u.username || u.password) return { error: 'addresses with credentials are not allowed' };
  if (u.origin !== pageOrigin) return { error: 'file is not on this Canvas site' };
  if (!FILE_PATHS.some((re) => re.test(u.pathname))) return { error: 'not a Canvas file download address' };
  u.hash = '';
  return { url: u.href };
}

// Hosts a Canvas download may legitimately redirect to.
const FILE_HOSTS = [
  /^([a-z0-9-]+\.)*instructure\.com$/,
  /^([a-z0-9-]+\.)*canvas-user-content\.com$/,
  /^([a-z0-9-]+\.)*inscloudgate\.net$/,
  /^instructure-uploads(-[a-z0-9-]+)?\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/,
];

/** Is the final (post-redirect) download address an expected Canvas file host? */
export function isAllowedFinalUrl(finalUrl, pageOrigin) {
  let u;
  try { u = new URL(finalUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.origin === pageOrigin) return true;
  return FILE_HOSTS.some((re) => re.test(u.hostname));
}
