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

module.exports = { borrarDependenciasDeProyecto };
