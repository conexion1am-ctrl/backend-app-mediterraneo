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

    // pausado en proyecto_equipo: permite a gerencia "pausar" el acceso de una persona a un
    // proyecto sin desasignarla del todo (a diferencia de eliminar la fila, que borra la
    // asignación por completo). Mientras está pausada, GET /asignaciones/:usuario_id la excluye,
    // así que la persona deja de ver ese proyecto en su lista — es un bloqueo real de acceso, no
    // solo una etiqueta visual. Volver a "despausar" restaura el acceso sin tener que re-asignar
    // desde cero (conserva el historial del chat que ya tenían).
    await pool.query(`ALTER TABLE proyecto_equipo ADD COLUMN IF NOT EXISTS pausado BOOLEAN NOT NULL DEFAULT false`);

    // remitente_nombre_snapshot en mensajes: guarda el nombre de quien envió, como respaldo para
    // cuando esa persona sea eliminada por completo de la plataforma (ver DELETE
    // /api/areas/personal/:usuario_id/total en areas.js). Sin esto, el chat de la OTRA persona en
    // la conversación se rompería: el SELECT de mensajes.js usa JOIN usuarios para mostrar el
    // nombre, y si la fila usuarios desaparece, esos mensajes dejarían de listarse por completo
    // (INNER JOIN los excluye). Con el snapshot, el historial se conserva intacto mostrando el
    // nombre tal como era al momento del borrado, aunque la cuenta ya no exista.
    await pool.query(`ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS remitente_nombre_snapshot VARCHAR(255)`);

    // usuario_id NULLABLE con ON DELETE SET NULL en fotos_avance y planos_3d: si se elimina a
    // alguien de la plataforma por completo, sus fotos de avance y planos 3D de proyectos
    // anteriores se CONSERVAN (son evidencia de obra que la empresa quiere conservar) — solo se
    // pierde la referencia de quién los subió. Buscamos el nombre REAL de la constraint FK
    // existente (Postgres lo autogenera y puede no ser el que asumiríamos por convención) antes
    // de reemplazarla, en vez de adivinar el nombre — así funciona sin importar cómo se llame.
    await pool.query(`ALTER TABLE fotos_avance ALTER COLUMN usuario_id DROP NOT NULL`);
    await pool.query(`
      DO $$
      DECLARE nombre_fk TEXT;
      BEGIN
        SELECT tc.constraint_name INTO nombre_fk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'fotos_avance' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'usuario_id'
        LIMIT 1;

        IF nombre_fk IS NOT NULL THEN
          EXECUTE format('ALTER TABLE fotos_avance DROP CONSTRAINT %I', nombre_fk);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'fotos_avance_usuario_id_set_null'
        ) THEN
          ALTER TABLE fotos_avance ADD CONSTRAINT fotos_avance_usuario_id_set_null
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await pool.query(`ALTER TABLE planos_3d ALTER COLUMN usuario_id DROP NOT NULL`);
    await pool.query(`
      DO $$
      DECLARE nombre_fk TEXT;
      BEGIN
        SELECT tc.constraint_name INTO nombre_fk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'planos_3d' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'usuario_id'
        LIMIT 1;

        IF nombre_fk IS NOT NULL THEN
          EXECUTE format('ALTER TABLE planos_3d DROP CONSTRAINT %I', nombre_fk);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'planos_3d_usuario_id_set_null'
        ) THEN
          ALTER TABLE planos_3d ADD CONSTRAINT planos_3d_usuario_id_set_null
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Mismo criterio de "conservar el contenido, solo desvincular el usuario_id" para mensajes
    // (remitente y destinatario) y archivos adjuntos: necesario para poder eliminar a alguien de
    // la plataforma por completo (DELETE /api/areas/personal/:usuario_id/total en areas.js) sin
    // que el DELETE FROM usuarios falle por constraint de FK. El nombre del remitente se conserva
    // aparte vía remitente_nombre_snapshot (ver arriba), así que perder mensajes.usuario_id no
    // rompe el chat — solo dejaría de poder filtrar/enlazar ese mensaje a una cuenta activa.
    for (const { tabla, columna } of [
      { tabla: 'mensajes', columna: 'usuario_id' },
      { tabla: 'mensajes', columna: 'destinatario_usuario_id' },
      { tabla: 'archivos', columna: 'usuario_id' },
    ]) {
      await pool.query(`ALTER TABLE ${tabla} ALTER COLUMN ${columna} DROP NOT NULL`);
      await pool.query(`
        DO $$
        DECLARE nombre_fk TEXT;
        BEGIN
          SELECT tc.constraint_name INTO nombre_fk
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
          WHERE tc.table_name = '${tabla}' AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = '${columna}'
          LIMIT 1;

          IF nombre_fk IS NOT NULL THEN
            EXECUTE format('ALTER TABLE ${tabla} DROP CONSTRAINT %I', nombre_fk);
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = '${tabla}_${columna}_set_null'
          ) THEN
            ALTER TABLE ${tabla} ADD CONSTRAINT ${tabla}_${columna}_set_null
              FOREIGN KEY (${columna}) REFERENCES usuarios(id) ON DELETE SET NULL;
          END IF;
        END $$;
      `);
    }

    // proyectos.creado_por_usuario_id: quién creó el proyecto (Gerencia o Administrativa, por
    // cualquiera de los 3 caminos de creación: manual, desde un contrato recién aceptado, o al
    // recrear un proyecto eliminado). Antes este dato no se guardaba en ningún lado — se necesita
    // ahora para el rediseño de "Actividades" del proyecto (2026-08-24): al crear un proyecto,
    // quien lo crea queda auto-asignado a la ficha de su propia área (GERENCIA o ADMINISTRATIVA),
    // y por separado se auto-asignan TODOS los gerentes activos de la empresa a la ficha GERENCIA
    // sin importar quién haya creado el proyecto. ON DELETE SET NULL: si esa cuenta se elimina de
    // la plataforma más adelante, el proyecto no debe romperse ni perder su registro histórico.
    await pool.query(`ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS creado_por_usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL`);

    // areas_catalogo: catálogo fijo de áreas (Gerencia, Administrativa, Logística, Comercial,
    // Proveedores, Clientes, y las 10 "subáreas" de oficio: Obra Civil, Electricidad, etc.). Esta
    // tabla NUNCA se vuelve a llenar sola si queda vacía (por ejemplo, tras un vaciado accidental
    // de la base de datos) — a diferencia de otras tablas de este archivo, no tiene ningún dueño
    // que la resiembre. El 2026-08-24 un vaciado completo de la BD la dejó vacía y nadie se dio
    // cuenta hasta que "Crear mi empresa" empezó a fallar siempre (el endpoint busca el area_id
    // de GERENCIA y explota si no existe ninguna fila). Este bloque la resiembra automáticamente
    // en cada arranque SOLO si está vacía (no duplica nada si ya tiene datos), para que este
    // problema nunca vuelva a ocurrir aunque la tabla se vacíe por accidente en el futuro.
    // Nombres tomados textualmente de los documentos de especificación originales del proyecto
    // (Especificacion_App_Mediterraneo.docx) y confirmados con seed-areas.js (el seed original,
    // que sembraba la tabla legada "areas_trabajo" con estos mismos 10 nombres).
    // pg_advisory_lock: evita que dos instancias del servidor arrancando al mismo tiempo (ej. un
    // rolling deploy de Render) vean ambas "la tabla está vacía" y ambas intenten sembrarla a la
    // vez (duplicados, o un INSERT chocando con otro a mitad del loop). El lock es exclusivo a
    // nivel de sesión de Postgres — la segunda instancia simplemente espera a que la primera
    // termine y libere el lock antes de hacer su propio SELECT COUNT(*), que para ese momento ya
    // no será 0. Se usa un client dedicado (no el pool genérico) porque el lock/unlock debe
    // ejecutarse sobre la MISMA conexión.
    const clienteLock = await pool.connect();
    try {
      await clienteLock.query('SELECT pg_advisory_lock(881234)'); // número arbitrario, solo debe ser único para este propósito
      const areasExistentes = await clienteLock.query('SELECT COUNT(*) FROM areas_catalogo');
      if (Number(areasExistentes.rows[0].count) === 0) {
        console.log('⚠️ areas_catalogo está vacía — resembrando catálogo de áreas...');
        const areasSemilla = [
          { nombre: 'GERENCIA', tipo: 'administrativa' },
          { nombre: 'AREA ADMINISTRATIVA', tipo: 'administrativa' },
          { nombre: 'AREA DE LOGISTICA', tipo: 'administrativa' },
          { nombre: 'AREA COMERCIAL', tipo: 'administrativa' },
          { nombre: 'AREA DE PROVEEDORES', tipo: 'especial' },
          { nombre: 'AREA DE CLIENTES', tipo: 'especial' },
          { nombre: 'Obra Civil', tipo: 'oficio' },
          { nombre: 'Electricidad', tipo: 'oficio' },
          { nombre: 'Hidráulica', tipo: 'oficio' },
          { nombre: 'Redes de Gas', tipo: 'oficio' },
          { nombre: 'Estuco', tipo: 'oficio' },
          { nombre: 'Enchapes', tipo: 'oficio' },
          { nombre: 'Pintura', tipo: 'oficio' },
          { nombre: 'Drywall', tipo: 'oficio' },
          { nombre: 'Carpintería', tipo: 'oficio' },
          { nombre: 'Aseo', tipo: 'oficio' },
        ];
        for (const area of areasSemilla) {
          await clienteLock.query('INSERT INTO areas_catalogo (nombre, tipo) VALUES ($1, $2)', [area.nombre, area.tipo]);
        }
        console.log('✅ areas_catalogo resembrada con', areasSemilla.length, 'áreas');
      }
    } finally {
      await clienteLock.query('SELECT pg_advisory_unlock(881234)').catch(() => {});
      clienteLock.release();
    }

    console.log('✅ Esquema verificado/actualizado correctamente');
  } catch (error) {
    // No tumbamos el servidor si esto falla: preferimos que la app siga funcionando con el
    // esquema anterior a que un problema de migración deje todo caído (mismo criterio que
    // firebaseAdmin.js).
    console.error('❌ Error aplicando migraciones automáticas:', error.message);
  }
}

module.exports = aplicarMigraciones;
