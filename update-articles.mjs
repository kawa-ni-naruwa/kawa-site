// update-articles.mjs — 「いま読まれている記事」「こちらも読まれています」をnoteの実績から作り直す
//
//   node update-articles.mjs          index.html と thumbs/ を更新するだけ（公開はしない）
//   node update-articles.mjs --push   更新して、変化があれば commit & push（＝公開）まで行う
//
// 人気順は note の「直近30日のPV」。PVはログインしないと見えないので、
// note-auto のログイン済みプロファイル（note-auto/user-data）を読み取り専用で使う。
// 取得に失敗したら index.html には一切触らずに終了する。
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTE_AUTO = path.join(HERE, '..', 'note-auto');
const USER = 'kawa_ni_naruwa';
const TOP_N = 6;       // 人気記事のカード枚数
const MORE_N = 4;      // その下に一覧で出す本数（7位〜）
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- 1. 公開記事の一覧（ログイン不要） ----
async function fetchPublic() {
  const all = [];
  for (let p = 1; p <= 30; p++) {
    const r = await fetch(`https://note.com/api/v2/creators/${USER}/contents?kind=note&page=${p}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`記事一覧の取得に失敗 (HTTP ${r.status})`);
    const d = (await r.json()).data;
    all.push(...d.contents);
    if (d.isLastPage || !d.contents.length) break;
  }
  const seen = new Set();
  return all.filter((n) => n.status === 'published' && !seen.has(n.key) && seen.add(n.key));
}

// ---- 2. 直近30日のPV（ログイン済みプロファイルで読むだけ） ----
async function fetchMonthlyPv() {
  const require = createRequire(path.join(NOTE_AUTO, 'package.json'));
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext(path.join(NOTE_AUTO, 'user-data'), {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`https://note.com/${USER}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const stats = [];
    for (let p = 1; p <= 30; p++) {
      const r = await page.evaluate(async (u) => {
        const res = await fetch(u, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        return { status: res.status, text: await res.text() };
      }, `https://note.com/api/v1/stats/pv?filter=monthly&page=${p}&sort=pv`);
      if (r.status !== 200) throw new Error(`PVの取得に失敗 (HTTP ${r.status})。ログイン切れなら note-auto で node login.js`);
      const d = JSON.parse(r.text).data;
      stats.push(...(d.note_stats || []));
      if (d.last_page || !(d.note_stats || []).length) break;
    }
    return new Map(stats.map((n) => [n.key, n.read_count || 0]));
  } finally {
    await ctx.close();
  }
}

// ---- 3. 表示用の加工 ----
function splitTitle(name) {
  // 先頭・末尾の【…】はタイトルから外し、先頭のものはタグ候補にする
  let title = name.trim();
  let tag = null;
  const head = title.match(/^【([^】]+)】\s*/);
  if (head) { tag = head[1]; title = title.slice(head[0].length); }
  const tail = title.match(/\s*【([^】]+)】$/);
  if (tail) { tag = tag || tail[1]; title = title.slice(0, tail.index).trim(); }
  return { title: title || name, tag };
}

function excerpt(body) {
  const t = String(body || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 78) + '…' : t;
}

async function saveThumb(note) {
  if (!note.eyecatch) return null;
  const rel = `thumbs/${note.key}.jpg`;
  const u = new URL(note.eyecatch);
  u.search = '?fit=bounds&format=jpeg&quality=85&width=640';
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    fs.mkdirSync(path.join(HERE, 'thumbs'), { recursive: true });
    fs.writeFileSync(path.join(HERE, rel), Buffer.from(await r.arrayBuffer()));
    return rel;
  } catch (e) {
    console.warn(`  サムネイル取得失敗 ${note.key}: ${e.message}`);
    return fs.existsSync(path.join(HERE, rel)) ? rel : null;
  }
}

function replaceBlock(html, name, inner, inline = false) {
  const re = new RegExp(`(<!-- AUTO:${name} -->)[\\s\\S]*?(<!-- /AUTO:${name} -->)`);
  if (!re.test(html)) throw new Error(`index.html に目印 AUTO:${name} が見つからない`);
  return html.replace(re, (_, a, b) => (inline ? `${a}${inner}${b}` : `${a}\n${inner}\n${b}`));
}

// ---- 4. 本体 ----
const notes = await fetchPublic();
if (notes.length < TOP_N) throw new Error(`公開記事が ${notes.length} 本しか取れなかったので中止`);
const pv = await fetchMonthlyPv();
if (![...pv.values()].some((v) => v > 0)) throw new Error('PVがすべて0だったので中止（取得の異常とみなす）');

const meta = JSON.parse(fs.readFileSync(path.join(HERE, 'articles-meta.json'), 'utf8'));
const ranked = [...notes].sort((a, b) => (pv.get(b.key) || 0) - (pv.get(a.key) || 0) || b.likeCount - a.likeCount);
const top = ranked.slice(0, TOP_N);
const more = ranked.slice(TOP_N, TOP_N + MORE_N).filter((n) => (pv.get(n.key) || 0) > 0);
const tagOf = (n) => (meta[n.key] || {}).tag || splitTitle(n.name).tag || (n.hashtags?.[0]?.hashtag?.name || '').replace(/^#/, '') || 'note';

const cards = [];
for (const [i, n] of top.entries()) {
  const { title } = splitTitle(n.name);
  const m = meta[n.key] || {};
  const tag = tagOf(n);
  const desc = m.desc || excerpt(n.body);
  const thumb = await saveThumb(n);
  cards.push(`      <a class="article-card" href="https://note.com/${USER}/n/${n.key}" target="_blank" rel="noopener">
        <div class="thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy" width="640" height="335">` : ''}<span class="rank" aria-label="${i + 1}位">${i + 1}</span></div>
        <div class="body">
          <span class="theory">${esc(tag)}</span>
          <h3>${esc(title)}</h3>
          <p>${esc(desc)}</p>
          <span class="more">noteで読む</span>
        </div>
      </a>`);
  console.log(`${i + 1}位  ${String(pv.get(n.key) || 0).padStart(4)} PV  ${title}${m.desc ? '' : '  ※紹介文は自動（articles-meta.json で手直し可）'}`);
}

const moreHtml = more.map((n) =>
  `        <li><a href="https://note.com/${USER}/n/${n.key}" target="_blank" rel="noopener"><span class="k">${esc(tagOf(n))}</span><span class="t">${esc(splitTitle(n.name).title)}</span></a></li>`
).join('\n');
for (const n of more) console.log(`次点  ${String(pv.get(n.key) || 0).padStart(4)} PV  ${splitTitle(n.name).title}  [${tagOf(n)}]`);

const now = new Date();
const today = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

const file = path.join(HERE, 'index.html');
const before = fs.readFileSync(file, 'utf8');
let html = before;
html = replaceBlock(html, 'popular', cards.join('\n'));
html = replaceBlock(html, 'more', moreHtml);
html = replaceBlock(html, 'count', String(notes.length), true);
// 日付だけの違いで毎回コミットしないよう、順位・本数が変わったときだけ日付を進める
if (html !== before) html = replaceBlock(html, 'updated', `${today} 更新`, true);
fs.writeFileSync(file, html);
console.log(html === before ? '変化なし' : 'index.html を更新した');

if (process.argv.includes('--push') && html !== before) {
  const git = (...a) => execFileSync('git', ['-C', HERE, ...a], { stdio: 'inherit' });
  git('add', 'index.html', 'thumbs');
  git('commit', '-m', `人気記事を更新（${today}）`);
  git('push');
  console.log('公開した（反映まで1〜2分）');
}
