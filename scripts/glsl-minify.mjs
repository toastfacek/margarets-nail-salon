// Build-time GLSL tidy (vite.config.js, build only): strips comments and
// indentation from the GLSL inside template literals in src/**/*.js, so the
// shipped shaders read exactly as written, minus the bytes no GPU needs.
//
// Only template literals that look like GLSL are touched (gl_*, void main(,
// #include <, uniform / varying / attribute declarations, precision, texture2D).
// Line breaks are kept (preprocessor lines need them; interior blank lines go),
// and the text around each ${} is left joined as written: a line that runs into
// or out of an interpolation keeps its spaces on that side, and a // comment
// that would run into an interpolation leaves the literal untouched. Each
// rewrite is checked: the whitespace-separated tokens of the literal, comments
// removed, must be unchanged, or the build fails.
import { parseAst } from 'rollup/parseAst';

const LOOKS_GLSL = /\bgl_[A-Z]\w*|\bvoid\s+main\s*\(|#include\s*<|\b(?:uniform|varying|attribute)\s+\w+\s+\w+|\bprecision\s+(?:high|medium|low)p\b|\btexture2D\s*\(/;

// Remove comments from one quasi's raw text. Returns null when a comment does
// not close inside it (a // running into ${...}, an open /*).
function stripComments(raw, endsAtExpr) {
  let out = '';
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c === '/' && raw[i + 1] === '/') {
      const e = raw.indexOf('\n', i);
      if (e < 0) {
        if (endsAtExpr) return null;
        i = n;
      } else i = e; // keep the newline
    } else if (c === '/' && raw[i + 1] === '*') {
      const e = raw.indexOf('*/', i + 2);
      if (e < 0) return null;
      out += raw.slice(i, e).includes('\n') ? '\n' : ' ';
      i = e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// GLSL tokens (numbers, names, multi-character operators, single characters)
const TOK = /\d+\.?\d*(?:[eE][+-]?\d+)?[fFuU]?|\.\d+(?:[eE][+-]?\d+)?[fF]?|[A-Za-z_]\w*|<<=|>>=|\+\+|--|&&|\|\||\^\^|<<|>>|[+\-*\/%<>=!&|^]=|\S/g;
const tokens = (s) => s.match(TOK) || [];

// Spaces next to punctuation go, unless the two characters would then read as
// one operator (a - -b, a + +b, a < =...) or start a comment.
const PUNCT = new Set(';,(){}[]=+-*/<>!&|?:.^%~'.split(''));
const KEEP_PAIR = new Set(['++', '--', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||', '^^', '<<', '>>', '&=', '|=', '^=', '//', '/*', '*/', '..']);
function squeeze(line) {
  line = line.replace(/[ \t]+/g, ' ');
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') {
      const a = out[out.length - 1], b = line[i + 1];
      if (a !== undefined && b !== undefined && (PUNCT.has(a) || PUNCT.has(b)) && !KEEP_PAIR.has(a + b)) continue;
    }
    out += c;
  }
  return out;
}

/** New raw text for each quasi of a GLSL template literal, or null to leave it. */
export function tidyQuasis(raws) {
  const last = raws.length - 1;
  const out = [];
  for (let q = 0; q <= last; q++) {
    const raw = raws[q];
    if (/\\\r?\n/.test(raw)) return null; // a JS line continuation: leave the literal alone
    const text = stripComments(raw, q < last);
    if (text === null) return null;
    const lines = text.split('\n');
    const L = lines.length - 1;
    const kept = [];
    for (let j = 0; j <= L; j++) {
      let line = lines[j];
      const joinsBefore = j === 0 && q > 0;   // continues the line of the ${} before it
      const joinsAfter = j === L && q < last; // runs into the ${} after it
      if (!joinsBefore) line = line.replace(/^[ \t]+/, '');
      if (!joinsAfter) line = line.replace(/[ \t]+$/, '');
      // preprocessor lines (and their continuations) keep their spacing:
      // #define F(x) and #define F (x) differ
      const pre = /^\s*#/.test(line) || (j > 0 && /\\\s*$/.test(lines[j - 1]));
      if (!pre && !joinsBefore && !joinsAfter) line = squeeze(line);
      else if (!pre) {
        // keep the spaces at the ${} side as they are, squeeze the rest
        const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(line);
        line = (joinsBefore ? m[1] : '') + squeeze(m[2]) + (joinsAfter ? m[3] : '');
      }
      if (line === '' && !joinsBefore && !joinsAfter && j !== 0 && j !== L) continue;
      kept.push(line);
    }
    // a quasi's first and last line stay lines of their own (the newline
    // before a ${} that begins a #directive matters); empty ones at the very
    // start and end of the literal can go
    if (q === 0) while (kept.length > 1 && kept[0] === '') kept.shift();
    if (q === last) while (kept.length > 1 && kept[kept.length - 1] === '') kept.pop();
    const res = kept.join('\n');
    // check: the same GLSL tokens as the comment-free original, and every
    // preprocessor line still a line of its own, unchanged
    if (tokens(res).join(' ') !== tokens(text).join(' ')) throw new Error('glsl-minify: token mismatch');
    const preIn = text.split('\n').filter((l) => /^\s*#/.test(l)).map((l) => l.trim());
    const preOut = res.split('\n').filter((l) => /^\s*#/.test(l)).map((l) => l.trim());
    if (preIn.join('\n') !== preOut.join('\n')) throw new Error('glsl-minify: preprocessor line changed');
    out.push(res);
  }
  return out;
}

/** Transform one module's code. Returns { code, saved } or null. */
export function tidyGlslInModule(code) {
  if (!code.includes('`')) return null;
  let ast;
  try { ast = parseAst(code); } catch (e) { return null; }
  const edits = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'TemplateLiteral') {
      const cooked = node.quasis.map((x) => x.value.cooked ?? x.value.raw).join(' ');
      if (LOOKS_GLSL.test(cooked)) {
        const raws = node.quasis.map((x) => x.value.raw);
        const res = tidyQuasis(raws);
        if (res) {
          node.quasis.forEach((x, k) => {
            if (res[k] !== x.value.raw) edits.push([x.start, x.end, res[k]]);
          });
        }
      }
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  if (!edits.length) return null;
  edits.sort((a, b) => b[0] - a[0]);
  let out = code;
  let saved = 0;
  for (const [s, e, text] of edits) {
    // a quasi's start/end span its raw text only (between ` or } and ` or ${)
    if (out.slice(s, e) === undefined) continue;
    saved += (e - s) - text.length;
    out = out.slice(0, s) + text + out.slice(e);
  }
  return { code: out, saved };
}

/** Vite plugin: build only, project sources only. */
export default function glslMinify() {
  let total = 0;
  return {
    name: 'glsl-minify',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/src\/.*\.js$/.test(id) || id.includes('node_modules')) return null;
      const r = tidyGlslInModule(code);
      if (!r) return null;
      total += r.saved;
      return { code: r.code, map: null };
    },
    buildEnd() {
      if (total) this.info(`glsl-minify: ${total} bytes of GLSL comments and indentation removed`);
    },
  };
}
