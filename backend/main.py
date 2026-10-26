"""FastAPI application entrypoint for the Smart City Guide backend."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from .database import close_database, init_database


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Initialize PostGIS tables on startup and close the pool on shutdown."""
    await init_database()
    try:
        yield
    finally:
        await close_database()


app = FastAPI(
    title="Smart City Guide API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/", tags=["system"])
async def root() -> dict[str, str]:
    """Return basic API metadata."""
    return {"service": "smart-city-guide-api", "status": "ok"}


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    """Return a lightweight health response."""
    return {"status": "ok"}