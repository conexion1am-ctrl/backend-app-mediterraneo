// Lógica compartida para borrar TODO lo que depende de un proyecto (fotos de avance, planos 3D,
// mensajes del chat y sus archivos adjuntos, equipo asignado, estadísticas, abonos registrados,
// actividades/checklist por área, y cotizaciones que apuntaban a él). Se usa tanto al eliminar
// un Cliente como al eliminar un Contrato, ya que en
// ambos casos el proyecto completo debe desaparecer. Antes esta lógica estaba duplicada (copiada
// y pegada) en clientes.js y cotizaciones_v2.js, con el riesgo de que quedaran desincronizadas
// entre sí — como pasó, causando el bug de "No se pudo eliminar el contrato".
//
// IMPORTANTE sobre el orden: esta función NO borra el proyecto en sí ni el contrato/cliente que
// lo originó — eso lo hace quien la llama, DESPUÉS de invocar esta función, ya que el orden
// correcto es: 1) vaciar todo lo que cuelga del proyecto, 2) borrar el proyecto, 3) borrar quien
// lo originó (cliente o contrato+cotización). Recibe `client` (una conexión de pg ya dentro de
// una transacción BEGIN) y `proyectoId`, y devuelve un arreglo con las URLs de Storage que hay
// que borrar después del COMMIT (fotos, planos .glb, adjuntos de chat).
async function borrarDependenciasDeProyecto(client, proyectoId) {
  const urlsABorrar = [];

  const fotos = await client.query('SELECT foto_url FROM fotos_avance WHERE proyecto_id = $1', [proyectoId]);
  fotos.rows.forEach((f) => f.foto_url && urlsABorrar.push(f.foto_url));

  const planos = await client.query('SELECT url_glb FROM planos_3d WHERE proyecto_id = $1', [proyectoId]);
  planos.rows.forEach((p) => p.url_glb && urlsABorrar.push(p.url_glb));

  const mensajesDelProyecto = await client.query('SELECT id FROM mensajes WHERE proyecto_id = $1', [proyectoId]);
  const idsMensajes = mensajesDelProyecto.rows.map((m) => m.id);
  if (idsMensajes.length > 0) {
    const archivosChat = await client.query('SELECT url_archivo FROM archivos WHERE mensaje_id = ANY($1::int[])', [idsMensajes]);
    archivosChat.rows.forEach((a) => a.url_archivo && urlsABorrar.push(a.url_archivo));
    await client.query('DELETE FROM archivos WHERE mensaje_id = ANY($1::int[])', [idsMensajes]);
  }

  await client.query('DELETE FROM mensajes WHERE proyecto_id = $1', [proyectoId]);
  await client.query('DELETE FROM fotos_avance WHERE proyecto_id = $1', [proyectoId]);
  await client.query('DELETE FROM planos_3d WHERE proyecto_id = $1', [proyectoId]);
  await client.query('DELETE FROM proyecto_equipo WHERE proyecto_id = $1', [proyectoId]);
  await client.query('DELETE FROM estadisticas_proyecto WHERE proyecto_id = $1', [proyectoId]);
  // Abonos registrados en la pestaña de Estadísticas del proyecto, y las actividades/checklist
  // por área (proyecto_actividades) — ambas tablas también cuelgan de proyecto_id y deben
  // limpiarse antes de poder borrar el proyecto.
  await client.query('DELETE FROM abonos_proyecto WHERE proyecto_id = $1', [proyectoId]);
  await client.query('DELETE FROM proyecto_actividades WHERE proyecto_id = $1', [proyectoId]);

  // Cualquier cotización que apunte a este proyecto (aceptada o no) se desvincula en vez de
  // borrarse, para que siga viéndose en la pantalla de Cotizaciones si corresponde.
  await client.query('UPDATE cotizaciones SET proyecto_id = NULL WHERE proyecto_id = $1', [proyectoId]);

  return urlsABorrar;
}

// Lógica hermana de borrarDependenciasDeProyecto, pero para UNA sola área dentro de un proyecto
// (ej. "Carpintería" de un proyecto puntual), en vez de todo el proyecto completo. Se usa cuando
// gerencia elimina una actividad/área de un proyecto (DELETE /:id/actividades/:area_id en
// proyectos_v2.js), sin importar cuánta gente esté asignada ahí. A propósito NO toca
// estadisticas_proyecto, abonos_proyecto ni cotizaciones: esas tablas son por proyecto completo
// (ligadas a la pestaña "Estadísticas"), no a un área específica, y deben sobrevivir intactas.
// Mismo contrato que la función hermana: recibe `client` ya dentro de una transacción BEGIN, y
// devuelve las URLs de Storage a borrar después del COMMIT.
async function borrarDependenciasDeArea(client, proyectoId, areaId) {
  const urlsABorrar = [];

  const fotos = await client.query('SELECT foto_url FROM fotos_avance WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);
  fotos.rows.forEach((f) => f.foto_url && urlsABorrar.push(f.foto_url));

  const planos = await client.query('SELECT url_glb FROM planos_3d WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);
  planos.rows.forEach((p) => p.url_glb && urlsABorrar.push(p.url_glb));

  const mensajesDelArea = await client.query('SELECT id FROM mensajes WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);
  const idsMensajes = mensajesDelArea.rows.map((m) => m.id);
  if (idsMensajes.length > 0) {
    const archivosChat = await client.query('SELECT url_archivo FROM archivos WHERE mensaje_id = ANY($1::int[])', [idsMensajes]);
    archivosChat.rows.forEach((a) => a.url_archivo && urlsABorrar.push(a.url_archivo));
    await client.query('DELETE FROM archivos WHERE mensaje_id = ANY($1::int[])', [idsMensajes]);
  }

  await client.query('DELETE FROM mensajes WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);
  await client.query('DELETE FROM fotos_avance WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);
  await client.query('DELETE FROM planos_3d WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);
  // Toda persona asignada a esta área en este proyecto (vinculada o pendiente) queda desasignada
  // de ESTE proyecto — su cuenta y su vínculo con la empresa no se tocan, solo esta asignación.
  await client.query('DELETE FROM proyecto_equipo WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);
  await client.query('DELETE FROM proyecto_actividades WHERE proyecto_id = $1 AND area_id = $2', [proyectoId, areaId]);

  return urlsABorrar;
}

// Termina de "armar" un proyecto recién creado (2026-08-24, rediseño de Actividades/Equipo):
// crea automáticamente las 3 actividades base (GERENCIA, AREA ADMINISTRATIVA, AREA DE LOGISTICA
// — sin importar cuáles otras actividades haya elegido manualmente quien lo creó) y auto-asigna
// personal en proyecto_equipo: TODOS los gerentes activos de la empresa a la ficha GERENCIA, y
// quien creó el proyecto a la ficha de SU PROPIA área (solo si esa área es GERENCIA o
// AREA ADMINISTRATIVA — si el proyecto lo crea el sistema sin un usuario real detrás, como al
// recrear desde un contrato sin usuario_id, simplemente no hay nadie que auto-asignar ahí).
// Recibe `client` ya dentro de una transacción BEGIN (misma conexión que insertó el proyecto).
async function configurarProyectoNuevo(client, proyectoId, empresaId, creadoPorUsuarioId) {
  const areasBase = await client.query(
    `SELECT id, nombre FROM areas_catalogo WHERE nombre IN ('GERENCIA', 'AREA ADMINISTRATIVA', 'AREA DE LOGISTICA')`
  );
  const idPorNombre = {};
  areasBase.rows.forEach((a) => { idPorNombre[a.nombre] = a.id; });

  // Actividades base: INSERT ... WHERE NOT EXISTS en vez de un SELECT previo + INSERT, para que
  // sea seguro aunque en el futuro se llame esta función más de una vez sobre el mismo proyecto.
  for (const areaId of Object.values(idPorNombre)) {
    await client.query(
      `INSERT INTO proyecto_actividades (proyecto_id, area_id)
       SELECT $1, $2 WHERE NOT EXISTS (
         SELECT 1 FROM proyecto_actividades WHERE proyecto_id = $1 AND area_id = $2
       )`,
      [proyectoId, areaId]
    );
  }

  // Todos los gerentes activos de la empresa, auto-asignados a la ficha GERENCIA de este proyecto.
  if (idPorNombre['GERENCIA']) {
    const gerentes = await client.query(
      `SELECT uer.usuario_id
       FROM usuario_empresa_rol uer
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.empresa_id = $1 AND a.nombre = 'GERENCIA' AND uer.estado = 'activo'`,
      [empresaId]
    );
    for (const gerente of gerentes.rows) {
      await client.query(
        `INSERT INTO proyecto_equipo (proyecto_id, usuario_id, area_id)
         SELECT $1, $2, $3 WHERE NOT EXISTS (
           SELECT 1 FROM proyecto_equipo WHERE proyecto_id = $1 AND usuario_id = $2
         )`,
        [proyectoId, gerente.usuario_id, idPorNombre['GERENCIA']]
      );
    }
  }

  // Quien creó el proyecto, auto-asignado a la ficha de su propia área — solo si esa área es
  // GERENCIA (ya cubierto arriba si es gerente, este INSERT queda protegido por el mismo
  // NOT EXISTS y no duplica) o AREA ADMINISTRATIVA.
  if (creadoPorUsuarioId && empresaId) {
    const areaCreador = await client.query(
      `SELECT a.id, a.nombre
       FROM usuario_empresa_rol uer
       JOIN areas_catalogo a ON a.id = uer.area_id
       WHERE uer.usuario_id = $1 AND uer.empresa_id = $2 AND uer.estado = 'activo'`,
      [creadoPorUsuarioId, empresaId]
    );
    const area = areaCreador.rows[0];
    if (area && (area.nombre === 'GERENCIA' || area.nombre === 'AREA ADMINISTRATIVA')) {
      await client.query(
        `INSERT INTO proyecto_equipo (proyecto_id, usuario_id, area_id)
         SELECT $1, $2, $3 WHERE NOT EXISTS (
           SELECT 1 FROM proyecto_equipo WHERE proyecto_id = $1 AND usuario_id = $2
         )`,
        [proyectoId, creadoPorUsuarioId, area.id]
      );
    }
  }
}

module.exports = { borrarDependenciasDeProyecto, borrarDependenciasDeArea, configurarProyectoNuevo };
