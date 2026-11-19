const SHELL = window.desktopShell || {};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

let mdMax = 0;
let hTimer = 0;

function reportHeight() {
  clearTimeout(hTimer);
  hTimer = setTimeout(() => {
    if (!SHELL.mailHeight) return;
    const md = document.querySelector('.md');
    if (!md) return;
    const h = Math.ceil(md.getBoundingClientRect().height) + 40;   /* 上下各 20px 外边距 */
    SHELL.mailHeight(h);
  }, 60);
}

const OTP_KEY = /(验证码|校验码|动态码|确认码|激活码|安全码|登录码|口令|verification\s*code|verify|passcode|\botp\b)/i;

let curSeq = Number(new URLSearchParams(location.search).get('seq') || 0);

function pickOtpFrom(text) {
  const s = String(text || '');
  if (!OTP_KEY.test(s)) return '';
  const hits = s.match(/(?<!\d)(\d{4,8})(?!\d)/g) || [];
  return hits.length ? hits[hits.length - 1] : '';
}

async function show(seq) {
  curSeq = seq;
  $('#mdSubject').textContent = '正在读取…';
  $('#mdFrom').textContent = '—';
  $('#mdDate').textContent = '';
  $('#mdBody').innerHTML = '<div class="md-empty">正在收取正文…</div>';
  $('#mdOtp').hidden = true;
  try {
    const m = await (SHELL.mailBody ? SHELL.mailBody(seq) : Promise.resolve({ error: '接口不可用' }));
    if (!m || m.error) {
      $('#mdSubject').textContent = '读取失败';
      $('#mdBody').innerHTML = '<div class="md-empty">' + esc((m && m.error) || '未知错误') + '</div>';
      return;
    }
    $('#mdFrom').textContent = m.from || '(未知发件人)';
    $('#mdSubject').textContent = m.subject || '(无主题)';
    $('#mdDate').textContent = m.date || '';

    const otp = pickOtpFrom((m.subject || '') + ' ' + (m.text || '').slice(0, 400));
    if (otp) {
      $('#mdOtp').hidden = false;
      $('#mdOtpCode').textContent = otp;
    }
    $('#mdBody').textContent = m.text || '（正文为空或无法解析）';
    reportHeight();
  } catch (e) {
    $('#mdBody').innerHTML = '<div class="md-empty">' + esc(String(e && e.message || e)) + '</div>';
  }
}

$('#mdClose').addEventListener('click', () => { if (SHELL.closeMail) SHELL.closeMail(); });

$('#mdOtpCopy').addEventListener('click', async () => {
  const code = $('#mdOtpCode').textContent.trim();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    $('#mdOtpCopy').textContent = '已复制';
    setTimeout(() => { $('#mdOtpCopy').textContent = '复制验证码'; }, 1200);
  } catch { /* 忽略 */ }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && SHELL.closeMail) SHELL.closeMail();
});

if (SHELL.onMailShow) SHELL.onMailShow((seq) => show(seq));
if (curSeq) show(curSeq);

async function initSize() {
  try {
    const d = SHELL.display ? await SHELL.display() : null;
    if (d && d.h) {
      mdMax = Math.max(300, d.h - 80);
      document.documentElement.style.setProperty('--md-max', mdMax + 'px');
      document.documentElement.style.setProperty('--md-body-max', Math.max(180, mdMax - 280) + 'px');
    }
  } catch { /* 忽略 */ }
}

initSize().then(() => {
  requestAnimationFrame(() => { document.body.classList.add('is-ready'); reportHeight(); });
  new ResizeObserver(reportHeight).observe(document.querySelector('.md'));
});
window.addEventListener('resize', reportHeight);
