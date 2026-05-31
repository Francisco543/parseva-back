#!/usr/bin/env node
/**
 * Comparación simple esperado vs extraído (golden set local).
 * Uso:
 *   node scripts/eval-extraction.mjs ./fixtures/caso1.expected.json ./fixtures/caso1.actual.json
 */

import fs from "node:fs";

const [, , expectedPath, actualPath] = process.argv;
if (!expectedPath || !actualPath) {
  console.error("Uso: node scripts/eval-extraction.mjs <expected.json> <actual.json>");
  process.exit(1);
}

const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
const actual = JSON.parse(fs.readFileSync(actualPath, "utf8"));

function flatten(obj, prefix = "") {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        Object.assign(out, flatten(v, p));
      } else {
        out[p] = v;
      }
    }
  }
  return out;
}

const fe = flatten(expected);
const fa = flatten(actual);
let ok = 0;
let fail = 0;
for (const k of Object.keys(fe)) {
  const a = fa[k];
  const e = fe[k];
  const match = JSON.stringify(a) === JSON.stringify(e);
  if (match) ok++;
  else {
    fail++;
    console.log(`DIFF ${k}: esperado=${JSON.stringify(e)} actual=${JSON.stringify(a)}`);
  }
}
console.log(JSON.stringify({ ok, fail, totalExpected: Object.keys(fe).length }, null, 2));
process.exit(fail > 0 ? 1 : 0);
