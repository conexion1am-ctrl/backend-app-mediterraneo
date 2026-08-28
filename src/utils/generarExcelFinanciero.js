// Genera el estado financiero de un proyecto en Excel (.xlsx), a partir de los mismos datos
// que ya calcula GET /estadisticas/:proyecto_id (valor del contrato, abonos, costos por tipo,
// resumen por categoría y el historial completo de movimientos). Se sube a Firebase Storage
// igual que los PDF de cotización/contrato, usando subirBufferAStorage.

const ExcelJS = require('exceljs');

const ETIQUETAS_TIPO = { materiales: 'Materiales', mano_obra: 'Mano de obra', imprevistos: 'Imprevistos' };

function formatearFecha(fecha) {
  if (!fecha) return '';
  const d = new Date(fecha);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const anio = d.getUTCFullYear();
  return `${dia}/${mes}/${anio}`;
}

// Aplica formato de moneda colombiana (sin decimales) a una celda.
function aplicarFormatoMoneda(celda) {
  celda.numFmt = '"$"#,##0;[Red]-"$"#,##0';
}

// REDISEÑO VISUAL (2026-08-28, a pedido del usuario, mismo estilo aplicado a
// generarExcelBalanceGeneralBuffer más abajo): la hoja Resumen ahora usa KPIs grandes en vez de una
// lista plana de etiqueta/valor, y las tablas de categorías/movimientos/abonos llevan encabezado
// con fondo de color y filas alternadas en gris claro — mismo criterio de "reporte financiero
// profesional" en los dos Excel de la app. La FIRMA de la función (proyectoNombre, empresaNombre,
// stats) y el objeto que recibe NO cambiaron, así que el endpoint que la llama (GET
// /:proyecto_id/excel en estadisticas.js) sigue funcionando exactamente igual, sin tocarlo.
async function generarExcelFinancieroBuffer({ proyectoNombre, empresaNombre, stats }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = empresaNombre || 'C&D Manager';
  workbook.created = new Date();

  const costosTotal =
    parseFloat(stats.costos_materiales || 0) +
    parseFloat(stats.valor_mano_obra || 0) +
    parseFloat(stats.valor_imprevistos || 0);

  // ---------- Hoja 1: Resumen ejecutivo (KPIs) ----------
  const hojaResumen = workbook.addWorksheet('Resumen');
  hojaResumen.columns = [{ width: 34 }, { width: 22 }];

  hojaResumen.mergeCells('A1:B1');
  hojaResumen.getCell('A1').value = empresaNombre || '';
  hojaResumen.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1E3A5F' } };

  hojaResumen.mergeCells('A2:B2');
  hojaResumen.getCell('A2').value = `Estado financiero — ${proyectoNombre}`;
  hojaResumen.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF444444' } };

  hojaResumen.mergeCells('A3:B3');
  hojaResumen.getCell('A3').value = `Generado el ${formatearFecha(new Date())}`;
  hojaResumen.getCell('A3').font = { italic: true, size: 9, color: { argb: 'FF888888' } };

  const utilidad = parseFloat(stats.utilidad || 0);
  const kpis = [
    { etiqueta: 'VALOR DEL CONTRATO', valor: parseFloat(stats.valor_contrato || 0), color: 'FF1E3A5F' },
    { etiqueta: 'TOTAL ABONADO POR EL CLIENTE', valor: parseFloat(stats.total_abonado || 0), color: 'FF2E7D32' },
    { etiqueta: 'SALDO PENDIENTE POR COBRAR', valor: parseFloat(stats.saldo_pendiente || 0), color: 'FFA66A00' },
    { etiqueta: 'TOTAL DE COSTOS', valor: costosTotal, color: 'FFC62828' },
    { etiqueta: 'UTILIDAD DEL PROYECTO', valor: utilidad, color: utilidad < 0 ? 'FFC62828' : 'FF2E7D32' },
  ];

  let filaKpi = 5;
  kpis.forEach((kpi) => {
    hojaResumen.mergeCells(`A${filaKpi}:B${filaKpi}`);
    const celdaEtiqueta = hojaResumen.getCell(`A${filaKpi}`);
    celdaEtiqueta.value = kpi.etiqueta;
    celdaEtiqueta.font = { bold: true, size: 10, color: { argb: 'FF888888' } };
    filaKpi += 1;

    hojaResumen.mergeCells(`A${filaKpi}:B${filaKpi}`);
    const celdaValor = hojaResumen.getCell(`A${filaKpi}`);
    celdaValor.value = kpi.valor;
    celdaValor.numFmt = '"$"#,##0;[Red]-"$"#,##0';
    celdaValor.font = { bold: true, size: 18, color: { argb: kpi.color } };
    filaKpi += 2;
  });

  // Detalle de costos por tipo (materiales/mano de obra/imprevistos), como tabla chica debajo de
  // los KPIs — información de apoyo, no son los indicadores principales.
  filaKpi += 1;
  hojaResumen.getCell(`A${filaKpi}`).value = 'Detalle de costos';
  hojaResumen.getCell(`A${filaKpi}`).font = { bold: true, size: 11 };
  filaKpi += 1;
  [
    ['Materiales', parseFloat(stats.costos_materiales || 0)],
    ['Mano de obra', parseFloat(stats.valor_mano_obra || 0)],
    ['Imprevistos', parseFloat(stats.valor_imprevistos || 0)],
  ].forEach(([etiqueta, valor], index) => {
    const celdaEtiqueta = hojaResumen.getCell(`A${filaKpi}`);
    const celdaValor = hojaResumen.getCell(`B${filaKpi}`);
    celdaEtiqueta.value = etiqueta;
    celdaValor.value = valor;
    aplicarFormatoMoneda(celdaValor);
    if (index % 2 === 1) aplicarFondoAlternado({ getCell: (c) => (c === 'A' ? celdaEtiqueta : celdaValor) }, ['A', 'B']);
    filaKpi += 1;
  });

  // ---------- Hoja 2: Costos por categoría ----------
  const hojaCategorias = workbook.addWorksheet('Costos por categoría');
  hojaCategorias.columns = [
    { header: 'Categoría', key: 'categoria', width: 26 },
    { header: 'Materiales', key: 'materiales', width: 16 },
    { header: 'Mano de obra', key: 'mano_obra', width: 16 },
    { header: 'Imprevistos', key: 'imprevistos', width: 16 },
    { header: 'Total', key: 'total', width: 16 },
  ];
  hojaCategorias.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hojaCategorias.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

  (stats.resumen_por_categoria || []).forEach((cat, index) => {
    const filaAgregada = hojaCategorias.addRow({
      categoria: cat.categoria_nombre,
      materiales: parseFloat(cat.total_materiales || 0),
      mano_obra: parseFloat(cat.total_mano_obra || 0),
      imprevistos: parseFloat(cat.total_imprevistos || 0),
      total: parseFloat(cat.total || 0),
    });
    ['materiales', 'mano_obra', 'imprevistos', 'total'].forEach((key) => {
      aplicarFormatoMoneda(filaAgregada.getCell(key));
    });
    if (index % 2 === 1) aplicarFondoAlternado(filaAgregada, ['categoria', 'materiales', 'mano_obra', 'imprevistos', 'total']);
  });

  if (!stats.resumen_por_categoria || stats.resumen_por_categoria.length === 0) {
    hojaCategorias.addRow({ categoria: 'Sin movimientos con categoría asignada todavía' });
  }

  // ---------- Hoja 3: Historial de movimientos de costos ----------
  const hojaMovimientos = workbook.addWorksheet('Movimientos de costos');
  hojaMovimientos.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Categoría', key: 'categoria', width: 22 },
    { header: 'Tipo', key: 'tipo', width: 14 },
    { header: 'Detalle', key: 'detalle', width: 34 },
    { header: 'Valor', key: 'valor', width: 16 },
  ];
  hojaMovimientos.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hojaMovimientos.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

  (stats.movimientos_costos || []).forEach((m, index) => {
    const filaAgregada = hojaMovimientos.addRow({
      fecha: formatearFecha(m.fecha),
      categoria: m.categoria_nombre || 'Sin categoría',
      tipo: ETIQUETAS_TIPO[m.tipo] || m.tipo,
      detalle: m.detalle || '',
      valor: parseFloat(m.valor || 0),
    });
    aplicarFormatoMoneda(filaAgregada.getCell('valor'));
    if (index % 2 === 1) aplicarFondoAlternado(filaAgregada, ['fecha', 'categoria', 'tipo', 'detalle', 'valor']);
  });

  if (!stats.movimientos_costos || stats.movimientos_costos.length === 0) {
    hojaMovimientos.addRow({ fecha: 'Sin movimientos registrados todavía' });
  }

  // ---------- Hoja 4: Historial de abonos ----------
  const hojaAbonos = workbook.addWorksheet('Abonos del cliente');
  hojaAbonos.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Valor abonado', key: 'valor', width: 18 },
  ];
  hojaAbonos.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hojaAbonos.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

  (stats.abonos || []).forEach((a, index) => {
    const filaAgregada = hojaAbonos.addRow({ fecha: formatearFecha(a.fecha), valor: parseFloat(a.valor || 0) });
    aplicarFormatoMoneda(filaAgregada.getCell('valor'));
    if (index % 2 === 1) aplicarFondoAlternado(filaAgregada, ['fecha', 'valor']);
  });

  if (!stats.abonos || stats.abonos.length === 0) {
    hojaAbonos.addRow({ fecha: 'Sin abonos registrados todavía' });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

// Aplica fondo gris muy claro a una fila completa (filas alternadas, estilo reporte financiero
// profesional — más fácil de leer que todas las filas en blanco plano).
function aplicarFondoAlternado(fila, columnas) {
  columnas.forEach((col) => {
    fila.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  });
}

// 📊 BALANCE FINANCIERO GENERAL de la empresa (2026-08-28, a pedido explícito del usuario): a
// diferencia de generarExcelFinancieroBuffer (un solo proyecto), este junta TODOS los proyectos de
// la empresa en un solo reporte — mismo criterio de "balance de obra" (no contabilidad formal:
// sin EBITDA, activos/pasivos, que no aplican a este negocio), pero con formato de KPIs grandes y
// tablas limpias, filas alternadas, para que se vea profesional al compartirlo con socios.
// NO genera gráficos (chartjs-node-canvas requiere compilar un módulo nativo — riesgo real de
// romper el despliegue en Render; se dejó fuera deliberadamente, ver conversación 2026-08-28).
async function generarExcelBalanceGeneralBuffer({ empresaNombre, balance }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = empresaNombre || 'C&D Manager';
  workbook.created = new Date();

  // ---------- Hoja 1: Resumen ejecutivo (KPIs) ----------
  const hojaResumen = workbook.addWorksheet('Balance General');
  hojaResumen.columns = [{ width: 34 }, { width: 22 }];

  hojaResumen.mergeCells('A1:B1');
  hojaResumen.getCell('A1').value = empresaNombre || '';
  hojaResumen.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1E3A5F' } };

  hojaResumen.mergeCells('A2:B2');
  hojaResumen.getCell('A2').value = 'Balance financiero general — todos los proyectos';
  hojaResumen.getCell('A2').font = { bold: true, size: 12, color: { argb: 'FF444444' } };

  hojaResumen.mergeCells('A3:B3');
  hojaResumen.getCell('A3').value = `Generado el ${formatearFecha(new Date())} · ${balance.total_proyectos} proyecto(s) incluidos`;
  hojaResumen.getCell('A3').font = { italic: true, size: 9, color: { argb: 'FF888888' } };

  // KPIs grandes (estilo "tarjeta"): etiqueta arriba en gris, valor abajo grande y en color.
  const kpis = [
    { etiqueta: 'TOTAL CONTRATADO', valor: balance.total_contratado, color: 'FF1E3A5F' },
    { etiqueta: 'TOTAL ABONADO', valor: balance.total_abonado, color: 'FF2E7D32' },
    { etiqueta: 'SALDO PENDIENTE POR COBRAR', valor: balance.total_saldo_pendiente, color: 'FFA66A00' },
    { etiqueta: 'TOTAL DE COSTOS', valor: balance.total_costos, color: 'FFC62828' },
    { etiqueta: 'UTILIDAD TOTAL', valor: balance.utilidad_total, color: balance.utilidad_total < 0 ? 'FFC62828' : 'FF2E7D32' },
  ];

  let filaKpi = 5;
  kpis.forEach((kpi) => {
    hojaResumen.mergeCells(`A${filaKpi}:B${filaKpi}`);
    const celdaEtiqueta = hojaResumen.getCell(`A${filaKpi}`);
    celdaEtiqueta.value = kpi.etiqueta;
    celdaEtiqueta.font = { bold: true, size: 10, color: { argb: 'FF888888' } };
    filaKpi += 1;

    hojaResumen.mergeCells(`A${filaKpi}:B${filaKpi}`);
    const celdaValor = hojaResumen.getCell(`A${filaKpi}`);
    celdaValor.value = kpi.valor;
    celdaValor.numFmt = '"$"#,##0;[Red]-"$"#,##0';
    celdaValor.font = { bold: true, size: 18, color: { argb: kpi.color } };
    filaKpi += 2;
  });

  // ---------- Hoja 2: Desglose por proyecto ----------
  const hojaProyectos = workbook.addWorksheet('Por proyecto');
  hojaProyectos.columns = [
    { header: 'Proyecto', key: 'proyecto', width: 28 },
    { header: 'Cliente', key: 'cliente', width: 24 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Valor contrato', key: 'contrato', width: 16 },
    { header: 'Abonado', key: 'abonado', width: 16 },
    { header: 'Saldo pendiente', key: 'saldo', width: 16 },
    { header: 'Costos totales', key: 'costos', width: 16 },
    { header: 'Utilidad', key: 'utilidad', width: 16 },
  ];
  hojaProyectos.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hojaProyectos.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

  (balance.por_proyecto || []).forEach((p, index) => {
    const filaAgregada = hojaProyectos.addRow({
      proyecto: p.proyecto_nombre,
      cliente: p.cliente_nombre || '',
      estado: p.proyecto_eliminado ? 'Eliminado' : 'Activo',
      contrato: p.valor_contrato,
      abonado: p.total_abonado,
      saldo: p.saldo_pendiente,
      costos: p.costos_totales,
      utilidad: p.utilidad,
    });
    ['contrato', 'abonado', 'saldo', 'costos', 'utilidad'].forEach((key) => {
      aplicarFormatoMoneda(filaAgregada.getCell(key));
    });
    filaAgregada.getCell('utilidad').font = { bold: true, color: { argb: p.utilidad < 0 ? 'FFC62828' : 'FF2E7D32' } };
    if (index % 2 === 1) aplicarFondoAlternado(filaAgregada, ['proyecto', 'cliente', 'estado', 'contrato', 'abonado', 'saldo', 'costos', 'utilidad']);
  });

  if (!balance.por_proyecto || balance.por_proyecto.length === 0) {
    hojaProyectos.addRow({ proyecto: 'Sin proyectos con estadísticas registradas todavía' });
  }

  // Fila de totales al final, destacada.
  const filaTotales = hojaProyectos.addRow({
    proyecto: 'TOTAL',
    contrato: balance.total_contratado,
    abonado: balance.total_abonado,
    saldo: balance.total_saldo_pendiente,
    costos: balance.total_costos,
    utilidad: balance.utilidad_total,
  });
  filaTotales.font = { bold: true };
  filaTotales.eachCell((celda) => {
    celda.border = { top: { style: 'medium' } };
  });
  ['contrato', 'abonado', 'saldo', 'costos', 'utilidad'].forEach((key) => {
    aplicarFormatoMoneda(filaTotales.getCell(key));
  });

  // ---------- Hoja 3: Desglose por categoría de costo (transversal a todos los proyectos) ----------
  const hojaCategorias = workbook.addWorksheet('Por categoría');
  hojaCategorias.columns = [
    { header: 'Categoría', key: 'categoria', width: 26 },
    { header: 'Materiales', key: 'materiales', width: 16 },
    { header: 'Mano de obra', key: 'mano_obra', width: 16 },
    { header: 'Imprevistos', key: 'imprevistos', width: 16 },
    { header: 'Total', key: 'total', width: 16 },
  ];
  hojaCategorias.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hojaCategorias.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

  (balance.por_categoria || []).forEach((cat, index) => {
    const filaAgregada = hojaCategorias.addRow({
      categoria: cat.categoria_nombre,
      materiales: cat.total_materiales,
      mano_obra: cat.total_mano_obra,
      imprevistos: cat.total_imprevistos,
      total: cat.total,
    });
    ['materiales', 'mano_obra', 'imprevistos', 'total'].forEach((key) => {
      aplicarFormatoMoneda(filaAgregada.getCell(key));
    });
    if (index % 2 === 1) aplicarFondoAlternado(filaAgregada, ['categoria', 'materiales', 'mano_obra', 'imprevistos', 'total']);
  });

  if (!balance.por_categoria || balance.por_categoria.length === 0) {
    hojaCategorias.addRow({ categoria: 'Sin movimientos con categoría asignada todavía' });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

module.exports = { generarExcelFinancieroBuffer, generarExcelBalanceGeneralBuffer };
