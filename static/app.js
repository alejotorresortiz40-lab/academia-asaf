"use strict";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

// Si la página la sirve el propio FastAPI, la API está en el mismo servidor.
// Si se abre con Live Server (puerto 5500) o como archivo, apunta a FastAPI.
const API_BASE =
  location.protocol === "file:" || location.port === "5500"
    ? "http://127.0.0.1:8000"
    : "";

const TIEMPO_MAXIMO_MS = 8000;   // tiempo máximo de espera por petición
const REINTENTOS = 3;            // reintentos ante fallos de red o del servidor
const ESPERA_YOUTUBE_MS = 12000; // tiempo máximo para que cargue la API de YouTube
const CLAVE_PROGRESO = "asaf-progreso-v1";
const CLAVE_TITULOS = "asaf-titulos-v1";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const estado = {
  cursos: [],              // resumen de todos los cursos
  cacheCursos: new Map(),  // cursos ya cargados (id -> curso con lecciones)
  curso: null,             // curso actual
  indice: 0,               // posición de la clase actual en curso.lecciones
  player: null,            // instancia de YT.Player
  peticionActual: 0,       // evita que una respuesta lenta pise a una más nueva
};

let iframePendiente = null;
let resolverYouTube;
const youTubeListo = new Promise((resolve) => { resolverYouTube = resolve; });
let apiYouTubeLista = false;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Red: peticiones con tiempo límite y reintentos
// ---------------------------------------------------------------------------

class ErrorHttp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const esReintentable = (status) => status >= 500 || status === 408 || status === 429;

async function pedirJSON(ruta) {
  let ultimoError;
  for (let intento = 0; intento <= REINTENTOS; intento++) {
    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), TIEMPO_MAXIMO_MS);
    try {
      const resp = await fetch(API_BASE + ruta, { signal: control.signal });
      if (resp.ok) return await resp.json();

      let mensaje = `Error ${resp.status}`;
      try {
        const cuerpo = await resp.json();
        if (cuerpo && cuerpo.error) mensaje = cuerpo.error;
      } catch (_) { /* respuesta sin JSON */ }
      ultimoError = new ErrorHttp(resp.status, mensaje);
      if (!esReintentable(resp.status)) throw ultimoError;
    } catch (err) {
      if (err instanceof ErrorHttp && !esReintentable(err.status)) throw err;
      ultimoError = err.name === "AbortError"
        ? new Error("El servidor tardó demasiado en responder")
        : err;
    } finally {
      clearTimeout(temporizador);
    }
    if (intento < REINTENTOS) {
      // Espera creciente con algo de azar para que muchos usuarios no
      // reintenten todos en el mismo instante.
      await esperar(500 * 2 ** intento + Math.random() * 300);
    }
  }
  throw ultimoError;
}

// ---------------------------------------------------------------------------
// Datos guardados en el navegador (progreso y títulos de clases)
// ---------------------------------------------------------------------------

function leerObjeto(clave) {
  try {
    const datos = JSON.parse(localStorage.getItem(clave));
    return datos && typeof datos === "object" && !Array.isArray(datos) ? datos : {};
  } catch (_) {
    return {}; // modo privado, almacenamiento lleno o datos corruptos
  }
}

function guardarObjeto(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch (_) { /* si no se puede guardar, la página sigue funcionando */ }
}

function completadas(cursoId) {
  const lista = leerObjeto(CLAVE_PROGRESO)[cursoId];
  return new Set(Array.isArray(lista) ? lista : []);
}

function marcarCompletada(cursoId, leccionId) {
  const progreso = leerObjeto(CLAVE_PROGRESO);
  const lista = new Set(Array.isArray(progreso[cursoId]) ? progreso[cursoId] : []);
  lista.add(leccionId);
  progreso[cursoId] = [...lista];
  guardarObjeto(CLAVE_PROGRESO, progreso);
}

// Una clase está desbloqueada si es la primera o si la anterior está hecha.
function estaDesbloqueada(curso, indice, hechas) {
  if (indice === 0) return true;
  return hechas.has(curso.lecciones[indice - 1].id);
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

function mostrarAviso(texto) {
  const aviso = $("aviso");
  aviso.textContent = texto;
  aviso.hidden = !texto;
}

let temporizadorToast;
function mostrarToast(texto) {
  const toast = $("toast");
  toast.textContent = texto;
  toast.classList.add("visible");
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => toast.classList.remove("visible"), 3500);
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

// La API de YouTube llama a esta función global cuando termina de cargar.
window.onYouTubeIframeAPIReady = function () {
  apiYouTubeLista = true;
  resolverYouTube();
  if (iframePendiente) {
    conectarPlayer(iframePendiente);
    iframePendiente = null;
  }
};

function esperarYouTube() {
  return Promise.race([
    youTubeListo,
    esperar(ESPERA_YOUTUBE_MS).then(() => {
      throw new Error("YouTube no respondió");
    }),
  ]);
}

// Plan B si el servidor aún no tiene las clases: pide la lista de videos
// directamente al reproductor oficial de YouTube.
async function idsDesdeYouTube(playlistId) {
  await esperarYouTube();
  const contenedor = document.createElement("div");
  $("lector-listas").appendChild(contenedor);

  return new Promise((resolve, reject) => {
    let lector;
    let terminado = false;
    const terminar = (error, ids) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(limite);
      try { lector.destroy(); } catch (_) { /* nada que limpiar */ }
      $("lector-listas").replaceChildren();
      if (error) reject(error);
      else resolve(ids);
    };
    const limite = setTimeout(() => terminar(new Error("YouTube no devolvió la lista")), ESPERA_YOUTUBE_MS);

    lector = new YT.Player(contenedor, {
      width: 1,
      height: 1,
      playerVars: { listType: "playlist", list: playlistId, autoplay: 0 },
      events: {
        onReady: async (e) => {
          // La lista a veces tarda un instante en estar disponible.
          for (let i = 0; i < 20 && !terminado; i++) {
            const ids = e.target.getPlaylist && e.target.getPlaylist();
            if (Array.isArray(ids) && ids.length > 0) return terminar(null, ids);
            await esperar(250);
          }
          terminar(new Error("La lista de reproducción está vacía o es privada"));
        },
        onError: () => terminar(new Error("La lista de reproducción no está disponible")),
      },
    });
  });
}

function construirUrlVideo(youtubeId) {
  const params = new URLSearchParams({
    rel: "0",            // al final solo sugiere videos del mismo canal
    modestbranding: "1", // oculta el logo grande de YouTube
    enablejsapi: "1",    // permite detectar desde JS cuándo termina el video
    playsinline: "1",    // en móviles se reproduce dentro de la página
  });
  if (location.protocol.startsWith("http")) {
    params.set("origin", location.origin); // requerido por la API de YouTube
  }
  return `https://www.youtube.com/embed/${encodeURIComponent(youtubeId)}?${params}`;
}

function destruirPlayer() {
  if (estado.player && typeof estado.player.destroy === "function") {
    try { estado.player.destroy(); } catch (_) { /* ya estaba destruido */ }
  }
  estado.player = null;
  iframePendiente = null;
}

function mostrarVideo(leccion) {
  destruirPlayer();
  const contenedor = $("reproductor");
  contenedor.replaceChildren();

  const iframe = document.createElement("iframe");
  iframe.src = construirUrlVideo(leccion.youtube_id);
  iframe.title = leccion.titulo;
  iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  contenedor.appendChild(iframe);

  if (apiYouTubeLista) conectarPlayer(iframe);
  else iframePendiente = iframe;
}

function conectarPlayer(iframe) {
  if (!document.body.contains(iframe)) return; // el usuario ya cambió de clase
  try {
    estado.player = new YT.Player(iframe, {
      events: {
        onStateChange: (evento) => {
          if (evento.data === YT.PlayerState.PLAYING) recordarTitulo(evento.target);
          if (evento.data === YT.PlayerState.ENDED) completarLeccionActual(true);
        },
        onError: () => {
          mostrarAviso(
            "Este video no se puede reproducir aquí (puede estar privado o no " +
            "permitir inserción). Puedes marcar la clase como completada para continuar."
          );
        },
      },
    });
  } catch (err) {
    console.error("No se pudo conectar con el reproductor de YouTube", err);
  }
}

// Cuando una clase sin título conocido se reproduce, guarda su título real.
function recordarTitulo(player) {
  const { curso, indice } = estado;
  if (!curso) return;
  let datos;
  try { datos = player.getVideoData && player.getVideoData(); } catch (_) { return; }
  const leccion = curso.lecciones[indice];
  if (!datos || !datos.title || datos.video_id !== leccion.youtube_id) return;
  if (leccion.titulo === datos.title) return;

  const titulos = leerObjeto(CLAVE_TITULOS);
  titulos[leccion.youtube_id] = datos.title;
  guardarObjeto(CLAVE_TITULOS, titulos);
  leccion.titulo = datos.title;
  pintarCabecera();
  pintarLecciones();
}

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------

function textoProgreso(cursoId, total) {
  const hechas = completadas(cursoId).size;
  if (!total) return hechas ? `${hechas} clases completadas` : "Empieza ahora";
  if (hechas >= total) return "✓ Curso completado";
  return hechas ? `${hechas} de ${total} clases completadas` : `${total} clases`;
}

function pintarNavegacion() {
  const nav = $("cursos-nav");
  const tarjetas = $("tarjetas");
  nav.replaceChildren();
  tarjetas.replaceChildren();

  for (const c of estado.cursos) {
    const tab = document.createElement("button");
    tab.className = "curso-tab";
    tab.textContent = c.nombre;
    tab.dataset.id = c.id;
    tab.addEventListener("click", () => irA(c.id));
    nav.appendChild(tab);

    const tarjeta = document.createElement("button");
    tarjeta.className = "tarjeta";
    const icono = document.createElement("span");
    icono.className = "icono";
    icono.textContent = c.icono;
    const titulo = document.createElement("h3");
    titulo.textContent = c.nombre;
    const desc = document.createElement("p");
    desc.textContent = c.descripcion;
    const est = document.createElement("span");
    est.className = "estado";
    const conocido = estado.cacheCursos.get(c.id);
    est.textContent = textoProgreso(c.id, conocido ? conocido.lecciones.length : c.total_lecciones);
    tarjeta.append(icono, titulo, desc, est);
    tarjeta.addEventListener("click", () => irA(c.id));
    tarjetas.appendChild(tarjeta);
  }
}

function marcarTabActiva(id) {
  for (const tab of document.querySelectorAll(".curso-tab")) {
    tab.classList.toggle("activo", tab.dataset.id === id);
  }
}

function pintarLecciones() {
  const { curso, indice } = estado;
  const hechas = completadas(curso.id);
  const lista = $("lista-lecciones");
  lista.replaceChildren();

  curso.lecciones.forEach((leccion, i) => {
    const desbloqueada = estaDesbloqueada(curso, i, hechas);
    const completada = hechas.has(leccion.id);

    const btn = document.createElement("button");
    btn.className = "leccion-btn";
    if (i === indice) btn.classList.add("actual");
    if (completada) btn.classList.add("completada");
    btn.disabled = !desbloqueada;

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = completada ? "✓" : desbloqueada ? String(i + 1) : "🔒";
    const texto = document.createElement("span");
    texto.textContent = leccion.titulo;
    btn.append(num, texto);
    btn.title = desbloqueada ? "" : "Completa la clase anterior para desbloquearla";
    btn.addEventListener("click", () => irA(curso.id, i));

    const li = document.createElement("li");
    li.appendChild(btn);
    lista.appendChild(li);
  });

  const actual = lista.children[indice];
  if (actual) actual.scrollIntoView({ block: "nearest" });

  const total = curso.lecciones.length;
  const hechasEnCurso = curso.lecciones.filter((l) => hechas.has(l.id)).length;
  $("barra-progreso").style.width = `${(hechasEnCurso / total) * 100}%`;
  $("texto-progreso").textContent = `${hechasEnCurso} de ${total} clases completadas`;

  const actualHecha = hechas.has(curso.lecciones[indice].id);
  $("btn-anterior").disabled = indice === 0;
  $("btn-completar").disabled = actualHecha;
  $("btn-completar").textContent = actualHecha ? "Completada ✓" : "Marcar como completada";
  $("btn-siguiente").disabled = !(indice < total - 1 && actualHecha);
}

function pintarCabecera() {
  const { curso, indice } = estado;
  const leccion = curso.lecciones[indice];
  $("nombre-curso").textContent = `${curso.icono} ${curso.nombre}`;
  $("descripcion-curso").textContent = curso.descripcion;
  $("etiqueta-leccion").textContent = `${curso.nombre} · Clase ${indice + 1} de ${curso.lecciones.length}`;
  $("titulo-leccion").textContent = leccion.titulo;
  document.title = `${leccion.titulo} · ${curso.nombre} · Academia ASAF`;
  marcarTabActiva(curso.id);
}

function completarLeccionActual(automatico) {
  const { curso, indice } = estado;
  if (!curso) return;
  const leccion = curso.lecciones[indice];
  if (completadas(curso.id).has(leccion.id)) return;

  marcarCompletada(curso.id, leccion.id);
  pintarLecciones();

  if (indice === curso.lecciones.length - 1) {
    mostrarToast(`🎉 ¡Terminaste el curso de ${curso.nombre}! Dios bendiga tu servicio.`);
  } else {
    mostrarToast(automatico
      ? "✅ ¡Clase terminada! Se desbloqueó la siguiente."
      : "✅ Clase completada. Se desbloqueó la siguiente.");
  }
}

// ---------------------------------------------------------------------------
// Vistas y navegación (la URL guarda el curso y la clase: #piano/2)
// ---------------------------------------------------------------------------

function mostrarInicio() {
  estado.peticionActual++;
  destruirPlayer();
  estado.curso = null;
  $("vista-curso").hidden = true;
  $("vista-inicio").hidden = false;
  marcarTabActiva(null);
  document.title = "Academia ASAF · Fe y Música";
  pintarNavegacion();
}

function irA(cursoId, indice) {
  const destino = indice === undefined ? `#${cursoId}` : `#${cursoId}/${indice + 1}`;
  if (location.hash === destino) cargarDesdeUrl();
  else location.hash = destino;
}

function primeraPendiente(curso) {
  const hechas = completadas(curso.id);
  const i = curso.lecciones.findIndex((l) => !hechas.has(l.id));
  return i === -1 ? 0 : i;
}

async function obtenerCurso(id) {
  if (estado.cacheCursos.has(id)) return estado.cacheCursos.get(id);
  const curso = await pedirJSON(`/api/cursos/${encodeURIComponent(id)}`);
  if (!curso || !Array.isArray(curso.lecciones)) throw new Error("Respuesta inválida del servidor");

  if (curso.lecciones.length === 0) {
    // El servidor aún no pudo leer la lista: la pedimos a YouTube directamente.
    const titulos = leerObjeto(CLAVE_TITULOS);
    const ids = await idsDesdeYouTube(curso.playlist_id);
    curso.lecciones = ids.map((vid, i) => ({
      id: vid,
      titulo: titulos[vid] || `Clase ${i + 1}`,
      orden: i + 1,
      youtube_id: vid,
    }));
  }
  estado.cacheCursos.set(id, curso);
  return curso;
}

async function cargarDesdeUrl() {
  if (estado.cursos.length === 0) return;

  const [idUrl, numUrl] = decodeURIComponent(location.hash.slice(1)).split("/");
  if (!estado.cursos.some((c) => c.id === idUrl)) {
    if (location.hash && location.hash !== "#") history.replaceState(null, "", location.pathname);
    mostrarAviso("");
    mostrarInicio();
    return;
  }

  const peticion = ++estado.peticionActual;
  const cambioDeCurso = !estado.curso || estado.curso.id !== idUrl;
  $("vista-inicio").hidden = true;
  $("vista-curso").hidden = false;
  if (cambioDeCurso) {
    destruirPlayer();
    estado.curso = null;
    const resumen = estado.cursos.find((c) => c.id === idUrl);
    marcarTabActiva(idUrl);
    $("reproductor").innerHTML = '<div class="vacio">Cargando clases…</div>';
    $("nombre-curso").textContent = `${resumen.icono} ${resumen.nombre}`;
    $("descripcion-curso").textContent = resumen.descripcion;
    $("etiqueta-leccion").textContent = "";
    $("titulo-leccion").textContent = "";
    $("lista-lecciones").replaceChildren();
    $("texto-progreso").textContent = "";
    $("barra-progreso").style.width = "0";
    for (const b of ["btn-anterior", "btn-completar", "btn-siguiente"]) $(b).disabled = true;
  }

  let curso;
  try {
    curso = await obtenerCurso(idUrl);
  } catch (err) {
    if (peticion !== estado.peticionActual) return;
    $("reproductor").innerHTML = '<div class="vacio">No se pudieron cargar las clases.</div>';
    mostrarAviso(`No se pudo cargar el curso: ${err.message}. Revisa tu conexión y recarga la página.`);
    return;
  }
  if (peticion !== estado.peticionActual) return; // llegó tarde, hay otra más nueva
  if (curso.lecciones.length === 0) {
    $("reproductor").innerHTML = '<div class="vacio">Este curso todavía no tiene clases.</div>';
    return;
  }

  let indice = Number.parseInt(numUrl, 10) - 1;
  const hechas = completadas(curso.id);
  if (
    !Number.isInteger(indice) ||
    indice < 0 ||
    indice >= curso.lecciones.length ||
    !estaDesbloqueada(curso, indice, hechas)
  ) {
    indice = primeraPendiente(curso);
  }

  const cambioLeccion =
    estado.curso !== curso || estado.indice !== indice || (!estado.player && !iframePendiente);

  estado.curso = curso;
  estado.indice = indice;
  mostrarAviso("");
  pintarCabecera();
  pintarLecciones();
  if (cambioLeccion) {
    mostrarVideo(curso.lecciones[indice]);
    window.scrollTo({ top: 0 });
  }

  // Deja la URL consistente con lo que se muestra, sin crear otra entrada de historial.
  const hashCorrecto = `#${curso.id}/${indice + 1}`;
  if (location.hash !== hashCorrecto) history.replaceState(null, "", hashCorrecto);
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function iniciar() {
  $("btn-anterior").addEventListener("click", () => {
    if (estado.curso && estado.indice > 0) irA(estado.curso.id, estado.indice - 1);
  });
  $("btn-siguiente").addEventListener("click", () => {
    const { curso, indice } = estado;
    if (curso && indice < curso.lecciones.length - 1) irA(curso.id, indice + 1);
  });
  $("btn-completar").addEventListener("click", () => completarLeccionActual(false));
  window.addEventListener("hashchange", cargarDesdeUrl);

  if (location.protocol === "file:") {
    mostrarAviso(
      "Abre la página desde http://127.0.0.1:8000 (con el servidor encendido). " +
      "YouTube no permite reproducir videos en archivos abiertos directamente."
    );
  }

  try {
    const cursos = await pedirJSON("/api/cursos");
    if (!Array.isArray(cursos) || cursos.length === 0) throw new Error("No hay cursos disponibles");
    estado.cursos = cursos;
  } catch (err) {
    mostrarAviso(`No se pudo conectar con el servidor: ${err.message}. Recarga la página en unos segundos.`);
    return;
  }

  pintarNavegacion();
  await cargarDesdeUrl();
}

iniciar();
