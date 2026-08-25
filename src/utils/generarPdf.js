// Genera el PDF de cotización/contrato en el servidor (Node), para que quede guardado
// automáticamente en Firebase Storage sin depender de que alguien abra la app.
//
// La cotización usa un formato de "carta" simple. El contrato usa un formato de contrato de
// obra legal completo (cláusulas fijas + tabla de ítems + condiciones de pago + firmas),
// igual al modelo real que usa la empresa.

const formatearMoneda = (valor) => {
  const numero = parseFloat(valor) || 0;
  return numero.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
};

// Convierte un número entero (pesos colombianos) a su forma en letras, en español, para el
// bloque "Segunda - Precio" del contrato: "$87.500.000 (Ochenta y siete millones quinientos mil
// pesos colombianos)". Cubre el rango que puede necesitar un contrato de obra (hasta miles de
// millones); no pretende ser un conversor genérico de propósito general.
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const DIEZ_A_DIECINUEVE = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
// 20-29 en español van pegados ("veintiuno", "veintidós"...), a diferencia de 30 en adelante
// ("treinta y uno", "cuarenta y dos"...) que van separados con "y".
const VEINTIALGO = ['veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function trescientosALetras(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  let texto = '';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) texto += CENTENAS[c];
  if (resto > 0) {
    if (texto) texto += ' ';
    if (resto < 10) {
      texto += UNIDADES[resto];
    } else if (resto < 20) {
      texto += DIEZ_A_DIECINUEVE[resto - 10];
    } else if (resto < 30) {
      texto += VEINTIALGO[resto - 20];
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      texto += DECENAS[d];
      if (u > 0) texto += ` y ${UNIDADES[u]}`;
    }
  }
  return texto;
}

// La forma apocopada "un/veintiún" (sin la "o" final) se usa cuando "uno" antecede directamente
// a un sustantivo masculino como "millones" o "mil" (ej. "veintiún millones", "treinta y un
// millones" — nunca "veintiuno millones" ni "treinta y uno millones"). Cubre tanto "uno" pegado
// (veintiuno → veintiún) como "y uno" separado (treinta y uno → treinta y un).
function conApocope(n) {
  const texto = trescientosALetras(n);
  if (n % 10 !== 1 || n === 1) return texto;
  return texto.endsWith('y uno') ? texto.replace(/y uno$/, 'y un') : texto.replace(/uno$/, 'ún');
}

// trescientosALetras/conApocope solo saben convertir bloques de 0-999. Los "millones" pueden
// superar 999 en montos de mil millones de pesos o más (poco común en un contrato de obra, pero
// posible), lo que antes rompía la función y llegaba a imprimir "Undefined" en el PDF del
// contrato. Esta función descompone CUALQUIER cantidad de millones en sus propios "miles de
// millones" + "millones" antes de convertirlos, igual que ya se hace con miles/centenas.
function bloqueDeMillonesALetras(millones) {
  if (millones < 1000) return conApocope(millones);
  const milesDeMillones = Math.floor(millones / 1000);
  const restoMillones = millones % 1000;
  const partes = [];
  partes.push(milesDeMillones === 1 ? 'mil' : `${conApocope(milesDeMillones)} mil`);
  if (restoMillones > 0) partes.push(conApocope(restoMillones));
  return partes.join(' ');
}

function numeroALetras(valor) {
  let n = Math.round(Math.abs(parseFloat(valor) || 0));
  if (n === 0) return 'cero pesos colombianos';

  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const centenas = n % 1000;

  const partes = [];
  if (millones > 0) {
    partes.push(millones === 1 ? 'un millón' : `${bloqueDeMillonesALetras(millones)} millones`);
  }
  if (miles > 0) {
    partes.push(miles === 1 ? 'mil' : `${conApocope(miles)} mil`);
  }
  if (centenas > 0) {
    partes.push(trescientosALetras(centenas));
  }

  let texto = partes.join(' ').trim();
  texto = texto.charAt(0).toUpperCase() + texto.slice(1);
  // "de pesos" solo aplica cuando el número es un múltiplo exacto de un millón (ej. "dos
  // millones de pesos"); si hay miles o centenas de por medio no lleva "de" (ej. "un millón
  // quinientos mil pesos", como en el ejemplo real del usuario: "ochenta y siete millones
  // quinientos mil pesos colombianos").
  const conector = millones > 0 && miles === 0 && centenas === 0 ? ' de' : '';
  return `${texto}${conector} pesos colombianos`;
}

const formatearFechaDdMmAa = (fecha) => {
  if (!fecha) return '';
  const d = new Date(fecha);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const anio = String(d.getUTCFullYear()).slice(-2);
  return `${dia}-${mes}-${anio}`;
};

const formatearFechaLarga = (fecha) => {
  if (!fecha) return '';
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const d = new Date(fecha);
  return `${d.getUTCDate()} de ${meses[d.getUTCMonth()]} del año ${d.getUTCFullYear()}`;
};

// Agrupa los ítems por su campo "seccion". Los que no tienen sección van en un grupo sin
// título, al final. Devuelve una lista de { nombre, items, subtotal }.
function agruparPorSeccion(items) {
  const grupos = [];
  const indicePorNombre = {};
  (items || []).forEach((item) => {
    const nombre = (item.seccion || '').trim();
    const clave = nombre || '__sin_seccion__';
    if (indicePorNombre[clave] === undefined) {
      indicePorNombre[clave] = grupos.length;
      grupos.push({ nombre, items: [] });
    }
    grupos[indicePorNombre[clave]].items.push(item);
  });
  return grupos.map((g) => ({
    ...g,
    subtotal: g.items.reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0),
  }));
}

// condicionesPago: array de { porcentaje, descripcion }. Se muestra como lista con viñetas,
// sin recuadros ni tabla, tal como se definió: "25% — descripción".
function listaCondicionesPago(condicionesPago) {
  if (!Array.isArray(condicionesPago) || condicionesPago.length === 0) return '';
  const filas = condicionesPago
    .filter((c) => c.porcentaje || c.descripcion)
    .map((c) => `<li>${c.porcentaje ? `${c.porcentaje}% — ` : ''}${c.descripcion || ''}</li>`)
    .join('');
  return filas ? `<ul>${filas}</ul>` : '';
}

function parsearCondicionesPago(condicionesPago) {
  if (Array.isArray(condicionesPago)) return condicionesPago;
  if (typeof condicionesPago === 'string') {
    try {
      const parsed = JSON.parse(condicionesPago);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------- COTIZACIÓN (carta simple) ----------

function construirHtmlCotizacion({
  empresa, cliente, numero, fecha, items, total, fechaEntrega,
  ciudad, propietario, saludo, parrafo, descuento, condicionesPago, tiempoEntrega, firmante,
}) {
  const colorEmpresa = empresa?.color_hex || '#1E90FF';
  const grupos = agruparPorSeccion(items);
  const subtotalBruto = (items || []).reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0);
  const valorDescuento = parseFloat(descuento) || 0;
  const condiciones = parsearCondicionesPago(condicionesPago);

  const filaItem = (item, index) => `
    <tr style="background:${index % 2 === 0 ? '#fff' : '#f7f7f7'};">
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:center;">${item.cantidad != null && item.cantidad !== '' ? item.cantidad : '-'}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee;">${item.descripcion || ''}${item.adicional ? ' <span style="color:#888; font-size:11px;">(adicional)</span>' : ''}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:right;">${formatearMoneda(item.valor)}</td>
    </tr>`;

  const tablasSecciones = grupos
    .map((grupo) => `
      ${grupo.nombre ? `<p class="tituloSeccion">${grupo.nombre.toUpperCase()}</p>` : ''}
      <table>
        <thead>
          <tr>
            <th class="cantidad">Cant.</th>
            <th>Descripción</th>
            <th class="valor">Valor</th>
          </tr>
        </thead>
        <tbody>
          ${grupo.items.map(filaItem).join('')}
          <tr class="subtotalFila">
            <td></td>
            <td>SUBTOTAL</td>
            <td style="text-align:right;">${formatearMoneda(grupo.subtotal)}</td>
          </tr>
        </tbody>
      </table>`)
    .join('');

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Helvetica, Arial, sans-serif; color: #222; padding: 28px; font-size: 13px; line-height: 1.5; }
        .encabezado { display:flex; align-items:center; gap:14px; border-bottom: 3px solid ${colorEmpresa}; padding-bottom: 16px; margin-bottom: 20px; }
        .logo { width: 64px; height: 64px; border-radius: 32px; object-fit: cover; }
        .empresaNombre { font-size: 20px; font-weight: bold; color: ${colorEmpresa}; margin: 0; }
        .empresaWeb { font-size: 12px; color: #888; margin: 2px 0 0 0; }
        .tituloDoc { font-size: 16px; font-weight: bold; text-align:center; margin: 0 0 18px 0; color:${colorEmpresa}; letter-spacing: 1px; }
        .fechaCiudad { text-align: right; margin-bottom: 10px; }
        p { margin: 6px 0; }
        .tituloSeccion { font-weight: bold; margin: 18px 0 4px 0; color: ${colorEmpresa}; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th { text-align:left; background:${colorEmpresa}; color:#fff; padding:8px 10px; font-size:12px; }
        th.cantidad { text-align:center; width: 50px; }
        th.valor { text-align:right; width: 110px; }
        .subtotalFila td { padding:8px 10px; font-weight:bold; border-top: 1px solid ${colorEmpresa}; background:#f2f2f2; }
        .resumen { margin-top: 18px; width: 100%; border-collapse: collapse; }
        .resumen td { padding: 6px 10px; font-size: 13px; }
        .resumen .totalGeneral td { font-weight: bold; font-size: 15px; border-top: 2px solid ${colorEmpresa}; padding-top: 10px; }
        .resumen .descuentoFila td { color: #c0392b; }
        .resumen td.etiqueta { text-align: left; }
        .resumen td.monto { text-align: right; }
        .condiciones { margin-top: 24px; }
        .condiciones ul { margin: 6px 0; padding-left: 20px; list-style: disc; }
        .condiciones li { margin: 3px 0; }
        .firma { margin-top: 30px; }
        .pie { margin-top: 30px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="encabezado">
        ${empresa?.logo_url ? `<img class="logo" src="${empresa.logo_url}" />` : ''}
        <div>
          <p class="empresaNombre">${empresa?.nombre || ''}</p>
          ${empresa?.sitio_web ? `<p class="empresaWeb">${empresa.sitio_web}</p>` : ''}
        </div>
      </div>

      <p class="tituloDoc">COTIZACIÓN${numero ? ` N° ${numero}` : ''}</p>

      <p class="fechaCiudad">${ciudad ? `${ciudad}, ` : ''}${formatearFechaDdMmAa(fecha || new Date())}</p>

      <p>Señor(a)<br/>${propietario || cliente?.nombre || ''}${cliente?.nombre_proyecto ? `<br/>${cliente.nombre_proyecto}` : ''}</p>

      <p>${saludo || 'Cordial Saludo:'}</p>

      ${parrafo ? `<p>${parrafo}</p>` : ''}

      ${tablasSecciones}

      <table class="resumen">
        <tbody>
          <tr>
            <td class="etiqueta">Subtotal</td>
            <td class="monto">${formatearMoneda(subtotalBruto)}</td>
          </tr>
          ${valorDescuento > 0 ? `
          <tr class="descuentoFila">
            <td class="etiqueta">Descuento</td>
            <td class="monto">- ${formatearMoneda(valorDescuento)}</td>
          </tr>` : ''}
          <tr class="totalGeneral">
            <td class="etiqueta">TOTAL</td>
            <td class="monto">${formatearMoneda(total)}</td>
          </tr>
        </tbody>
      </table>

      ${(condiciones && condiciones.length) || tiempoEntrega ? `
      <div class="condiciones">
        ${condiciones && condiciones.length ? `<p><strong>Condiciones de pago:</strong></p>${listaCondicionesPago(condiciones)}` : ''}
        ${tiempoEntrega ? `<p><strong>Tiempo de entrega:</strong> ${tiempoEntrega}</p>` : ''}
      </div>` : ''}

      ${fechaEntrega ? `<p><strong>Fecha de entrega estimada:</strong> ${formatearFechaDdMmAa(fechaEntrega)}</p>` : ''}

      <p>Agradecemos por contar con nuestra empresa y estaremos atentos a resolver cualquier inquietud sobre esta cotización.</p>

      <div class="firma">
        <p>Atentamente,</p>
        <p><strong>${firmante || ''}</strong><br/>${empresa?.nombre || ''}</p>
      </div>

      <p class="pie">Generado desde ${empresa?.nombre || 'C&D Manager'}</p>
    </body>
  </html>`;
}

// ---------- CONTRATO DE OBRA (formato legal completo) ----------

// Texto legal fijo y genérico (mismas cláusulas para todas las empresas), con marcadores
// {{ORDENANTE}} / {{CONTRATISTA}} que se reemplazan según el caso.
// 2026-08-25: las cláusulas ya NO son texto fijo — cada contrato guarda su propio array editable
// (ver contratos.clausulas, precargado con CLAUSULAS_DEFECTO en cotizaciones_v2.js). Esta función
// solo arma el HTML a partir de lo que venga guardado; si por algún motivo un contrato viejo no
// tiene clausulas (creado antes de este cambio), simplemente no se imprime esa sección en vez de
// fallar. La cláusula "Segunda - Precio" recibe además, en su propio párrafo aparte, el valor
// total en números y en letras entre paréntesis — a pedido explícito del usuario.
function parsearClausulas(clausulas) {
  if (Array.isArray(clausulas)) return clausulas;
  if (typeof clausulas === 'string') {
    try {
      const parsed = JSON.parse(clausulas);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function clausulasLegalesHtml({ clausulas, total, ciudad, fechaLarga }) {
  const lista = parsearClausulas(clausulas);
  const esSegundaPrecio = (titulo) => /segunda/i.test(titulo || '') && /precio/i.test(titulo || '');

  const bloques = lista
    .map((c) => {
      const textoConSaltos = (c.texto || '').replace(/\n/g, '<br/>');
      const valorEnLetras = esSegundaPrecio(c.titulo) && total != null
        ? `<br/>${formatearMoneda(total)} (${numeroALetras(total)})`
        : '';
      return `<p><strong>${c.titulo || ''}.</strong> ${textoConSaltos}${valorEnLetras}</p>`;
    })
    .join('\n');

  return `
    ${bloques}

    <p>En señal de conformidad las partes contratantes suscriben el presente documento${ciudad ? ` en la Ciudad de ${ciudad}` : ''} siendo el día ${fechaLarga}. Se extienden dos copias del mismo tenor y valor.</p>
  `;
}

// Reemplaza los marcadores {{...}} del párrafo introductorio editable (ver
// PARRAFO_INTRODUCTORIO_DEFECTO en cotizaciones_v2.js) por los datos reales del cliente/empresa,
// igual que antes se armaba ese párrafo a mano, pero ahora el TEXTO ALREDEDOR de esos datos es
// editable por el usuario en la pantalla de revisión sin tener que volver a escribir los datos.
function armarParrafoIntroductorio({ plantilla, cliente, empresa, firmante, direccionInmueble, mts2Texto, nombreProyecto }) {
  if (!plantilla) return '';
  return plantilla
    .replace('{{ORDENANTE_NOMBRE}}', cliente?.nombre || 'el ORDENANTE')
    .replace('{{ORDENANTE_CEDULA}}', cliente?.cedula ? `, quién se identifica con la cédula de ciudadanía ${cliente.cedula}` : '')
    .replace('{{FIRMANTE}}', firmante || 'el representante de la CONTRATISTA')
    .replace('{{FIRMANTE_CEDULA}}', empresa?.cedula_representante ? `, quién se identifica con la cédula de ciudadanía ${empresa.cedula_representante}` : '')
    .replace('{{EMPRESA_NOMBRE}}', empresa?.nombre || 'la empresa')
    .replace('{{EMPRESA_NIT}}', empresa?.nit ? ` con NIT: ${empresa.nit}` : '')
    .replace('{{PROYECTO_NOMBRE}}', nombreProyecto ? ` en ${nombreProyecto}` : '')
    .replace('{{DIRECCION_INMUEBLE}}', direccionInmueble ? ` ubicado en ${direccionInmueble}` : '')
    .replace('{{MTS2}}', mts2Texto || '');
}

function construirHtmlContrato({
  empresa, cliente, numero, fecha, items, total, fechaEntrega,
  ciudad, parrafoIntroductorio, clausulas, condicionesPago, tiempoEntrega, firmante,
}) {
  const colorEmpresa = empresa?.color_hex || '#1E90FF';
  const grupos = agruparPorSeccion(items);
  const subtotalGeneral = (items || []).reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0);
  const condiciones = parsearCondicionesPago(condicionesPago);
  const fechaContrato = fecha || new Date();
  const direccionInmueble = cliente?.direccion ? `${cliente.direccion}` : '';
  const mts2Texto = cliente?.mts2 ? ` (${cliente.mts2} m²)` : '';
  const totalContrato = total != null ? total : subtotalGeneral;

  const filaItem = (item, index) => `
    <tr style="background:${index % 2 === 0 ? '#fff' : '#f7f7f7'};">
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:center;">${item.cantidad != null && item.cantidad !== '' ? item.cantidad : '-'}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee;">${item.descripcion || ''}${item.adicional ? ' <span style="color:#888; font-size:11px;">(adicional)</span>' : ''}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:right;">${formatearMoneda(item.valor)}</td>
    </tr>`;

  const tablasSecciones = grupos
    .map((grupo) => `
      ${grupo.nombre ? `<p class="tituloSeccion">${grupo.nombre.toUpperCase()}</p>` : ''}
      <table>
        <thead>
          <tr>
            <th class="cantidad">Cant.</th>
            <th>Descripción</th>
            <th class="valor">Valor</th>
          </tr>
        </thead>
        <tbody>
          ${grupo.items.map(filaItem).join('')}
          <tr class="subtotalFila">
            <td></td>
            <td>SUBTOTAL</td>
            <td style="text-align:right;">${formatearMoneda(grupo.subtotal)}</td>
          </tr>
        </tbody>
      </table>`)
    .join('');

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Helvetica, Arial, sans-serif; color: #222; padding: 28px; font-size: 12.5px; line-height: 1.55; }
        .encabezado { display:flex; align-items:center; gap:14px; border-bottom: 3px solid ${colorEmpresa}; padding-bottom: 16px; margin-bottom: 20px; }
        .logo { width: 64px; height: 64px; border-radius: 32px; object-fit: cover; }
        .empresaNombre { font-size: 20px; font-weight: bold; color: ${colorEmpresa}; margin: 0; }
        .empresaWeb { font-size: 12px; color: #888; margin: 2px 0 0 0; }
        .tituloDoc { font-size: 17px; font-weight: bold; text-align:center; margin: 0 0 18px 0; color:${colorEmpresa}; letter-spacing: 1px; }
        .fechaCiudad { margin-bottom: 14px; }
        p { margin: 8px 0; text-align: justify; }
        .tituloSeccion { font-weight: bold; margin: 18px 0 4px 0; color: ${colorEmpresa}; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 6px; }
        th { text-align:left; background:${colorEmpresa}; color:#fff; padding:8px 10px; font-size:12px; }
        th.cantidad { text-align:center; width: 50px; }
        th.valor { text-align:right; width: 110px; }
        .subtotalFila td { padding:8px 10px; font-weight:bold; border-top: 1px solid ${colorEmpresa}; background:#f2f2f2; }
        .resumen { margin-top: 18px; width: 100%; border-collapse: collapse; }
        .resumen td { padding: 6px 10px; font-size: 13px; }
        .resumen .totalGeneral td { font-weight: bold; font-size: 15px; border-top: 2px solid ${colorEmpresa}; padding-top: 10px; }
        .resumen td.etiqueta { text-align: left; }
        .resumen td.monto { text-align: right; }
        .condiciones { margin-top: 20px; }
        .condiciones ul { margin: 6px 0; padding-left: 20px; list-style: disc; }
        .condiciones li { margin: 3px 0; }
        .clausulas { margin-top: 26px; page-break-inside: auto; }
        .firmas { margin-top: 40px; display:flex; justify-content: space-between; gap: 40px; }
        .firmaBloque { flex: 1; }
        .firmaLinea { border-top: 1px solid #333; margin-top: 46px; padding-top: 6px; }
        .firmaNombre { font-weight: bold; font-size: 13px; }
        .firmaCedula { font-size: 12px; color: #555; }
        .pie { margin-top: 30px; font-size: 11px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="encabezado">
        ${empresa?.logo_url ? `<img class="logo" src="${empresa.logo_url}" />` : ''}
        <div>
          <p class="empresaNombre">${empresa?.nombre || ''}</p>
          ${empresa?.sitio_web ? `<p class="empresaWeb">${empresa.sitio_web}</p>` : ''}
        </div>
      </div>

      <p class="tituloDoc">CONTRATO DE OBRA${numero ? ` N° ${numero}` : ''}</p>

      <div class="fechaCiudad">
        ${ciudad ? `<p>Ciudad: ${ciudad}</p>` : ''}
        <p>Fecha: ${formatearFechaDdMmAa(fechaContrato)}</p>
      </div>

      <p>${armarParrafoIntroductorio({
        plantilla: parrafoIntroductorio,
        cliente, empresa, firmante, direccionInmueble, mts2Texto,
        nombreProyecto: cliente?.nombre_proyecto,
      })}</p>

      ${tablasSecciones}

      <table class="resumen">
        <tbody>
          <tr class="totalGeneral">
            <td class="etiqueta">TOTAL</td>
            <td class="monto">${formatearMoneda(totalContrato)}</td>
          </tr>
        </tbody>
      </table>

      ${(condiciones && condiciones.length) || tiempoEntrega ? `
      <div class="condiciones">
        ${condiciones && condiciones.length ? `<p><strong>Condiciones de pago:</strong></p>${listaCondicionesPago(condiciones)}` : ''}
        ${tiempoEntrega ? `<p><strong>Tiempo de entrega:</strong> ${tiempoEntrega}</p>` : ''}
      </div>` : ''}

      ${fechaEntrega ? `<p><strong>Fecha de entrega estimada:</strong> ${formatearFechaDdMmAa(fechaEntrega)}</p>` : ''}

      ${empresa?.banco_numero ? `
      <p>Los dineros deben ser consignados a la Cuenta ${empresa.banco_tipo_cuenta || ''} de ${empresa.banco_nombre || ''} <strong>${empresa.banco_numero}</strong> a nombre de <strong>${empresa.banco_titular || empresa.nombre || ''}</strong>.</p>` : ''}

      <div class="clausulas">
        ${clausulasLegalesHtml({ clausulas, total: totalContrato, ciudad, fechaLarga: formatearFechaLarga(fechaContrato) })}
      </div>

      <div class="firmas">
        <div class="firmaBloque">
          <p style="margin-bottom:0;"><strong>LA CONTRATISTA:</strong></p>
          <div class="firmaLinea">
            <p class="firmaNombre">${firmante || ''}</p>
            ${empresa?.cedula_representante ? `<p class="firmaCedula">CC. ${empresa.cedula_representante}</p>` : ''}
          </div>
        </div>
        <div class="firmaBloque">
          <p style="margin-bottom:0;"><strong>EL ORDENANTE:</strong></p>
          <div class="firmaLinea">
            <p class="firmaNombre">${cliente?.nombre || ''}</p>
            ${cliente?.cedula ? `<p class="firmaCedula">CC. ${cliente.cedula}</p>` : ''}
          </div>
        </div>
      </div>

      <p class="pie">Generado desde ${empresa?.nombre || 'C&D Manager'}</p>
    </body>
  </html>`;
}

function construirHtml(datos) {
  return datos.tipoDocumento === 'contrato' ? construirHtmlContrato(datos) : construirHtmlCotizacion(datos);
}

// Convierte el HTML a un PDF (Buffer) usando Puppeteer con Chromium empaquetado para entornos
// tipo Render (sin depender de que Chrome esté instalado en el sistema).
async function generarPdfBuffer(datos) {
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');

  const html = construirHtml(datos);

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({ format: 'letter', printBackground: true });
    return buffer;
  } finally {
    await browser.close();
  }
}

module.exports = { construirHtml, generarPdfBuffer };
