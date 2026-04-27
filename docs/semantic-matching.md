# Matching semántico (embeddings + pgvector)

## Resumen

Tras cada extracción, el backend puede generar un embedding del **texto canónico** del documento (metadatos + `extractionJson` sin el bloque `classification`) y guardarlo en PostgreSQL con la extensión **pgvector**. El matching automático combina:

- **Score estructural** (órdenes de compra, CUIT, importes, etc.).
- **Similitud coseno** frente a vecinos cercanos en el espacio de embeddings.

La política por tipo de documento vive en `DocumentType.matchingPolicy.semanticMatch` (ver validación en `src/services/document-type-policies.js`).

## Requisitos de infraestructura

1. PostgreSQL con extensión `vector` habilitada.

   - Ejemplo: `CREATE EXTENSION IF NOT EXISTS vector;` (ya incluido en la migración).
   - En Azure Database for PostgreSQL, habilitar la extensión según la documentación de Microsoft (`azure.extensions` / allow-list).

2. Ejecutar migraciones después de actualizar el repo:

   ```bash
   cd invoicely-back
   npx prisma migrate deploy
   ```

   En desarrollo, si usás `db push`, asegurate de que la tabla `DocumentEmbedding` y el índice HNSW existan; la migración canónica está en `prisma/migrations/20260402120000_add_document_embedding_pgvector/`.

3. Dimensión del vector: la columna es **`vector(1536)`**, alineada con `text-embedding-3-small` por defecto. Si cambiás a un modelo con otra dimensión, hay que **ajustar el schema Prisma, la migración SQL y** `SCHEMA_VECTOR_DIMS` en `src/services/document-embedding.service.js`.

## Variables de entorno

| Variable | Descripción | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | Necesaria para llamadas a embeddings | (vacío) |
| `OPENAI_EMBEDDING_MODEL` | Modelo de embeddings | `text-embedding-3-small` |
| `OPENAI_EMBEDDING_DIMS` | Debe ser `1536` con el schema actual | `1536` |
| `EMBEDDING_MAX_CHARS` | Tope de caracteres del texto canónico | `8000` |

Si `OPENAI_EMBEDDING_DIMS !== 1536`, el servicio **no escribe** embeddings (evita corrupción respecto al tipo `vector(1536)`).

## Formato de política JSON (`matchingPolicy`)

Ejemplo mínimo:

```json
{
  "enabled": true,
  "relatedDocumentTypeKeys": ["delivery_note"],
  "relationCardinality": "ONE_TO_MANY",
  "autoMatchAfterIngest": true,
  "minLinkScore": 0.35,
  "semanticMatch": {
    "enabled": true,
    "semanticWeight": 0.3,
    "semanticMinSimilarity": 0.72,
    "neighborLimit": 30
  }
}
```

- **semanticWeight**: peso \(w\) en la fusión `finalScore = (1-w)*structural + w*semantic`.
- **semanticMinSimilarity**: sólo entran vecinos KNN con similitud ≥ este valor (similitud ≈ `1 - distancia_coseno` de pgvector).
- **neighborLimit**: tamaño del top-K en la búsqueda por índice HNSW.

## Evidencia en vínculos (`DocumentLink.evidenceJson`)

Los enlaces automáticos pueden incluir:

- `structuralScore`, `semanticSimilarity`, `semanticUsed`, `semanticWeight`
- Los campos estructurales previos (`purchase_order`, `vendor_tax_id`, …)

## Privacidad y coste

- El texto enviado al proveedor de embeddings es el **canónico interno** (sin loguear contenido completo en logger de aplicación).
- Cada cambio relevante en la extracción invalida el hash (`contentHash`) y puede disparar **re-embedding**.
- Activar `semanticMatch.enabled` en un tipo implica llamadas a la API de embeddings al ingerir documentos de ese tipo (además del matching si está encendido).

## Degradación

- Sin extensión `vector`, sin API key, o error de escritura: el pipeline sigue con matching **solo estructural** y eventos en log (`semantic_unavailable`, `document_embedding.*`).
