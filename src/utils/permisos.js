const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Espejo (en el backend) de los permisos definidos en el frontend (app/utils/roles.js).
// Se usa para validar en el servidor las acciones sensibles que no deben poder saltarse
// aunque alguien manipule la app directamente (editar/eliminar Gerencia, eliminar clientes).
const PERMISOS_POR_AREA = {
  GERENCIA: { eliminarClientes: true },
  'AREA ADMINISTRATIVA': { eliminarClientes: true },
  'AREA DE LOGISTICA': { eliminarClientes: false },
  'AREA COMERCIAL': { eliminarClientes: false },
};

// Devuelve el nombre del área de un usuario dentro de una empresa (o null si no pertenece).
async function areaDeUsuarioEnEmpresa(usuario_id, empresa_id) {
  const result = await pool.query(
    `SELECT a.nombre AS area_nombre
     FROM usuario_empresa_rol uer
     JOIN areas_catalogo a ON a.id = uer.area_id
     WHERE uer.usuario_id = $1 AND uer.empresa_id = $2 AND uer.estado = 'activo'`,
    [usuario_id, empresa_id]
  );
  return result.rows.length > 0 ? result.rows[0].area_nombre : null;
}

// true si el usuario tiene, en esa empresa, rol de GERENCIA.
async function esGerencia(usuario_id, empresa_id) {
  const area = await areaDeUsuarioEnEmpresa(usuario_id, empresa_id);
  return area === 'GERENCIA';
}

// true si el usuario tiene, en esa empresa, rol de GERENCIA o AREA ADMINISTRATIVA.
// (2026-08-28, a pedido del usuario): antes solo Gerencia podía eliminar proyectos (ver
// esGerencia arriba); Administrativa pidió la misma facultad. Función aparte para no tocar el
// sentido estricto de esGerencia, que otros endpoints siguen usando tal cual.
async function puedeEliminarProyectos(usuario_id, empresa_id) {
  const area = await areaDeUsuarioEnEmpresa(usuario_id, empresa_id);
  return area === 'GERENCIA' || area === 'AREA ADMINISTRATIVA';
}

// true si el área (por nombre) tiene permiso para eliminar clientes.
function puedeEliminarClientes(area_nombre) {
  return !!PERMISOS_POR_AREA[area_nombre]?.eliminarClientes;
}

module.exports = { areaDeUsuarioEnEmpresa, esGerencia, puedeEliminarClientes, puedeEliminarProyectos };
