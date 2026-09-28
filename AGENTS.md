# Desarrollo del fork para Essentials

- Preferencia explícita de Leandro (2026-09-28): mejorar este MCP de forma incremental mientras se trabaja en su juego. Si una tarea revela una limitación, un error o una operación repetida que pueda generalizarse, corregirla o añadir una herramienta aquí, además de completar la edición del juego.
- Evitar construir un MCP nuevo desde cero o repetir scripts desechables cuando una mejora pequeña y reutilizable en este fork resuelva la necesidad.
- Mantener compatibilidad con RPG Maker XP estándar y Pokémon Essentials. No publicar datos, gráficos ni scripts del juego como fixtures del repositorio.
- Este fork es público. Guardar aquí las instrucciones y documentación generales del MCP; los documentos y contenidos particulares del juego pertenecen a su repositorio privado. No copiar informes locales con rutas personales o datos del proyecto sin preparar una versión general.
- Añadir regresiones para errores de serialización y probar mutaciones en proyectos de prueba. Las comprobaciones sobre el proyecto real deben ser de lectura o contar con el alcance de edición autorizado.
- Compilar con `npm run build` tras cambiar TypeScript. Pruebas relevantes: `node test/essentials-strings.mjs`, `node test/tools.mjs` y `node test/essentials-mcp.mjs <ruta-del-proyecto>` (esta última solo lee el proyecto).
- Para cambios en rutas, escrituras, validación, serialización o previsualizaciones, ejecutar también `node test/security-audit.mjs <carpeta-temporal-existente>` y `node test/security-files.mjs <carpeta-temporal-existente>`. Respetar los límites documentados en `SECURITY.md`; no desactivarlos para resolver una edición puntual.
- La conexión activa puede seguir usando el proceso anterior hasta reiniciarse; no afirmar que una herramienta nueva está disponible sin comprobarlo.
