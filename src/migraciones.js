const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Cambios de esquema que se aplican automáticamente cada vez que el servidor arranca en Render.
// Usamos "ADD COLUMN IF NOT EXISTS" para que sea seguro correrlo una y otra vez sin duplicar
// columnas ni romper nada si ya existen. Este es el mismo patrón que se viene usando para agregar
// columnas nuevas a la base de datos real (nit, cedula_representante, cliente_nombre_snapshot,
// etc.), pero ahora automatizado en vez de correrlo a mano en la consola de Railway.
//
// Estas columnas nuevas son la base del "blindaje" pedido: el proyecto y el contrato deben poder
// existir de forma independiente, cada uno guardando su propia copia de los datos que necesita
// para no romperse si se borra la cotización o el cliente que los originó.
async function aplicarMigraciones() {
  try {
    console.log('🔧 Verificando esquema de base de datos (migraciones automáticas)...');

    // contratos: ya no depende de que el proyecto exista en el momento de aceptar la cotización.
    // Guarda un snapshot mínimo (nombre, dirección, m2) para poder crear o recrear el proyecto
    // más adelante con el botón "Crear Proyecto", incluso si el cliente original fue borrado.
    await pool.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS proyecto_nombre_snapshot VARCHAR(255)`);
    await pool.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS proyecto_direccion_snapshot TEXT`);
    await pool.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS proyecto_mts2_snapshot DECIMAL(10, 2)`);

    // proyectos: al crearse (ya sea automático desde una cotización aceptada o manualmente con
    // "Crear Proyecto"), guarda su propia copia blindada del nombre/cédula/celular del cliente,
    // para que sobreviva intacta aunque el cliente original se elimine de la pantalla de Clientes.
    await pool.query(`ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS cliente_nombre_snapshot VARCHAR(255)`);
    await pool.query(`ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS cliente_celular_snapshot VARCHAR(50)`);
    await pool.query(`ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS cliente_cedula_snapshot VARCHAR(50)`);

    // movimientos_costos: registro día a día de cada compra/pago (materiales, mano de obra,
    // imprevistos) con su detalle y valor, para llevar un historial en vez de solo un total
    // editable a mano. Los totales de estadisticas_proyecto se recalculan sumando estos
    // movimientos cada vez que se agrega uno nuevo.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS movimientos_costos (
        id SERIAL PRIMARY KEY,
        proyecto_id INT NOT NULL,
        tipo VARCHAR(20) NOT NULL,
        detalle TEXT,
        valor DECIMAL(12, 2) NOT NULL,
        fecha DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_movimientos_costos_proyecto ON movimientos_costos(proyecto_id)`);

    // proyecto_equipo: hasta ahora solo se podía asignar a alguien que YA hubiera aceptado su
    // invitación (usuario_id NOT NULL, con usuario real creado). Esto impedía ver/asignar a
    // personal invitado que todavía no acepta el link. Ahora usuario_id puede quedar en NULL
    // mientras la persona esté pendiente, y invitacion_id guarda a cuál invitación corresponde
    // esa asignación "provisional". Cuando la persona acepta la invitación, invitaciones.js migra
    // automáticamente estas filas de invitacion_id a usuario_id real (ver POST /aceptar/:token).
    await pool.query(`ALTER TABLE proyecto_equipo ALTER COLUMN usuario_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE proyecto_equipo ADD COLUMN IF NOT EXISTS invitacion_id INT REFERENCES invitaciones(id)`);
    // Evita asignar dos veces a la misma persona pendiente en el mismo proyecto+área.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'proyecto_equipo_invitacion_unica'
        ) THEN
          ALTER TABLE proyecto_equipo
            ADD CONSTRAINT proyecto_equipo_invitacion_unica UNIQUE (proyecto_id, invitacion_id, area_id);
        END IF;
      END $$;
    `);

    // categorias_costo: rubros reutilizables (ej. "Carpintería", "Ferretería", "Estuco") que el
    // usuario crea una vez por empresa y luego usa para etiquetar cada movimiento de costo
    // (materiales, mano de obra o imprevistos), sin importar en qué proyecto esté. Así puede ver
    // después cuánto costó REALMENTE un rubro completo, sumando sus materiales + mano de obra +
    // imprevistos, en vez de solo el total genérico por tipo.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categorias_costo (
        id SERIAL PRIMARY KEY,
        empresa_id INT NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_categorias_costo_empresa ON categorias_costo(empresa_id)`);
    // Evita crear la misma categoría dos veces (por nombre) dentro de la misma empresa.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'categorias_costo_empresa_nombre_unica'
        ) THEN
          ALTER TABLE categorias_costo
            ADD CONSTRAINT categorias_costo_empresa_nombre_unica UNIQUE (empresa_id, nombre);
        END IF;
      END $$;
    `);

    // categoria_id en movimientos_costos: NULLABLE a propósito, para no romper los movimientos
    // que ya existían antes de esta función (quedan "sin categoría", agrupados aparte). ON
    // DELETE SET NULL: si se borra una categoría, los movimientos que la usaban no se pierden,
    // simplemente quedan sin categoría otra vez.
    await pool.query(`ALTER TABLE movimientos_costos ADD COLUMN IF NOT EXISTS categoria_id INT REFERENCES categorias_costo(id) ON DELETE SET NULL`);

    console.log('✅ Esquema verificado/actualizado correctamente');
  } catch (error) {
    // No tumbamos el servidor si esto falla: preferimos que la app siga funcionando con el
    // esquema anterior a que un problema de migración deje todo caído (mismo criterio que
    // firebaseAdmin.js).
    console.error('❌ Error aplicando migraciones automáticas:', error.message);
  }
}

module.exports = aplicarMigraciones;
