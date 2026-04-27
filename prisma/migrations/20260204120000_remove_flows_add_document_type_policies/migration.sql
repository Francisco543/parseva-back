-- Tablas de flujos BPMN legacy (ya fuera del schema Prisma). Idempotente en bases nuevas.
DROP TABLE IF EXISTS "FlowTransitionLog";
DROP TABLE IF EXISTS "FlowTask";
DROP TABLE IF EXISTS "FlowRun";
DROP TABLE IF EXISTS "FlowEdge";
DROP TABLE IF EXISTS "FlowNode";
DROP TABLE IF EXISTS "FlowDefinition";
DROP TABLE IF EXISTS "FlowStep";
DROP TABLE IF EXISTS "Flow";
