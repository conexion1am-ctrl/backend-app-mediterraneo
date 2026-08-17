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
  ciudad, propietario, parrafo, descuento, condicionesPago, tiempoEntrega, firmante,
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

      <p>Cordial saludo:</p>

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
function clausulasLegales({ ciudad, fechaLarga }) {
  return `
    <p><strong>Primera - Objeto.</strong> La CONTRATISTA se obliga a realizar y producir y el ORDENANTE a pagar los trabajos y objetos especificados en este contrato que consta de la tabla de ítems relacionada a continuación.</p>

    <p><strong>Segunda - Precio.</strong> El ORDENANTE pagará a la CONTRATISTA acorde con el volumen de trabajos realmente realizados los valores relacionados en el presente contrato.</p>

    <p><strong>Tercera - Pago.</strong> El ORDENANTE pagará a la CONTRATISTA los dineros que deba en razón a las entregas que efectivamente ésta realice, estipulándose el modo de pago según las condiciones de pago relacionadas en este documento. En caso de que se haga entrega de dinero o valores por encima del monto establecido, estos se abonarán al pago final. Los costos planteados en el presente documento corresponden al total de los trabajos a realizar. Se debe tomar en cuenta que, si se agregan elementos, aumentan cantidad de bienes a suministrar, estos se informarán y cobrarán aparte después de previa aprobación por escrito por parte del ORDENANTE.</p>

    <p><strong>Cuarta - Entrega.</strong> La CONTRATISTA realizará la entrega de los trabajos según el plazo acordado, concretándose a la firma del presente documento y el respectivo abono inicial.</p>

    <p><strong>Quinta - Procedimiento para la entrega.</strong> La CONTRATISTA hará el procedimiento para la entrega de los trabajos en el domicilio del ORDENANTE. El ORDENANTE dispondrá de 10 días hábiles, contados a partir de la entrega de los trabajos para formular los reclamos que procedan debido a las diferencias que exhiba respecto de los trabajos contratados.</p>

    <p><strong>Sexta - Materia Prima.</strong><br/>
    a) La materia prima será suministrada por la CONTRATISTA de lo que este haya acordado.<br/>
    b) Los desperdicios corresponderán a la CONTRATISTA de lo que este haya suministrado.</p>

    <p><strong>Séptima - Duración.</strong> El contrato que consta en este escrito tiene una duración igual a la entrega del total de los trabajos. Para terminarlo, cualquiera de las partes podrá comunicar a la otra con una anticipación mínima de quince (15) días su intención de cesar su vínculo contractual, en tal caso, ORDENANTE y CONTRATISTA quedan obligados a cumplir con las obligaciones derivadas de los trabajos contratados con anterioridad al preaviso.</p>

    <p><strong>Octava - Obligaciones de la CONTRATISTA.</strong> Constituyen las principales obligaciones de la CONTRATISTA las siguientes:<br/>
    a. Realizar los trabajos objeto del presente contrato según las especificaciones acordadas.<br/>
    b. Realizar las entregas dentro del plazo acordado para tal efecto.<br/>
    c. Tomar las medidas de protección necesarias para proteger los elementos ya instalados en el inmueble.<br/>
    d. En caso de ocasionar daños estos se repararán y cambiarán para dejarlos en estado original.<br/>
    e. No se responderá por daños que existan previamente, establecidos por chequeo visual previo y documentado fotográficamente, la fachada externa de la puerta de ingreso no es susceptible a reclamaciones.<br/>
    f. En caso de requerirse arreglos fuera de este contrato por desperfectos preexistentes, deberán solicitarse al ORDENANTE y tendrán un valor adicional.<br/>
    g. Pagar cuando corresponda o hacer la verificación de los aportes a la Seguridad Social de cada uno de los empleados que ingresan a la obra; en ningún momento el ORDENANTE genera vínculo laboral ni se obliga a hacer reservas para dichos aportes.<br/>
    h. Entregar la obra con aseo, retirar todos los escombros y de la correcta disposición de estos.</p>

    <p><strong>Novena - Obligaciones especiales del ORDENANTE.</strong> Constituyen las obligaciones principales del ORDENANTE las siguientes:<br/>
    a. Pagar los precios dentro del plazo previsto.<br/>
    b. Recibir los trabajos que le entregue la CONTRATISTA, cuando tal hecho esté conforme con los términos definidos en esta convención y a los diseños previamente aprobados.<br/>
    c. Avisar oportunamente de requerimientos especiales para el ingreso al inmueble.<br/>
    d. Autorizar al personal que indique la CONTRATISTA en caso de ser requerido.<br/>
    e. Informar oportunamente de suspensión de agua o energía en el inmueble.<br/>
    f. Responder oportunamente las dudas que le presente la CONTRATISTA, así mismo tomar decisiones oportunas de la elección de materiales, diseños y colores.</p>

    <p><strong>Décima - Garantía.</strong> Un año en mano de obra; en materiales, cada proveedor determina la garantía de su producto, la CONTRATISTA gestiona la garantía y su cubrimiento por parte del proveedor de los materiales que sean suministrados por la empresa.</p>

    <p><strong>Undécima - Cláusula de indemnidad.</strong> La CONTRATISTA se obliga a mantener indemne al ORDENANTE de cualquier daño o perjuicio originado en reclamaciones de terceros que tengan como causa sus actuaciones hasta por el monto del daño o perjuicio causado. La CONTRATISTA mantendrá indemne al ORDENANTE por cualquier obligación de carácter laboral o relacionado que se origine en el incumplimiento de las obligaciones laborales o de la seguridad social que la CONTRATISTA asume frente al personal, subordinados, empleados o terceros que se vinculen a la ejecución de las obligaciones derivadas del presente Contrato.</p>

    <p><strong>Duodécima - Cláusula compromisoria.</strong> Toda controversia o diferencia relativa a este contrato y a su ejecución o liquidación, se resolverá por un tribunal de Arbitramento designado por la cámara de comercio del domicilio de la CONTRATISTA mediante sorteo entre los árbitros inscritos en las listas que se lleva dicha cámara. El tribunal así constituido se sujetará a lo dispuesto por el Decreto 2279/89 y las demás disposiciones legales que lo modifiquen o adicionen, de acuerdo con las siguientes reglas:<br/>
    a. El tribunal estará integrado por un árbitro.<br/>
    b. La organización interna del tribunal se sujetará a las reglas previstas para el efecto por el centro de arbitraje de la cámara de comercio correspondiente.<br/>
    c. El tribunal decidirá en derecho.<br/>
    d. El tribunal funcionará en el centro de arbitraje de la Cámara de Comercio de su domicilio.</p>

    <p>En señal de conformidad las partes contratantes suscriben el presente documento${ciudad ? ` en la Ciudad de ${ciudad}` : ''} siendo el día ${fechaLarga}. Se extienden dos copias del mismo tenor y valor.</p>
  `;
}

function construirHtmlContrato({
  empresa, cliente, numero, fecha, items, total, fechaEntrega,
  ciudad, condicionesPago, tiempoEntrega, firmante,
}) {
  const colorEmpresa = empresa?.color_hex || '#1E90FF';
  const grupos = agruparPorSeccion(items);
  const subtotalGeneral = (items || []).reduce((sum, i) => sum + (parseFloat(i.valor) || 0), 0);
  const condiciones = parsearCondicionesPago(condicionesPago);
  const fechaContrato = fecha || new Date();
  const direccionInmueble = cliente?.direccion ? `${cliente.direccion}` : '';
  const mts2Texto = cliente?.mts2 ? ` (${cliente.mts2} m²)` : '';

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

      <p>Entre ${cliente?.nombre || 'el ORDENANTE'}${cliente?.cedula ? `, quién se identifica con la cédula de ciudadanía ${cliente.cedula}` : ''}, quién para los efectos del presente contrato se denominará simplemente como el ORDENANTE y ${firmante || 'el representante de la CONTRATISTA'}${empresa?.cedula_representante ? `, quién se identifica con la cédula de ciudadanía ${empresa.cedula_representante}` : ''}, quién actúa en representación de ${empresa?.nombre || 'la empresa'}${empresa?.nit ? ` con NIT: ${empresa.nit}` : ''}, y en lo sucesivo se denominará como la CONTRATISTA, hemos decidido celebrar el contrato de obra civil y reformas que tendrán lugar${cliente?.nombre_proyecto ? ` en ${cliente.nombre_proyecto}` : ''}${direccionInmueble ? ` ubicado en ${direccionInmueble}` : ''}${mts2Texto}; que consta en el documento que ahora se suscribe y que se rige por las cláusulas que se enuncian y en lo previsto en ellas por las disposiciones legales aplicables a la materia de la que trata este acto jurídico.</p>

      ${tablasSecciones}

      <table class="resumen">
        <tbody>
          <tr class="totalGeneral">
            <td class="etiqueta">TOTAL</td>
            <td class="monto">${formatearMoneda(total != null ? total : subtotalGeneral)}</td>
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
        ${clausulasLegales({ ciudad, fechaLarga: formatearFechaLarga(fechaContrato) })}
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
