/* 极简 IMAP 客户端 + 轮询。
   只做一件事：拿 INBOX 最新几封的 发件人 / 主题 / 时间。
   不引第三方库，靠 tls 裸协议，方便直接打进 exe。
*/
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');

const TIMEOUT = 20000;

/* ---------- 编码 ---------- */
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return buf.toString(/gb|big5/i.test(cs) ? 'binary' : 'utf8');
    } catch { return data; }
  }).replace(/\?=\s+=\?/g, '');
}

/* ---------- 把 {123}\r\n<123 bytes> 换成占位符 ---------- */
function extractLiterals(buf) {
  const lits = [];
  let out = Buffer.alloc(0);
  let i = 0;
  while (i < buf.length) {
    const open = buf.indexOf(0x7b, i);            /* '{' */
    if (open === -1) { out = Buffer.concat([out, buf.subarray(i)]); break; }
    const close = buf.indexOf(0x7d, open);        /* '}' */
    if (close === -1) { out = Buffer.concat([out, buf.subarray(i)]); break; }
    const size = parseInt(buf.subarray(open + 1, close).toString(), 10);
    if (!Number.isFinite(size) || size < 0) { out = Buffer.concat([out, buf.subarray(i)]); break; }
    const dataStart = close + 1 + 2;              /* 跳过 }\r\n */
    if (buf.length < dataStart + size) {          /* 还没收全，等下一包 */
      out = Buffer.concat([out, buf.subarray(i)]);
      break;
    }
    out = Buffer.concat([out, buf.subarray(i, open), Buffer.from(`\u0000L${lits.length}\u0000`)]);
    lits.push(buf.subarray(dataStart, dataStart + size).toString('utf8'));
    i = dataStart + size;
  }
  return { text: out.toString('utf8'), lits };
}

/* ---------- 一次抓取 ---------- */
function fetchInbox({ host, port = 993, user, pass, limit = 10 }) {
  return new Promise((resolve, reject) => {
    let sock;
    let tag = 0;
    let stage = 0;
    let raw = Buffer.alloc(0);
    let done = false;
    let mailboxCount = 0;
    let firstSeq = 1;

    const finish = (err, data) => {
      if (done) return;
      done = true;
      try { sock && sock.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve(data);
    };

    const timer = setTimeout(() => finish(new Error('连接 IMAP 超时')), TIMEOUT);

    try {
      sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
        /* 连上就发命令，按阶段推进 */
      });
    } catch (e) { clearTimeout(timer); reject(e); return; }

    sock.setEncoding('latin1');
    sock.on('error', (e) => { clearTimeout(timer); finish(e); });

    const send = (cmd) => { tag += 1; sock.write(`A${tag} ${cmd}\r\n`); return `A${tag}`; };
    let curTag = null;

    /* IMAP 规定：必须先读到服务器的问候语 * OK / * PREAUTH，才能发命令。
       握手完成就抢发 LOGIN 会被服务器忽略，之后永远等不到回应 → 20 秒超时。 */
    sock.on('data', (chunk) => {
      raw = Buffer.concat([raw, Buffer.from(chunk, 'latin1')]);
      const { text } = extractLiterals(raw);

      /* 问候语到达后再登录 */
      if (stage === 0) {
        if (/^\* (OK|PREAUTH)/m.test(text)) {
          curTag = send(`LOGIN "${String(user).replace(/"/g, '\\"')}" "${String(pass).replace(/"/g, '\\"')}"`);
          stage = 1;
        }
        return;
      }
      if (stage === 1 && new RegExp(`^A${tag} (OK|NO|BAD)`, 'm').test(text)) {
        if (new RegExp(`^A${tag} BAD`, 'm').test(text)) { clearTimeout(timer); finish(new Error('登录失败：检查邮箱/授权码')); return; }
        if (new RegExp(`^A${tag} NO`, 'm').test(text)) { clearTimeout(timer); finish(new Error('登录被拒绝：多半要授权码而不是密码')); return; }
        raw = Buffer.alloc(0);
        curTag = send('SELECT "INBOX"');
        stage = 2;
        return;
      }
      if (stage === 2) {
        const m = text.match(/^\* (\d+) EXISTS/m);
        if (m) mailboxCount = parseInt(m[1], 10);
        if (new RegExp(`^A${tag} (OK|NO|BAD)`, 'm').test(text)) {
          raw = Buffer.alloc(0);
          if (!mailboxCount) { clearTimeout(timer); finish(null, { count: 0, messages: [] }); return; }
          const from = Math.max(1, mailboxCount - limit + 1);
          firstSeq = from;
          curTag = send(`FETCH ${from}:${mailboxCount} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
          stage = 3;
        }
        return;
      }
      if (stage === 3) {
        if (!new RegExp(`^A${tag} (OK|NO|BAD)`, 'm').test(text)) return;
        clearTimeout(timer);
        const { text: t2, lits } = extractLiterals(raw);
        const messages = [];
        const re = /\u0000L(\d+)\u0000/g;
        let mt;
        while ((mt = re.exec(t2))) {
          const head = lits[Number(mt[1])] || '';
          const get = (k) => {
            const mm = head.match(new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\r?\\n[!-9;-~]+:|$)`, 'im'));
            return mm ? decodeWords(mm[1].replace(/\r?\n\s+/g, ' ').trim()) : '';
          };
          const idx = messages.length;
          messages.push({
            seq: firstSeq + idx,
            from: get('From').replace(/<.*?>/, '').replace(/"/g, '').trim() || get('From'),
            subject: get('Subject'),
            date: get('Date'),
          });
        }
        finish(null, { count: mailboxCount, messages: messages.reverse() });
      }
    });

    sock.on('close', () => {
      if (!done) { clearTimeout(timer); finish(new Error('IMAP 连接被关闭')); }
    });
  });
}

/* ---------- 凭据存盘 ---------- */
function storeFile(dir) { return path.join(dir, 'mailbox.json'); }

function loadConfig(dir) {
  try { return JSON.parse(fs.readFileSync(storeFile(dir), 'utf8')); } catch { return null; }
}

function saveConfig(dir, cfg) {
  fs.writeFileSync(storeFile(dir), JSON.stringify(cfg, null, 2), 'utf8');
}

function clearConfig(dir) {
  try { fs.unlinkSync(storeFile(dir)); } catch { /* ignore */ }
}


/* ---------- 正文解析 ---------- */
function decodeQuotedPrintable(s) {
  return Buffer.from(
    s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
    'latin1'
  );
}

function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function splitHeadBody(raw) {
  const m = String(raw).match(/\r?\n\r?\n/);
  if (!m) return { head: String(raw), body: '' };
  const i = m.index;
  return { head: String(raw).slice(0, i), body: String(raw).slice(i + m[0].length) };
}

function headerGetter(head) {
  return (k) => {
    const m = head.match(new RegExp('^' + k + ':\\s*([\\s\\S]*?)(?=\\r?\\n[!-9;-~]+:|$)', 'im'));
    return m ? m[1].replace(/\r?\n\s+/g, ' ').trim() : '';
  };
}

function decodeBody(body, h) {
  const enc = h('Content-Transfer-Encoding').toLowerCase();
  const ctype = h('Content-Type').toLowerCase();
  const charset = (ctype.match(/charset="?([\w-]+)/) || [])[1] || 'utf-8';

  let bytes;
  if (enc === 'base64') bytes = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  else if (enc === 'quoted-printable') bytes = decodeQuotedPrintable(body);
  else bytes = Buffer.from(body, 'latin1');

  let text;
  try {
    text = new TextDecoder(/^gb/i.test(charset) ? 'gbk' : charset).decode(bytes);
  } catch {
    text = bytes.toString('utf8');
  }
  return { text, isHtml: /text\/html/.test(ctype) || /<html|<body|<div|<p[\s>]/i.test(text) };
}

/* 递归取第一个有内容的文本部件 */
function parsePart(raw, depth = 0) {
  if (depth > 4) return null;
  const { head, body } = splitHeadBody(raw);
  const h = headerGetter(head);
  const ctype = h('Content-Type');
  const boundary = (ctype.match(/boundary="?([^";]+)"?/i) || [])[1];

  if (boundary) {
    const safe = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chunks = body.split(new RegExp('--' + safe + '(?:--)?[ \\t]*\\r?\\n'));
    for (const c of chunks) {
      const t = c.trim();
      if (!t || t === '--') continue;
      const r = parsePart(t, depth + 1);
      if (r && r.text && r.text.trim()) return r;
    }
    return null;
  }
  const d = decodeBody(body, h);
  return { text: d.text, isHtml: d.isHtml };
}

function parseMessage(raw) {
  const { head } = splitHeadBody(raw);
  const h = headerGetter(head);
  const body = splitHeadBody(raw).body;

  /* 正文部件：优先 text/plain，其次第一个非空文本部件 */
  let part = null;
  const topType = h('Content-Type');
  const boundary = (topType.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (boundary) {
    const safe = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chunks = body.split(new RegExp('--' + safe + '(?:--)?[ \\t]*\\r?\\n'));
    let plain = null, html = null;
    for (const c of chunks) {
      const t = c.trim();
      if (!t || t === '--') continue;
      const sub = splitHeadBody(t);
      const sh = headerGetter(sub.head);
      const st = sh('Content-Type').toLowerCase();
      const r = parsePart(t, 1);
      if (!r || !r.text || !r.text.trim()) continue;
      const isPlain = /text\/plain/.test(st) || (!/text\/html/.test(st) && !r.isHtml);
      if (isPlain && !plain) plain = r;
      else if (!html) html = r;
    }
    part = plain || html;
  } else {
    part = parsePart(raw, 0);
  }

  let text = (part && part.text) || '';
  if (!text && !boundary) {
    const d = decodeBody(body, h);
    text = d.text;
    if (d.isHtml) text = htmlToText(text);
  } else if (part && part.isHtml) {
    text = htmlToText(text);
  }

  text = String(text).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    from: decodeWords(h('From')).replace(/<.*?>/, '').replace(/"/g, '').trim() || decodeWords(h('From')),
    subject: decodeWords(h('Subject')),
    date: h('Date'),
    text: text.slice(0, 8000),
  };
}

/* ---------- 取单封正文 ---------- */
function fetchBody({ host, port = 993, user, pass, seq }) {
  return new Promise((resolve, reject) => {
    let sock;
    let tag = 0;
    let stage = 0;
    let raw = Buffer.alloc(0);
    let done = false;

    const finish = (err, data) => {
      if (done) return;
      done = true;
      try { sock && sock.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve(data);
    };

    const timer = setTimeout(() => finish(new Error('连接 IMAP 超时')), TIMEOUT);

    try {
      sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {});
    } catch (e) { clearTimeout(timer); reject(e); return; }

    sock.setEncoding('latin1');
    sock.on('error', (e) => { clearTimeout(timer); finish(e); });

    const send = (cmd) => { tag += 1; sock.write(`A${tag} ${cmd}\r\n`); return `A${tag}`; };

    sock.on('data', (chunk) => {
      raw = Buffer.concat([raw, Buffer.from(chunk, 'latin1')]);
      const { text } = extractLiterals(raw);

      if (stage === 0) {
        if (/^\* (OK|PREAUTH)/m.test(text)) {
          send(`LOGIN "${String(user).replace(/"/g, '\\"')}" "${String(pass).replace(/"/g, '\\"')}"`);
          stage = 1;
        }
        return;
      }
      if (!new RegExp('^A' + tag + ' (OK|NO|BAD)', 'm').test(text)) return;

      if (stage === 1) {
        if (new RegExp('^A' + tag + ' (NO|BAD)', 'm').test(text)) {
          clearTimeout(timer); finish(new Error('登录失败：检查邮箱或授权码')); return;
        }
        raw = Buffer.alloc(0);
        send('SELECT "INBOX"');
        stage = 2;
        return;
      }
      if (stage === 2) {
        raw = Buffer.alloc(0);
        send(`FETCH ${seq} BODY.PEEK[]`);
        stage = 3;
        return;
      }
      if (stage === 3) {
        clearTimeout(timer);
        const { lits } = extractLiterals(raw);
        if (!lits.length) { finish(new Error('没有取到正文')); return; }
        try { finish(null, parseMessage(lits[lits.length - 1])); } catch (e) { finish(e); }
      }
    });
  });
}

module.exports = { fetchInbox, fetchBody, loadConfig, saveConfig, clearConfig };
