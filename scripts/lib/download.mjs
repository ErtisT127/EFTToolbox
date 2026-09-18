// Every host this project downloads from: the two pinned GitHub repositories, the snapshot API and
// the assets CDN. Some URLs come from upstream data itself — an item's baseImageLink, a map rule's
// svgPath — so without this list a tampered upstream could make a developer or CI machine fetch
// anything, including loopback and link-local addresses.
const allowedHosts = new Set([
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
  'json.tarkov.dev',
  'assets.tarkov.dev',
]);

// Immediate retries all land inside the same network blip, so each attempt waits longer than the
// last. Jitter keeps the concurrent workers in item-images.mjs from retrying in lockstep.
const retryDelays = [2000, 5000, 15000];
const redirectLimit = 5;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

// Errors that describe the URL rather than the connection: retrying cannot change the answer.
const permanent = (message) => Object.assign(new Error(message), { permanent: true });

// Retries are announced through here rather than straight to console.log, so a caller drawing a live
// progress line can clear it first instead of having the notice land inside the bar.
let announce = (line) => console.log(line);

export function setAnnouncer(fn) {
  announce = fn;
}

function assertAllowed(target) {
  const parsed = new URL(target);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !allowedHosts.has(parsed.hostname)
  )
    throw permanent(`Refusing to fetch outside ${[...allowedHosts].join(', ')}: ${target}`);
  return parsed;
}

// raw.githubusercontent.com is unreachable from some networks, so every GitHub request goes through
// jsDelivr by default. Our refs are commit SHAs, which jsDelivr treats as immutable, so the bytes —
// and therefore the recorded provenance — are the same either way. Set GITHUB_MIRROR=direct to hit
// GitHub itself.
function mirror(url) {
  if (process.env.GITHUB_MIRROR === 'direct') return url;
  const parsed = new URL(url);
  if (parsed.hostname !== 'raw.githubusercontent.com') return url;
  const [owner, repo, ref, ...rest] = parsed.pathname.replace(/^\//, '').split('/');
  if (!owner || !repo || !ref || !rest.length)
    throw permanent(`Cannot mirror ${url}: expected /{owner}/{repo}/{ref}/{path}`);
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest.join('/')}`;
}

// fetch follows redirects itself, which would issue the next request before the allowlist ever
// sees its URL, so each hop is followed by hand and re-checked.
async function send(url, headers) {
  let target = url;
  for (let hop = 0; ; hop++) {
    assertAllowed(target);
    const response = await fetch(target, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
    if (!redirectStatuses.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || hop >= redirectLimit)
      throw permanent(`${url}: unusable redirect (HTTP ${response.status})`);
    target = new URL(location, target).toString();
  }
}

// Retries a request until it yields a body the caller wants or a status it handles itself, and
// throws the last failure otherwise.
async function request(url, { headers, tolerate }) {
  // Resolved once, so the retry line names the URL actually being requested rather than the caller's.
  const target = mirror(url);
  for (let attempt = 0; ; attempt++) {
    let response;
    let failure;
    try {
      response = await send(target, headers);
    } catch (error) {
      failure = error;
    }
    if (response && (response.ok || tolerate.includes(response.status))) return response;
    if (response) failure = new Error(`${target}: HTTP ${response.status}`);
    const status = Number(failure.message.match(/HTTP (\d{3})$/)?.[1]);
    if (
      failure.permanent ||
      attempt >= retryDelays.length ||
      (status >= 400 && status < 500 && status !== 429)
    )
      throw failure;
    const delay = retryDelays[attempt] + Math.floor(Math.random() * 500);
    announce(`Retrying ${target} in ${delay}ms (${failure.message})`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// The status, the cache validators and the body, for callers that need more than the bytes. Pass
// `tolerate` for statuses the caller handles itself instead of treating as a failure.
export async function downloadResponse(url, { headers, tolerate = [] } = {}) {
  const response = await request(url, { headers, tolerate });
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    bytes: response.status === 304 ? null : Buffer.from(await response.arrayBuffer()),
  };
}

// Returns the response body, or null when the server has nothing at that URL and the caller said a
// missing file is acceptable — sparse tile coverage answers 404 by design.
export async function download(url, { allowMissing = false } = {}) {
  const response = await downloadResponse(url, { tolerate: allowMissing ? [404] : [] });
  return response.status === 404 ? null : response.bytes;
}
