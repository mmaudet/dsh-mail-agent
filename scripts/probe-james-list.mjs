// Which LIST RETURN option does an IMAP server reject?
//
// One command per option, on one connection, raw over TLS with no library in
// the path, so the output is the server's answer rather than a client's
// interpretation of it. Written to narrow a failure on a Twake Mail
// deployment; see docs/upstream/twake-mail-list-return-subscribed.md.
//
//   PROBE_HOST=imap.example.com PROBE_USER=user@example.com \
//     PROBE_PASS="$PASSWORD" node scripts/probe-james-list.mjs
import tls from 'node:tls';

const CRLF = '\r\n';
const NUL = "\u0000";

const HOST = process.env.PROBE_HOST ?? 'imap.linagora.com';
const PORT = Number(process.env.PROBE_PORT ?? 993);
const USER = process.env.PROBE_USER ?? 'mmaudet@linagora.com';
const PASS = process.env.PROBE_PASS ?? process.env.MAIL_SENTINEL_IMAP_PASSWORD;

const COMMANDS = [
  'LIST "" "INBOX"',
  'LIST "" "INBOX" RETURN (SPECIAL-USE)',
  'LIST "" "INBOX" RETURN (CHILDREN)',
  'LIST "" "INBOX" RETURN (SUBSCRIBED)',
  'LIST "" "INBOX" RETURN (SPECIAL-USE CHILDREN)',
  'LIST "" "INBOX" RETURN (CHILDREN SUBSCRIBED)',
  'LIST "" "INBOX" RETURN (SPECIAL-USE CHILDREN SUBSCRIBED)',
  'LIST (SUBSCRIBED) "" "INBOX"',
  'LSUB "" "INBOX"',
];

const s = tls.connect({ host: HOST, port: PORT, servername: HOST, rejectUnauthorized: false });
s.setEncoding('utf8');
let buf = '';
let phase = 'greeting';
let i = 0;
const timer = setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 60000);

function next() {
  if (i >= COMMANDS.length) {
    clearTimeout(timer);
    s.write(`z LOGOUT${CRLF}`);
    s.end();
    return;
  }
  buf = '';
  const tag = `c${String(i)}`;
  s.write(`${tag} ${COMMANDS[i]}${CRLF}`);
}

s.on('error', (e) => {
  console.error('socket', e.message);
  process.exit(1);
});

s.on('data', (chunk) => {
  buf += chunk;
  if (phase === 'greeting' && buf.includes('* OK')) {
    phase = 'auth';
    buf = '';
    const sasl = Buffer.from(`${NUL}${USER}${NUL}${PASS}`, 'utf8').toString('base64');
    s.write(`a1 AUTHENTICATE PLAIN ${sasl}${CRLF}`);
    return;
  }
  if (phase === 'auth' && /a1 (OK|NO|BAD)/.test(buf)) {
    if (!/a1 OK/.test(buf)) {
      console.error('auth failed');
      process.exit(1);
    }
    console.log(`${HOST}:${String(PORT)}\n`);
    phase = 'commands';
    next();
    return;
  }
  if (phase === 'commands') {
    const tag = `c${String(i)}`;
    const re = new RegExp(`${tag} (OK|NO|BAD)[^\r\n]*`);
    const m = re.exec(buf);
    if (m === null) return;
    const rows = buf.split(/\r?\n/).filter((l) => /^\* (LIST|LSUB)/.test(l)).length;
    const verdict = m[0].slice(tag.length + 1);
    console.log(`  ${verdict.startsWith('OK') ? 'ok  ' : 'FAIL'}  ${COMMANDS[i].padEnd(52)} rows=${String(rows)}  ${verdict.slice(0, 40)}`);
    i += 1;
    next();
  }
});
