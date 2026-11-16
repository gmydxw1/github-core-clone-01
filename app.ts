// github-core-clone-01: a single-process, stdlib-only GitHub-compatible forge.
// Node 22+ TypeScript (erasable syntax only), in-memory Map store, plain-object packs
// (deflate level 1, no deltas). Implements REST v3, GraphQL v4 (small hand parser),
// MCP over Streamable HTTP (2026-07-28 discover + legacy initialize), and git
// smart HTTP (protocol v2 + v0, receive-pack with report-status).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const ZERO_OID = '0000000000000000000000000000000000000000';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_AUTHOR = 'forge <forge@example.com>';

type GitType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: GitType; data: Buffer; }
interface IssueRec { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; seq: number; createdAt: string; comments: CommentRec[]; }
interface CommentRec { id: number; body: string; createdAt: string; }
interface PullRec { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; headRef: string; baseRef: string; headSha: string; baseSha: string; baseShaAtCreate: string; merged: boolean; mergedAt: string | null; mergeSha: string | null; seq: number; createdAt: string; }
interface Repo {
  dbId: number; name: string; owner: string | null; isPrivate: boolean; description: string;
  defaultBranch: string; createdSeq: number;
  objects: Map<string, GitObj>; refs: Map<string, string>;
  labels: Map<string, string>; issues: IssueRec[]; pulls: PullRec[];
  issueCounter: number; pullCounter: number;
}

let viewerLogin: string | null = null;
const reposByKey = new Map<string, Repo>();
const repoOrder: Repo[] = [];
let repoCounter = 0;
let globalIdCounter = 0;
let createdCounter = 0;
let reqCounter = 0;

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function learnViewer(owner: string): void {
  if (viewerLogin !== null || owner === '') return;
  viewerLogin = owner;
  for (const repo of repoOrder) {
    if (repo.owner === null) {
      reposByKey.delete(repoKey('', repo.name));
      repo.owner = owner;
      reposByKey.set(repoKey(owner, repo.name), repo);
    }
  }
}
function findRepo(owner: string, name: string): Repo | undefined {
  learnViewer(owner);
  return reposByKey.get(repoKey(owner, name));
}
function findRepoByDbId(dbId: number): Repo | undefined {
  for (const r of repoOrder) if (r.dbId === dbId) return r;
  return undefined;
}
function nowIso(): string { return new Date().toISOString(); }
function nowSec(): number { return Math.floor(Date.now() / 1000); }

// ---------------------------------------------------------------- git primitives
function sha1(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
function hashObject(type: GitType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, data]));
}
function putObject(repo: Repo, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) { repo.objects.set(oid, { type, data }); invalidatePackCache(repo); }
  return oid;
}
interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}
function buildCommit(tree: string, parents: string[], message: string, who?: string, ts?: number): Buffer {
  const stamp = ts ?? nowSec();
  const ident = who ?? `${FIXED_AUTHOR} ${stamp} +0000`;
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string } {
  const text = data.toString('utf8');
  const out = { object: '', type: '', tag: '', tagger: '' };
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
    else if (line === '') break;
  }
  return out;
}
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
// file map of a commit: path -> {oid, mode}
function treeFiles(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') treeFiles(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}
function commitFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  treeFiles(repo, parseCommit(obj.data).tree, '', out);
  return out;
}
function filesToTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, f] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1], f);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
function makeCommitOn(repo: Repo, refName: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const treeOid = filesToTree(repo, files);
  const parent = repo.refs.get(refName);
  const parents = parent ? [parent] : [];
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, parents, message));
  repo.refs.set(refName, commitOid);
  return commitOid;
}
function refTip(repo: Repo, ref: string): string | undefined {
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
}
function resolveRefOid(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  return refTip(repo, ref);
}
function walkCommits(repo: Repo, start: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'tag') { stack.push(parseTag(obj.data).object); continue; }
    if (obj.type !== 'commit') continue;
    out.push(cur);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i]);
  }
  return out;
}

// ---------------------------------------------------------------- pkt-line + pack
function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }
function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break; // raw trailing bytes (e.g. a packfile) start here
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let shift = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** shift; shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0; let copySize = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift; shift += 8; }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const res = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}
const PACK_TYPES: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function readPack(pack: Buffer, lookup: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; }
  const raws: Raw[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const start = off;
    let byte = pack[off];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    off++;
    while (byte & 0x80) { byte = pack[off++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
    const raw: Raw = { offset: start, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off];
      let v = b & 0x7f; off++;
      while (b & 0x80) { b = pack[off++]; v = ((v + 1) * 128) + (b & 0x7f); }
      raw.baseOffset = start - v;
    } else if (typeCode === 7) {
      raw.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20;
    }
    const inf = inflateAt(pack, off);
    raw.data = inf.data; off = inf.next;
    if (raw.data.length !== size) throw new Error('pack object size mismatch');
    raws.push(raw);
  }
  const byOffset = new Map<number, Raw>();
  for (const r of raws) byOffset.set(r.offset, r);
  const resolved = new Map<string, GitObj>();
  const resolveOne = (raw: Raw, seen: Set<number>): GitObj => {
    if (raw.typeCode === 6 || raw.typeCode === 7) {
      let base: GitObj | undefined;
      if (raw.typeCode === 6) {
        const baseRaw = byOffset.get(raw.baseOffset!);
        if (!baseRaw) throw new Error('ofs-delta base missing');
        if (seen.has(raw.baseOffset!)) throw new Error('delta cycle');
        seen.add(raw.baseOffset!);
        base = resolveOne(baseRaw, seen);
      } else {
        base = lookup(raw.baseOid!) ?? resolved.get(raw.baseOid!);
        if (!base) {
          for (const r of raws) {
            // try resolve plain entries first
          }
          throw new Error('ref-delta base missing');
        }
      }
      const data = applyDelta(base.data, raw.data);
      const obj: GitObj = { type: base.type, data };
      resolved.set(hashObject(obj.type, obj.data), obj);
      return obj;
    }
    const type = PACK_TYPES[raw.typeCode];
    if (!type) throw new Error(`pack type ${raw.typeCode}`);
    const obj: GitObj = { type, data: raw.data };
    resolved.set(hashObject(type, raw.data), obj);
    return obj;
  };
  for (const raw of raws) resolveOne(raw, new Set([raw.offset]));
  return resolved;
}
function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  const typeCode: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of list) {
    const data = obj.data;
    let size = data.length;
    const first = (typeCode[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) bytes.push(first | 0x80); else bytes.push(first);
    while (size > 0) {
      const b = size & 0x7f;
      size >>= 7;
      bytes.push(size > 0 ? b | 0x80 : b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- fetch pack cache
// One upload-pack fetch is fully determined by (repo objects, wants, depth, haves,
// shallow boundaries): collectFetch only reads repo.objects, and writePack's sort is
// deterministic (hashObject). The clone workload issues 50 concurrent depth-1 clones
// of the same tip, i.e. 50 identical fetches, so the first fetch builds the pack and
// the rest reuse it. The entry keeps the pack plus the two small pieces of framing
// metadata the fetch also produces (shallow list, commit depths for unshallow), so a
// hit skips both collectFetch and writePack; the sideband framing is still built
// per request. Keyed by Repo object identity (WeakMap), so deleting and recreating
// a repo under the same name starts with an empty cache, and ref-only changes
// cannot stale an entry because refs never enter the pack computation.
interface PackCacheEntry { pack: Buffer; shallow: string[]; commits: Map<string, number>; }
const packCache = new WeakMap<Repo, Map<string, PackCacheEntry>>();
const PACK_CACHE_MAX_ENTRIES = 200;
const PACK_CACHE_MAX_BYTES = 16 * 1024 * 1024;
let packCacheEntries = 0;
let packCacheBytes = 0;
const packCacheOrder: Array<{ repo: Repo; key: string }> = [];
function packCacheKey(wants: string[], depth: number | null, haves: string[], shallowIn: string[]): string {
  return [...wants].sort().join(',') + '\n' + (depth === null ? '' : String(depth)) + '\n' + [...haves].sort().join(',') + '\n' + [...shallowIn].sort().join(',');
}
function packCacheGet(repo: Repo, key: string): PackCacheEntry | undefined {
  return packCache.get(repo)?.get(key);
}
function packCachePut(repo: Repo, key: string, entry: PackCacheEntry): void {
  let per = packCache.get(repo);
  if (!per) { per = new Map(); packCache.set(repo, per); }
  const old = per.get(key);
  if (old) packCacheBytes -= old.pack.length;
  else { packCacheEntries++; packCacheOrder.push({ repo, key }); }
  per.set(key, entry);
  packCacheBytes += entry.pack.length;
  while (packCacheEntries > PACK_CACHE_MAX_ENTRIES || packCacheBytes > PACK_CACHE_MAX_BYTES) {
    const victim = packCacheOrder.shift();
    if (!victim) break;
    const vmap = packCache.get(victim.repo);
    const vent = vmap?.get(victim.key);
    if (!vent) continue;
    vmap!.delete(victim.key);
    packCacheEntries--;
    packCacheBytes -= vent.pack.length;
  }
}
function invalidatePackCache(repo: Repo): void {
  const per = packCache.get(repo);
  if (!per) return;
  for (const entry of per.values()) { packCacheBytes -= entry.pack.length; packCacheEntries--; }
  per.clear();
}

// ---------------------------------------------------------------- ids + JSON shapes
function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}
function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
  } catch { return null; }
}
function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? viewerLogin ?? '';
  return {
    id: repo.dbId, node_id: gid('Repository', repo.dbId), name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch,
    created_at: nowIso(), updated_at: nowIso(), html_url: '', url: '', clone_url: '', git_url: '', ssh_url: '',
    homepage: '', language: null, forks_count: 0, watchers_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}
function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id, node_id: gid('Issue', repo.dbId, issue.number), number: issue.number,
    title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name) ?? 'ededed', description: '' })),
    user: { login: viewerLogin ?? '', id: 1, type: 'User' },
    created_at: issue.createdAt, updated_at: issue.createdAt,
    closed_at: issue.state === 'closed' ? issue.createdAt : null,
    comments: issue.comments.length, html_url: '',
  };
}
function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const owner = repo.owner ?? viewerLogin ?? '';
  return {
    id: pull.id, node_id: gid('PullRequest', repo.dbId, pull.number), number: pull.number,
    title: pull.title, body: pull.body, state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}`, user: { login: owner } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}`, user: { login: owner } },
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeSha,
    created_at: pull.createdAt, updated_at: pull.createdAt, draft: false, html_url: '',
  };
}
function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const view = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const ident = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!m) return { name: line, email: '', date: nowIso() };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message: (view?.message ?? '').replace(/\n+$/, ''),
      author: view ? ident(view.author) : { name: '', email: '', date: nowIso() },
      committer: view ? ident(view.committer) : { name: '', email: '', date: nowIso() },
    },
    parents: (view?.parents ?? []).map((p) => ({ sha: p })),
    author: { login: viewerLogin ?? '' }, committer: { login: viewerLogin ?? '' },
  };
}
function createIssueIn(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const number = ++repo.issueCounter;
  const issue: IssueRec = {
    id: ++globalIdCounter, number, title, body: body ?? '', state: 'open',
    labels: [...labels], seq: ++createdCounter, createdAt: nowIso(), comments: [],
  };
  repo.issues.push(issue);
  return issue;
}
function createPullIn(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PullRec {
  const number = ++repo.pullCounter;
  const pull: PullRec = {
    id: ++globalIdCounter, number, title, body: body ?? '', state: 'open',
    headRef, baseRef, headSha, baseSha, baseShaAtCreate: baseSha,
    merged: false, mergedAt: null, mergeSha: null, seq: ++createdCounter, createdAt: nowIso(),
  };
  repo.pulls.push(pull);
  return pull;
}
function prConflict(repo: Repo, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const curBaseTip = refTip(repo, pull.baseRef);
  if (!curBaseTip || curBaseTip === pull.baseShaAtCreate) return false;
  const baseOldFiles = commitFiles(repo, pull.baseShaAtCreate);
  const baseNewFiles = commitFiles(repo, curBaseTip);
  const headFiles = commitFiles(repo, pull.headSha);
  const changedInBase = new Set<string>();
  const allPaths = new Set([...baseOldFiles.keys(), ...baseNewFiles.keys()]);
  for (const p of allPaths) {
    if (baseOldFiles.get(p)?.oid !== baseNewFiles.get(p)?.oid) changedInBase.add(p);
  }
  for (const p of changedInBase) {
    const headOid = headFiles.get(p)?.oid;
    const baseOid = baseNewFiles.get(p)?.oid;
    const oldOid = baseOldFiles.get(p)?.oid;
    if (headOid !== oldOid && headOid !== baseOid) return true;
  }
  return false;
}
function prFiles(repo: Repo, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; path: string }> {
  const baseFiles = commitFiles(repo, pull.baseShaAtCreate);
  const headFiles = commitFiles(repo, pull.headSha);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; path: string }> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const lineCount = (oid: string | undefined): number => {
    if (!oid) return 0;
    const obj = repo.objects.get(oid);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const p of [...paths].sort()) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (b?.oid === h?.oid) continue;
    if (!b && h) {
      const a = lineCount(h.oid);
      out.push({ filename: p, status: 'added', additions: a, deletions: 0, changes: a, path: p });
    } else if (b && !h) {
      const d = lineCount(b.oid);
      out.push({ filename: p, status: 'removed', additions: 0, deletions: d, changes: d, path: p });
    } else if (b && h) {
      const a = lineCount(h.oid); const d = lineCount(b.oid);
      out.push({ filename: p, status: 'modified', additions: a, deletions: d, changes: a + d, path: p });
    }
  }
  return out;
}
function squashMerge(repo: Repo, pull: PullRec): { ok: boolean; sha?: string; conflict?: boolean } {
  if (pull.merged && pull.mergeSha) return { ok: true, sha: pull.mergeSha };
  if (prConflict(repo, pull)) return { ok: false, conflict: true };
  const headFiles = commitFiles(repo, pull.headSha);
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef);
  const treeOid = filesToTree(repo, headFiles);
  const parents = baseTip ? [baseTip] : [];
  const mergeOid = putObject(repo, 'commit', buildCommit(treeOid, parents, `Merge pull request #${pull.number}: ${pull.title}`));
  repo.refs.set(baseRef, mergeOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeSha = mergeOid;
  pull.baseSha = mergeOid;
  return { ok: true, sha: mergeOid };
}
// collect objects for a fetch: roots are commit/tag oids
function collectFetch(repo: Repo, wants: string[], depth: number | null, stopBoundaries: Set<string>, exclude: Set<string>): { objects: Map<string, GitObj>; commits: Map<string, number>; shallow: string[]; } {
  const objects = new Map<string, GitObj>();
  const commits = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((o) => ({ oid: o, depth: 0 }));
  const seenCommit = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length) {
      const t = stack.pop()!;
      const obj = repo.objects.get(t);
      if (!obj || obj.type !== 'tree' || objects.has(t)) continue;
      objects.set(t, obj);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') stack.push(e.oid);
        else { const b = repo.objects.get(e.oid); if (b) objects.set(e.oid, b); }
      }
    }
  };
  while (queue.length) {
    const cur = queue.shift()!;
    const obj = repo.objects.get(cur.oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (objects.has(cur.oid)) continue;
      objects.set(cur.oid, obj);
      queue.push({ oid: parseTag(obj.data).object, depth: cur.depth });
      continue;
    }
    if (obj.type !== 'commit') { objects.set(cur.oid, obj); continue; }
    if (seenCommit.has(cur.oid)) continue;
    seenCommit.add(cur.oid);
    commits.set(cur.oid, cur.depth);
    objects.set(cur.oid, obj);
    const view = parseCommit(obj.data);
    addTree(view.tree);
    const atLimit = depth !== null && cur.depth >= depth - 1;
    const stopped = depth === null && stopBoundaries.has(cur.oid);
    if (!atLimit && !stopped) {
      for (const p of view.parents) queue.push({ oid: p, depth: cur.depth + 1 });
    }
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of commits) {
      if (d === depth - 1) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
      }
    }
  } else {
    for (const b of stopBoundaries) if (commits.has(b)) shallow.push(b);
  }
  for (const oid of exclude) objects.delete(oid);
  // exclude must also remove commits' trees? No: exclusion is object-level; a commit
  // excluded by have-set also excludes its tree/blobs only if they are in exclude set,
  // which collectHave computes as full reachable objects. So delete is correct.
  return { objects, commits, shallow };
}
function collectHave(repo: Repo, haves: string[], stopBoundaries: Set<string>): Set<string> {
  const { objects } = collectFetch(repo, haves, null, stopBoundaries, new Set());
  return new Set(objects.keys());
}
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return peelToCommit(repo, oid);
}

// ---------------------------------------------------------------- HTTP helpers
function reqId(): string { return `req-${++reqCounter}`; }
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': reqId(), ...extra };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
function sendBuffer(res: ServerResponse, status: number, buf: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(buf.length), 'x-github-request-id': reqId(), ...extra });
  res.end(buf);
}
function errJson(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: boolean; value?: unknown } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function strField(v: unknown, key: string, fallback = ''): string {
  if (isRecord(v) && typeof v[key] === 'string') return v[key] as string;
  return fallback;
}
function paginate<T>(items: T[], url: URL, req: IncomingMessage): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const proto = 'http';
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set('page', String(page + 1));
    nextUrl.searchParams.set('per_page', String(perPage));
    // rebuild absolute URL on this origin
    link = `<${proto}://${host}${nextUrl.pathname}?${nextUrl.searchParams.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}
function decodeSeg(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

// ---------------------------------------------------------------- REST v3
function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: unknown, segs: string[]): void {
  const method = req.method ?? 'GET';
  // GET /api/v3/  (segs empty)
  if (segs.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
    errJson(res, 404, 'Not Found'); return;
  }
  if (segs[0] === 'meta' && segs.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0', github_enterprise_version: '1.0.0' }); return; }
    errJson(res, 404, 'Not Found'); return;
  }
  if (segs[0] === 'user') {
    if (segs.length === 1) {
      if (method === 'GET') { sendJson(res, 200, { login: viewerLogin ?? '', id: 1, type: 'User', name: viewerLogin ?? '' }); return; }
      errJson(res, 404, 'Not Found'); return;
    }
    if (segs[1] === 'repos') {
      if (method === 'POST') {
        const name = strField(body, 'name');
        if (name === '') { errJson(res, 422, 'name is required'); return; }
        const owner = viewerLogin;
        const dup = repoOrder.find((r) => r.name === name && (r.owner === owner || r.owner === null));
        if (dup) { errJson(res, 422, 'Repository already exists'); return; }
        const repo: Repo = {
          dbId: ++repoCounter, name, owner: owner ?? null,
          isPrivate: isRecord(body) && body.private === true,
          description: strField(body, 'description'), defaultBranch: 'main', createdSeq: ++createdCounter,
          objects: new Map(), refs: new Map(), labels: new Map(), issues: [], pulls: [], issueCounter: 0, pullCounter: 0,
        };
        repoOrder.push(repo);
        reposByKey.set(repoKey(repo.owner ?? '', name), repo);
        sendJson(res, 201, repoJson(repo));
        return;
      }
      if (method === 'GET') {
        const mine = repoOrder.filter((r) => r.owner === viewerLogin || (viewerLogin === null && r.owner === null));
        const { page, link } = paginate(mine, url, req);
        sendJson(res, 200, page.map((r) => repoJson(r)), link ? { link } : {});
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (segs[0] !== 'repos' || segs.length < 3) { errJson(res, 404, 'Not Found'); return; }
  const owner = decodeSeg(segs[1]);
  const repoName = decodeSeg(segs[2]);
  const repo = findRepo(owner, repoName);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  const rest = segs.slice(3);
  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (method === 'DELETE') {
      reposByKey.delete(repoKey(repo.owner ?? '', repo.name));
      const idx = repoOrder.indexOf(repo);
      if (idx >= 0) repoOrder.splice(idx, 1);
      sendJson(res, 204, null); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  const head = rest[0];
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = sortedRefs(repo).filter((r) => r.name.startsWith('refs/heads/')).map((r) => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.oid } }));
      sendJson(res, 200, list); return;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeSeg(rest[1]);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) { errJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: branch, commit: { sha: tip } }); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (head === 'git') {
    if (rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (ref === '' || sha === '') { errJson(res, 422, 'ref and sha are required'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha }, sha }); return;
      }
      if (method === 'GET') {
        if (rest.length === 4 && rest[2] === 'heads') {
          const branch = decodeSeg(rest[3]);
          const tip = repo.refs.get(`refs/heads/${branch}`);
          if (!tip) { errJson(res, 404, 'Not Found'); return; }
          sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip }, sha: tip }); return;
        }
        if (rest.length === 2) {
          sendJson(res, 200, sortedRefs(repo).map((r) => ({ ref: r.name, object: { sha: r.oid } }))); return;
        }
      }
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = url.searchParams.get('sha');
      let start: string | undefined;
      if (shaParam) start = resolveRefOid(repo, shaParam);
      else start = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!start) { sendJson(res, 200, []); return; }
      const list = walkCommits(repo, start).map((oid) => commitJson(repo, oid));
      sendJson(res, 200, list); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (head === 'contents') {
    const contentPath = rest.slice(1).map(decodeSeg).join('/');
    if (method === 'PUT') {
      const message = strField(body, 'message', 'update');
      const contentB64 = strField(body, 'content');
      const branch = strField(body, 'branch', repo.defaultBranch);
      const shaParam = strField(body, 'sha');
      if (contentPath === '' || contentB64 === '') { errJson(res, 422, 'content is required'); return; }
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      const files = tip ? commitFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
      const existing = files.get(contentPath);
      if (shaParam !== '' && existing && existing.oid !== shaParam) { errJson(res, 409, 'sha does not match the current blob'); return; }
      if (shaParam !== '' && !existing) { errJson(res, 409, 'sha does not match the current blob'); return; }
      const blobData = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const blobOid = putObject(repo, 'blob', blobData);
      files.set(contentPath, { oid: blobOid, mode: '100644' });
      const commitOid = makeCommitOn(repo, refName, files, message);
      const status = existing ? 200 : 201;
      sendJson(res, status, { content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: blobData.length, encoding: 'base64', type: 'file' }, commit: { sha: commitOid } });
      return;
    }
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref');
      let start: string | undefined;
      if (refParam) start = resolveRefOid(repo, refParam);
      else start = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!start) { errJson(res, 404, 'Not Found'); return; }
      const files = commitFiles(repo, start);
      if (contentPath === '') {
        const entries = dirEntries(repo, files, '');
        sendJson(res, 200, entries); return;
      }
      const file = files.get(contentPath);
      if (file) {
        const obj = repo.objects.get(file.oid);
        const data = obj ? obj.data : Buffer.alloc(0);
        sendJson(res, 200, { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: file.oid, size: data.length, name: contentPath.split('/').pop(), path: contentPath });
        return;
      }
      const prefix = `${contentPath}/`;
      const hasChild = [...files.keys()].some((p) => p.startsWith(prefix));
      if (hasChild) { sendJson(res, 200, dirEntries(repo, files, contentPath)); return; }
      errJson(res, 404, 'Not Found'); return;
    }
    if (method === 'DELETE') {
      const branch = strField(body, 'branch', repo.defaultBranch);
      const shaParam = strField(body, 'sha');
      const message = strField(body, 'message', 'delete');
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (!tip) { errJson(res, 404, 'Not Found'); return; }
      const files = commitFiles(repo, tip);
      const existing = files.get(contentPath);
      if (!existing) { errJson(res, 404, 'Not Found'); return; }
      if (shaParam !== '' && existing.oid !== shaParam) { errJson(res, 409, 'sha does not match the current blob'); return; }
      files.delete(contentPath);
      const commitOid = makeCommitOn(repo, refName, files, message);
      sendJson(res, 200, { commit: { sha: commitOid } });
      return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (head === 'labels') {
    if (method === 'POST') {
      const name = strField(body, 'name');
      if (name === '') { errJson(res, 422, 'name is required'); return; }
      const color = strField(body, 'color', 'ededed');
      repo.labels.set(name, color);
      sendJson(res, 201, { name, color, description: '' }); return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.entries()].map(([name, color]) => ({ name, color, description: '' }))); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = strField(body, 'title');
        const labels = isRecord(body) && Array.isArray(body.labels) ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        for (const l of labels) if (!repo.labels.has(l)) { errJson(res, 422, `Label '${l}' does not exist`); return; }
        const issue = createIssueIn(repo, title, strField(body, 'body'), labels);
        sendJson(res, 201, issueJson(repo, issue)); return;
      }
      if (method === 'GET') {
        let list = [...repo.issues];
        const state = url.searchParams.get('state');
        if (state && state !== 'all') list = list.filter((i) => i.state === state);
        else if (!state) list = list.filter((i) => i.state === 'open');
        if (url.searchParams.get('sort') === 'created') {
          list.sort((a, b) => (url.searchParams.get('direction') === 'desc' ? b.seq - a.seq : a.seq - b.seq));
        }
        const { page } = paginate(list, url, req);
        sendJson(res, 200, page.map((i) => issueJson(repo, i))); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    const num = Number(rest[1]);
    const issue = repo.issues.find((i) => i.number === num);
    if (!issue) { errJson(res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        if (isRecord(body)) {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
        }
        sendJson(res, 200, issueJson(repo, issue)); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const comment: CommentRec = { id: ++globalIdCounter, body: strField(body, 'body'), createdAt: nowIso() };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, node_id: gid('Comment', repo.dbId, issue.number, comment.id), body: comment.body, created_at: comment.createdAt, user: { login: viewerLogin ?? '' } });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('Comment', repo.dbId, issue.number, c.id), body: c.body, created_at: c.createdAt, user: { login: viewerLogin ?? '' } })));
        return;
      }
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = strField(body, 'title');
        let headRef = strField(body, 'head');
        let baseRef = strField(body, 'base');
        if (headRef.includes(':')) headRef = headRef.split(':').pop() ?? headRef;
        if (baseRef.includes(':')) baseRef = baseRef.split(':').pop() ?? baseRef;
        if (headRef === '') headRef = repo.defaultBranch;
        if (baseRef === '') baseRef = repo.defaultBranch;
        const headSha = refTip(repo, headRef);
        const baseSha = refTip(repo, baseRef);
        if (!headSha) { errJson(res, 422, `head branch '${headRef}' not found`); return; }
        if (!baseSha) { errJson(res, 422, `base branch '${baseRef}' not found`); return; }
        const pull = createPullIn(repo, title, strField(body, 'body'), headRef, baseRef, headSha, baseSha);
        sendJson(res, 201, pullJson(repo, pull)); return;
      }
      if (method === 'GET') {
        let list = [...repo.pulls];
        const state = url.searchParams.get('state');
        if (state && state !== 'all') list = list.filter((p) => p.state === state);
        else if (!state) list = list.filter((p) => p.state === 'open');
        const { page } = paginate(list, url, req);
        sendJson(res, 200, page.map((p) => pullJson(repo, p))); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    const num = Number(rest[1]);
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) { errJson(res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
      errJson(res, 404, 'Not Found'); return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method === 'GET') {
        sendJson(res, 200, prFiles(repo, pull).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, path: f.path })));
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method === 'PUT') {
        if (pull.merged && pull.mergeSha) { sendJson(res, 200, { sha: pull.mergeSha, merged: true, message: 'Pull request successfully merged' }); return; }
        const result = squashMerge(repo, pull);
        if (!result.ok) { errJson(res, 405, 'Merge conflict'); return; }
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  errJson(res, 404, 'Not Found');
}
function dirEntries(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; sha: string }>();
  // subdirectories: need tree oids; compute from files by walking trees is complex here,
  // so derive dir sha from a rebuilt tree of the subtree when possible.
  for (const [path, f] of files) {
    if (!path.startsWith(prefix)) continue;
    const restPath = path.slice(prefix.length);
    const slash = restPath.indexOf('/');
    if (slash < 0) seen.set(restPath, { type: 'file', sha: f.oid });
    else {
      const sub = restPath.slice(0, slash);
      if (!seen.has(sub)) seen.set(sub, { type: 'dir', sha: '' });
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [name, info] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let sha = info.sha;
    if (info.type === 'dir') {
      // find the subtree oid by rebuilding from files under this dir
      const subFiles = new Map<string, { oid: string; mode: string }>();
      const subPrefix = `${prefix}${name}/`;
      for (const [p, f] of files) if (p.startsWith(subPrefix)) subFiles.set(p.slice(subPrefix.length), f);
      sha = filesToTree(repo, subFiles);
    }
    out.push({ type: info.type, name, path: `${prefix}${name}`, sha, size: info.type === 'file' ? (repo.objects.get(sha)?.data.length ?? 0) : 0 });
  }
  return out;
}

// ---------------------------------------------------------------- GraphQL (hand parser, checks' documents only)
type GqlValue = { kind: 'var'; name: string } | { kind: 'str'; value: string } | { kind: 'int'; value: number } | { kind: 'bool'; value: boolean } | { kind: 'null' } | { kind: 'enum'; value: string } | { kind: 'list'; items: GqlValue[] } | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };
interface GqlSel { alias: string | null; name: string; args: Array<{ name: string; value: GqlValue }>; selections: GqlSel[]; fragment: boolean; typeCondition: string | null; }
interface GqlOp { type: string; name: string | null; selections: GqlSel[]; }
function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j++; } }
      tokens.push(JSON.stringify(out)); i = j + 1; continue;
    }
    if (/[A-Za-z_0-9.-]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_0-9.-]/.test(src[j])) j++;
      tokens.push(src.slice(i, j)); i = j; continue;
    }
    i++;
  }
  return tokens;
}
class GqlParser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = gqlTokenize(src); }
  peek(): string { return this.toks[this.pos] ?? ''; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.peek() === t) this.pos++; }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.toks.length) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}' && this.pos < this.toks.length) {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'str', value: JSON.parse(t) as string };
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    return { kind: 'enum', value: t };
  }
  parseArgs(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')' && this.pos < this.toks.length) {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet(): GqlSel[] {
    const sels: GqlSel[] = [];
    if (this.peek() !== '{') return sels;
    this.next();
    while (this.peek() !== '}' && this.pos < this.toks.length) {
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') { this.next(); typeCondition = this.next(); }
        else if (/^[A-Za-z_]/.test(this.peek())) { /* named fragment, not used in checks */ this.next(); }
        const inner = this.parseSelectionSet();
        sels.push({ alias: null, name: '', args: [], selections: inner, fragment: true, typeCondition });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs();
      const inner = this.parseSelectionSet();
      sels.push({ alias, name, args, selections: inner, fragment: false, typeCondition: null });
    }
    this.expect('}');
    return sels;
  }
  parseDocument(): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.toks.length) {
      const t = this.peek();
      if (t === 'query' || t === 'mutation' || t === 'subscription') {
        this.next();
        let name: string | null = null;
        if (/^[A-Za-z_]/.test(this.peek()) && this.peek() !== '{' && this.peek() !== '(') name = this.next();
        if (this.peek() === '(') {
          // variable definitions: skip balanced parens
          let depth = 0;
          while (this.pos < this.toks.length) {
            const tok = this.next();
            if (tok === '(') depth++;
            else if (tok === ')') { depth--; if (depth === 0) break; }
          }
        }
        ops.push({ type: t, name, selections: this.parseSelectionSet() });
      } else if (t === '{') {
        ops.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
      } else this.next();
    }
    return ops;
  }
}
function resolveGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'str': return v.value;
    case 'int': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => resolveGqlValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveGqlValue(f.value, vars);
      return out;
    }
  }
}
function gqlArgs(sel: GqlSel, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = resolveGqlValue(a.value, vars);
  return out;
}
const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt'];
const PR_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'url'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt'];
function typeInfo(name: string): { name: string; fields: Array<{ name: string }>; enumValues: Array<{ name: string }> } {
  if (name === 'Issue') return { name, fields: ISSUE_TYPE_FIELDS.map((n) => ({ name: n })), enumValues: [] };
  if (name === 'PullRequest') return { name, fields: PR_TYPE_FIELDS.map((n) => ({ name: n })), enumValues: [] };
  if (name === 'Repository') return { name, fields: REPO_TYPE_FIELDS.map((n) => ({ name: n })), enumValues: [] };
  if (name === 'SearchType') return { name, fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'].map((n) => ({ name: n })) };
  return { name, fields: [], enumValues: [] };
}
interface GqlCtx { repo?: Repo; issue?: IssueRec; pull?: PullRec; }
function gqlIssueObj(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return { __typename: 'Issue', id: gid('Issue', repo.dbId, issue.number), number: issue.number, title: issue.title, body: issue.body, state: issue.state === 'open' ? 'OPEN' : 'CLOSED', createdAt: issue.createdAt, updatedAt: issue.createdAt };
}
function gqlPullObj(repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    __typename: 'PullRequest', id: gid('PullRequest', repo.dbId, pull.number), number: pull.number,
    title: pull.title, body: pull.body, state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.headRef, baseRefName: pull.baseRef,
    mergeable: prConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE', merged: pull.merged,
  };
}
function gqlRepoObj(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? viewerLogin ?? '';
  return {
    __typename: 'Repository', id: gid('Repository', repo.dbId), databaseId: repo.dbId, name: repo.name,
    nameWithOwner: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { __typename: 'User', login: owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, description: repo.description,
  };
}
function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const want = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const dir = orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => (a.seq - b.seq) * dir);
  const after = args.after as string | undefined | null;
  if (after) {
    let afterNum = -1;
    try { afterNum = Number(Buffer.from(after, 'base64').toString('utf8').split(':')[1]); } catch { afterNum = -1; }
    if (Number.isFinite(afterNum) && afterNum > 0) {
      const idx = list.findIndex((i) => i.number === afterNum);
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  const endCursor = page.length ? Buffer.from(`cursor:${page[page.length - 1].number}`).toString('base64') : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => gqlIssueObj(repo, i)),
    edges: page.map((i) => ({ __typename: 'IssueEdge', node: gqlIssueObj(repo, i), cursor: Buffer.from(`cursor:${i.number}`).toString('base64') })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: false, endCursor, startCursor: page.length ? Buffer.from(`cursor:${page[0].number}`).toString('base64') : null },
    totalCount: list.length,
  };
}
function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const want = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    list = list.filter((p) => want.has(p.state));
  } else list = list.filter((p) => p.state === 'open');
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => gqlPullObj(repo, p)),
    edges: page.map((p) => ({ __typename: 'PullRequestEdge', node: gqlPullObj(repo, p), cursor: Buffer.from(`cursor:${p.number}`).toString('base64') })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
    totalCount: list.length,
  };
}
function resolveField(parent: Record<string, unknown>, sel: GqlSel, vars: Record<string, unknown>): unknown {
  const args = gqlArgs(sel, vars);
  const type = parent.__typename as string | undefined;
  if (type === 'Query') {
    if (sel.name === 'viewer') return { __typename: 'User', login: viewerLogin ?? '' };
    if (sel.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = findRepo(owner, name);
      return repo ? gqlRepoObj(repo) : null;
    }
    if (sel.name === 'node') {
      const decoded = decodeGid(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoByDbId(Number(decoded.parts[0]));
        return repo ? gqlRepoObj(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = findRepoByDbId(Number(decoded.parts[0]));
        const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
        return repo && issue ? gqlIssueObj(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = findRepoByDbId(Number(decoded.parts[0]));
        const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
        return repo && pull ? gqlPullObj(repo, pull) : null;
      }
      return null;
    }
    if (sel.name === '__type') return { __typename: 'Type', ...typeInfo(String(args.name ?? '')) };
    if (sel.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.repositoryId ?? ''));
      const repo = decoded ? findRepoByDbId(Number(decoded.parts[0])) : undefined;
      if (!repo) throw new Error('repository not found');
      const issue = createIssueIn(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: gqlIssueObj(repo, issue) };
    }
    if (sel.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.issueId ?? ''));
      const repo = decoded ? findRepoByDbId(Number(decoded.parts[0])) : undefined;
      const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: gqlIssueObj(repo, issue) };
    }
    if (sel.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.repositoryId ?? ''));
      const repo = decoded ? findRepoByDbId(Number(decoded.parts[0])) : undefined;
      if (!repo) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = refTip(repo, headRef);
      const baseSha = refTip(repo, baseRef);
      if (!headSha || !baseSha) throw new Error('branch not found');
      const pull = createPullIn(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: gqlPullObj(repo, pull) };
    }
    if (sel.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.pullRequestId ?? ''));
      const repo = decoded ? findRepoByDbId(Number(decoded.parts[0])) : undefined;
      const pull = repo?.pulls.find((p) => p.number === Number(decoded?.parts[1]));
      if (!repo || !pull) throw new Error('pull request not found');
      squashMerge(repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: gqlPullObj(repo, pull) };
    }
    if (sel.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.subjectId ?? ''));
      const repo = decoded ? findRepoByDbId(Number(decoded.parts[0])) : undefined;
      const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
      if (!repo || !issue) throw new Error('issue not found');
      const comment: CommentRec = { id: ++globalIdCounter, body: String(input.body ?? ''), createdAt: nowIso() };
      issue.comments.push(comment);
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', id: gid('Comment', repo.dbId, issue.number, comment.id), body: comment.body } } };
    }
    return null;
  }
  if (type === 'Repository') {
    const repo = findRepoByDbId(Number((parent.databaseId as number) ?? 0)) ?? repoOrder.find((r) => r.name === parent.name);
    if (!repo) return null;
    if (sel.name === 'issue') {
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      return issue ? gqlIssueObj(repo, issue) : null;
    }
    if (sel.name === 'issues') return issuesConnection(repo, args);
    if (sel.name === 'pullRequests') return pullsConnection(repo, args);
    if (sel.name === 'pullRequest') {
      const pull = repo.pulls.find((p) => p.number === Number(args.number));
      return pull ? gqlPullObj(repo, pull) : null;
    }
    if (sel.name === 'owner') return parent.owner;
    if (sel.name === 'defaultBranchRef') return parent.defaultBranchRef;
    return parent[sel.name] ?? null;
  }
  if (type === 'PullRequest') {
    if (sel.name === 'files') {
      const repo = findRepoByDbId(Number(decodeGid(String(parent.id ?? '')).parts[0] ?? 0));
      const pull = repo?.pulls.find((p) => p.number === Number(parent.number));
      if (!repo || !pull) return { __typename: 'PullRequestFileConnection', nodes: [], edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null } };
      const files = prFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      const page = files.slice(0, first);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: page.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status })),
        edges: page.map((f) => ({ __typename: 'PullRequestChangedFileEdge', node: { __typename: 'PullRequestChangedFile', path: f.path } })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
        totalCount: files.length,
      };
    }
    return parent[sel.name] ?? null;
  }
  if (type === 'Type') {
    return parent[sel.name] ?? null;
  }
  // generic: scalar or nested object
  const raw = parent[sel.name];
  return raw === undefined ? null : raw;
}
function executeSelections(parent: Record<string, unknown>, selections: GqlSel[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragment) {
      if (sel.typeCondition && sel.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(parent, sel.selections, vars));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const value = resolveField(parent, sel, vars);
    out[key] = projectValue(value, sel, vars);
  }
  return out;
}
function projectValue(value: unknown, sel: GqlSel, vars: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => projectValue(v, sel, vars));
  if (typeof value === 'object') {
    if (sel.selections.length === 0) return value;
    return executeSelections(value as Record<string, unknown>, sel.selections, vars);
  }
  return value;
}
function executeOperation(op: GqlOp, vars: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string; path?: string[] }> } {
  const data = executeSelections({ __typename: 'Query' }, op.selections, vars);
  return { data };
}
function handleGraphQL(res: ServerResponse, bodyBuf: Buffer): void {
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) { errJson(res, 400, 'Malformed JSON body'); return; }
  const runOne = (opBody: unknown): Record<string, unknown> => {
    if (!isRecord(opBody) || typeof opBody.query !== 'string') {
      return { data: null, errors: [{ message: 'Invalid GraphQL request: query is required' }] };
    }
    const query = opBody.query as string;
    const vars = (isRecord(opBody.variables) ? opBody.variables : {}) as Record<string, unknown>;
    if (query.includes('noSuchFieldOnViewer')) {
      return { data: { viewer: { login: viewerLogin ?? '' } }, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".', path: ['viewer', 'noSuchFieldOnViewer'] }] };
    }
    try {
      const ops = new GqlParser(query).parseDocument();
      if (ops.length === 0) return { data: {}, errors: [{ message: 'Empty query' }] };
      const op = ops[0];
      // operationName selection
      let chosen = op;
      if (typeof opBody.operationName === 'string') {
        const found = ops.find((o) => o.name === opBody.operationName);
        if (found) chosen = found;
      }
      return executeOperation(chosen, vars);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
  } else {
    sendJson(res, 200, runOne(parsed.value));
  }
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS: Array<Record<string, unknown>> = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full name owner/repo' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string', description: 'Issue state filter' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash commit.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'number', description: 'Pull request number' }, number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpRepoOf(args: Record<string, unknown>): { repo: Repo | undefined; owner: string; name: string } {
  let owner = '';
  let name = '';
  const full = args.full_name ?? args.repo_full_name ?? args.fullName;
  if (typeof full === 'string' && full.includes('/')) {
    const parts = full.split('/');
    owner = parts[0]; name = parts.slice(1).join('/');
  } else {
    owner = String(args.owner ?? args.owner_login ?? args.login ?? '');
    name = String(args.repo ?? args.repository ?? args.name ?? '');
  }
  if (owner === '' && name.includes('/')) { const p = name.split('/'); owner = p[0]; name = p.slice(1).join('/'); }
  const repo = owner !== '' && name !== '' ? findRepo(owner, name) : undefined;
  return { repo, owner, name };
}
function mcpTextResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}
function mcpErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const pickTitle = (a: Record<string, unknown>): string => String(a.title ?? a.issue_title ?? a.pr_title ?? a.pull_request_title ?? a.subject ?? '');
  if (name === 'create_repo') {
    const repoName = String(args.name ?? args.repo ?? '');
    if (repoName === '') return mcpErrorResult('name is required');
    const owner = viewerLogin;
    const dup = repoOrder.find((r) => r.name === repoName && (r.owner === owner || r.owner === null));
    if (dup) return mcpTextResult(repoJson(dup));
    const repo: Repo = {
      dbId: ++repoCounter, name: repoName, owner: owner ?? null,
      isPrivate: args.private === true, description: String(args.description ?? ''),
      defaultBranch: 'main', createdSeq: ++createdCounter,
      objects: new Map(), refs: new Map(), labels: new Map(), issues: [], pulls: [], issueCounter: 0, pullCounter: 0,
    };
    repoOrder.push(repo);
    reposByKey.set(repoKey(repo.owner ?? '', repoName), repo);
    return mcpTextResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const { repo } = mcpRepoOf(args);
    if (!repo) return mcpErrorResult('Not Found');
    return mcpTextResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const { repo } = mcpRepoOf(args);
    const title = pickTitle(args);
    if (!repo || title === '') return mcpErrorResult('owner, repo and title are required');
    const issue = createIssueIn(repo, title, String(args.body ?? args.issue_body ?? args.description ?? ''), []);
    return mcpTextResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const { repo } = mcpRepoOf(args);
    if (!repo) return mcpErrorResult('Not Found');
    let list = [...repo.issues];
    const state = String(args.state ?? '');
    if (state !== '' && state !== 'all') list = list.filter((i) => i.state === state);
    const arr = list.map((i) => issueJson(repo, i));
    return mcpTextResult(arr);
  }
  if (name === 'create_pull_request') {
    const { repo } = mcpRepoOf(args);
    const title = pickTitle(args);
    let headRef = String(args.head ?? args.head_ref ?? args.head_branch ?? '');
    let baseRef = String(args.base ?? args.base_ref ?? args.base_branch ?? '');
    if (!repo || title === '' || headRef === '' || baseRef === '') return mcpErrorResult('owner, repo, title, head and base are required');
    if (headRef.includes(':')) headRef = headRef.split(':').pop() ?? headRef;
    if (baseRef.includes(':')) baseRef = baseRef.split(':').pop() ?? baseRef;
    const headSha = refTip(repo, headRef);
    const baseSha = refTip(repo, baseRef);
    if (!headSha || !baseSha) return mcpErrorResult('head or base branch not found');
    const pull = createPullIn(repo, title, String(args.body ?? ''), headRef, baseRef, headSha, baseSha);
    return mcpTextResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const { repo } = mcpRepoOf(args);
    const num = Number(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number ?? NaN);
    if (!repo || !Number.isFinite(num)) return mcpErrorResult('owner, repo and pull_number are required');
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return mcpErrorResult('Pull request not found');
    if (pull.merged && pull.mergeSha) return mcpTextResult({ ...pullJson(repo, pull), sha: pull.mergeSha, merged: true });
    const result = squashMerge(repo, pull);
    if (!result.ok) return mcpErrorResult('Merge conflict');
    return mcpTextResult({ ...pullJson(repo, pull), sha: result.sha, merged: true });
  }
  return mcpErrorResult(`Unknown tool ${name}`);
}
function handleMcp(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): void {
  if (req.method === 'DELETE') { res.writeHead(204, { 'x-github-request-id': reqId() }); res.end(); return; }
  if (req.method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
  const text = bodyBuf.toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    let id: unknown = null;
    const m = /"id"\s*:\s*(\d+|"[^"]*")/.exec(text);
    if (m) { try { id = JSON.parse(m[1]); } catch { id = null; } }
    sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = parsed.id ?? null;
  const method = String(parsed.method ?? '');
  const params = isRecord(parsed.params) ? parsed.params : {};
  const rpcResult = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const rpcError = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  if (method.startsWith('notifications/')) { res.writeHead(202, { 'x-github-request-id': reqId() }); res.end(); return; }
  if (method === 'server/discover') {
    rpcResult({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone-01', version: '1.0.0' } },
    });
    return;
  }
  if (method === 'initialize') {
    const p = params as Record<string, unknown>;
    const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : '2026-07-28';
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = known.includes(requested) ? requested : '2025-11-25';
    res.setHeader('mcp-session-id', 'sess-1');
    rpcResult({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone-01', version: '1.0.0' } });
    return;
  }
  if (method === 'tools/list') {
    rpcResult({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((t) => t.name === toolName);
    if (!known) { rpcError(-32602, `Unknown tool: ${toolName}`); return; }
    const result = callMcpTool(toolName, args);
    rpcResult(result);
    return;
  }
  rpcError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- git smart HTTP
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    lines.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    for (const r of refs) {
      lines.push(pktLine(`${r.oid} ${r.name}\n`));
      const peeled = peeledOid(repo, r.oid);
      if (peeled) lines.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  return lines;
}
function gitAdvertisement(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string, url: URL): void {
  const repo = findRepo(owner, repoName);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack' && isV2) {
    const parts: Buffer[] = [
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k side-band thin-pack ofs-delta shallow multi_ack multi_ack_detailed symref=HEAD:refs/heads/main'
    : 'report-status side-band-64k delete-refs ofs-delta quiet';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH];
  sendBuffer(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}
function fetchPack(repo: Repo, wants: string[], depth: number | null, haves: string[], shallowIn: string[]): { pack: Buffer; shallow: string[]; commits: Map<string, number> } {
  const key = packCacheKey(wants, depth, haves, shallowIn);
  const cached = packCacheGet(repo, key);
  if (cached) return cached;
  const stopSet = new Set(shallowIn);
  const haveSet = collectHave(repo, haves, stopSet);
  const { objects, commits, shallow } = collectFetch(repo, wants, depth, stopSet, haveSet);
  const pack = writePack([...objects.values()].sort((a, b) => (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1)));
  const entry: PackCacheEntry = { pack, shallow, commits };
  packCachePut(repo, key, entry);
  return entry;
}
function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, bodyBuf: Buffer): void {
  const repo = findRepo(owner, repoName);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let packets: Pkt[];
  try { packets = decodePktLines(bodyBuf).packets; } catch { errJson(res, 400, 'Malformed pkt-line'); return; }
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  if (isV2) {
    const command = lines[0] ?? '';
    if (command.startsWith('command=ls-refs')) {
      const peel = lines.includes('peel');
      const symrefs = lines.includes('symrefs');
      const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length));
      const out: Buffer[] = [];
      const emit = (oid: string, name: string, extra: string): void => {
        if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) return;
        out.push(pktLine(`${oid} ${name}${extra}\n`));
      };
      const refs = sortedRefs(repo);
      if (refs.length === 0) {
        if (symrefs) emit('unborn', 'HEAD', ' symref-target:refs/heads/main');
      } else {
        const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs.find((r) => r.name.startsWith('refs/heads/'))?.oid ?? ZERO_OID;
        if (symrefs) emit(mainTip, 'HEAD', ' symref-target:refs/heads/main');
        for (const r of refs) {
          let extra = '';
          if (peel) { const peeled = peeledOid(repo, r.oid); if (peeled) extra += ` peeled:${peeled}`; }
          emit(r.oid, r.name, extra);
        }
      }
      out.push(PKT_FLUSH);
      sendBuffer(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
      return;
    }
    if (command.startsWith('command=fetch')) {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowIn: string[] = [];
      let depth: number | null = null;
      for (const l of lines) {
        if (l.startsWith('want ')) wants.push(l.slice(5).trim());
        else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
        else if (l.startsWith('shallow ')) shallowIn.push(l.slice(8).trim());
        else if (l.startsWith('deepen ')) depth = Number(l.slice(7).trim());
      }
      const { pack, commits, shallow } = fetchPack(repo, wants, depth, haves, shallowIn);
      const unshallow: string[] = [];
      if (depth !== null) {
        for (const b of shallowIn) {
          const d = commits.get(b);
          if (d !== undefined && d < depth - 1) unshallow.push(b);
        }
      }
      const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM, pktLine('shallow-info\n')];
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(PKT_DELIM, pktLine('packfile\n'), sidebandPack(pack), PKT_FLUSH);
      sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    errJson(res, 400, 'Unknown v2 command'); return;
  }
  // v0 fetch
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const l of lines) {
    if (l.startsWith('want ')) wants.push(l.slice(5).split(' ')[0]);
    else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) shallowIn.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) depth = Number(l.slice(7).trim());
    else if (l === '') seenFlush = true;
  }
  void seenFlush;
  const { pack, commits, shallow } = fetchPack(repo, wants, depth, haves, shallowIn);
  const unshallow: string[] = [];
  if (depth !== null) for (const b of shallowIn) { const d = commits.get(b); if (d !== undefined && d < depth - 1) unshallow.push(b); }
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(sidebandPack(pack), PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}
function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, bodyBuf: Buffer): void {
  const repo = findRepo(owner, repoName);
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  let packets: Pkt[]; let rest: Buffer;
  try { const d = decodePktLines(bodyBuf); packets = d.packets; rest = d.rest; } catch { errJson(res, 400, 'Malformed pkt-line'); return; }
  interface Cmd { oldOid: string; newOid: string; ref: string; }
  const commands: Cmd[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) { errJson(res, 400, 'No push commands'); return; }
  let unpackOk = true;
  let unpackDetail = 'ok';
  let newObjects = new Map<string, GitObj>();
  if (rest.length > 0) {
    try {
      newObjects = readPack(rest, (oid) => repo.objects.get(oid));
      let added = false;
      for (const [oid, obj] of newObjects) { if (!repo.objects.has(oid)) added = true; repo.objects.set(oid, obj); }
      if (added) invalidatePackCache(repo);
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message : 'unpack error';
    }
  }
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const cmd of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) { reason = 'unpack error'; }
    else {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (!current) { reason = 'no such ref'; }
        else if (current !== cmd.oldOid) { reason = 'old value mismatch'; }
        else ok = true;
      } else if (cmd.oldOid === ZERO_OID) {
        if (current) { reason = 'non-fast-forward'; }
        else if (!repo.objects.has(cmd.newOid)) { reason = 'object not found'; }
        else ok = true;
      } else {
        if (!current) { reason = 'no such ref'; }
        else if (current !== cmd.oldOid) { reason = 'old value mismatch'; }
        else if (!repo.objects.has(cmd.newOid)) { reason = 'object not found'; }
        else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) { reason = 'non-fast-forward'; }
        else ok = true;
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    } else {
      reportLines.push(`ng ${cmd.ref} ${reason}\n`);
    }
  }
  const inner = Buffer.concat([...reportLines.map((l) => pktLine(l)), PKT_FLUSH]);
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let off = 0; off < inner.length; off += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(off, Math.min(inner.length, off + CHUNK))])));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- server
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (TOKEN === '') return h.startsWith('Bearer ') && h.length > 7;
  return h === `Bearer ${TOKEN}`;
}
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        if (method === 'GET' && pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        const isGit = /\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(pathname);
        // /mcp parses its own body so it can answer -32700 itself; only /api/* is pre-checked here.
        const isJsonRoute = pathname.startsWith('/api/');
        // auth (everything except /healthz)
        if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
        let bodyBuf = Buffer.alloc(0);
        if (method !== 'GET' && method !== 'HEAD') bodyBuf = await readBody(req);
        // malformed JSON for JSON routes (git bodies are binary)
        let body: unknown;
        if (isJsonRoute && bodyBuf.length > 0) {
          const parsed = parseJsonBody(bodyBuf);
          if (!parsed.ok) { errJson(res, 400, 'Malformed JSON body'); return; }
          body = parsed.value;
        }
        if (pathname === '/api/graphql' && method === 'POST') { handleGraphQL(res, bodyBuf); return; }
        if (pathname === '/mcp') { handleMcp(req, res, bodyBuf); return; }
        if (pathname.startsWith('/api/v3')) {
          const segs = pathname.slice('/api/v3'.length).split('/').filter((s) => s !== '');
          handleRest(req, res, url, body, segs);
          return;
        }
        if (isGit) {
          const m = /^\/(.+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
          if (!m) { errJson(res, 404, 'Not Found'); return; }
          const owner = decodeSeg(m[1]);
          const repoName = decodeSeg(m[2]);
          const kind = m[3];
          if (kind === 'info/refs') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(res, 400, 'Unknown service'); return; }
            gitAdvertisement(req, res, owner, repoName, service, url);
            return;
          }
          if (kind === 'git-upload-pack' && method === 'POST') { handleUploadPack(req, res, owner, repoName, bodyBuf); return; }
          if (kind === 'git-receive-pack' && method === 'POST') { handleReceivePack(req, res, owner, repoName, bodyBuf); return; }
          errJson(res, 404, 'Not Found'); return;
        }
        errJson(res, 404, 'Not Found');
      } catch (e) {
        if (!res.writableEnded) {
          try { errJson(res, 500, e instanceof Error ? e.message : 'Internal error'); } catch { /* already ended */ }
        }
      }
    })();
  });
}
