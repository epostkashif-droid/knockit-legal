/* TokenLive shared logic: used by the clinic app, the patient page and the tests.
   No UI code here. Works in browsers (window.TL) and in Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATUSES = ['open', 'break', 'notyet', 'closed'];
  var MAX_TOKEN = 9999;
  var ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 symbols: no 0/o/1/l confusion, unbiased with 256 % 32 = 0

  function int(v, min, max, def) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function str(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  }

  function randomId(len) {
    var bytes = new Uint8Array(len || 20);
    (typeof crypto !== 'undefined' ? crypto : require('crypto').webcrypto).getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] % 32];
    return out;
  }

  function validTopic(t) { return typeof t === 'string' && /^tl-[a-z0-9]{12,40}$/.test(t); }

  /* Minutes per patient, learned from when the receptionist pressed Next.
     Gaps longer than a break (3x the usual time, at least 30 min) are ignored. */
  function pace(times, fallback) {
    fallback = Math.min(60, Math.max(1, Number(fallback) || 6));
    if (!times || times.length < 2) return fallback;
    var cap = Math.max(30, fallback * 3), gaps = [];
    for (var i = 1; i < times.length; i++) {
      var g = (times[i] - times[i - 1]) / 60000;
      if (g >= 0.5 && g <= cap) gaps.push(g);
    }
    gaps = gaps.slice(-8);
    if (gaps.length < 3) return fallback;
    var s = gaps.slice().sort(function (a, b) { return a - b; });
    var mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    var w = gaps.length / (gaps.length + 2);
    var m = w * mid + (1 - w) * fallback;
    return Math.min(60, Math.max(1, Math.round(m * 2) / 2));
  }

  /* What the clinic publishes. Only token numbers and the clinic's own names: no patient data. */
  function publicState(c, now) {
    var s = c.session;
    return {
      v: 1,
      s: s.id,
      c: str(c.clinic, 60),
      d: str(c.doctor, 60),
      n: int(s.n, 0, MAX_TOKEN, 0),
      i: int(s.i, 0, MAX_TOKEN, 0),
      m: pace(s.times, c.mins),
      st: STATUSES.indexOf(s.status) >= 0 ? s.status : 'open',
      at: (s.status === 'break' || s.status === 'notyet') ? int(s.at, 0, 4102444800000, 0) : 0,
      ts: now
    };
  }

  /* Reads a published state from the network. Anything malformed is rejected. */
  function parseState(text) {
    var o;
    try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!o || typeof o !== 'object' || o.v !== 1) return null;
    if (typeof o.s !== 'string' || !/^[a-z0-9]{4,24}$/.test(o.s)) return null;
    if (STATUSES.indexOf(o.st) < 0) return null;
    var ts = Number(o.ts);
    if (!isFinite(ts) || ts <= 0) return null;
    return {
      v: 1, s: o.s,
      c: str(o.c, 60), d: str(o.d, 60),
      n: int(o.n, 0, MAX_TOKEN, 0), i: int(o.i, 0, MAX_TOKEN, 0),
      m: Math.min(60, Math.max(1, Number(o.m) || 6)),
      st: o.st, at: int(o.at, 0, 4102444800000, 0), ts: ts
    };
  }

  /* A patient's place in the queue.
     kind: none | waiting | near | turn | passed | closed */
  function estimate(ps, mine, now) {
    if (!ps) return { kind: 'none' };
    var stale = now - ps.ts > 3 * 3600000;
    mine = int(mine, 0, MAX_TOKEN, 0);
    if (!mine) return { kind: ps.st === 'closed' ? 'closed' : 'none', stale: stale };
    var ahead = mine - ps.n;
    if (ahead < 0) return { kind: 'passed', ahead: ahead, stale: stale };
    if (ahead === 0 && ps.n > 0) return { kind: ps.st === 'closed' ? 'closed' : 'turn', ahead: 0, stale: stale };
    if (ps.st === 'closed') return { kind: 'closed', ahead: ahead, stale: stale };
    var base = 0;
    if ((ps.st === 'break' || ps.st === 'notyet') && ps.at > now) base = (ps.at - now) / 60000;
    // The patient being seen now is about half done; before the first call, everyone ahead is still waiting.
    var people = ps.n === 0 ? mine - 1 : ahead - 0.5;
    var wait = base + Math.max(0, people) * ps.m;
    return {
      kind: ahead <= 3 && ps.st === 'open' ? 'near' : 'waiting',
      ahead: ps.n === 0 ? mine - 1 : ahead,
      wait: wait,
      low: roundNice(wait * 0.8),
      high: roundNice(wait * 1.25 + 2),
      at: now + wait * 60000,
      stale: stale
    };
  }

  function roundNice(m) {
    if (m < 10) return Math.max(0, Math.round(m));
    return Math.round(m / 5) * 5;
  }

  /* An Indian 10-digit mobile gets +91; numbers with a country code are kept. */
  function waNumber(raw, cc) {
    var d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length === 11 && d[0] === '0') d = d.slice(1);
    if (d.length === 10) d = (cc || '91') + d;
    return d.length >= 11 && d.length <= 15 ? d : '';
  }

  function patientLink(base, topic, token) {
    var u = base + '?c=' + encodeURIComponent(topic);
    if (token) u += '&t=' + int(token, 1, MAX_TOKEN, 1);
    return u;
  }

  return {
    STATUSES: STATUSES, MAX_TOKEN: MAX_TOKEN,
    int: int, str: str, randomId: randomId, validTopic: validTopic,
    pace: pace, publicState: publicState, parseState: parseState,
    estimate: estimate, roundNice: roundNice, waNumber: waNumber, patientLink: patientLink
  };
});
