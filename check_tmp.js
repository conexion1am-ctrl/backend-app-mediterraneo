require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const areas = await pool.query("SELECT id, nombre FROM areas_catalogo WHERE nombre = 'AREA DE CLIENTES'");
    console.log('Area de Clientes:', areas.rows);
    if (areas.rows.length) {
      const areaId = areas.rows[0].id;
      const usados = await pool.query('SELECT id, nombre_invitado, celular_invitado, empresa_id, usado FROM invitaciones WHERE area_id = $1', [areaId]);
      console.log('Invitaciones a esa area:', usados.rows);
      const roles = await pool.query('SELECT ur.usuario_id, u.nombre FROM usuario_empresa_rol ur JOIN usuarios u ON u.id = ur.usuario_id WHERE ur.area_id = $1', [areaId]).catch(e => ({rows: [], err: e.message}));
      console.log('Usuarios vinculados a esa area:', roles.rows, roles.err || '');
    }
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await pool.end();
  }
})();
