# Roadmap: flujos de aprobación condicionales (fase 2)

Este documento resume el diseño previsto para **asignación de aprobadores y notificaciones antes de Business Central**, sin implementación en código aún.

## Objetivo

Tras la extracción y antes de enviar a BC, permitir **reglas por tipo de documento** que enruten la aprobación según condiciones sobre campos extraídos o metadatos (ej.: proveedor, importe umbral, categoría).

## Componentes previstos

1. **Modelo de reglas** (`workspaceId` + `documentTypeId`): lista ordenada de reglas con `conditionJson` (operadores: igualdad, comparación numérica, `in`, coincidencia de texto controlada) y `assigneeUserId` (o secuencia de aprobadores).
2. **Motor de evaluación**: al entrar el documento en estado de aprobación humana (`NEEDS_APPROVAL` o equivalente), evaluar reglas en orden; la primera que coincida define el responsable (o cadena).
3. **Persistencia de tarea de aprobación**: extender o complementar [`ApprovalRequest`](prisma/schema.prisma) con asignación explícita (`assigneeUserId`) y estado de cola si hay varios pasos.
4. **Notificaciones**: correo vía Microsoft Graph (infra existente) y/o bandeja in-app; workers si el volumen lo requiere.
5. **UI**: editor de reglas por tipo de documento (similar en complejidad al “studio” de mapeos), reutilizando la lista de **miembros e invitados** como candidatos a asignar.

## Relación con invitaciones (fase 1)

Los usuarios dados de alta por **invitación al workspace** son candidatos válidos como `assigneeUserId` en las reglas de la fase 2.

## Riesgos

- Evitar expresiones arbitrarias en `conditionJson` (no ejecutar código); limitar operadores y rutas de campos conocidas del esquema de extracción.
- Coherencia con RBAC: solo quienes con `documents:manage` (o permiso dedicado) deberían poder aprobar según política del producto.
