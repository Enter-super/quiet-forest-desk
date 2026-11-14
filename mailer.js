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
function fetchInbox({ host, port = 993, user, pass, limit = 5 }) {
  return new Promise((resolve, reject) => {
    let sock;
    let tag = 0;
    let stage = 0;
    let raw = Buffer.alloc(0);
    let done = false;
    let mailboxCount = 0;

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

    sock.on('connect', () => {
      curTag = send(`LOGIN "${user.replace(/"/g, '\\"')}" "${String(pass).replace(/"/g, '\\"')}"`);
      stage = 1;
    });

    sock.on('data', (chunk) => {
      raw = Buffer.concat([raw, Buffer.from(chunk, 'latin1')]);
      const { text } = extractLiterals(raw);
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
          messages.push({
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

module.exports = { fetchInbox, loadConfig, saveConfig, clearConfig };
