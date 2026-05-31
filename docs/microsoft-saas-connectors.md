# Conectores Microsoft SaaS

Parseva separa el login de usuarios de los conectores app-only. El usuario entra con la app de login, pero el admin del tenant concede permisos a los conectores desde la pantalla Integraciones.

## Apps Entra

### Invoicely

Uso: login de usuarios.

Permisos recomendados:

- Delegated: `User.Read`.
- Scopes OIDC: `openid`, `profile`, `email`, `offline_access`.
- No agregar permisos application de Graph o Business Central a esta app.

Variables:

- `MSAL_CLIENT_ID`
- `MSAL_CLIENT_SECRET`
- `MSAL_TENANT_ID`
- `MSAL_REDIRECT_URI`

### Invoicely Graph

Uso: Microsoft 365 app-only para correo, webhooks y SharePoint.

Permisos recomendados:

- Application: `Mail.Read`.
- Application: `Sites.ReadWrite.All`.
- Opcional Application: `User.Read.All` si la UI lista o valida buzones por usuario.

Variables:

- `GRAPH_CLIENT_ID`
- `GRAPH_CLIENT_SECRET`
- `GRAPH_TENANT_ID=common` o el tenant por defecto de desarrollo.
- Redirect URI tipo **Web** en Azure:
  - `<PUBLIC_API_BASE_URL>/integrations/graph/admin-consent/callback`

El producto genera admin consent con:

```txt
https://login.microsoftonline.com/common/adminconsent?client_id=<GRAPH_CLIENT_ID>&redirect_uri=<PUBLIC_API_BASE_URL>/integrations/graph/admin-consent/callback
```

### Parseva BC API

Uso: Business Central app-only para listar entornos, empresas y llamar la extensión AL.

Permisos recomendados:

- Application: `API.ReadWrite.All`.
- Application: `Automation.ReadWrite.All`.
- Application: `AdminCenter.Read.All` si alcanza para listar entornos.
- Application: `AdminCenter.ReadWrite.All` si el tenant exige permisos de escritura para la Admin API.
- Application: `app_access` si Business Central lo requiere para S2S.

Variables:

- `BC_CONNECTOR_CLIENT_ID`
- `BC_CONNECTOR_CLIENT_SECRET`
- Redirect URI tipo **Web** en Azure:
  - `<PUBLIC_API_BASE_URL>/integrations/bc/admin-consent/callback`

El producto genera admin consent con:

```txt
https://login.microsoftonline.com/common/adminconsent?client_id=<BC_CONNECTOR_CLIENT_ID>&redirect_uri=<PUBLIC_API_BASE_URL>/integrations/bc/admin-consent/callback
```

## Business Central

Además del admin consent de Azure, el admin debe habilitar la app en Business Central:

1. Instalar `Parseva_App` versión `1.0.0.12` o superior.
2. Ir a **Business Central Admin Center** > **Microsoft Entra Apps** y autorizar el client id para usar la Admin Center API.
3. Registrar el `BC_CONNECTOR_CLIENT_ID`.
4. En un entorno BC, ir a **Microsoft Entra Applications** y asignar permission sets necesarios, incluyendo `Parseva API`.

## Flujo en Integraciones

1. El admin entra con la app `Invoicely`.
2. En **Microsoft 365**, pulsa **Conectar Microsoft 365** y concede admin consent.
3. Parseva guarda `tenantId`, `consentStatus`, `consentGrantedAt` y verifica token Graph.
4. En **Business Central**, pulsa **Conectar BC** y concede admin consent.
5. Parseva toma el tenant desde el admin consent e intenta listar entornos por
   Admin API. Si Admin Center no permite esa llamada, el admin puede escribir el
   entorno manualmente.
6. Parseva lista empresas por API v2.0 y verifica `/targets` de la extensión.

Estados esperados:

- `Pendiente`: falta consentimiento o selección.
- `Conectado`: token app-only responde.
- `Acción requerida`: falta permiso, extensión o permission set.
- `Listo`: el conector puede operar.

## Errores frecuentes

### `AADSTS500113: No reply address is registered for the application`

La app Entra usada para el conector no tiene registrada la URL de callback que
Parseva envía en `redirect_uri`.

Solución:

1. Abrir la app correspondiente en Azure:
   - `Invoicely Graph` para **Conectar Microsoft 365**.
   - `Parseva BC API` para **Conectar BC**.
2. Ir a **Authentication**.
3. Agregar plataforma **Web**.
4. Registrar exactamente la URL generada por Parseva:

```txt
<PUBLIC_API_BASE_URL>/integrations/graph/admin-consent/callback
<PUBLIC_API_BASE_URL>/integrations/bc/admin-consent/callback
```

En desarrollo con ngrok, `PUBLIC_API_BASE_URL` cambia cuando cambia el túnel;
también hay que actualizar las Redirect URIs en Azure.

### `Business Central respondió con HTTP 401` al listar entornos

El token OAuth se obtuvo, pero la Admin Center API rechazó la app. Esto suele
pasar cuando solo se concedieron permisos en Azure, pero no se autorizó la app en
el Admin Center de Business Central.

Esto no bloquea el flujo principal si ya conocés el entorno: el tenant ya queda
guardado por el consentimiento admin; escribí el nombre del entorno manualmente
(`Production`, `Sandbox`, `Parseva`, etc.) y Parseva seguirá listando empresas
mediante la API estándar del entorno y validando la extensión AL.

La extensión AL no puede listar todos los entornos del tenant antes de elegir un
entorno, porque para llamarla ya hace falta una URL con entorno y empresa. Sí
puede validar que la conexión al entorno elegido funciona.

Checklist:

1. Azure > `Parseva BC API` > API permissions:
   - `AdminCenter.ReadWrite.All` como **Application**.
   - `API.ReadWrite.All` como **Application**.
   - `Automation.ReadWrite.All` como **Application**.
   - Estado **Granted for <tenant>**.
2. Business Central Admin Center > **Microsoft Entra Apps**:
   - Agregar el `BC_CONNECTOR_CLIENT_ID`.
3. Business Central entorno elegido > **Microsoft Entra Applications**:
   - Agregar el mismo client id.
   - Asignar permission sets, incluyendo `Parseva API`.
4. Volver a Parseva y pulsar **Reautorizar BC** / **Verificar**.
