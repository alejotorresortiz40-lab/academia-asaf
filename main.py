"""Backend de la plataforma de clases de la Academia ASAF.

Cada curso es una lista de reproducción de YouTube. El servidor descarga la
lista de videos (títulos e IDs) en segundo plano, la guarda en memoria y la
sirve al navegador. Si YouTube no responde, la página obtiene la lista
directamente desde el reproductor de YouTube, así que nunca se queda vacía.

Desarrollo:   python main.py
Producción:   uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
"""

import asyncio
import json
import logging
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

CACHE_API = "public, max-age=300"
ACTUALIZAR_CADA = 6 * 60 * 60     # refresca las listas cada 6 horas
REINTENTAR_EN = 10 * 60           # si YouTube falla, reintenta a los 10 minutos
TIEMPO_MAXIMO_YOUTUBE = 15        # segundos por petición a YouTube

log = logging.getLogger("asaf")
logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")


class Leccion(BaseModel):
    id: str          # ID del video de YouTube (se usa también para el progreso)
    titulo: str
    orden: int
    youtube_id: str


class Curso(BaseModel):
    id: str
    nombre: str
    descripcion: str
    icono: str
    enlace: str      # enlace de YouTube a la lista de reproducción


class CursoResumen(BaseModel):
    id: str
    nombre: str
    descripcion: str
    icono: str
    total_lecciones: int


class CursoDetalle(BaseModel):
    id: str
    nombre: str
    descripcion: str
    icono: str
    playlist_id: str
    lecciones: list[Leccion]


# ---------------------------------------------------------------------------
# Cursos. Para cambiar las clases de un instrumento, pega aquí el enlace de su
# lista de reproducción de YouTube (debe contener "list=").
# ---------------------------------------------------------------------------
CURSOS: list[Curso] = [
    Curso(
        id="piano",
        nombre="Piano",
        descripcion="Desde las primeras notas hasta acompañar alabanzas.",
        icono="🎹",
        enlace="https://www.youtube.com/watch?v=vD2XDxrwRnk&list=PLqE3Rr8n2gAVZpK4Eaf14LglgPJkMwiwj",
    ),
    Curso(
        id="guitarra-acustica",
        nombre="Guitarra acústica",
        descripcion="Acordes, rasgueos y acompañamiento.",
        icono="🎸",
        enlace="https://www.youtube.com/watch?v=ZiBVB6dVDdw&list=PLjFHUxZOfBNXttxDGznuuj-Lb6y27ny3D",
    ),
    Curso(
        id="guitarra-electrica",
        nombre="Guitarra eléctrica",
        descripcion="Técnica, escalas y sonido para la banda.",
        icono="⚡",
        enlace="https://www.youtube.com/watch?v=8Vn7I-TFFZg&list=PLCc5Q_sXsaXGAdv8339MMlMRZDXgsO6FG",
    ),
    Curso(
        id="bajo",
        nombre="Bajo",
        descripcion="La base rítmica y armónica de la banda.",
        icono="🎵",
        enlace="https://www.youtube.com/watch?v=Vb04wMG_KTI&list=PL3Q6wdvGWhlBjexnStBY645W7qMRujupm",
    ),
    Curso(
        id="bateria",
        nombre="Batería",
        descripcion="Ritmo, coordinación y tus primeros grooves.",
        icono="🥁",
        enlace="https://www.youtube.com/watch?v=-5N7fWV79iM&list=PLmVQzwEw62VNzTGUKVuFr2BMRs7hwvG5-&index=2",
    ),
    Curso(
        id="vocalizacion",
        nombre="Vocalización",
        descripcion="Respiración, afinación y cuidado de la voz.",
        icono="🎤",
        enlace="https://www.youtube.com/watch?v=5BZLiFIh2M0&list=PL7DglPZoQpLyvdN5GaxFi_Ce0k8TTGGuB",
    ),
]

PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def extraer_playlist(enlace: str) -> str:
    valor = parse_qs(urlparse(enlace).query).get("list", [""])[0]
    if not PLAYLIST_ID.match(valor):
        raise ValueError(f"El enlace no contiene una lista de reproducción válida: {enlace}")
    return valor


def validar_cursos(cursos: list[Curso]) -> dict[str, str]:
    """Detiene el arranque si hay un error en los cursos, en vez de que lo
    descubra un estudiante en el navegador. Devuelve curso -> playlist."""
    playlists = {}
    for curso in cursos:
        if curso.id in playlists:
            raise ValueError(f"Hay dos cursos con el id '{curso.id}'")
        playlists[curso.id] = extraer_playlist(curso.enlace)
    return playlists


PLAYLISTS = validar_cursos(CURSOS)
CURSOS_POR_ID = {c.id: c for c in CURSOS}

# Lecciones descargadas de YouTube: curso -> lista de lecciones.
LECCIONES: dict[str, list[dict]] = {}


# ---------------------------------------------------------------------------
# Descarga de las listas de reproducción
# ---------------------------------------------------------------------------

CABECERAS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept-Language": "es-ES,es;q=0.9",
    "Cookie": "SOCS=CAI; CONSENT=YES+1",
}


def descargar(url: str) -> str:
    peticion = urllib.request.Request(url, headers=CABECERAS)
    with urllib.request.urlopen(peticion, timeout=TIEMPO_MAXIMO_YOUTUBE) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _texto(nodo) -> str:
    if isinstance(nodo, dict):
        if "simpleText" in nodo:
            return nodo["simpleText"]
        if "runs" in nodo:
            return "".join(r.get("text", "") for r in nodo["runs"])
        if "content" in nodo:
            return nodo["content"]
    return ""


def videos_desde_pagina(html: str) -> list[tuple[str, str]]:
    """Lee la página de la lista (hasta ~100 videos, con títulos)."""
    inicio = html.find("ytInitialData")
    if inicio == -1:
        return []
    inicio = html.find("{", inicio)
    datos, _ = json.JSONDecoder().raw_decode(html[inicio:])

    videos, vistos = [], set()
    pendientes = [datos]
    while pendientes:
        nodo = pendientes.pop()
        if isinstance(nodo, dict):
            renderer = nodo.get("playlistVideoRenderer")
            if isinstance(renderer, dict):
                vid = renderer.get("videoId", "")
                titulo = _texto(renderer.get("title"))
                # Los videos privados o eliminados no se pueden reproducir.
                if YOUTUBE_ID.match(vid) and vid not in vistos and renderer.get("isPlayable", True):
                    vistos.add(vid)
                    indice = _texto(renderer.get("index"))
                    videos.append((int(indice) if indice.isdigit() else 10**6, vid, titulo))
                continue
            pendientes.extend(nodo.values())
        elif isinstance(nodo, list):
            pendientes.extend(nodo)
    videos.sort(key=lambda v: v[0])
    return [(vid, titulo) for _, vid, titulo in videos]


def videos_desde_rss(xml: str) -> list[tuple[str, str]]:
    """Plan B: el feed oficial (solo devuelve los primeros 15 videos)."""
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
    raiz = ET.fromstring(xml)
    videos = []
    for entrada in raiz.findall("a:entry", ns):
        vid = entrada.findtext("yt:videoId", default="", namespaces=ns)
        titulo = entrada.findtext("a:title", default="", namespaces=ns)
        if YOUTUBE_ID.match(vid):
            videos.append((vid, titulo))
    return videos


def obtener_lista(playlist_id: str) -> list[tuple[str, str]]:
    mejores: list[tuple[str, str]] = []
    try:
        mejores = videos_desde_pagina(
            descargar(f"https://www.youtube.com/playlist?list={playlist_id}")
        )
    except Exception as err:
        log.warning("No se pudo leer la página de la lista %s: %s", playlist_id, err)
    if len(mejores) < 15:
        try:
            rss = videos_desde_rss(
                descargar(f"https://www.youtube.com/feeds/videos.xml?playlist_id={playlist_id}")
            )
            if len(rss) > len(mejores):
                mejores = rss
        except Exception as err:
            log.warning("No se pudo leer el feed de la lista %s: %s", playlist_id, err)
    return mejores


def a_lecciones(videos: list[tuple[str, str]]) -> list[dict]:
    return [
        Leccion(id=vid, titulo=titulo.strip() or f"Clase {i}", orden=i, youtube_id=vid).model_dump()
        for i, (vid, titulo) in enumerate(videos, start=1)
    ]


async def actualizar_listas() -> bool:
    todo_bien = True
    for curso_id, playlist_id in PLAYLISTS.items():
        try:
            videos = await asyncio.wait_for(
                asyncio.to_thread(obtener_lista, playlist_id),
                timeout=TIEMPO_MAXIMO_YOUTUBE * 3,
            )
        except Exception as err:
            log.warning("Lista de '%s' no disponible: %s", curso_id, err)
            videos = []
        if videos:
            LECCIONES[curso_id] = a_lecciones(videos)
            log.info("Curso '%s': %d clases cargadas desde YouTube", curso_id, len(videos))
        else:
            # Se conserva la última versión buena, si la hay.
            todo_bien = False
    return todo_bien


async def mantener_listas_al_dia():
    while True:
        try:
            ok = await actualizar_listas()
        except Exception:
            log.exception("Error actualizando las listas")
            ok = False
        await asyncio.sleep(ACTUALIZAR_CADA if ok else REINTENTAR_EN)


@asynccontextmanager
async def ciclo_de_vida(app: FastAPI):
    tarea = asyncio.create_task(mantener_listas_al_dia())
    yield
    tarea.cancel()


# ---------------------------------------------------------------------------
# Aplicación
# ---------------------------------------------------------------------------

app = FastAPI(title="Academia ASAF", lifespan=ciclo_de_vida)

app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.exception_handler(StarletteHTTPException)
async def error_http(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(RequestValidationError)
async def error_validacion(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=400, content={"error": "Petición inválida"})


@app.exception_handler(Exception)
async def error_inesperado(request: Request, exc: Exception):
    log.exception("Error inesperado en %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"error": "Error interno. Inténtalo de nuevo en unos segundos."},
    )


@app.get("/api/salud")
async def salud():
    return {
        "estado": "ok",
        "cursos_con_clases": sorted(LECCIONES),
    }


@app.get("/api/cursos", response_model=list[CursoResumen])
async def listar_cursos():
    datos = [
        CursoResumen(
            id=c.id,
            nombre=c.nombre,
            descripcion=c.descripcion,
            icono=c.icono,
            total_lecciones=len(LECCIONES.get(c.id, [])),
        ).model_dump()
        for c in CURSOS
    ]
    return JSONResponse(datos, headers={"Cache-Control": "public, max-age=60"})


@app.get("/api/cursos/{curso_id}", response_model=CursoDetalle)
async def obtener_curso(curso_id: str):
    curso = CURSOS_POR_ID.get(curso_id.strip().lower())
    if curso is None:
        return JSONResponse(status_code=404, content={"error": "Curso no encontrado"})
    lecciones = LECCIONES.get(curso.id, [])
    detalle = CursoDetalle(
        id=curso.id,
        nombre=curso.nombre,
        descripcion=curso.descripcion,
        icono=curso.icono,
        playlist_id=PLAYLISTS[curso.id],
        lecciones=lecciones,
    ).model_dump()
    # Si aún no hay clases descargadas, no se guarda en caché para que el
    # navegador vuelva a preguntar pronto.
    cache = CACHE_API if lecciones else "no-store"
    return JSONResponse(detalle, headers={"Cache-Control": cache})


@app.get("/api/{ruta:path}", include_in_schema=False)
async def api_no_encontrada(ruta: str):
    return JSONResponse(status_code=404, content={"error": "Ruta no encontrada"})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
