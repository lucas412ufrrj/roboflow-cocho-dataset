"""
Logging estruturado com redação obrigatória de segredos.

Regra de ouro: ROBOFLOW_API_KEY (ou qualquer valor igual a ela) NUNCA deve
aparecer em texto puro em nenhum log. `redact()` é aplicado em qualquer
string antes de ser logada pelos módulos que lidam com Roboflow.
"""

from __future__ import annotations

import logging
import sys

from app.config import get_settings

_REDACTED = "***REDACTED***"


def redact(text: str, *secrets: str) -> str:
    """Substitui qualquer ocorrência dos segredos fornecidos por um placeholder."""
    result = text
    for secret in secrets:
        if secret:
            result = result.replace(secret, _REDACTED)
    return result


class RedactingFilter(logging.Filter):
    """Filtro de logging que redige a ROBOFLOW_API_KEY de qualquer registro."""

    def __init__(self) -> None:
        super().__init__()
        self._settings = get_settings()

    def filter(self, record: logging.LogRecord) -> bool:
        secret = self._settings.ROBOFLOW_API_KEY
        if secret:
            if isinstance(record.msg, str):
                record.msg = redact(record.msg, secret)
            record.args = ()
        return True


def configure_logging() -> None:
    settings = get_settings()
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RedactingFilter())
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
    )
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(settings.LOG_LEVEL)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
