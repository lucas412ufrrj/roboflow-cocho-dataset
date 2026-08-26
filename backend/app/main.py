"""Ponto de entrada da aplicação FastAPI."""

from __future__ import annotations

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.captures import router as captures_router
from app.config import get_settings
from app.core.logging import configure_logging
from app.core.security import limiter

configure_logging()
settings = get_settings()

app = FastAPI(
    title="Backend de Coleta de Vídeos — Dataset Roboflow (Peso de Alimento no Cocho)",
    description=(
        "API responsável por receber vídeos do app móvel, extrair e validar "
        "frames, e enviá-los ao dataset Roboflow do workspace "
        f"'{settings.ROBOFLOW_WORKSPACE}'."
    ),
    version="1.0.0",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrinja em produção conforme a origem do app/admin.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(captures_router)


@app.get("/health", tags=["infra"])
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"}, status_code=status.HTTP_200_OK)


@app.get("/", tags=["infra"])
async def root() -> dict:
    return {
        "app": settings.APP_NAME,
        "roboflow_workspace": settings.ROBOFLOW_WORKSPACE,
        "roboflow_project": settings.ROBOFLOW_PROJECT,
    }
