/**
 * Tests del motor de condiciones (sin Prisma).
 * Ejecutar: node --test test/approval-routing-eval.test.js
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  findFirstMatchingRule,
  buildAllowedRuleFieldKeys,
} = require("../src/services/approval-routing-eval.service");

test("always rule matches after failed eq", () => {
  const allowed = new Set(["vendor_name", "__confidence"]);
  const rules = [
    { id: "r1", conditionJson: { op: "eq", field: "vendor_name", value: "X" }, assigneeUserId: "u1" },
    { id: "r2", conditionJson: { op: "always" }, assigneeUserId: "u2" },
  ];
  const m = findFirstMatchingRule(rules, { vendor_name: "Y" }, null, allowed);
  assert.equal(m.assigneeUserId, "u2");
});

test("first matching ordered rule wins", () => {
  const allowed = new Set(["vendor_name", "__confidence"]);
  const rules = [
    { id: "a", conditionJson: { op: "contains_ci", field: "vendor_name", value: "acme" }, assigneeUserId: "alice" },
    { id: "b", conditionJson: { op: "always" }, assigneeUserId: "bob" },
  ];
  const m = findFirstMatchingRule(rules, { vendor_name: "ACME SA" }, 0.5, allowed);
  assert.equal(m.assigneeUserId, "alice");
});

test("in operator", () => {
  const allowed = new Set(["vendor_name", "__confidence"]);
  const rules = [
    { id: "x", conditionJson: { op: "in", field: "vendor_name", values: ["a", "b"] }, assigneeUserId: "u" },
  ];
  const m = findFirstMatchingRule(rules, { vendor_name: "B" }, null, allowed);
  assert.equal(m.assigneeUserId, "u");
});

test("__confidence gte", () => {
  const allowed = new Set(["__confidence"]);
  const rules = [
    { id: "c", conditionJson: { op: "gte", field: "__confidence", value: 0.9 }, assigneeUserId: "hi" },
  ];
  const m1 = findFirstMatchingRule(rules, {}, 0.95, allowed);
  assert.equal(m1.assigneeUserId, "hi");
  const m2 = findFirstMatchingRule(rules, {}, 0.2, allowed);
  assert.equal(m2, null);
});

test("buildAllowedRuleFieldKeys includes invoice fallbacks when schema empty", () => {
  const keys = buildAllowedRuleFieldKeys(null);
  assert.ok(keys.has("vendor_name"));
  assert.ok(keys.has("__confidence"));
});
