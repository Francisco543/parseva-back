# PostgreSQL con pgvector (Docker)

Imagen oficial recomendada: [pgvector/pgvector](https://github.com/pgvector/pgvector) sobre PostgreSQL 16, alineada con el esquema Prisma y las migraciones de Invoicely.

## Requisitos

- Docker Desktop (Windows/macOS) o Docker Engine + Compose v2.

## Configuración

1. **Puerto**: en Windows suele haber otro `postgres.exe` nativo. Usá un puerto **solo para Docker** (p. ej. `5435`) en `POSTGRES_PUBLISH_PORT` y el mismo en `DATABASE_URL`. Si `5433` u otro puerto ya lo usa el servicio de Windows, las credenciales de Prisma fallan aunque el contenedor esté bien.

2. **Credenciales**: añadí a `invoicely-back/.env` las variables del archivo `docker/env.example`. `DATABASE_URL` debe usar el mismo usuario, contraseña, host, puerto y nombre de base.

3. **Levantar**:

   ```bash
   cd invoicely-back
   docker compose up -d
   ```

4. **Esperar salud del contenedor** (opcional):

   ```bash
   docker compose ps
   ```

5. **Migraciones**:

   ```bash
   npx prisma migrate deploy
   ```

En el **primer arranque**, el script `docker/postgres/init/01-enable-vector.sql` ejecuta `CREATE EXTENSION vector`. La migración Prisma también lo declara; repetir la sentencia es idempotente.

## Datos

El volumen nombrado `invoicely_pgdata` persiste los datos. Para empezar de cero:

```bash
docker compose down -v
docker compose up -d
npx prisma migrate deploy
```

**Atención**: `-v` borra la base dentro del volumen.

### Error P3018 / "relation does not exist" al hacer `migrate deploy`

Suele pasar tras un deploy a medio aplicar. En desarrollo, lo más simple:

```bash
docker compose down -v
docker compose up -d
npx prisma migrate deploy
```

La primera migración (`20250101120000_init_schema`) crea el esquema completo. Si tu base **ya existía** solo con `prisma db push` y tenés todas las tablas, consultá el comentario al inicio de esa migración o la documentación de Prisma para marcarla como aplicada sin ejecutarla (`migrate resolve`).

## Kafka

El stack de mensajería sigue en `docker-compose.kafka.yml`. Para levantar ambos:

```bash
docker compose -f docker-compose.yml -f docker-compose.kafka.yml up -d
```
